import { configRead, configAddChangeListener } from './config.js';
import { isWatchPage, isShortsPage } from './utils.js';
import { isLegacyWebOS } from './webos-utils.js';

/**
 * Fix Black Tile Previews (#67), on by default on every webOS.
 *
 * A tile preview does not play inside the tile: YouTube's one full-screen
 * player is scaled down onto it, under the browse page. On webOS the video is
 * a hole punched through the page down to a hardware plane, so anything drawn
 * over that hole covers the picture, while the sound plays. On an OLED C9
 * (webOS 4.10) the browse page's ytlr-surface-page, full screen, drew a black
 * background over the player: YouTube leaves it transparent where previews
 * work, by a rule the old engine apparently cannot read.
 *
 * While a preview plays, the elements stacked over the middle of its video
 * that draw anything of their own (a background colour or image, a shadow, an
 * image) lose it; when it stops or the page changes, they get it back. On the
 * C9 that is the one surface page; nothing else on the tile changes.
 *
 * On webOS 22 and newer most TVs show previews with their picture (a webOS 25
 * TV), but some play the sound over a black tile (NicholasBly/youtube-webos#221,
 * a webOS 26 C4 and others); the same clearing shows it there
 * (NicholasBly/youtube-webos#229, by valentinBoch, tested on such a TV). There
 * the stack is looked up when the preview starts, when the focus moves or the
 * layout changes (once per frame, however many events) and every RESCAN_MS,
 * not every second, as each lookup restyles the page twice (stackAt); and a
 * shadow stays (the focus ring can be one). webOS 3-6 keep the 1 s re-check
 * and the shadow cleared, as tested on the C9. On a TV that shows the
 * picture anyway the clearing changes nothing visible (a webOS 25 TV,
 * 2026-11-24: same focus ring, no flash, same scroll time).
 */

const CLEAR_CLASS = 'ytaf-pfix-cleared';
const ON_CLASS = 'ytaf-pfix-clear';
const TICK_MS = 1000;
const RESCAN_MS = 5000;
// On webOS 22 and newer: the shadow is not cleared (yt-fixes.css).
const MODERN_CLASS = 'ytaf-pfix-modern';

let legacy = false;
let timer = null;
let frame = null;
let cleared = [];

const isPreviewPage = () => !isWatchPage() && !isShortsPage();
const enabled = () => !!configRead('fixBlackPreviews');

function playingVideo() {
  const videos = document.querySelectorAll('video');
  for (let i = 0; i < videos.length; i++) {
    // A media error leaves paused and ended false: a failed video is not playing.
    if (!videos[i].paused && !videos[i].ended && !videos[i].error) return videos[i];
  }
  return null;
}

/** Whether an element draws anything of its own that can cover the video. */
function paints(el) {
  const tag = el.tagName.toUpperCase();
  if (tag === 'IMG' || tag === 'CANVAS' || tag === 'SVG') return true;
  const cs = window.getComputedStyle(el);
  const bg = cs.backgroundColor;
  if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)) return true;
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  return !!(cs.boxShadow && cs.boxShadow !== 'none');
}

/**
 * Every element hit at (x, y), topmost first, pointer-events: none ones too.
 * webOS 3 (Chrome 38) has no elementsFromPoint: there the surface pages that
 * cover the point are taken instead.
 */
function stackAt(x, y) {
  if (typeof document.elementsFromPoint === 'function') {
    const tmp = document.createElement('style');
    tmp.textContent = '*{pointer-events:auto!important}';
    (document.head || document.documentElement).appendChild(tmp);
    try {
      return Array.prototype.slice.call(document.elementsFromPoint(x, y));
    } finally {
      tmp.parentNode.removeChild(tmp);
    }
  }
  const out = [];
  const pages = document.querySelectorAll('ytlr-surface-page');
  for (let i = 0; i < pages.length; i++) {
    const r = pages[i].getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) out.push(pages[i]);
  }
  return out;
}

/** The painting elements drawn over the middle of the video. */
function coverOf(video) {
  const r = video.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return [];
  const stack = stackAt(r.left + r.width / 2, r.top + r.height / 2);
  const out = [];
  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    if (el === video || el.contains(video)) break;
    // The settings panel open over a playing preview keeps its look
    // (NicholasBly/youtube-webos 4f7d787).
    if (el.closest && el.closest('.ytaf-ui-container')) continue;
    if (el.classList.contains(CLEAR_CLASS) || paints(el)) out.push(el);
  }
  return out;
}

function unclear() {
  for (let i = 0; i < cleared.length; i++) cleared[i].classList.remove(CLEAR_CLASS);
  cleared = [];
}

function tick() {
  const video = enabled() && isPreviewPage() ? playingVideo() : null;
  if (!video) {
    stop();
    return;
  }
  const cover = coverOf(video);
  for (let i = 0; i < cleared.length; i++) {
    if (cover.indexOf(cleared[i]) === -1) cleared[i].classList.remove(CLEAR_CLASS);
  }
  for (let i = 0; i < cover.length; i++) cover[i].classList.add(CLEAR_CLASS);
  cleared = cover;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  unclear();
}

// Clear at once, then keep up with YouTube's re-renders.
function start() {
  tick();
  if (!timer) timer = setInterval(tick, legacy ? TICK_MS : RESCAN_MS);
}

// webOS 22 and newer: the focus moved or the layout changed while a preview
// plays: looked up again in the next frame, once however many events came.
function queueTick() {
  if (!timer || frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    if (timer) tick();
  });
}

// A transition ended: only one around the playing video moves it (the
// player scaled onto the tile); the page's other transitions (each focus
// move has some) look nothing up (NicholasBly/youtube-webos 4f7d787).
function onTransitionEnd(evt) {
  if (!timer) return;
  const video = playingVideo();
  if (video && evt.target && evt.target.contains && evt.target.contains(video)) queueTick();
}

// A preview starting.
function onPlaying(evt) {
  if (!(evt.target instanceof HTMLVideoElement) || !enabled() || !isPreviewPage()) return;
  start();
}

// A preview stopping: what was cleared gets its look back at once, not at the
// next re-check up to a second later (until then the stopped video's hole
// shows through it).
function onStopped(evt) {
  if (!timer || !(evt.target instanceof HTMLVideoElement)) return;
  tick();
}

function sync() {
  document.documentElement.classList.toggle(ON_CLASS, enabled());
  if (!enabled() || !isPreviewPage()) stop();
}

// The setting switched: turned on while a preview plays, that preview is
// fixed now rather than from the next one.
function onSettingChange() {
  sync();
  if (enabled() && isPreviewPage() && !timer && playingVideo()) start();
}

export function initPreviewFix() {
  legacy = isLegacyWebOS();
  if (!legacy) {
    document.documentElement.classList.add(MODERN_CLASS);
    document.addEventListener('focusin', queueTick, true);
    document.addEventListener('transitionend', onTransitionEnd, true);
    window.addEventListener('resize', queueTick);
  }
  document.addEventListener('playing', onPlaying, true);
  document.addEventListener('pause', onStopped, true);
  document.addEventListener('ended', onStopped, true);
  // Its source taken away (a tile recycled) or failed: stopped too.
  document.addEventListener('emptied', onStopped, true);
  document.addEventListener('error', onStopped, true);
  window.addEventListener('ytaf-page-update', sync);
  configAddChangeListener('fixBlackPreviews', onSettingChange);
  sync();
}
