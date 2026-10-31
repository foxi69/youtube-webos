import { configRead, configAddChangeListener, previewFixModes } from './config.js';
import { isWatchPage, isShortsPage } from './utils.js';
import { getWebOSVersion, isLegacyWebOS } from './webos-utils.js';

/**
 * Tile previews on webOS 3-6 (#67): an OLED C9 on webOS 4.10 plays the
 * preview's sound over a black tile. The Shorts page's border trick
 * (yt-fixes.css) did not help there, so this offers more to try, and a way
 * to see what the TV does, without a debugger:
 *
 * Preview Picture Fix (webOS 3-6), `previewFixMode`:
 *   - border:  the Shorts border trick on the preview <video> (0.9.1's fix);
 *   - flatten: no rounded corners, opacity, filter or mask on the <video> and
 *              its ancestors while a preview plays. Each of those makes
 *              Chromium draw the video into an offscreen layer first, and on
 *              webOS the video is a hole punched through the page down to a
 *              hardware plane: drawn offscreen, the hole stays black;
 *   - both, off.
 *
 * Show Preview Diagnostics, `previewDiagnostics`: a text box in the top-right
 * corner with what the preview <video> and its ancestors look like, refreshed
 * every second while a preview plays, for a photo to attach to the issue.
 *
 * Both act on legacy webOS only, and never on the watch or Shorts page.
 */

const FLAT_CLASS = 'ytaf-pfix-flat';
const TICK_MS = 1000;
const MAX_ANCESTORS = 12;

let legacy = false;
let timer = null;
let box = null;
let flattened = [];

const isPreviewPage = () => !isWatchPage() && !isShortsPage();

function fixMode() {
  const mode = configRead('previewFixMode');
  // Object.keys rather than Object.hasOwn, which needs Chrome 93.
  return Object.keys(previewFixModes).indexOf(mode) !== -1 ? mode : 'border';
}

/** The html classes yt-fixes.css keys the fixes on. */
function syncClasses() {
  const cl = document.documentElement.classList;
  const mode = legacy ? fixMode() : 'off';
  cl.toggle('ytaf-pfix-border', mode === 'border' || mode === 'both');
  cl.toggle('ytaf-pfix-flatten', mode === 'flatten' || mode === 'both');
  if (!cl.contains('ytaf-pfix-flatten')) unflatten();
}

function previewVideo() {
  if (!isPreviewPage()) return null;
  const videos = document.querySelectorAll('video');
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (!v.paused && !v.ended) return v;
  }
  return videos[0] || null;
}

function unflatten() {
  for (let i = 0; i < flattened.length; i++) flattened[i].classList.remove(FLAT_CLASS);
  flattened = [];
}

/** Marks the playing preview <video> and its ancestors up to <body>. */
function flatten(video) {
  unflatten();
  if (!video || video.paused) return;
  for (let el = video; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    el.classList.add(FLAT_CLASS);
    flattened.push(el);
  }
}

// ---- diagnostics ----------------------------------------------------------

function describe(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => c && c !== FLAT_CLASS) : [];
  if (cls.length) s += '.' + cls.slice(0, 2).join('.');
  const key = el.getAttribute && el.getAttribute('idomkey');
  if (key) s += '[' + key + ']';
  return s.length > 48 ? s.slice(0, 47) + '~' : s;
}

function rect(el) {
  const r = el.getBoundingClientRect();
  return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
}

/** The computed properties that matter for a punched-through video. */
function flags(el) {
  const cs = window.getComputedStyle(el);
  const out = [];
  if (cs.position !== 'static') out.push(cs.position.slice(0, 3));
  if (cs.zIndex !== 'auto') out.push('z' + cs.zIndex);
  if (cs.opacity !== '1') out.push('op' + cs.opacity);
  const tf = cs.transform || cs.webkitTransform;
  if (tf && tf !== 'none') out.push('tf:' + tf.replace(/matrix(?:3d)?\(|[)\s]/g, '').slice(0, 24));
  const rad = cs.borderTopLeftRadius;
  if (rad && rad !== '0px') out.push('rad' + rad);
  if (cs.overflow && cs.overflow !== 'visible') out.push('ovf:' + cs.overflow);
  const filter = cs.filter || cs.webkitFilter;
  if (filter && filter !== 'none') out.push('flt');
  const mask = cs.webkitMaskImage || cs.maskImage;
  if (mask && mask !== 'none') out.push('mask');
  if (cs.willChange && cs.willChange !== 'auto') out.push('wc:' + cs.willChange);
  if (cs.visibility !== 'visible') out.push(cs.visibility);
  if (cs.display === 'none') out.push('NONE');
  const bg = cs.backgroundColor;
  if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') out.push('bg:' + bg.replace(/\s/g, ''));
  if (cs.backgroundImage && cs.backgroundImage !== 'none') out.push('bgimg');
  return out.join(' ');
}

