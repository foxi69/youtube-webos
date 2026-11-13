// DeArrow (https://dearrow.ajay.app): crowdsourced titles and thumbnails in
// place of clickbait ones, on the tiles of shelves and grids. Off by default;
// its own section on the UI Tweaks page. Ported from NicholasBly/youtube-webos
// #200 (by @magicsk), which replaced the titles-only version from MickLesk's
// fork.
//
// A branding lookup takes a request, which the JSON.parse hook cannot wait
// for, so it works in two halves:
//   1. applyDeArrow() runs in the parse hook (adblock.js) and writes what is
//      already decided into every tile of the response, so those render
//      right the first time; videos not seen before are queued for a lookup
//      (lookup.js).
//   2. When a lookup lands, the tiles already on screen are patched
//      (sweep.js). Tiles are rebuilt as the user moves around, so the sweep
//      also follows every parse and key press.
// What is shown follows the extension: the top title or thumbnail unless it
// is the original or voted below zero (a locked one always wins), with the
// extension's own title formatter (src/vendor/dearrow).
import { configRead, configAddChangeListener } from '../config.js';
import { CACHE_LIMIT, DEARROW_CONFIG_KEYS, SWEEP_DELAY } from './constants.js';
import { videos, nextGeneration } from './state.js';
import { forgetThumbs, thumbsFull } from './thumbs.js';
import { patchResponseTiles, unpatchResponses, applyToVideo } from './tiles.js';
import { sweepTiles } from './sweep.js';
import { queueLookups, lookUpOnScreen, clearQueue, setChangeHandler, wantsLookup } from './lookup.js';
import { diagDeArrow } from '../speed/diag.js';

export { titleFormattingSupported } from './titles.js';

let sweepTimer = null;

/** Drops the sweep waiting for its moment. */
function cancelSweep() {
  clearTimeout(sweepTimer);
  sweepTimer = null;
}

/**
 * Sweeps the rendered tiles SWEEP_DELAY from now, once however often it is
 * asked. The videos with a tile on screen are then looked up ahead of the
 * rest; the other rendered ones decided under old settings in the background.
 */
function scheduleSweep() {
  if (sweepTimer || !configRead('enableDeArrow')) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    const sweptAt = performance.now();
    const found = sweepTiles(false);
    diagDeArrow(`sweep: ms: ${Math.round(performance.now() - sweptAt)}, tiles: ${document.querySelectorAll('ytlr-tile-renderer').length}, ` +
      `on screen: ${found.onScreen.length}, stale off screen: ${found.stale.length}`);
    lookUpOnScreen(found.onScreen);
    if (found.stale.length) queueLookups(found.stale);
  }, SWEEP_DELAY);
}

/** Puts YouTube's own titles and thumbnails back on screen; a pending sweep would undo it. */
function restoreTiles() {
  cancelSweep();
  sweepTiles(true);
}

/**
 * Forgets everything (too many videos remembered): originals back on screen
 * and in the stored responses while they are still known, then the videos,
 * the queue and the thumbnails.
 */
function wipe() {
  restoreTiles();
  unpatchResponses();
  nextGeneration();
  clearQueue();
  videos.clear();
  forgetThumbs();
}

/**
 * The parse hook's step (adblock.js) for an InnerTube response, after its
 * filters: its video tiles get what is decided, new videos are queued for a
 * lookup, and the rendered tiles are swept a moment later. Player responses
 * carry no tiles and are skipped.
 */
export function applyDeArrow(data, responseType) {
  if (!data || typeof data !== 'object' || responseType === 'PLAYER') return;
  // Before any patching: a wipe in the middle of a response would free blobs
  // this same response was just given.
  if (videos.size >= CACHE_LIMIT || thumbsFull()) wipe();
  const found = patchResponseTiles(data, wantsLookup);
  diagDeArrow(`response: type: ${responseType}, to look up: ${found.length}, videos known: ${videos.size}`);
  if (found.length) queueLookups(found);
  scheduleSweep();
}

// The settings changed since the last refresh: switching accounts changes
// several at once (config.js), which is one refresh.
const changedKeys = new Set();
let refreshTimer = null;

function onSettingsChange({ detail }) {
  changedKeys.add(detail.key);
  if (!refreshTimer) refreshTimer = setTimeout(refresh, 0);
}

/**
 * Switched off: YouTube's titles and thumbnails back everywhere, then the
 * thumbnail copies freed, with what pointed at them: they would otherwise
 * stay in memory, up to the thumbnail budget, for the rest of the session
 * (NicholasBly's 0.8.5 build 3, fork watch #107). The videos and their
 * answers stay, a few strings each, so switching DeArrow back on decides
 * them again at once, the tiles on screen included.
 */
function switchOff() {
  restoreTiles();
  videos.forEach((video) => {
    video.thumb = null;
    video.crowdThumb = false;
    video.shownThumb = null;
  });
  forgetThumbs();
}

/**
 * The settings changed: turned off, YouTube's own come back everywhere
 * (switchOff). Only the badge: the decided videos get or lose it, nothing is
 * decided again. Otherwise every video is decided again, at once only the
 * ones with a tile drawn now (the sweep finds them, in or out of view); the
 * others when a tile shows them again, from answers already fetched.
 */
function refresh() {
  refreshTimer = null;
  const badgeOnly = changedKeys.size === 1 && changedKeys.has('dearrowShowBadge');
  diagDeArrow(`settings refresh: keys: ${Array.from(changedKeys).join(', ')}, videos known: ${videos.size}`);
  changedKeys.clear();
  if (configRead('enableDeArrow') && badgeOnly) {
    videos.forEach((video) => {
      if (video.resolved && !video.stale) applyToVideo(video);
    });
    scheduleSweep();
    return;
  }
  nextGeneration();
  // Stored responses get the new output when a tile shows the video again.
  unpatchResponses();
  clearQueue();
  if (!configRead('enableDeArrow')) {
    switchOff();
    return;
  }
  videos.forEach((video) => {
    video.stale = true;
  });
  cancelSweep();
  scheduleSweep();
}

// A video decided: the tiles of the stored responses get it now, for the next
// time YouTube draws them, and the ones on screen with the sweep.
setChangeHandler((video) => {
  applyToVideo(video);
  scheduleSweep();
});
DEARROW_CONFIG_KEYS.forEach((key) => {
  configAddChangeListener(key, onSettingsChange);
});

// Moving around is what makes the app build new tiles, so a key press is the
// cheapest sign that tiles may need patching again.
document.addEventListener(
  'keydown',
  () => {
    if (videos.size) scheduleSweep();
  },
  true
);
