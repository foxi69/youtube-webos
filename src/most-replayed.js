import { configRead, configAddChangeListener } from './config.js';
import { isWatchPage, getVideo, SELECTORS } from './utils.js';
import { getHeatmap, buildHeatmapUri } from './heatmap-data.js';

/**
 * Most Replayed Graph: YouTube's "most replayed" curve just above the seek
 * bar, whenever the controls are on screen (NicholasBly/youtube-webos#211).
 * The data comes from heatmap-data.js.
 *
 * Like time-remaining.js it is drawn by one <style>: a pseudo-element on the
 * seek bar with the graph as an SVG background, as a node added to YouTube's
 * controls would be deleted by incremental-dom. The pseudo-element lives in
 * the bar, so it hides and shows with it. Only the geometry is measured here:
 * the graph sits right above the track (the bar's inner line), which may be
 * narrower than the bar and moves when the bar is focused.
 *
 * The geometry is checked four times a second, and only on the watch page
 * while the controls are up; the stylesheet is rewritten only when something
 * changed. Nothing is shown for a video without a heatmap.
 */

const HOST_SELECTORS = ['ytlr-multi-markers-player-bar-renderer', 'ytlr-progress-bar'];
const TRACK_SELECTORS = ['[idomkey="progress-bar"]', '[idomkey="slider"]', '.ytLrProgressBarSliderBase'];
const TICK_MS = 250;
// Height of the graph, as a share of the screen height (38px at 1080p), and
// the gap between it and the track.
const HEIGHT_VH = 0.035;
const GAP_PX = 4;

let styleEl = null;
let css = '';
let timer = null;
let videoId = '';
let uri = '';
let lookupId = '';

function write(next) {
  if (next === css && (!next || (styleEl && styleEl.isConnected))) return;
  css = next;
  if (!styleEl || !styleEl.isConnected) {
    if (!next) return;
    styleEl = document.createElement('style');
    styleEl.id = 'ytaf-most-replayed';
    (document.head || document.documentElement).appendChild(styleEl);
  }
  styleEl.textContent = next;
}

function currentVideoId() {
  try {
    const data = document.getElementById(SELECTORS.PLAYER_ID)?.getVideoData?.();
    if (!data || data.isLive) return '';
    return typeof data.video_id === 'string' ? data.video_id : '';
  } catch {
    return '';
  }
}

function findHost() {
  for (let i = 0; i < HOST_SELECTORS.length; i++) {
    const el = document.querySelector(HOST_SELECTORS[i]);
    if (el) return { el, selector: HOST_SELECTORS[i] };
  }
  return null;
}

function findTrack(host) {
  for (let i = 0; i < TRACK_SELECTORS.length; i++) {
    const el = host.querySelector(TRACK_SELECTORS[i]);
    if (el) return el;
  }
  return host;
}

/**
 * The rule that draws `graphUri` above the track. `geo` is the track's box
 * relative to the host's: { left, top, width }, in px. `hostStyle` holds the
 * host's computed position and display, so that only a static or inline host
 * is changed (making a positioned bar relative would move it).
 */
export function buildCss(selector, graphUri, geo, height, hostStyle) {
  if (!graphUri || !geo || !(geo.width > 0) || !(height > 0)) return '';
  let host = '';
  if (hostStyle && hostStyle.position === 'static') host += 'position:relative!important;';
  if (hostStyle && hostStyle.display === 'inline') host += 'display:block!important;';
  return (host ? `${selector}{${host}}` : '') +
    `${selector}::after{content:'';position:absolute;` +
    `left:${geo.left}px;top:${geo.top - height - GAP_PX}px;width:${geo.width}px;height:${height}px;` +
    `background:url("${graphUri}") no-repeat;background-size:100% 100%;` +
    'pointer-events:none;z-index:1;}';
}

let lastSig = '';

function draw() {
  if (!uri) {
    lastSig = '';
    write('');
    return;
  }
  const host = findHost();
  if (!host) return;
  // Hidden controls: leave the rule as it is, it hides with the bar.
  if (host.el.classList.contains('zylon-hidden') || host.el.style.opacity === '0') return;

  const track = findTrack(host.el);
  const hr = host.el.getBoundingClientRect();
  const tr = track.getBoundingClientRect();
  if (!(tr.width > 0)) return;
  const geo = {
    left: Math.round(tr.left - hr.left),
    top: Math.round(tr.top - hr.top),
    width: Math.round(tr.width)
  };
  const height = Math.max(16, Math.round(window.innerHeight * HEIGHT_VH));
  const sig = `${host.selector}|${geo.left}|${geo.top}|${geo.width}|${height}|${uri.length}`;
  if (sig === lastSig && css) return;
  lastSig = sig;
  const cs = window.getComputedStyle(host.el);
  write(buildCss(host.selector, uri, geo, height, { position: cs.position, display: cs.display }));
}

function tick() {
  const id = currentVideoId();
  if (id !== videoId) {
    videoId = id;
    uri = '';
    lastSig = '';
    write('');
    if (id) {
      lookupId = id;
      getHeatmap(id).then((markers) => {
        if (lookupId !== id || videoId !== id || !timer) return;
        const video = getVideo();
        const duration = video && isFinite(video.duration) ? video.duration : 0;
        uri = markers ? buildHeatmapUri(markers, duration) : '';
        draw();
      });
    }
    return;
  }
  draw();
}

function sync() {
  const on = !!configRead('showMostReplayed') && isWatchPage();
  if (on && !timer) {
    timer = setInterval(tick, TICK_MS);
    tick();
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
    videoId = '';
    lookupId = '';
    uri = '';
    lastSig = '';
    write('');
  }
}

window.addEventListener('ytaf-page-update', sync);
configAddChangeListener('showMostReplayed', sync);
sync();
