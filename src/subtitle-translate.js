import { configRead } from './config.js';
import { SELECTORS, SYNTHETIC_KEY_FLAG, isShortsPage, isWatchPage } from './utils.js';

/**
 * Auto-translated subtitles in a language of the viewer's choosing.
 *
 * The TV (leanback) client gets a truncated `translationLanguages` list in the
 * /player response - about 16 entries where the web client gets about 125 - so
 * most languages (Hungarian, Serbian, Czech, ...) never appear in the TV's
 * Auto-translate menu, and on many videos there is no translated track to
 * pick at all.
 *
 * The translation itself is done server side: YouTube's timedtext endpoint
 * machine-translates any translatable track when the request carries
 * `&tlang=<code>`, whichever client asked for the track. So two edits to the
 * /player response are enough:
 *
 *   1. The chosen language is added to `translationLanguages` (pinned to the
 *      top, so it is not a hundred presses away on a remote), and ASR tracks
 *      the TV client forgot to flag as translatable are flagged.
 *   2. When the video has no track in that language, a ready-made
 *      "<Language> (auto-translated)" track is added: a copy of an existing
 *      track's baseUrl (auth/signature params kept) with `tlang` set. It is
 *      registered on every audio track, because the captions menu is built
 *      from `captionTrackIndices`, not from `captionTracks` directly.
 *
 * Ported and generalised from the forks of DavidVodus (English), relianceai
 * (Serbian) and ZUI-WebOS (Turkish).
 */

export const subtitleTranslateLanguages = {
  off: 'Off',
  hu: 'Magyar (Hungarian)',
  en: 'English',
  de: 'Deutsch (German)',
  es: 'Español (Spanish)',
  fr: 'Français (French)',
  it: 'Italiano (Italian)',
  pt: 'Português (Portuguese)',
  nl: 'Nederlands (Dutch)',
  pl: 'Polski (Polish)',
  cs: 'Čeština (Czech)',
  sk: 'Slovenčina (Slovak)',
  ro: 'Română (Romanian)',
  hr: 'Hrvatski (Croatian)',
  sr: 'Српски (Serbian)',
  sl: 'Slovenščina (Slovenian)',
  bg: 'Български (Bulgarian)',
  el: 'Ελληνικά (Greek)',
  tr: 'Türkçe (Turkish)',
  uk: 'Українська (Ukrainian)',
  ru: 'Русский (Russian)',
  sv: 'Svenska (Swedish)',
  da: 'Dansk (Danish)',
  fi: 'Suomi (Finnish)',
  no: 'Norsk (Norwegian)',
  ar: 'العربية (Arabic)',
  hi: 'हिन्दी (Hindi)',
  id: 'Bahasa Indonesia',
  vi: 'Tiếng Việt (Vietnamese)',
  th: 'ไทย (Thai)',
  ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)',
  'zh-Hans': '中文 简体 (Chinese, Simplified)'
};

const LOG_PREFIX = '[SubtitleTranslate]';
const DEBUG = false;

