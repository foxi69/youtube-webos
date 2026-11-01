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
 *   - resize:  the preview does not play in the tile: YouTube scales its one
 *              full-screen player (ytlr-player#player-container, 1920x1080)
 *              down onto the tile with a CSS transform, e.g.
 *              matrix(0.375, 0, 0, 0.375, 156, 243) for a 720x405 tile at
 *              156,243 (the C9's diagnostics on #67). The TV places its
 *              hardware video plane from the layout box, it seems, not the
 *              transformed one, so the hole punched for it at the tile stays
 *              black. This mode drops the transform and gives the player the
 *              same place as real left/top/width/height, and the <video> the
 *              tile's size, so nothing between them is scaled;
 *   - resize_border: both of these. Resize also gives html5-video-container
 *              the video's box, as it has on the Shorts page, where it is
 *              absolutely placed; behind a preview it is 0px high;
 *   - clear:   the elements stacked over the middle of the preview (the
 *              tile, its thumbnail) lose their backgrounds and images while
 *              it plays: anything opaque over the punched-through video
 *              covers it. Resize Player did place the C9's video exactly
 *              where the tile is, still black, while the Shorts player,
 *              610x1082 and not full screen either, plays;
 *   - fullscreen: a test, not a fix: the player is left at full screen
 *              (YouTube's transform dropped, nothing resized) behind the
 *              browse page. A picture through the tile then means the TV
 *              draws the preview and only its small box goes wrong;
 *   - flatten: no rounded corners, opacity, filter or mask on the <video> and
 *              its ancestors while a preview plays. Each of those makes
 *              Chromium draw the video into an offscreen layer first, and on
 *              webOS the video is a hole punched through the page down to a
 *              hardware plane: drawn offscreen, the hole stays black;
 *   - both (border and flatten), off.
 *
 * Show Preview Diagnostics, `previewDiagnostics`: a text box in the top-right
 * corner with what the preview <video> and its ancestors look like, refreshed
 * every second while a preview plays, for a photo to attach to the issue.
 *
 * Both act on legacy webOS only, and never on the watch page. The fixes leave
 * the Shorts page alone too; the diagnostics show there as well, to compare
 * the Shorts player, which plays, with a preview, which does not.
 */

const FLAT_CLASS = 'ytaf-pfix-flat';
const CLEAR_CLASS = 'ytaf-pfix-cleared';
const MAX_COVER = 30;
const TICK_MS = 1000;
const MAX_ANCESTORS = 12;

let legacy = false;
let timer = null;
let box = null;
let flattened = [];
let cleared = [];

const isPreviewPage = () => !isWatchPage() && !isShortsPage();
const isDiagPage = () => !isWatchPage();

const PLAYER_SELECTOR = 'ytlr-player#player-container';
const RESIZE_SCOPE = 'html.ytaf-pfix-resize body:not(.WEB_PAGE_TYPE_WATCH):not(.WEB_PAGE_TYPE_SHORTS) ' + PLAYER_SELECTOR;

function fixMode() {
  const mode = configRead('previewFixMode');
  // Object.keys rather than Object.hasOwn, which needs Chrome 93.
  return Object.keys(previewFixModes).indexOf(mode) !== -1 ? mode : 'border';
}

/** The html classes yt-fixes.css keys the fixes on. */
function syncClasses() {
  const cl = document.documentElement.classList;
  const mode = legacy ? fixMode() : 'off';
  cl.toggle('ytaf-pfix-border', mode === 'border' || mode === 'both' || mode === 'resize_border');
  cl.toggle('ytaf-pfix-flatten', mode === 'flatten' || mode === 'both');
  cl.toggle('ytaf-pfix-resize', mode === 'resize' || mode === 'resize_border' || mode === 'fullscreen');
  cl.toggle('ytaf-pfix-fullscreen', mode === 'fullscreen');
  cl.toggle('ytaf-pfix-clear', mode === 'clear');
  if (!cl.contains('ytaf-pfix-flatten')) unflatten();
  if (!cl.contains('ytaf-pfix-clear')) unclear();
}

function previewVideo() {
  if (!isDiagPage()) return null;
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

// ---- clear ----------------------------------------------------------------

/**
 * Every element hit at (x, y), topmost first; pointer-events: none ones too,
 * as an overlay that ignores the remote still paints. Null where the browser
 * has no elementsFromPoint (Chrome 43; webOS 3 has 38).
 */
function stackAt(x, y) {
  if (typeof document.elementsFromPoint !== 'function') return null;
  const tmp = document.createElement('style');
  tmp.textContent = '*{pointer-events:auto!important}#ytaf-preview-diag,#ytaf-pfix-probe{pointer-events:none!important}';
  (document.head || document.documentElement).appendChild(tmp);
  try {
    return Array.prototype.slice.call(document.elementsFromPoint(x, y));
  } finally {
    tmp.parentNode.removeChild(tmp);
  }
}

/** The elements drawn over the middle of the video, topmost first. */
function coverOf(video) {
  const r = video.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return [];
  const stack = stackAt(r.left + r.width / 2, r.top + r.height / 2);
  if (!stack) return null;
  const out = [];
  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    if (el === video || el.contains(video)) break;
    if (el.id === 'ytaf-preview-diag' || el.id === 'ytaf-pfix-probe') continue;
    out.push(el);
  }
  return out;
}

function unclear() {
  for (let i = 0; i < cleared.length; i++) cleared[i].classList.remove(CLEAR_CLASS);
  cleared = [];
}

/** Clears what covers the playing preview; what stops covering it gets its looks back. */
function clearOver(video) {
  const cover = video && !video.paused ? coverOf(video) || [] : [];
  for (let i = 0; i < cleared.length; i++) {
    if (cover.indexOf(cleared[i]) === -1) cleared[i].classList.remove(CLEAR_CLASS);
  }
  for (let i = 0; i < cover.length; i++) cover[i].classList.add(CLEAR_CLASS);
  cleared = cover;
}

// ---- resize ---------------------------------------------------------------

let resizeStyle = null;
let resizeKey = '';
/** The player's own layout box and transform origin, measured unresized. */
let resizeBase = null;
let resizeInfo = 'off';
let observer = null;
let observed = null;
let probe = null;

const num = (v) => {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round(n * 100) / 100;

function setResizeRule(css) {
  if (!resizeStyle || !resizeStyle.parentNode) {
    if (!css) return;
    resizeStyle = document.createElement('style');
    resizeStyle.id = 'ytaf-pfix-resize-style';
    (document.head || document.documentElement).appendChild(resizeStyle);
  }
  if (resizeStyle.textContent !== css) resizeStyle.textContent = css;
}

function clearResize(info) {
  setResizeRule('');
  resizeKey = '';
  resizeBase = null;
  resizeInfo = info;
}

function observePlayer(player) {
  if (observed === player) return;
  if (!observer) {
    if (typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(updateResize);
  }
  observer.disconnect();
  observed = player;
  if (player) observer.observe(player, { attributes: true, attributeFilter: ['style'] });
}

/**
 * A transform as [a, b, c, d, e, f] and its origin in px, resolved the way the
 * player resolves them (percentages against a w x h box): the browser does
 * the parsing, on a hidden probe element, as the player's own computed
 * transform is ours.
 */
function resolveTransform(transform, origin, w, h) {
  if (!document.body) return null;
  if (!probe || !probe.parentNode) {
    probe = document.createElement('div');
    probe.id = 'ytaf-pfix-probe';
    probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(probe);
  }
  const ps = probe.style;
  ps.width = w + 'px';
  ps.height = h + 'px';
  ps.transform = transform;
  ps.transformOrigin = origin;
  if (ps.transform === '' && 'webkitTransform' in ps) {
    ps.webkitTransform = transform;
    ps.webkitTransformOrigin = origin;
  }
  const cs = window.getComputedStyle(probe);
  const o = (cs.transformOrigin || cs.webkitTransformOrigin || '0px 0px').split(' ');
  const value = cs.transform || cs.webkitTransform || 'none';
  let m = [1, 0, 0, 1, 0, 0];
  if (value !== 'none') {
    const parts = value.match(/^matrix(3d)?\(([^)]*)\)$/);
    if (!parts) return null;
    const v = parts[2].split(',').map(parseFloat);
    m = parts[1] ? [v[0], v[1], v[4], v[5], v[12], v[13]] : v;
  }
  return { m, ox: num(o[0]), oy: num(o[1]) };
}

/**
 * Mirrors YouTube's transform on the preview player as left/top/width/height
 * in a stylesheet (YouTube rewrites the player's style attribute), whenever
 * YouTube moves the player: on each change of its style attribute.
 */
function updateResize() {
  const active = legacy && document.documentElement.classList.contains('ytaf-pfix-resize') && isPreviewPage();
  if (!active) {
    observePlayer(null);
    if (resizeKey || resizeBase || resizeInfo !== 'off') clearResize('off');
    return;
  }
  const player = document.querySelector(PLAYER_SELECTOR);
  if (player !== observed) clearResize('new player');
  observePlayer(player);
  if (!player) {
    clearResize('no ' + PLAYER_SELECTOR);
    return;
  }
  const st = player.style;
  const transform = st.transform || st.webkitTransform || '';
  const key = [transform, st.left, st.top, st.width, st.height, st.transformOrigin, window.innerWidth, window.innerHeight].join('|');
  if (key === resizeKey && resizeStyle && resizeStyle.parentNode) return;
  if (!transform) {
    // Nothing of YouTube's to undo, or nothing this can read once undone.
    clearResize('player has no inline transform');
    return;
  }
  if (!resizeBase) {
    // The rule is empty here, so this is YouTube's own layout.
    const cs = window.getComputedStyle(player);
    const origin = (cs.transformOrigin || cs.webkitTransformOrigin || '0px 0px').split(' ');
    resizeBase = { w: player.offsetWidth, h: player.offsetHeight, ox: num(origin[0]), oy: num(origin[1]), pos: cs.position };
    if (!resizeBase.w || !resizeBase.h) {
      clearResize('player has no size');
      return;
    }
  }
  const b = resizeBase;
  const w = /px$/.test(st.width) ? num(st.width) : b.w;
  const h = /px$/.test(st.height) ? num(st.height) : b.h;
  // YouTube's own origin: inline if it sets one there, else the one measured.
  const t = resolveTransform(transform, st.transformOrigin || b.ox + 'px ' + b.oy + 'px', w, h);
  const m = t && t.m;
  if (!m || m.some((x) => !isFinite(x))) {
    clearResize('unreadable transform');
    return;
  }
  if (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) {
    clearResize('rotated transform');
    return;
  }
  // The transformed box: origin + scale * (point - origin) + translate. The
  // full screen test keeps the untransformed one.
  const full = document.documentElement.classList.contains('ytaf-pfix-fullscreen');
  const left = full ? num(st.left) : r2(num(st.left) + t.ox * (1 - m[0]) + m[4]);
  const top = full ? num(st.top) : r2(num(st.top) + t.oy * (1 - m[3]) + m[5]);
  const width = full ? w : r2(w * m[0]);
  const height = full ? h : r2(h * m[3]);
  setResizeRule(
    RESIZE_SCOPE + '{' +
      (b.pos === 'static' ? 'position:relative!important;' : '') +
      '-webkit-transform:none!important;transform:none!important;' +
      '-webkit-transition:none!important;transition:none!important;' +
      `left:${left}px!important;top:${top}px!important;width:${width}px!important;height:${height}px!important}` +
    RESIZE_SCOPE + ' video,' + RESIZE_SCOPE + ' .html5-video-container{' +
      `left:0!important;top:0!important;width:${width}px!important;height:${height}px!important}` +
    RESIZE_SCOPE + ' .html5-video-container{position:absolute!important}'
  );
  resizeKey = key;
  resizeInfo = (full ? 'full screen test: ' : '') + `${left},${top} ${width}x${height} (scale ${r2(m[0])}, origin ${r2(t.ox)},${r2(t.oy)}, base ${w}x${h})`;
}

// ---- diagnostics ----------------------------------------------------------

function describe(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => c && c !== FLAT_CLASS && c !== CLEAR_CLASS) : [];
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
  if (cs.boxShadow && cs.boxShadow !== 'none') out.push('shadow');
  if (cs.visibility !== 'visible') out.push(cs.visibility);
  if (cs.display === 'none') out.push('NONE');
  const bg = cs.backgroundColor;
  if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') out.push('bg:' + bg.replace(/\s/g, ''));
  if (cs.backgroundImage && cs.backgroundImage !== 'none') out.push('bgimg');
  return out.join(' ');
}

/**
 * Whether an element draws anything of its own over the video: a background
 * colour or image, a shadow, or image content. Text aside, these are what can
 * cover a punched-through video.
 */
function paints(el) {
  const tag = el.tagName.toUpperCase();
  if (tag === 'IMG' || tag === 'CANVAS' || tag === 'SVG') return true;
  const cs = window.getComputedStyle(el);
  const bg = cs.backgroundColor;
  if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)) return true;
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  return !!(cs.boxShadow && cs.boxShadow !== 'none');
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
  const player = document.querySelector(PLAYER_SELECTOR);
  const inlineTf = player ? player.style.transform || player.style.webkitTransform || '-' : 'no player';
  lines.push(`player inline tf: ${inlineTf.length > 60 ? inlineTf.slice(0, 59) + '~' : inlineTf}`);
  if (document.documentElement.classList.contains('ytaf-pfix-resize')) lines.push(`resize: ${resizeInfo}`);
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

  const cover = coverOf(video);
  if (cover) {
    // All of them, the ones that paint (marked *) first: only those can
    // cover the video.
    const painting = cover.filter(paints);
    const shown = painting.concat(cover.filter((el) => painting.indexOf(el) === -1));
    lines.push(
      `over the video at centre: ${cover.length || 'nothing'}` +
        (cover.length ? `, ${painting.length} painting (*)` : '') +
        (cleared.length ? ', cleared' : '')
    );
    for (let i = 0; i < shown.length && i < MAX_COVER; i++) {
      const mark = i < painting.length ? '* ' : '  ';
      lines.push(`${mark}${describe(shown[i])} ${rect(shown[i])} ${flags(shown[i])}`);
    }
    if (shown.length > MAX_COVER) lines.push(`  ...${shown.length - MAX_COVER} more`);
  } else {
    const r = video.getBoundingClientRect();
    const top = r.width > 0 ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    if (top) {
      let chain = describe(top);
      if (top.parentElement) chain += ' < ' + describe(top.parentElement);
      lines.push(`on top at centre: ${top === video ? 'the video' : chain}`);
      if (top !== video && !video.contains(top)) lines.push(`  ${rect(top)} ${flags(top)}`);
    }
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
      'position:fixed;top:8px;right:8px;max-width:64vw;max-height:calc(100vh - 16px);overflow:hidden;' +
      'padding:6px 8px;background:rgba(0,0,0,0.85);color:#fff;font:12px/1.3 monospace;white-space:pre-wrap;' +
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
  updateResize();
  if (!isDiagPage()) {
    unflatten();
    unclear();
    hideBox();
    return;
  }
  const video = isPreviewPage() ? previewVideo() : null;
  if (!isPreviewPage()) unclear();
  else if (document.documentElement.classList.contains('ytaf-pfix-clear')) clearOver(video);
  if (!isPreviewPage()) {
    unflatten();
  } else if (document.documentElement.classList.contains('ytaf-pfix-flatten')) {
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
  updateResize();
  const cl = document.documentElement.classList;
  const on = legacy && isDiagPage() &&
    (cl.contains('ytaf-pfix-flatten') || cl.contains('ytaf-pfix-resize') || cl.contains('ytaf-pfix-clear') ||
      !!configRead('previewDiagnostics'));
  if (on && !timer) {
    timer = setInterval(tick, TICK_MS);
    tick();
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
    unflatten();
    unclear();
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
