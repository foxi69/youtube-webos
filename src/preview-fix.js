import { configRead, configAddChangeListener } from './config.js';
import { isWatchPage, isShortsPage } from './utils.js';
import { isLegacyWebOS } from './webos-utils.js';

/**
 * Fix Black Tile Previews (#67): on by default on webOS 3-6, off on webOS 22
 * and newer, where it is a switch of its own (fixBlackPreviews22).
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
 * On webOS 22 and newer previews show their picture (a webOS 25 TV), but a
 * webOS 26 OLED C4 was reported with the sound only (NicholasBly#221): the
 * switch is there for such a TV.
 */

const CLEAR_CLASS = 'ytaf-pfix-cleared';
const ON_CLASS = 'ytaf-pfix-clear';
const TICK_MS = 1000;

let legacy = false;
let timer = null;
let cleared = [];

const isPreviewPage = () => !isWatchPage() && !isShortsPage();
const enabled = () => !!configRead(legacy ? 'fixBlackPreviews' : 'fixBlackPreviews22');

function playingVideo() {
  const videos = document.querySelectorAll('video');
  for (let i = 0; i < videos.length; i++) {
    if (!videos[i].paused && !videos[i].ended) return videos[i];
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
  unclear();
}

// A preview starting: clear at once, then keep up with YouTube's re-renders.
function onPlaying(evt) {
  if (!(evt.target instanceof HTMLVideoElement) || !enabled() || !isPreviewPage()) return;
  tick();
  if (!timer) timer = setInterval(tick, TICK_MS);
}

function sync() {
  document.documentElement.classList.toggle(ON_CLASS, enabled());
  if (!enabled() || !isPreviewPage()) stop();
}

export function initPreviewFix() {
  legacy = isLegacyWebOS();
  document.addEventListener('playing', onPlaying, true);
  window.addEventListener('ytaf-page-update', sync);
  configAddChangeListener(legacy ? 'fixBlackPreviews' : 'fixBlackPreviews22', sync);
  sync();
}