/** Display name for the injected entries, in the language itself. */
function nativeName(code) {
  const label = subtitleTranslateLanguages[code] || code;
  const paren = label.indexOf(' (');
  return paren === -1 ? label : label.slice(0, paren);
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `en` matches `en`, `en-GB`, `en-US`...; `zh-Hans` matches only itself. */
function sameLanguage(code, target) {
  if (typeof code !== 'string') return false;
  const a = code.toLowerCase();
  const b = target.toLowerCase();
  return a === b || (b.indexOf('-') === -1 && a.split('-')[0] === b);
}

/**
 * YouTube renders names either as `{ simpleText }` or `{ runs: [{ text }] }`
 * depending on client and version; mirror whatever shape it already sent.
 */
function makeName(template, text) {
  if (isObject(template) && Array.isArray(template.runs)) return { runs: [{ text }] };
  return { simpleText: text };
}

function withTlang(baseUrl, code) {
  if (typeof baseUrl !== 'string') return null;
  try {
    const url = new URL(baseUrl, document.location.href);
    url.searchParams.set('tlang', code);
    return url.toString();
  } catch {
    // URL with no usable constructor (very old engines): append by hand.
    if (/[?&]tlang=/.test(baseUrl)) return baseUrl.replace(/([?&]tlang=)[^&]*/, '$1' + encodeURIComponent(code));
    return baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + 'tlang=' + encodeURIComponent(code);
  }
}

function addTranslationLanguage(renderer, code) {
  const list = renderer.translationLanguages;
  // No list means nothing on this video is translatable; an entry would be a
  // dead option.
  if (!Array.isArray(list) || list.length === 0) return;

  let index = -1;
  for (let i = 0; i < list.length; i++) {
    if (isObject(list[i]) && list[i].languageCode === code) { index = i; break; }
  }

  let entry;
  if (index === -1) {
    entry = { languageCode: code, languageName: makeName(isObject(list[0]) ? list[0].languageName : null, nativeName(code)) };
  } else {
    entry = list.splice(index, 1)[0];
  }
  list.unshift(entry);
}

function addTranslatedTrack(renderer, code) {
  const tracks = renderer.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return;

  for (let i = 0; i < tracks.length; i++) {
    if (isObject(tracks[i]) && sameLanguage(tracks[i].languageCode, code)) return; // already offered
  }

  // Prefer a human-made track as the source: machine-translating machine
  // transcription compounds the errors.
  let source = null;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!isObject(t) || typeof t.baseUrl !== 'string' || t.isTranslatable === false) continue;
    if (t.kind !== 'asr') { source = t; break; }
    if (!source) source = t;
  }
  if (!source) return;

  const baseUrl = withTlang(source.baseUrl, code);
  if (!baseUrl) return;

  const label = `${nativeName(code)} (auto-translated)`;
  // A clean track rather than a copy of the source: copying would drag along
  // wrong fields (rtl from an Arabic source, kind: 'asr'). A distinct vssId and
  // languageCode keep the menu from folding it into the source as a duplicate.
  const newIndex = tracks.push({
    baseUrl,
    name: makeName(source.name, label),
    vssId: `.${code}`,
    languageCode: code,
    isTranslatable: false,
    trackName: label
  }) - 1;

  const audioTracks = renderer.audioTracks;
  if (Array.isArray(audioTracks)) {
    for (const at of audioTracks) {
      if (isObject(at) && Array.isArray(at.captionTrackIndices) && at.captionTrackIndices.indexOf(newIndex) === -1) {
        at.captionTrackIndices.push(newIndex);
      }
    }
  }
  if (DEBUG) console.info(LOG_PREFIX, 'Added translated track', code, 'from', source.languageCode);
}

function patchRenderer(renderer, code) {
  const tracks = renderer.captionTracks;
  if (Array.isArray(tracks)) {
    for (const t of tracks) {
      // ASR tracks are always translatable server side; the TV client
      // sometimes omits the flag, which hides the Auto-translate menu.
      if (isObject(t) && t.kind === 'asr' && t.isTranslatable !== true) t.isTranslatable = true;
    }
  }
  addTranslationLanguage(renderer, code);
  addTranslatedTrack(renderer, code);
}

/**
 * The track to turn on for `code`: a human-made one first, then YouTube's
 * own speech recognition in that language. The injected auto-translated
 * track is a plain (non-ASR) track in that language, so it is found here too;
 * it only exists when the video had no track in the language to begin with.
 */
function pickTrack(list, code) {
  if (!Array.isArray(list)) return null;
  let asr = null;
  for (const t of list) {
    if (!isObject(t) || isObject(t.translationLanguage) || !sameLanguage(t.languageCode, code)) continue;
    if (t.kind !== 'asr') return t;
    if (!asr) asr = t;
  }
  return asr;
}

// The response's view of the target track, per video, for a player whose
// captions API answers with no tracklist (see autoEnableCaptions below).
const RESPONSE_TRACKS_MAX = 20;
const responseTracks = [];

function rememberResponseTrack(videoId, track) {
  if (typeof videoId !== 'string' || !videoId) return;
  for (let i = 0; i < responseTracks.length; i++) {
    if (responseTracks[i].videoId === videoId) { responseTracks.splice(i, 1); break; }
  }
  if (!track) return;
  responseTracks.push({ videoId, languageCode: track.languageCode, kind: track.kind, vssId: track.vssId });
  if (responseTracks.length > RESPONSE_TRACKS_MAX) responseTracks.shift();
}

function responseTrack(videoId) {
  for (let i = 0; i < responseTracks.length; i++) {
    if (responseTracks[i].videoId === videoId) return responseTracks[i];
  }
  return null;
}

function patchResponse(res, code) {
  const containers = [res, res.playerResponse];
  for (const c of containers) {
    if (!isObject(c) || !isObject(c.captions)) continue;
    const renderer = c.captions.playerCaptionsTracklistRenderer;
    if (!isObject(renderer)) continue;
    patchRenderer(renderer, code);
    const target = pickTrack(renderer.captionTracks, code);
    const videoId = isObject(c.videoDetails) ? c.videoDetails.videoId : null;
    if (configRead('subtitlesAtStart') === 'translated') startWith(renderer, isOpenedVideo(videoId) ? target : null);
    if (videoId) rememberResponseTrack(videoId, target);
  }
}

