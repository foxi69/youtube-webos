import { isWatchPage, isShortsPage } from './utils.js';

/**
 * Tile previews stay out of the watch history.
 *
 * A preview that plays on a focused tile (Home, search, Subscriptions) sends
 * the same two requests as a watched video, '/api/stats/playback' and
 * '/api/stats/watchtime', and after about 10 s of it YouTube takes the video
 * into the watch history, or moves an entry it already has to the top. These
 * are dropped here. No setting, like the preview that opened by itself.
 *
 * A ping is a preview's only when both hold; a watched video's must never be
 * dropped, so in doubt it goes out:
 *  - the page is not the watch or the Shorts page, and
 *  - its URL has both autoplay=1 and vis=5.
 * Measured on webOS 25: a preview's pings carry both; a watched video's carry
 * neither, also the last one (final=1), which goes out when the page is Home
 * again; a video that autoplay started carries autoplay=1 only. A preview
 * opened with OK sends a watched video's pings from then on.
 *
 * On the TV they go out with fetch. XMLHttpRequest is covered for the engines
 * where the player has no fetch to use. Imported before adblock.js: Tracking
 * Block puts the XMLHttpRequest methods it found back when it is turned off,
 * and these have to be the ones it finds.
 */

const DEBUG = false;

const PING_PATH_RE = /\/api\/stats\/(?:playback|watchtime)$/;
const AUTOPLAY_RE = /[?&]autoplay=1(?:&|$)/;
// A watchtime request that reports several spans has one value for each.
const VIS_RE = /[?&]vis=5(?:(?:,|%2C)5)*(?:&|$)/i;

export function isPreviewPing(url) {
  if (isWatchPage() || isShortsPage()) return false;
  const hash = url.indexOf('#');
  const full = hash === -1 ? url : url.slice(0, hash);
  const query = full.indexOf('?');
  if (query === -1 || !PING_PATH_RE.test(full.slice(0, query))) return false;
  const search = full.slice(query);
  return AUTOPLAY_RE.test(search) && VIS_RE.test(search);
}

function urlOf(resource) {
  if (typeof resource === 'string') return resource;
  if (resource && typeof resource.url === 'string') return resource.url;
  return String(resource);
}

function dropped(via, url) {
  if (DEBUG || window.__ytaf_debug__) console.info('[PreviewHistory] Dropped a preview ping (' + via + '):', url);
}

const originalFetch = window.fetch;
if (typeof originalFetch === 'function') {
  window.fetch = function (resource) {
    const url = urlOf(resource);
    // indexOf first: every other request of the app passes here too.
    if (url.indexOf('/api/stats/') !== -1 && isPreviewPing(url)) {
      dropped('fetch', url);
      // What YouTube answers a ping with; nobody reads it.
      return Promise.resolve(typeof Response === 'function' ? new Response(null, { status: 204 }) : { ok: true, status: 204 });
    }
    return originalFetch.apply(this, arguments);
  };
}

const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url) {
  const urlStr = urlOf(url);
  this.__ytafPreviewPing = urlStr.indexOf('/api/stats/') !== -1 && isPreviewPing(urlStr);
  if (this.__ytafPreviewPing) {
    dropped('XHR', urlStr);
    // An empty data: URL instead of the ping, as Tracking Block does: the
    // caller still gets its load event.
    return originalOpen.call(this, 'GET', 'data:text/plain,', arguments.length > 2 ? arguments[2] : true);
  }
  return originalOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function () {
  if (this.__ytafPreviewPing) return originalSend.call(this);
  return originalSend.apply(this, arguments);
};
