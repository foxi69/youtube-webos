// TEMPORARY diagnostics for a speed change on a real TV: what the player
// reports for subtitles and quality before, during and after the reload, what
// this app asks of it, and what YouTube writes to localStorage meanwhile.
// Everything goes to the console as "[SpeedDiag] +<ms> ..."; remove this file
// and its calls once the cause is found.

const PREFIX = '[SpeedDiag]';
const ON = typeof window !== 'undefined';
const STORAGE_KEY_RE = /quality|caption|subtitle|sticky|module/i;
const watchedKey = (key) => STORAGE_KEY_RE.test(key) && String(key).indexOf('ytaf-thumb') !== 0;
const METHOD_RE = /quality|caption|subtitle|option|preferred|module|track/i;
const WATCH_MS = 500;
const WATCH_TICKS = 40; // 20 s

let base = Date.now();
let watchTimer = null;
let methodsLogged = false;

const cut = (s, n = 300) => (s.length > n ? s.slice(0, n) + '...' : s);

/** Starts a new timeline: later lines show the milliseconds since. */
export function diagMark() {
  base = Date.now();
}

export function diag(msg) {
  if (ON) console.info(`${PREFIX} +${Date.now() - base}ms ${msg}`);
}

/** A captions track in one line. */
export function describeTrack(t) {
  if (t === null || t === undefined || typeof t !== 'object') return String(t);
  return JSON.stringify({
    languageCode: t.languageCode,
    vss_id: t.vss_id,
    vssId: t.vssId,
    kind: t.kind,
    translation: t.translationLanguage && t.translationLanguage.languageCode,
    keys: Object.keys(t).slice(0, 15)
  });
}

/** What getOption('captions', 'track') answers now, or the error it throws. */
export function captionsInfo(player) {
  try {
    return describeTrack(player.getOption('captions', 'track'));
  } catch (e) {
    return 'error: ' + (e && e.message);
  }
}

function call(player, name) {
  try {
    return typeof player[name] === 'function' ? JSON.stringify(player[name]()) : 'absent';
  } catch (e) {
    return 'error: ' + (e && e.message);
  }
}

/** The quality the player reports, with every quality getter it has. */
export function qualityInfo(player) {
  return `quality: ${call(player, 'getPlaybackQuality')}, label: ${call(player, 'getPlaybackQualityLabel')}, ` +
    `available: ${call(player, 'getAvailableQualityLevels')}, preferred: ${call(player, 'getPreferredQuality')}, ` +
    `range: ${call(player, 'getPlaybackQualityRange')}`;
}

/** The localStorage entries that may hold subtitles or quality choices. */
export function storageInfo() {
  const out = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (watchedKey(key)) out.push(`${key}: ${cut(String(window.localStorage.getItem(key)))}`);
    }
  } catch (e) {
    out.push('error: ' + (e && e.message));
  }
  return out.join(' | ') || 'none';
}

/** Once: the player's methods about quality, captions and options. */
export function logPlayerMethods(player) {
  if (!ON || methodsLogged || !player) return;
  methodsLogged = true;
  const names = new Set();
  for (let o = player; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const name of Object.getOwnPropertyNames(o)) {
      try {
        if (METHOD_RE.test(name) && typeof player[name] === 'function') names.add(name);
      } catch { /* a getter that throws */ }
    }
  }
  diag(`player methods: ${Array.from(names).sort().join(', ')}`);
  try {
    const all = [];
    for (let i = 0; i < window.localStorage.length; i++) all.push(window.localStorage.key(i));
    diag(`localStorage keys: ${all.join(', ')}`);
  } catch { /* no storage */ }
}

/** For 20 s after a reload, every change of state, subtitles or quality. */
export function watchAfterReload(player) {
  if (!ON) return;
  clearInterval(watchTimer);
  let last = '';
  let ticks = 0;
  watchTimer = setInterval(() => {
    const state = call(player, 'getPlayerState');
    const line = `state: ${state}, captions: ${captionsInfo(player)}, ${qualityInfo(player)}`;
    if (line !== last) diag('watch: ' + line);
    last = line;
    if (++ticks >= WATCH_TICKS) {
      clearInterval(watchTimer);
      watchTimer = null;
      diag('watch: done');
    }
  }, WATCH_MS);
}


// DeArrow: when each step of a lookup starts and ends, on one clock from page
// load (no timeline reset), so the queue and the stages can be read off.
export function diagDeArrow(msg) {
  if (ON) console.info(`[DeArrowDiag] @${Math.round(performance.now())}ms ${msg}`);
}

// Video id -> its tag in this session's log.
const diagIds = new Map();

/**
 * A video id as a tag numbered in the order first seen (v1, v2...): the same
 * through every step of a session, with nothing in it that names the video.
 */
export function diagId(id) {
  let tag = diagIds.get(id);
  if (!tag) {
    tag = 'v' + (diagIds.size + 1);
    diagIds.set(id, tag);
  }
  return tag;
}
