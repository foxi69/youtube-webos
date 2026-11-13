// DeArrow's thumbnails, downloaded once and drawn as a 16:9 copy as wide as
// Max Thumbnail Quality makes the tiles around them (COPY_WIDTHS), as a blob
// URL (a data URL on webOS 3 and 4, where canvas has no toBlob), remembered
// with the video it belongs to. YouTube's own frames (hq1 to hq3, for Start,
// Middle and End) are used as they are, like the hqdefault YouTube's tiles
// already show: drawing them took up to 2 s while a TV started the app.
import { configRead } from '../config.js';
import {
  COPY_WIDTHS,
  DATA_URL_WIDTH,
  BLOB_BUDGET,
  DATA_URL_BUDGET,
  CACHE_LIMIT,
  IMAGE_TIMEOUT_MS,
  MAX_DRAWS
} from './constants.js';
import { diagDeArrow, diagId } from '../speed/diag.js';

// copy width + ' ' + source URL -> the copy's URL
const copies = new Map();
// copy's URL -> the video it shows
const thumbOwners = new Map();
// The same key -> the download in flight, so a settings change meanwhile does
// not make a second copy of the same image (only one would ever be revoked).
const loadingThumbs = new Map();
// What the kept copies weigh: blob bytes, or data URL characters.
let keptWeight = 0;
// Copies being drawn, and the ones waiting for their turn (MAX_DRAWS).
let drawing = 0;
const waitingDraws = [];

/** Runs `draw` (resolving with a copy) once fewer than MAX_DRAWS are being drawn; resolves with its copy. */
function whenDrawSlot(draw) {
  return new Promise((resolve) => {
    const start = () => {
      drawing++;
      draw().then((copy) => {
        drawing--;
        if (waitingDraws.length) waitingDraws.shift()();
        resolve(copy);
      });
    };
    if (drawing < MAX_DRAWS) start();
    else waitingDraws.push(start);
  });
}

/** Whether canvas can make blobs here (Chrome 50+); webOS 3 and 4 make data URLs. */
const canBlob = () =>
  typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.toBlob;

/** The video a copy shows, or undefined for any other URL (YouTube's frames name theirs in the path). */
export const thumbOwner = (url) => thumbOwners.get(url);

/** Whether `url` is one of YouTube's own frames, shown as it is. */
const isYouTubeFrame = (url) => url.indexOf('https://i.ytimg.com/') === 0;

/**
 * Whether the kept copies are at their limit: CACHE_LIMIT of them, or their
 * weight at BLOB_BUDGET (DATA_URL_BUDGET for data URLs, on webOS 3 and 4).
 */
export const thumbsFull = () =>
  copies.size >= CACHE_LIMIT || keptWeight >= (canBlob() ? BLOB_BUDGET : DATA_URL_BUDGET);

/**
 * How wide copies are drawn now: as wide as Max Thumbnail Quality's strategy
 * makes YouTube's tiles (COPY_WIDTHS), DATA_URL_WIDTH for data URLs.
 */
export function copyWidth() {
  if (!canBlob()) return DATA_URL_WIDTH;
  if (!configRead('upgradeThumbnails')) return COPY_WIDTHS.off;
  return COPY_WIDTHS[configRead('thumbnailQualityMode')] || COPY_WIDTHS.safe;
}

/**
 * Downloads `url` and resolves with a copy `width` wide (never wider than the
 * source), cropped to 16:9; null when the image does not load (the thumbnail
 * server answers 204 for a frame it has not rendered yet), takes longer than
 * IMAGE_TIMEOUT_MS, or cannot be drawn.
 */
