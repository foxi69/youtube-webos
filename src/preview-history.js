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
 * A preview opened with OK while Open Playing Previews Without Reloading is
 * on is not loaded again: the same playback (the same cpn) carries on full
 * screen, and its start ping, the playback one, was dropped. Without it
 * YouTube keeps none of that viewing: not in the history, the place to resume
 * from unchanged. So a preview's start ping is kept, by its cpn, and sent as
 * it came, once, just before the first ping of that cpn that goes out. Its
 * watchtime pings stay dropped: the time in the preview is no viewing; the
 * first one that goes out starts where the last dropped one ended. A preview
 * nobody opens never sends one that goes out: its start ping expires.
 *
 * On the TV they go out with fetch. XMLHttpRequest is covered for the engines
 * where the player has no fetch to use. Imported before adblock.js: Tracking
 * Block puts the XMLHttpRequest methods it found back when it is turned off,
 * and these have to be the ones it finds.
 */

const DEBUG = false;

const PING_PATH_RE = /\/api\/stats\/(playback|watchtime)$/;
const AUTOPLAY_RE = /[?&]autoplay=1(?:&|$)/;
// A watchtime request that reports several spans has one value for each.
const VIS_RE = /[?&]vis=5(?:(?:,|%2C)5)*(?:&|$)/i;
const CPN_RE = /[?&]cpn=([^&]+)/;

// A preview plays 40 s from its start ping (measured: 40.1 s to its last
// ping), and the first ping after OK comes at the player's next report, at
// most 30 s later (its reports come 10 s apart at first, then 30 s).
const KEEP_MS = 80000;
// The last few previews: a viewer opens one soon after moving past others.
const KEEP_MAX = 3;
/** Kept start pings: { cpn, at, url, send() }, oldest first. */
const kept = [];

/** 'playback' or 'watchtime' and the query of such a ping, or null. */
function pingOf(url) {
  const hash = url.indexOf('#');
  const full = hash === -1 ? url : url.slice(0, hash);
  const query = full.indexOf('?');
  const m = query === -1 ? null : PING_PATH_RE.exec(full.slice(0, query));
  return m ? { path: m[1], search: full.slice(query) } : null;
}

export function isPreviewPing(url) {
  if (isWatchPage() || isShortsPage()) return false;
  const ping = pingOf(url);
  return !!ping && AUTOPLAY_RE.test(ping.search) && VIS_RE.test(ping.search);
}

function cpnOf(url) {
  const ping = pingOf(url);
  const m = ping && CPN_RE.exec(ping.search);
  return m ? m[1] : null;
}

function dropExpired() {
  const now = Date.now();
  while (kept.length && now - kept[0].at > KEEP_MS) kept.shift();
}

/** Keeps a dropped start ping; `send` sends it as it came, once. */
function keepStart(url, send) {
  const ping = pingOf(url);
  const cpn = ping && ping.path === 'playback' ? cpnOf(url) : null;
  if (!cpn) return;
  dropExpired();
  takeStart(cpn);
  kept.push({ cpn, at: Date.now(), url, send });
  if (kept.length > KEEP_MAX) kept.shift();
}

/** The kept start ping of a ping that goes out, taken off the list. */
function takeStart(cpn) {
  dropExpired();
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].cpn === cpn) return kept.splice(i, 1)[0];
  }
  return null;
}

function urlOf(resource) {
  if (typeof resource === 'string') return resource;
  if (resource && typeof resource.url === 'string') return resource.url;
  return String(resource);
}

function log(what, via, url) {
  if (DEBUG || window.__ytaf_debug__) console.info('[PreviewHistory] ' + what + ' (' + via + '):', url);
}

const originalFetch = window.fetch;
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;

/** Sends a kept start ping; settles once it is answered or failed. */
function sendKept(start) {
  log('Sent a kept preview start ping', 'before the ping of its cpn', start.url);
  return start.send();
}

if (typeof originalFetch === 'function') {
  window.fetch = function (resource) {
    const url = urlOf(resource);
    // indexOf first: every other request of the app passes here too.
    if (url.indexOf('/api/stats/') === -1) return originalFetch.apply(this, arguments);
    if (isPreviewPing(url)) {
      log('Dropped a preview ping', 'fetch', url);
      const args = arguments;
      keepStart(url, () => originalFetch.apply(window, args));
      // What YouTube answers a ping with; nobody reads it.
      return Promise.resolve(typeof Response === 'function' ? new Response(null, { status: 204 }) : { ok: true, status: 204 });
    }
    const cpn = cpnOf(url);
    const start = cpn && takeStart(cpn);
    if (!start) return originalFetch.apply(this, arguments);
    const self = this;
    const args = arguments;
    const go = () => originalFetch.apply(self, args);
    return sendKept(start).then(go, go);
  };
}

XMLHttpRequest.prototype.open = function (method, url) {
  const urlStr = urlOf(url);
  const stats = urlStr.indexOf('/api/stats/') !== -1;
  this.__ytafPreviewPing = stats && isPreviewPing(urlStr) ? { method, url: urlStr } : null;
  this.__ytafStart = null;
  if (this.__ytafPreviewPing) {
    log('Dropped a preview ping', 'XHR', urlStr);
    // An empty data: URL instead of the ping, as Tracking Block does: the
    // caller still gets its load event.
    return originalOpen.call(this, 'GET', 'data:text/plain,', arguments.length > 2 ? arguments[2] : true);
  }
  const cpn = stats && cpnOf(urlStr);
  this.__ytafStart = cpn ? takeStart(cpn) : null;
  return originalOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function (body) {
  const preview = this.__ytafPreviewPing;
  if (preview) {
    keepStart(preview.url, () => new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.addEventListener('loadend', resolve);
      originalOpen.call(x, preview.method, preview.url, true);
      originalSend.call(x, body);
    }));
    return originalSend.call(this);
  }
  const start = this.__ytafStart;
  if (!start) return originalSend.apply(this, arguments);
  this.__ytafStart = null;
  const self = this;
  const args = arguments;
  const go = () => originalSend.apply(self, args);
  sendKept(start).then(go, go);
};