/**
 * The video opened on the watch page, not a tile preview, a Short or the video
 * loading behind "Who's watching": those must not start with subtitles.
 */
function isOpenedVideo(videoId) {
  if (typeof videoId !== 'string' || !videoId || isShortsPage()) return false;
  if (document.body && /ACCOUNT_SELECTOR/.test(document.body.className)) return false;
  const m = /^#\/watch\b.*[?&]v=([\w-]{11})/.exec(location.hash);
  return !!m && m[1] === videoId;
}

// The player's own memory of subtitles being on. Without it, it leaves even a
// default track off as the video loads, and only the app's decision a second
// later turns it on. It sets this itself once any track is on.
const CAPTIONS_REMEMBERED_KEY = 'yt-html5-player-modules::subtitlesModuleData::module-enabled';

/**
 * Translated. For the opened video, the target track becomes the default,
 * turned on from the start: the player puts it on as the video loads and the
 * app's own start-up decision a second later keeps it, so the subtitles are
 * there from the first line and never go off and on. Any other response, or
 * none in the language: YouTube's own default goes and subtitles start off
 * (the attempt below then turns on the target, if there is one).
 */
function startWith(renderer, target) {
  const index = target && Array.isArray(renderer.captionTracks) ? renderer.captionTracks.indexOf(target) : -1;
  if (!Array.isArray(renderer.audioTracks)) return;
  for (const at of renderer.audioTracks) {
    if (!isObject(at)) continue;
    if (index >= 0) {
      at.defaultCaptionTrackIndex = index;
      at.captionsInitialState = 'CAPTIONS_INITIAL_STATE_ON_REQUIRED';
    } else {
      delete at.defaultCaptionTrackIndex;
      at.captionsInitialState = 'CAPTIONS_INITIAL_STATE_OFF_RECOMMENDED';
    }
  }
  if (index >= 0) {
    try {
      localStorage.setItem(CAPTIONS_REMEMBERED_KEY, 'true');
    } catch { /* the app's decision turns it on a second later */ }
  }
}

function currentTarget() {
  const code = configRead('subtitleTranslateLang');
  return code && code !== 'off' && subtitleTranslateLanguages[code] ? code : null;
}

// Installed once and gated internally, like force-codec.js: unwinding a
// JSON.parse wrapper after other modules have stacked theirs would drop them.
const origParse = JSON.parse;
JSON.parse = function (text, reviver) {
  const out = origParse.call(this, text, reviver);
  // A /player response is tens of kilobytes; the small blobs YouTube parses
  // constantly never get past the first check.
  if (typeof text !== 'string' || text.length < 1000 || !out || typeof out !== 'object') return out;
  if (!out.captions && !(out.playerResponse && out.playerResponse.captions)) return out;
  const code = currentTarget();
  if (!code) return out;
  try {
    patchResponse(out, code);
  } catch (err) {
    // Never let a caption edge case break playback.
    console.warn(LOG_PREFIX, 'Failed to patch captions:', err);
  }
  return out;
};

/**
 * Subtitles When a Video Starts: Translated.
 *
 * When a video starts playing, captions are switched to the chosen language
 * through the player's own API: a native track in that language if the video
 * has one, otherwise the auto-translated track added above. Restraint is the
 * point, both for the viewer and for YouTube's timedtext endpoint (every track
 * switch is a request, and a burst earns HTTP 429):
 *
 *   - one attempt per viewing of a video (until another video plays or the
 *     watch page is left), plus at most one re-apply when the player resets
 *     the track on its own within a few seconds (it does that while the
 *     captions module settles);
 *   - any key the viewer presses ends it for that video, so captions turned
 *     off (or another language picked) by hand stay that way;
 *   - no player API, no tracklist in the language: nothing happens.
 */
const STATE_PLAYING = 1;
const TRACKLIST_POLL_MS = 300;
const TRACKLIST_TRIES = 10; // ~3 s for the captions module to list its tracks
const REAPPLY_WINDOW_MS = 5000;
const REAPPLY_POLL_MS = 500;
// The TV app sets its own start-up subtitles 1 s after the player reports
// onPlaybackStartExternal (off, unless YouTube wants them on). Turned on
// before that, the subtitles showed for a second, went off and came back with
// the re-apply: so the attempt waits for that decision, or, when the event
// never comes, for a while after PLAYING.
const APP_DECISION_MS = 1150;
const NO_START_EVENT_MS = 2500;