function pageType() {
  const cls = document.body ? document.body.className.split(/\s+/) : [];
  for (let i = 0; i < cls.length; i++) if (cls[i].indexOf('WEB_PAGE_TYPE_') === 0) return cls[i].slice(14);
  return '?';
}

export function collectDiagnostics() {
  const chrome = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '?';
  const lines = [
    `YTAF preview diag · webOS ${getWebOSVersion()} · Chrome ${chrome} · fix: ${fixMode()}`,
    `page ${pageType()} · ${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio} · videos ${document.querySelectorAll('video').length}`
  ];
  const video = previewVideo();
  if (!video) {
    lines.push('no preview <video> yet: focus a tile and wait for its preview');
    return lines.join('\n');
  }
  const cs = window.getComputedStyle(video);
  lines.push(
    `video ${rect(video)} · src ${video.videoWidth}x${video.videoHeight} · rs${video.readyState}` +
      ` · ${video.paused ? 'paused' : 'playing'} t${video.currentTime.toFixed(1)}${video.muted ? ' muted' : ''}`
  );
  lines.push(
    `  ${flags(video)} · obj ${cs.objectFit || '-'} · bimg ${cs.borderImageSource && cs.borderImageSource !== 'none' ? 'yes' : 'no'}` +
      ` · border ${cs.borderTopWidth}`
  );

  const r = video.getBoundingClientRect();
  const top = r.width > 0 ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  if (top) {
    let chain = describe(top);
    if (top.parentElement) chain += ' < ' + describe(top.parentElement);
    lines.push(`on top at centre: ${top === video ? 'the video' : chain}`);
    if (top !== video && !video.contains(top)) lines.push(`  ${rect(top)} ${flags(top)}`);
  }

  let el = video.parentElement;
  for (let i = 0; el && el !== document.documentElement && i < MAX_ANCESTORS; i++, el = el.parentElement) {
    lines.push(`${i + 1}. ${describe(el)} ${rect(el)} ${flags(el)}`);
  }
  return lines.join('\n');
}

function showBox(text) {
  if (!box || !box.isConnected) {
    if (!document.body) return;
    box = document.createElement('div');
    box.id = 'ytaf-preview-diag';
    box.style.cssText =
      'position:fixed;top:8px;right:8px;max-width:55vw;padding:8px 10px;' +
      'background:rgba(0,0,0,0.85);color:#fff;font:13px/1.35 monospace;white-space:pre-wrap;' +
      'word-break:break-all;z-index:2147483647;pointer-events:none;border:1px solid #ff7a1a;';
    document.body.appendChild(box);
  }
  box.textContent = text;
  box.style.display = 'block';
}

function hideBox() {
  if (box) box.style.display = 'none';
}

// ---- loop -----------------------------------------------------------------

function tick() {
  if (!isPreviewPage()) {
    unflatten();
    hideBox();
    return;
  }
  const video = previewVideo();
  if (document.documentElement.classList.contains('ytaf-pfix-flatten')) {
    if (video && !video.paused) {
      if (!flattened.length || flattened[0] !== video || !video.classList.contains(FLAT_CLASS)) flatten(video);
    } else {
      unflatten();
    }
  }
  if (configRead('previewDiagnostics')) {
    try {
      showBox(collectDiagnostics());
    } catch (err) {
      showBox('YTAF preview diag failed: ' + (err && err.message));
    }
  } else {
    hideBox();
  }
}

function sync() {
  syncClasses();
  const on = legacy && isPreviewPage() &&
    (document.documentElement.classList.contains('ytaf-pfix-flatten') || !!configRead('previewDiagnostics'));
  if (on && !timer) {
    timer = setInterval(tick, TICK_MS);
    tick();
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
    unflatten();
    hideBox();
  } else if (!on) {
    hideBox();
  }
}

// The flatten mode reacts at once to a preview starting, not on the next tick.
function onPlaying(evt) {
  if (!timer || !(evt.target instanceof HTMLVideoElement)) return;
  tick();
}

export function initPreviewFix() {
  legacy = isLegacyWebOS();
  if (!legacy) return;
  document.addEventListener('playing', onPlaying, true);
  window.addEventListener('ytaf-page-update', sync);
  configAddChangeListener('previewFixMode', sync);
  configAddChangeListener('previewDiagnostics', sync);
  sync();
}