function drawCopy(url, videoId, width, key) {
  return new Promise((resolve) => {
    let settled = false;
    // TEMPORARY (speed/diag.js): load and draw times.
    const startedAt = performance.now();
    let loadedAt = 0;
    let size = '';
    const img = new Image();
    /** Resolves once: the image's own outcome or the timeout, whichever comes first. */
    const done = (copy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(copy);
    };
    const timer = setTimeout(() => done(null), IMAGE_TIMEOUT_MS);
    img.crossOrigin = 'anonymous';
    /** Not loaded (204 for a frame not rendered yet, a network error): no copy. */
    img.onerror = () => done(null);
    /** Loaded: draws the copy. */
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      loadedAt = performance.now();
      if (!w || !h) {
        done(null);
        return;
      }
      /** Remembers the copy and its weight, if there is one, and resolves with it. */
      const finish = (copy, weight) => {
        diagDeArrow(`copy: id: ${diagId(videoId)}, load: ${Math.round(loadedAt - startedAt)}ms, ` +
          `draw: ${Math.round(performance.now() - loadedAt)}ms, size: ${size}, bytes: ${weight}, kept: ${!settled && !!copy}`);
        if (settled || !configRead('enableDeArrow')) {
          // Timed out while toBlob ran, or DeArrow switched off meanwhile:
          // nobody takes this copy, and it is not kept.
          if (copy && copy.indexOf('blob:') === 0) URL.revokeObjectURL(copy);
          if (!settled) done(null);
          return;
        }
        if (copy) {
          copies.set(key, copy);
          thumbOwners.set(copy, videoId);
          keptWeight += weight;
        }
        done(copy);
      };
      try {
        const cropW = Math.min(w, (h * 16) / 9);
        const cropH = (cropW * 9) / 16;
        const outW = Math.round(Math.min(width, cropW));
        const outH = Math.round((outW * 9) / 16);
        size = `${w}x${h} -> ${outW}x${outH}`;
        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        canvas
          .getContext('2d')
          .drawImage(img, (w - cropW) / 2, (h - cropH) / 2, cropW, cropH, 0, 0, outW, outH);
        if (canvas.toBlob) {
          canvas.toBlob(
            (blob) => finish(blob ? URL.createObjectURL(blob) : null, blob ? blob.size : 0),
            'image/jpeg',
            0.85
          );
        } else {
          // toBlob is Chrome 50+. Two videos with the same frame would share a
          // data URL, so the copy carries its video in the fragment.
          const copy = canvas.toDataURL('image/jpeg', 0.85) + '#videoID=' + videoId;
          finish(copy, copy.length);
        }
      } catch {
        // A tainted canvas or no memory: YouTube's thumbnail stays.
        finish(null, 0);
      }
    };
    img.src = url;
  });
}

/**
 * Resolves with YouTube's frame `url` itself once it is known to exist, kept
 * under `key`; null when it does not load or is YouTube's grey 120 x 90
 * placeholder (the 404 body for a frame a live stream or a new upload does
 * not have, which an image loads like any other picture).
 */
function checkFrame(url, videoId, key) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const img = new Image();
    let timer = null;
    /** Resolves once: the image's own outcome or the timeout, whichever comes first. */
    const done = (frame) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      if (frame) copies.set(key, frame);
      diagDeArrow(`copy: id: ${diagId(videoId)}, load: ${Math.round(performance.now() - startedAt)}ms, ` +
        `draw: none, size: ${img.naturalWidth}x${img.naturalHeight}, kept: ${!!frame}`);
      resolve(frame);
    };
    timer = setTimeout(() => done(null), IMAGE_TIMEOUT_MS);
    img.onerror = () => done(null);
    img.onload = () => {
      const placeholder = img.naturalWidth === 120 && img.naturalHeight === 90;
      done(img.naturalWidth && !placeholder ? url : null);
    };
    img.src = url;
  });
}

/**
 * The thumbnail for `url` (`videoId`'s): YouTube's frame itself, or a copy at
 * the current width; the one kept, the download in flight, or a new one.
 */
export function loadThumb(url, videoId) {
  const frame = isYouTubeFrame(url);
  const width = copyWidth();
  const key = frame ? url : width + ' ' + url;
  const cached = copies.get(key);
  if (cached) return Promise.resolve(cached);
  let loading = loadingThumbs.get(key);
  if (!loading) {
    loading = frame ? checkFrame(url, videoId, key) : whenDrawSlot(() => drawCopy(url, videoId, width, key));
    loadingThumbs.set(key, loading);
    loading.then(() => loadingThumbs.delete(key));
  }
  return loading;
}

/** Drops every copy, freeing the blobs. */
export function forgetThumbs() {
  copies.forEach((copy) => {
    if (copy.indexOf('blob:') === 0) URL.revokeObjectURL(copy);
  });
  copies.clear();
  thumbOwners.clear();
  keptWeight = 0;
}