// The video this viewing's one attempt was made for. Kept for the viewing
// only: remembered for the whole session, a video watched again later got no
// subtitles (YouTube's own are dropped with Translated and a language).
let attemptedVideoId = null;
let lastUserKeyAt = 0;
let autoTimer = null;
let startTimer = null;
let startSince = 0;
let startVideoId = null;
let externalStartAt = 0;
// Off: the video the app's start-up decision was checked for.
let offVideoId = null;
const hookedPlayers = new WeakSet();

function cancelAutoEnable() {
  if (autoTimer !== null) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
}

function cancelStart() {
  if (startTimer !== null) {
    clearTimeout(startTimer);
    startTimer = null;
  }
}

/**
 * Runs the start-up handling after `delay`. A key pressed since the first call
 * for this video still ends it; one for the video before (Next) does not.
 */
function scheduleAutoEnable(delay) {
  const player = captionsPlayer();
  const videoId = player && playerVideoId(player);
  if (startTimer === null || videoId !== startVideoId) startSince = Date.now();
  startVideoId = videoId;
  clearTimeout(startTimer);
  startTimer = setTimeout(() => {
    startTimer = null;
    if (configRead('subtitlesAtStart') === 'off') enforceOff(startSince);
    else autoEnableCaptions(startSince);
  }, delay);
}

/**
 * Off, after the app's start-up decision: it turns subtitles on when YouTube
 * wants them, or when they were turned on earlier in the session. Kept off for
 * a few seconds (the app may wait for the tracklist), unless a key is pressed.
 */
function enforceOff(since) {
  if (isShortsPage() || !isWatchPage()) return;
  const player = captionsPlayer();
  if (!player) return;
  const videoId = playerVideoId(player);
  if (!videoId || videoId === offVideoId) return;
  offVideoId = videoId;
  cancelAutoEnable();
  const check = () => {
    autoTimer = null;
    if (lastUserKeyAt > since || !player.isConnected || playerVideoId(player) !== videoId) return;
    const track = captionsOption(player, 'track');
    if (isObject(track) && track.languageCode) setCaptionsTrack(player, {});
    if (Date.now() - since < REAPPLY_WINDOW_MS) autoTimer = setTimeout(check, REAPPLY_POLL_MS);
  };
  check();
}

// YouTube's own track, put on when the player remembers subtitles being on,
// showed until the app's decision (or ours): with Off, or Translated and a
// language, it goes at once. One already in the language too: the app turns
// it off a second later and the attempt turns it on again, a blink in the
// middle of the first line. Once per video, so one picked by hand stays.
let checkedVideoId = null;

function dropYouTubeTrack(player) {
  const mode = configRead('subtitlesAtStart');
  const code = mode === 'translated' ? currentTarget() : null;
  if ((mode !== 'off' && !code) || isShortsPage() || !isWatchPage()) return;
  const videoId = playerVideoId(player);
  if (!videoId || videoId === checkedVideoId) return;
  checkedVideoId = videoId;
  const track = captionsOption(player, 'track');
  if (isObject(track) && track.languageCode && !(code && isTargetTrack(track, code))) setCaptionsTrack(player, {});
}

function onPlaying() {
  const player = captionsPlayer();
  if (player) dropYouTubeTrack(player);
  const mode = configRead('subtitlesAtStart');
  if (mode !== 'translated' && mode !== 'off') return;
  if (player && !hookedPlayers.has(player) && typeof player.addEventListener === 'function') {
    hookedPlayers.add(player);
    try {
      player.addEventListener('onPlaybackStartExternal', () => {
        externalStartAt = Date.now();
        scheduleAutoEnable(APP_DECISION_MS);
      });
    } catch { /* NO_START_EVENT_MS covers it */ }
  }
  // PLAYING comes just before onPlaybackStartExternal, which then sets the time.
  const sinceStart = Date.now() - externalStartAt;
  scheduleAutoEnable(sinceStart < APP_DECISION_MS ? APP_DECISION_MS - sinceStart : NO_START_EVENT_MS);
}

function captionsPlayer() {
  const p = document.getElementById(SELECTORS.PLAYER_ID);
  return p && typeof p.getOption === 'function' && typeof p.setOption === 'function' ? p : null;
}

function playerVideoId(player) {
  try {
    const data = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
    return (data && data.video_id) || null;
  } catch {
    return null;
  }
}

function captionsOption(player, name) {
  try {
    return player.getOption('captions', name);
  } catch {
    return null;
  }
}

function isTargetTrack(track, code) {
  if (!isObject(track)) return false;
  if (isObject(track.translationLanguage)) return sameLanguage(track.translationLanguage.languageCode, code);
  return sameLanguage(track.languageCode, code);
}

function setCaptionsTrack(player, track) {
  try {
    player.setOption('captions', 'track', track);
    return true;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not turn on subtitles:', err);
    return false;
  }
}

/** Watches for the player dropping the track it was just given; puts it back once. */
function watchForReset(player, videoId, code, track, appliedAt) {
  const check = () => {
    autoTimer = null;
    if (lastUserKeyAt > appliedAt || !player.isConnected || playerVideoId(player) !== videoId) return;
    if (!isTargetTrack(captionsOption(player, 'track'), code)) {
      if (DEBUG) console.info(LOG_PREFIX, 'Subtitles were reset, re-applying once', videoId);
      setCaptionsTrack(player, track);
      return;
    }
    if (Date.now() - appliedAt < REAPPLY_WINDOW_MS) autoTimer = setTimeout(check, REAPPLY_POLL_MS);
  };
  autoTimer = setTimeout(check, REAPPLY_POLL_MS);
}

function autoEnableCaptions(since) {
  // The watch page only: the player also reports the tile previews that play
  // in it on Home, and a preview counted as the video's one attempt, so the
  // video then opened got no subtitles.
  if (configRead('subtitlesAtStart') !== 'translated' || isShortsPage() || !isWatchPage()) return;
  const code = currentTarget();
  if (!code) return;
  const player = captionsPlayer();
  if (!player) return;
  const videoId = playerVideoId(player);
  if (!videoId || videoId === attemptedVideoId) return;

  attemptedVideoId = videoId;
  cancelAutoEnable();
  // Already on (the default given in the response): the module is not loaded
  // again, which could drop the line on screen.
  if (isTargetTrack(captionsOption(player, 'track'), code)) return;

  // The captions module loads on demand; until it has, the tracklist is empty.
  try {
    if (typeof player.loadModule === 'function') player.loadModule('captions');
  } catch { /* the tracklist poll below copes */ }

  const startedAt = since || Date.now();
  let tries = 0;
  const attempt = () => {
    autoTimer = null;
    // The viewer is already doing something with the player, or moved on.
    if (lastUserKeyAt > startedAt || !player.isConnected || playerVideoId(player) !== videoId) return;
    if (configRead('subtitlesAtStart') !== 'translated' || currentTarget() !== code) return;
    if (isTargetTrack(captionsOption(player, 'track'), code)) return; // already on

    let track = pickTrack(captionsOption(player, 'tracklist'), code);
    if (!track && ++tries < TRACKLIST_TRIES) {
      autoTimer = setTimeout(attempt, TRACKLIST_POLL_MS);
      return;
    }
    if (!track) {
      // No tracklist from the API: name the track the response carried.
      const known = responseTrack(videoId);
      if (!known) return;
      track = { languageCode: known.languageCode, kind: known.kind, vss_id: known.vssId };
    }
    if (DEBUG) console.info(LOG_PREFIX, 'Turning on subtitles', videoId, track.languageCode);
    if (setCaptionsTrack(player, track)) watchForReset(player, videoId, code, track, Date.now());
  };
  attempt();
}

window.addEventListener('keydown', (evt) => {
  if (evt.isTrusted === false || evt[SYNTHETIC_KEY_FLAG]) return;
  lastUserKeyAt = Date.now();
}, true);

// Published by video-quality.js for every player state change on a watch page.
window.addEventListener('yt-player-state-change', (evt) => {
  if (evt && evt.detail && evt.detail.state === STATE_PLAYING) onPlaying();
});

window.addEventListener('ytaf-page-update', (evt) => {
  if (!evt || !evt.detail || !evt.detail.isWatch) {
    cancelAutoEnable();
    cancelStart();
    // The viewing is over: opened again, the video gets its attempt again.
    attemptedVideoId = null;
    checkedVideoId = null;
    offVideoId = null;
    return;
  }
  // A watch page entered with the video already running gets no PLAYING change.
  const player = captionsPlayer();
  try {
    if (player && typeof player.getPlayerState === 'function' && player.getPlayerState() === STATE_PLAYING) onPlaying();
  } catch { /* the state-change event will come */ }
});
