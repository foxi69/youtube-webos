import { AudioEngine } from './speed/audio-engine.js';
import { installMseHook, isSupportedSpeed, SUPPORTED_SPEEDS } from './speed/mse-hook.js';
import { keepStretchableAudio, allowSpeedMenuOnSurround, LEGACY_STRETCHABLE_AUDIO_RE } from './speed/containers.js';
import { legacyAudioCodecs } from './speed/legacy-decoder.js';
import { watchPosition } from './speed/position-watch.js';
import { readCaptions, keepCaptions, readQualityRecord, QUALITY_KEY, QUALITY_HEIGHTS, levelUpTo } from './speed/player-state.js';
import { showNotification } from './notifications.js';
import { configRead, configWrite, configAddChangeListener, forceQualityLines, forceQualityOn } from './config.js';
import { SELECTORS, SYNTHETIC_KEY_FLAG } from './utils.js';

export const SPEED_BUTTON_TYPE = 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED_BUTTON';
export const SPEED_OVERLAY_TYPE = 'CLIENT_OVERLAY_TYPE_VIDEO_PLAYBACK_SPEED';

export function enableSpeedButton(response) {
  const holder =
    response && response.transportControls
      ? response
      : response &&
        response.playerOverlays &&
        response.playerOverlays.playerOverlayRenderer;
  const renderer =
    holder &&
    holder.transportControls &&
    holder.transportControls.transportControlsRenderer;
  if (!renderer || typeof renderer !== 'object') return 0;
  let enabled = 0;
  for (const key of Object.keys(renderer)) {
    const actions = renderer[key];
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (!action || action.type !== SPEED_BUTTON_TYPE) continue;
      const button = action.button && action.button.buttonRenderer;
      if (!button || !button.isDisabled) continue;
      button.isDisabled = false;
      if (!button.command) {
        button.command = {
          openClientOverlayAction: { type: SPEED_OVERLAY_TYPE }
        };
      }
      enabled++;
    }
  }
  return enabled;
}

export function installSpeedButtonPatch(win, isOn) {
  const json = win.JSON || JSON;
  const original = json.parse;
  const patched = function () {
    const r = original.apply(this, arguments);
    if (
      r &&
      typeof r === 'object' &&
      (r.transportControls ||
        (r.playerOverlays &&
          r.playerOverlays.playerOverlayRenderer &&
          r.playerOverlays.playerOverlayRenderer.transportControls)) &&
      isOn()
    ) {
      enableSpeedButton(r);
    }
    return r;
  };
  json.parse = patched;
  return () => {
    if (json.parse === patched) json.parse = original;
  };
}

// The player response of a reload at a speed other than 1x (and of the next
// video while it lasts) loses the audio the engine cannot stretch
// (speed/containers.js). At 1x the offer is left as it is: AC-3 stays.
// Without WebCodecs only AAC LC can be stretched (`stretchable`).
export function installAudioOfferFilter(win, getSpeed, stretchable) {
  const json = win.JSON || JSON;
  const original = json.parse;
  const patched = function () {
    const r = original.apply(this, arguments);
    const streaming =
      r &&
      typeof r === 'object' &&
      (r.streamingData || (r.playerResponse && r.playerResponse.streamingData));
    if (streaming && getSpeed() !== 1) keepStretchableAudio(streaming, stretchable);
    return r;
  };
  json.parse = patched;
  return () => {
    if (json.parse === patched) json.parse = original;
  };
}

export function enableNativeSpeedMenu(win, isOn = () => true) {
  const proto = (win.Object || Object).prototype;
  const previous = Object.getOwnPropertyDescriptor(proto, 'enableSpeedOptions');
  Object.defineProperty(proto, 'enableSpeedOptions', {
    configurable: true,
    enumerable: false,
    get() {
      return isOn();
    },
    set(value) {
      Object.defineProperty(this, 'enableSpeedOptions', {
        value,
        writable: true,
        configurable: true,
        enumerable: true
      });
    }
  });
  return () => {
    if (previous) Object.defineProperty(proto, 'enableSpeedOptions', previous);
    else delete proto.enableSpeedOptions;
  };
}

export function hookRateAssignments(win, controller, now = () => Date.now()) {
  const proto = (win.Object || Object).prototype;
  const previous = Object.getOwnPropertyDescriptor(proto, 'setPlaybackRate');
  Object.defineProperty(proto, 'setPlaybackRate', {
    configurable: true,
    enumerable: false,
    get() {
      return undefined;
    },
    set(fn) {
      if (Object(this) !== this) return;
      // hasOwnProperty, not Object.hasOwn (Chromium 93): this runs on every
      // setPlaybackRate assignment, on webOS 4-6 and 22 too.
      const plain =
        Object.getPrototypeOf(this) === proto &&
        !Object.prototype.hasOwnProperty.call(this, 'constructor');
      Object.defineProperty(this, 'setPlaybackRate', {
        value:
          plain && typeof fn === 'function'
            ? wrapRate(fn, controller, now)
            : fn,
        writable: true,
        configurable: true,
        enumerable: true
      });
    }
  });
  return () => {
    if (previous) Object.defineProperty(proto, 'setPlaybackRate', previous);
    else delete proto.setPlaybackRate;
  };
}

export function bindPlayerRate(player, controller, now = () => Date.now()) {
  if (
    !player ||
    typeof player.setPlaybackRate !== 'function' ||
    player.__ytafSpeedBound
  )
    return false;
  const original = player.setPlaybackRate;
  player.__ytafOriginalSetPlaybackRate = original.__ytafUnwrapped || original;
  if (!original.__ytafUnwrapped)
    player.setPlaybackRate = wrapRate(original, controller, now);
  player.__ytafSpeedBound = true;
  return true;
}

function wrapRate(original, controller, now) {
  if (original.__ytafUnwrapped) return original;
  const wrapped = function (rate) {
    const r = Number(rate);
    // YouTube's own rate change on a live stream stalls it the same way: a
    // speed from the menu is refused there (catch-up rates like 1.03 pass).
    if (r !== 1 && isSupportedSpeed(r) && controller.isLive && controller.isLive()) {
      controller.setSpeed(r);
      return original.call(this, 1);
    }
    const result = original.apply(this, arguments);
    const sinceReload = now() - controller.lastReloadAt();
    if (
      isSupportedSpeed(r) &&
      r !== controller.getSpeed() &&
      sinceReload > IGNORE_AFTER_RELOAD_MS
    ) {
      controller.setSpeed(r, { immediate: true });
    }
    return result;
  };
  wrapped.__ytafUnwrapped = original;
  return wrapped;
}

export const IGNORE_AFTER_RELOAD_MS = 3000;

export const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

export const RELOAD_DELAY_MS = 800;

export const RESUME_AFTER_PAGE_MS = 1000;

// Seconds of audio queued ahead on a TV without WebCodecs (webOS 4-6 and 22).
// Its main thread can stay busy past the engine's 0.4 s (about every 5 s on a
// webOS 5 TV), and the queue then ran out and clicked (#97). A/V sync reads
// the scheduled times, not the queue's length; a pause or a seek still stops
// the queued audio at once. Small drift corrections are heard later.
const LEGACY_LEAD_S = 1;

// Above this speed the video plays at 1080p at most: the TV cannot decode
// 2160p fast enough (at 1.5x it dropped 85% of the frames and reached 1.43x; at
// 1.25x YouTube fell to 480p and it reached 1.17x).
const CAP_ABOVE = 1;
// Below the cap: where YouTube falls by itself at speed.
const BELOW_1080 = ['hd720', 'large', 'medium', 'small', 'tiny'];
const LEVELS_DOWN = ['hd1080', ...BELOW_1080];
const ABOVE_1080 = ['highres', 'hd2880', 'hd2160', 'hd1440'];
// A change of Force Max Quality applied above 1x this long after the row last moved.
const LIMIT_APPLY_MS = 600;
// YouTube can write our quality range asynchronously, at times more than a
// second later. A record of a level this controller asked for is ours unless
// the viewer pressed a key between our last call and the record (a pick in
// the menu); within this long of the call it is ours either way. A different
// level is always the viewer's choice.
const OWN_RECORD_MS = 1000;
// The level this controller last asked for, kept across runs of the app:
// { level, from, last } (setRange). A record from an earlier run is that run's
// own cap when it names that level and was written after the call, within
// this long of the last one (no key presses are known from then).
const OWN_RANGE_KEY = 'ytaf-speed-own-range';
const OWN_RECORD_BEFORE_MS = 10000;
// The viewer's last key presses remembered for that (installSpeedFeature).
const KEY_TIMES = 16;

/**
 * userKeyAt: a count of the viewer's key presses; keyPressedBetween(from, to):
 * whether the viewer pressed a key after `from` and at or before `to`
 * (Date.now() times). Without it only the time window tells our records.
 */
export function createSpeedController({
  win, getPlayer, notify, configRead, codecs, userKeyAt = () => 0, keyPressedBetween = () => true,
  onSpeed = () => {}
}) {
  let currentSpeed = 1;
  // Another account's speed, loaded while a video played: set once it is left.
  let deferredSpeed = null;
  let activeSink = null;
  let pending = null;
  let lastReloadAt = 0;
  let stopPositionWatch = null;
  // The video the position watch is on (stopPositionWatch.running() says if it still is).
  let watchedVideoId = null;
  // The subtitles to put back after a reload: { videoId, captions, landed, keyAt }.
  // Kept until the reload plays, so a second speed change meanwhile does not
  // read the subtitles YouTube put on the half-loaded video; dropped when its
  // position check ends without the video having played.
  let keptCaptions = null;
  // Stops the caption checks of the last reload (player-state.js).
  let stopCaptions = () => {};
  // The check that puts YouTube's own speed menu in line after a reload.
  let rateTimer = null;
  // When this controller asked for each quality level ({ from, last, until }
  // by level), the level it asked for last, and the viewer's last pick read
  // from YouTube's record (see viewerPick), with the record it was read from.
  const ownRanges = new Map();
  let ownRangeLevel;
  // The last range Force Max Quality set (video-quality.js), at any level:
  // the record YouTube writes for it is no pick of the viewer's either.
  let forcedRange = null;
  let lastPick = null;
  let seenRaw;
  let seenRecord = null;
  // A record older than this controller is from an earlier run of the app:
  // that run's own cap (a session that ended above 1x) is no pick, any other
  // is the viewer's, which YouTube keeps playing after a restart.
  const startedAt = Date.now();
  let ownBefore = null;
  try { ownBefore = JSON.parse(win.localStorage.getItem(OWN_RANGE_KEY)); } catch { /* none known */ }
  let qualityPickVideoId = null;

  function isSupported() {
    return typeof win.AudioDecoder !== 'undefined' || !!codecs;
  }

  function enabled() {
    return configRead('enablePlaybackSpeed') !== false;
  }

  // A live stream plays at 1x. Faster, it reached the live edge and then
  // stalled for about 2 s every 5 s (webOS 25); YouTube offers no speed there
  // either. The speed set is kept for the next video that is not live.
  function isLive() {
    try {
      const data = getPlayer()?.getVideoData?.();
      return !!(data && data.isLive);
    } catch {
      return false;
    }
  }

  let liveNoticeAt = 0;
  function refuseLive() {
    // Once per press: the player API and YouTube's own object both pass it on.
    if (Date.now() - liveNoticeAt > 1000) notify('Playback speed is not available on a live stream');
    liveNoticeAt = Date.now();
  }

  // A tile preview (Home, a channel, a list) plays at 1x: the speed belongs to
  // the watch page and Shorts, and is kept for the next video opened there.
  // The page is read now, not from the page-update event, which comes later.
  function onPlaybackPage() {
    const body = win.document && win.document.body;
    if (!body) return true;
    const cl = body.classList;
    return cl.contains(SELECTORS.WATCH_PAGE_CLASS) || cl.contains(SELECTORS.SHORTS_PAGE_CLASS);
  }

  function getSpeed() {
    return enabled() && isSupported() && !isLive() && onPlaybackPage() ? currentSpeed : 1;
  }

  // A playback set up at 1x that goes on in the watch page: a preview YouTube
  // carries on there, or a MediaSource made before the page turned. Loaded
  // again at the speed once it plays, at most once per video.
  let resumedVideoId = null;
  function resumeOnPlaybackPage() {
    if (getSpeed() === 1 || activeSink || pending) return false;
    const video = win.document && win.document.querySelector('video');
    if (!video || video.paused || video.readyState < 3) return false;
    let id;
    try {
      const player = getPlayer();
      const videoData = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
      id = videoData && videoData.video_id;
    } catch {
      // The player between two videos: the next 'playing' tries again.
      return false;
    }
    if (!id || id === resumedVideoId) return false;
    resumedVideoId = id;
    scheduleReload(1, true);
    return true;
  }

    function position(player) {
    try {
      return player.getCurrentTime();
    } catch {
      return 0;
    }
  }

  function scheduleReload(fromSpeed, immediate = false) {
    const player = getPlayer();
    if (!player) return;
    if (pending) {
      win.clearTimeout(pending.timer);
    } else {
      pending = { position: position(player), fromSpeed, timer: null };
    }
    if (immediate) {
      const p = pending;
      pending = null;
      applyReload(p);
      return;
    }
    pending.timer = win.setTimeout(() => {
      const p = pending;
      pending = null;
      applyReload(p);
    }, RELOAD_DELAY_MS);
  }

  // The quality the viewer picked in YouTube's menu (player-state.js), or null.
  // A different level written during the reload is a new manual choice,
  // even if it arrives within the controller's own-record window. A record is
  // judged once: read again unchanged, the pick stays what it was.
  function viewerPick() {
    const now = Date.now();
    let raw;
    try {
      const storage = win.localStorage;
      raw = storage ? storage.getItem(QUALITY_KEY) : null;
    } catch {
      // Storage denied: the pick known so far.
      return lastPick;
    }
    if (raw === seenRaw && !(seenRecord && seenRecord.expires < now)) return lastPick;
    seenRaw = raw;
    seenRecord = readQualityRecord({ getItem: () => raw }, now);
    const record = seenRecord;
    if (!record) {
      lastPick = null;
      return lastPick;
    }
    if (record.at < startedAt) {
      const own = !!ownBefore && record.level === ownBefore.level && record.at >= ownBefore.from &&
        record.at <= ownBefore.last + OWN_RECORD_BEFORE_MS;
      lastPick = own ? null : record.level;
      return lastPick;
    }
    const own = ownRanges.get(record.level);
    const ours = !!own && record.at >= own.from &&
      (record.at < own.until || !keyPressedBetween(own.last, record.at));
    // Force Max Quality's: written after its range with no key pressed since.
    // A key in between (a pick in YouTube's menu, even within a second) makes
    // the record the viewer's.
    const forced = !!forcedRange && record.at >= forcedRange.from && !keyPressedBetween(forcedRange.from, record.at);
    // Force's record replaced whatever was picked before it (on another video, say).
    if (!ours) lastPick = forced ? null : record.level;
    return lastPick;
  }

  // Only the video whose speed reload kept this pick suppresses quality forcing,
  // while it plays: another video, or the same one opened again later, is
  // forced as any other.
  function keepsQuality(watched) {
    if (!lastPick || !qualityPickVideoId || !watched) return false;
    let id;
    try { id = watched.getVideoData()?.video_id; }
    catch { return false; }
    if (id && id !== qualityPickVideoId) qualityPickVideoId = null;
    return !!id && id === qualityPickVideoId;
  }

  /** The video was left (another page than the watch page or Shorts). */
  function leaveVideo() {
    qualityPickVideoId = null;
    // Also called with the watch page still there (a page update of the
    // account selector over it): the video plays on, and so does its speed.
    if (deferredSpeed === null || onPlaybackPage()) return;
    const next = deferredSpeed;
    deferredSpeed = null;
    dropStaleReload();
    currentSpeed = next;
  }

  // A reload still waiting once the watch page is gone was for the video left:
  // it would reload nothing of the next one, and must not keep its speed.
  function dropStaleReload() {
    if (!pending || onPlaybackPage()) return;
    win.clearTimeout(pending.timer);
    pending = null;
  }

  function clearQualityPick() {
    lastPick = null;
    qualityPickVideoId = null;
  }

  // The same level asked again (the cap, once the reload plays) keeps the
  // first call's start: its record can still be the newest when the next read
  // comes, and it is no pick of the viewer's.
  function setRange(player, quality) {
    const level = quality === 'highres' || quality === 'auto' ? null : quality;
    const now = Date.now();
    const own = level === ownRangeLevel ? ownRanges.get(level) : null;
    const from = own ? own.from : now;
    // Ours only once the player took it (times from before the call, which
    // writes the record): a call that throws leaves a later record the viewer's.
    player.setPlaybackQualityRange(quality, quality);
    ownRanges.set(level, { from, last: now, until: now + OWN_RECORD_MS });
    ownRangeLevel = level;
    // Kept for the next run only when it is a cap of the controller's own: a
    // retained pick of the viewer's (720p kept at 1.5x) stays theirs after a
    // restart, or its record would read as the cap and 1080p would replace it.
    if (level && level !== lastPick) {
      try { win.localStorage.setItem(OWN_RANGE_KEY, JSON.stringify({ level, from, last: now })); } catch { /* storage denied */ }
    }
  }

  // Above CAP_ABOVE: 1080p, or the viewer's own pick when it is lower.
  function capQuality() {
    const pick = viewerPick();
    if (pick && BELOW_1080.indexOf(pick) !== -1) return pick;
    // A lower limit of Force Max Quality's own (Up to 480p) holds above 1x too.
    const lines = forceQualityLines(configRead('forceQuality'));
    if (lines && lines < QUALITY_HEIGHTS.hd1080) {
      for (let i = 0; i < BELOW_1080.length; i++) if (QUALITY_HEIGHTS[BELOW_1080[i]] <= lines) return BELOW_1080[i];
      return BELOW_1080[BELOW_1080.length - 1];
    }
    return 'hd1080';
  }

  function applyReload({ position: at, fromSpeed }) {
    // Back where the burst started: the playing MediaSource is already right.
    if (currentSpeed === fromSpeed) return;
    // Stop any previous Web Audio engine immediately so it doesn't keep playing
    // while the new MediaSource is being set up.
    releaseAudioSink();
    const player = getPlayer();
    if (!player) return;
    // The last reload's checks would put back the subtitles from before it.
    stopCaptions();
    let videoData = null;
    try {
      videoData = player.getVideoData && player.getVideoData();
    } catch {
      // The player between two videos: no ID, so no reload below (as in isLive).
    }
    const videoId = videoData && videoData.video_id;
    // Read before the quality range below, which can reload the <video> too.
    const reused = !!keptCaptions && !keptCaptions.landed && keptCaptions.videoId === videoId;
    if (reused) {
      // The keys pressed since the first reload include this speed change:
      // only a key after this reload is the viewer's own choice of subtitles.
      keptCaptions.keyAt = userKeyAt();
    } else {
      keptCaptions = { videoId, captions: readCaptions(player), landed: false, keyAt: userKeyAt() };
    }
    qualityPickVideoId = viewerPick() ? videoId : null;
    // The audio sink is gone already: a player that fails on the quality still
    // gets the reload below, or the video would go on without sound.
    try {
      if (currentSpeed > CAP_ABOVE) {
        const cap = capQuality();
        setRange(player, cap);
      } else if (fromSpeed > CAP_ABOVE) {
        // A pick in YouTube's menu wins over Force Max Quality, whose level is
        // its limit's (Up to 1080p: the best up to 1080p), as video-quality.js asks.
        const mode = configRead('forceQuality');
        let levels = null;
        try { levels = player.getAvailableQualityLevels(); } catch { /* none listed */ }
        // None listed: the level named for the limit, so it still holds.
        if (!Array.isArray(levels) || !levels.length) levels = Object.keys(QUALITY_HEIGHTS);
        const quality = viewerPick() || (forceQualityOn(mode) ? levelUpTo(levels, forceQualityLines(mode)) : 'auto');
        setRange(player, quality);
      }
    } catch { /* the reload goes on at the quality it has */ }
    if (!videoId) return;
    lastReloadAt = Date.now();
    player.loadVideoById(videoId, at);
    restorePosition(player, at, videoId, keptCaptions);
    // If YouTube's own menu is bound (native-menu.js), keep what it shows in
    // line with the real speed once the reloaded video has started.
    const setRate = player.__ytafOriginalSetPlaybackRate;
    if (setRate && typeof player.getPlaybackRate === 'function') {
      if (rateTimer !== null) win.clearTimeout(rateTimer);
      rateTimer = win.setTimeout(() => {
        rateTimer = null;
        try {
          if (player.getPlaybackRate() !== currentSpeed)
            setRate.call(player, currentSpeed);
        } catch {
          // The menu only shows a stale value; playback itself is unaffected.
        }
      }, 2500);
    }
  }

  function restorePosition(player, at, videoId, kept) {
    if (stopPositionWatch) stopPositionWatch();
    // True when it set a range (the watch then knows the video may reload).
    const setCap = () => {
      if (currentSpeed <= CAP_ABOVE) return false;
      // The cap, or the most the video has below it (capFor reads the pick first).
      const cap = capFor(player) || capQuality();
      qualityPickVideoId = lastPick ? videoId : null;
      setRange(player, cap);
      return true;
    };
    const onPlaying = () => {
      const capped = setCap();
      kept.landed = true;
      stopCaptions = keepCaptions(win, player, kept.captions, userKeyAt, kept);
      return capped;
    };
    watchedVideoId = videoId;
    stopPositionWatch = watchPosition(win, player, at, onPlaying, {
      // Below the cap or the viewer's lower pick (720p picked, fallen to 480p),
      // as capNext judges it: a pick at or above what plays is not a fall.
      isLow: () => currentSpeed > CAP_ABOVE && belowCap(player),
      setCap,
      keys: userKeyAt
    }, videoId, () => {
      // Never played (another video opened, or the check gave up): those
      // subtitles belong to that reload only, not to a later one of the video.
      if (keptCaptions === kept && !kept.landed) keptCaptions = null;
    });
  }

  // The cap, or the highest level the video has below it.
  function capFor(player) {
    const cap = capQuality();
    // Anything but a list (none yet, say) is no levels: no target, the caller falls back.
    let levels = player.getAvailableQualityLevels && player.getAvailableQualityLevels();
    if (!Array.isArray(levels)) levels = [];
    return LEVELS_DOWN.slice(LEVELS_DOWN.indexOf(cap)).find((q) => levels.includes(q)) || null;
  }

  function belowCap(player) {
    // At 1080p or above (or not known) nothing is below a cap: the stored
    // record (capFor) is read only below 1080p, not on each of the watch's ticks.
    const now = LEVELS_DOWN.indexOf(player.getPlaybackQuality());
    if (now <= 0) return false;
    const target = capFor(player);
    return !!target && now > LEVELS_DOWN.indexOf(target);
  }

  // A next video (autoplay, a tile) playing below the cap above 1x: on webOS
  // 25 YouTube starts a 60 fps video at 480p30 there, counting the frames a
  // 60 Hz screen cannot show as dropped, though 1080p60 keeps 1.5x and shows
  // 60 fps (480p30: 45). Raised as it starts, the <video> stayed at 0 (8 of 8
  // times); raised once it has played (the watch's 2 s), it did not. A watch
  // already on this video (its speed reload) is left to do it.
  // Once a video: its watch raises it up to three times in 25 s, and a fall
  // after that is the line's (a slow one), not the start's. Watched again at
  // every later play, it was raised, and so loaded again, over and over.
  // Once a playback, though, not once an id: another video played in
  // between (any quality), the same video opened again gets its turn again.
  let nextCappedVideoId = null;
  let lastPlayedVideoId = null;
  /** Every play, at any speed: a different video ends the last one's once. */
  function notePlay(player) {
    let videoId;
    try { videoId = player.getVideoData().video_id; } catch { return; }
    if (videoId && videoId !== lastPlayedVideoId) {
      lastPlayedVideoId = videoId;
      nextCappedVideoId = null;
    }
  }
  function capNext(player) {
    if (!belowCap(player)) return;
    let videoId = null;
    try { videoId = player.getVideoData().video_id; } catch { /* tried again on the next play */ }
    // Unnamed, it may be the reload's video: the next play tries again.
    if (!videoId) return;
    if (stopPositionWatch && stopPositionWatch.running() && watchedVideoId === videoId) return;
    // A stop by hand does not call the watch's onEnd: the subtitles of the
    // replaced video's reload that never played are dropped here instead.
    if (keptCaptions && !keptCaptions.landed && keptCaptions.videoId === watchedVideoId && watchedVideoId !== videoId) {
      keptCaptions = null;
    }
    if (videoId === nextCappedVideoId) return;
    nextCappedVideoId = videoId;
    if (stopPositionWatch) stopPositionWatch();
    watchedVideoId = videoId;
    // No position to restore (null): a seek the viewer makes as it starts is
    // theirs. The raise's own reload starting the video over is undone by the
    // watch (where the cap was set), unless the viewer pressed a key since.
    stopPositionWatch = watchPosition(win, player, null, () => {}, {
      isLow: () => currentSpeed > CAP_ABOVE && belowCap(player),
      setCap() {
        const target = capFor(player);
        if (!target) return false;
        setRange(player, target);
        return true;
      },
      keys: userKeyAt
    }, videoId);
  }

  function setSpeed(speed, { immediate = false } = {}) {
    if (speed !== 1 && isSupportedSpeed(speed) && isLive()) {
      refuseLive();
      return;
    }
    if (speed === currentSpeed || !isSupportedSpeed(speed)) return;
    if (!enabled()) {
      notify('Playback speed is disabled in YTAF settings');
      return;
    }
    if (!isSupported()) {
      notify('Playback speed is not supported on this TV');
      return;
    }
    // The viewer's choice wins over another account's speed still waiting.
    deferredSpeed = null;
    const previousSpeed = currentSpeed;
    currentSpeed = speed;
    notify(`Playback speed ${speed}×`);
    // The viewer's choice (a key, YouTube's menu): remembered (initPlaybackSpeed).
    try { onSpeed(speed); } catch { /* the speed still applies */ }
    scheduleReload(pending ? pending.fromSpeed : previousSpeed, immediate);
  }

  /**
   * Remember Playback Speed: the speed of the last run, set as the app starts,
   * before any video plays, so the first one opens at it with no reload, as
   * the next video after a speed change does. Nothing is shown; a live stream
   * or a preview still plays at 1x (getSpeed).
   */
  function restoreSpeed(speed) {
    if (speed === 1 || currentSpeed !== 1 || !isSupportedSpeed(speed) || !enabled() || !isSupported()) return false;
    currentSpeed = speed;
    return true;
  }

  /**
   * Another account's settings loaded (Separate Settings for Each Account):
   * its remembered speed, or 1x when it remembers none, for the next video it
   * opens, set with no reload as at the start. Not while a video plays: then
   * once that video is left (leaveVideo), unless the viewer set a speed meanwhile.
   */
  function rememberedSpeed(speed) {
    const next = speed !== 1 && isSupportedSpeed(speed) && enabled() && isSupported() ? speed : 1;
    if (onPlaybackPage()) {
      deferredSpeed = next === currentSpeed ? null : next;
      return false;
    }
    deferredSpeed = null;
    dropStaleReload();
    if (next === currentSpeed || pending) return false;
    currentSpeed = next;
    return true;
  }

  // Toggle Speed (1x / Last): from 1x to `other`, from any other speed to 1x.
  // Not on a live stream, which plays at 1x whatever is set: the speed set
  // stays for the next video that is not live.
  function toggle(other) {
    if (isLive()) {
      refuseLive();
      return;
    }
    setSpeed(currentSpeed === 1 ? other : 1);
  }

  function cycle() {
    const idx = SPEEDS.indexOf(currentSpeed);
    const nextIdx = (idx + 1) % SPEEDS.length;
    setSpeed(SPEEDS[nextIdx]);
  }

  function step(dir) {
    let idx = SUPPORTED_SPEEDS.indexOf(currentSpeed);
    if (idx === -1) idx = SUPPORTED_SPEEDS.indexOf(1);
    const nextIdx = Math.min(
      SUPPORTED_SPEEDS.length - 1,
      Math.max(0, idx + (dir >= 0 ? 1 : -1))
    );
    setSpeed(SUPPORTED_SPEEDS[nextIdx]);
  }

  function reset() {
    setSpeed(1);
  }

  // Option turned off mid-video: go back to 1x now, not on the next video.
  function stop() {
    if (currentSpeed === 1) return;
    const previousSpeed = currentSpeed;
    currentSpeed = 1;
    scheduleReload(pending ? pending.fromSpeed : previousSpeed, true);
  }

    function onRateRequest() {}

  function onError(_err) {
    if (currentSpeed !== 1) {
      const previousSpeed = currentSpeed;
      currentSpeed = 1;
      notify('Playback speed not available for this video');
      scheduleReload(pending ? pending.fromSpeed : previousSpeed);
    }
  }

    function releaseAudioSink() {
    if (!activeSink) return;
    activeSink.engine.destroy();
    if (activeSink.element)
      activeSink.element.removeEventListener(
        'volumechange',
        activeSink.listener
      );
    activeSink = null;
  }

  /** Ends what a reload left running: the reload waiting, its position and subtitle checks. */
  function dispose() {
    if (rateTimer !== null) {
      win.clearTimeout(rateTimer);
      rateTimer = null;
    }
    if (pending) {
      win.clearTimeout(pending.timer);
      pending = null;
    }
    if (stopPositionWatch) {
      stopPositionWatch();
      stopPositionWatch = null;
    }
    stopCaptions();
    stopCaptions = () => {};
  }

  function createAudioSink({ speed, element }) {
    releaseAudioSink();

    const engine = new AudioEngine({ win, speed, onError, codecs, leadS: codecs ? LEGACY_LEAD_S : undefined });
    if (element) {
      engine.attachVideo(element);
      engine.setVolume(element.volume, element.muted);
      const listener = () => {
        engine.setVolume(element.volume, element.muted);
      };
      element.addEventListener('volumechange', listener);
      activeSink = { engine, element, listener };
    } else {
      activeSink = { engine, element: null, listener: null };
    }
    return engine;
  }

  return {
        activeEngine: () => (activeSink ? activeSink.engine : null),
    lastReloadAt: () => lastReloadAt,
    isSupported,
    isLive,
    getSpeed,
    resumeOnPlaybackPage,
    setSpeed,
    cycle,
    step,
    reset,
    restoreSpeed,
    rememberedSpeed,
    toggle,
    stop,
    onRateRequest,
    onError,
    createAudioSink,
    releaseAudioSink,
    capQuality,
    setRange,
    capNext,
    notePlay,
    keepsQuality,
    viewerPick,
    clearQualityPick,
    noteForcedRange() {
      const now = Date.now();
      forcedRange = { from: now };
    },
    leaveVideo,
    dispose
  };
}

let speedInstance = null;

/** Whether the speed caps quality at 1080p now (Force Max Quality then waits). */
export function speedCapsQuality() {
  return !!speedInstance && speedInstance.controller.getSpeed() > CAP_ABOVE;
}

/** A manual quality retained by a speed reload wins over automatic quality forcing. */
export function speedKeepsQuality(player) {
  return !!speedInstance && speedInstance.controller.keepsQuality(player);
}

/** Whether the quality record is no cap of the speed feature's own (with none installed, it wrote none). */
export function speedRecordIsPick() {
  return !speedInstance || !!speedInstance.controller.viewerPick();
}

/** Force Max Quality is about to set a range: the record that follows is not the viewer's pick. */
export function noteForcedQuality() {
  if (speedInstance) speedInstance.controller.noteForcedRange();
}

/** Explicitly enabling Force Max Quality releases the previously retained pick. */
export function clearSpeedQualityPick() {
  if (speedInstance) speedInstance.controller.clearQualityPick();
}

export function installSpeedFeature(win, { notify, configRead: cfgRead, getPlayer, onSpeed }) {
  if (typeof win.AudioContext === 'undefined' || typeof win.MediaSource === 'undefined') {
    return null;
  }
  // Without WebCodecs (webOS 4-6 and 22): AAC decoded with decodeAudioData.
  const codecs = typeof win.AudioDecoder === 'undefined' ? legacyAudioCodecs(win) : null;
  if (typeof win.AudioDecoder === 'undefined' && !codecs) return null;

  // The keys the viewer pressed: a change of subtitles by hand after a reload
  // ends putting the old ones back (player-state.js), and a quality record
  // written after a key press is a pick in the menu (viewerPick). A Magic
  // Remote pointer press counts as one (it sends no key). The times are the
  // last few, newest last.
  let lastUserKeyAt = 0;
  const keyTimes = [];
  // The time of the newest key press dropped from keyTimes: up to then the
  // presses are no longer all known.
  let droppedKeyAt = 0;
  const onKey = (evt) => {
    if (evt.isTrusted === false || evt[SYNTHETIC_KEY_FLAG]) return;
    lastUserKeyAt++;
    keyTimes.push(Date.now());
    if (keyTimes.length > KEY_TIMES) droppedKeyAt = keyTimes.shift();
  };
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('mousedown', onKey, true);
  const ctrl = createSpeedController({
    win, getPlayer, notify, configRead: cfgRead, codecs, userKeyAt: () => lastUserKeyAt, onSpeed,
    // A span that reaches into the dropped presses may have had one: a record
    // there counts as the viewer's, not as ours for want of a known key.
    keyPressedBetween: (from, to) => droppedKeyAt > from || keyTimes.some((at) => at > from && at <= to)
  });
  const mseHook = installMseHook(win, {
    getSpeed: ctrl.getSpeed,
    createAudioSink: ctrl.createAudioSink,
    onRateRequest: ctrl.onRateRequest,
    onError: ctrl.onError,
    onNativeAudio: ctrl.releaseAudioSink
  });

  const isOn = () => cfgRead('enablePlaybackSpeed') !== false;
  const restoreMenu = enableNativeSpeedMenu(win, isOn);
  const restoreSurround = allowSpeedMenuOnSurround(win, isOn);
  const restoreRateHook = hookRateAssignments(win, ctrl);
  const restoreButton = installSpeedButtonPatch(win, isOn);
  const restoreAudioOffer = installAudioOfferFilter(win, ctrl.getSpeed, codecs ? LEGACY_STRETCHABLE_AUDIO_RE : undefined);
  const bindTimer =
    typeof win.setInterval === 'function'
      ? win.setInterval(() => bindPlayerRate(getPlayer(), ctrl), 1000)
      : null;

  // Capture: media events do not bubble. A preview carried on into the watch
  // page plays on without a new 'playing': the page change, a moment later
  // (RESUME_AFTER_PAGE_MS), so that a video opened anew has its own
  // MediaSource at the speed by then.
  const resume = () => ctrl.resumeOnPlaybackPage();
  let resumeTimer = null;
  const onPageUpdate = ({ detail }) => {
    if (!detail) return;
    if (!(detail.isWatch || detail.isShorts)) {
      ctrl.leaveVideo();
      return;
    }
    if (resumeTimer !== null) win.clearTimeout(resumeTimer);
    resumeTimer = win.setTimeout(() => {
      resumeTimer = null;
      resume();
    }, RESUME_AFTER_PAGE_MS);
  };
  if (win.document) win.document.addEventListener('playing', resume, true);
  win.addEventListener('ytaf-page-update', onPageUpdate);

  // The speed keys go through the button mapping
  // (speed_up / speed_down / speed_reset), so Yellow keeps YouTube's search.
  return {
    controller: ctrl,
    uninstall() {
      ctrl.dispose();
      mseHook.uninstall();
      restoreMenu();
      restoreSurround();
      restoreRateHook();
      restoreButton();
      restoreAudioOffer();
      if (bindTimer !== null) win.clearInterval(bindTimer);
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('mousedown', onKey, true);
      if (win.document) win.document.removeEventListener('playing', resume, true);
      win.removeEventListener('ytaf-page-update', onPageUpdate);
      if (resumeTimer !== null) win.clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  };
}

export function initPlaybackSpeed() {
  if (speedInstance || typeof window === 'undefined') return speedInstance;
  // Force Max Quality's mode as it last settled (the panel row stopped for
  // LIMIT_APPLY_MS): a play meanwhile does not take a step on the way (Up to
  // 720p while going to Up to 480p) for the limit.
  let settledQuality = configRead('forceQuality');
  speedInstance = installSpeedFeature(window, {
    notify: showNotification,
    configRead: (key) => (key === 'forceQuality' ? settledQuality : configRead(key)),
    onSpeed: rememberSpeed,
    getPlayer: () =>
      document.getElementById(SELECTORS.PLAYER_ID) ||
      document.querySelector('.html5-video-player')
  });
  window.ytafSpeed = speedInstance ? speedInstance.controller : null;
  if (speedInstance) {
    if (configRead('rememberPlaybackSpeed')) speedInstance.controller.restoreSpeed(Number(configRead('savedPlaybackSpeed')));
    // Separate Settings for Each Account: the account picked in Who's watching
    // brings its own Remember Playback Speed, not the one the app started with.
    const remembered = () => (configRead('rememberPlaybackSpeed') ? Number(configRead('savedPlaybackSpeed')) : 1);
    window.addEventListener('ytaf-profile-change', () => speedInstance.controller.rememberedSpeed(remembered()));
    // The settings back from their copy after the start (localStorage was
    // emptied, config-backup.js): the speed they remember, as an account's
    // comes. Only the restore's own change: one in the panel is no new video.
    const onRestored = ({ detail }) => { if (detail.restored) speedInstance.controller.rememberedSpeed(remembered()); };
    configAddChangeListener('rememberPlaybackSpeed', onRestored);
    configAddChangeListener('savedPlaybackSpeed', onRestored);
    configAddChangeListener('enablePlaybackSpeed', ({ detail }) => {
      if (!detail.newValue) speedInstance.controller.stop();
    });
    // A lower limit set in Force Max Quality above 1x (Up to 480p at 1.5x):
    // the video playing above it goes down to it at once, once the row stops
    // (as video-quality.js does at 1x). Raised again by the next video.
    let limitTimer = null;
    // A lower limit that could not be applied (a player between two videos):
    // the next play applies it once, as the change would have.
    let limitMissed = false;
    configAddChangeListener('forceQuality', () => {
      clearTimeout(limitTimer);
      limitMissed = false;
      limitTimer = setTimeout(() => {
        limitTimer = null;
        settledQuality = configRead('forceQuality');
        if (!speedCapsQuality()) return;
        const player =
          document.getElementById(SELECTORS.PLAYER_ID) ||
          document.querySelector('.html5-video-player');
        // No player that can take it now (one being built again): missed too.
        if (!player || typeof player.getPlaybackQuality !== 'function' || typeof player.setPlaybackQualityRange !== 'function') {
          limitMissed = true;
          return;
        }
        try {
          const cap = speedInstance.controller.capQuality();
          if ((QUALITY_HEIGHTS[player.getPlaybackQuality()] || 0) > QUALITY_HEIGHTS[cap]) speedInstance.controller.setRange(player, cap);
        } catch {
          // A player between two videos: applied when it plays.
          limitMissed = true;
        }
      }, LIMIT_APPLY_MS);
    });
    // The next video (autoplay, a tile) keeps the speed but starts at the
    // quality YouTube picks: 2160p on a 4K TV, capped once it plays, or one
    // below the cap (capNext).
    window.addEventListener('yt-player-state-change', ({ detail }) => {
      if (!detail || detail.state !== 1) return;
      const player =
        document.getElementById(SELECTORS.PLAYER_ID) ||
        document.querySelector('.html5-video-player');
      if (!player) return;
      speedInstance.controller.notePlay(player);
      if (!speedCapsQuality()) { limitMissed = false; return; }
      if (limitMissed) {
        // Kept until the range goes through (or is not needed): a player that
        // fails again gets it at its next play.
        try {
          const cap = speedInstance.controller.capQuality();
          const above = (QUALITY_HEIGHTS[player.getPlaybackQuality()] || 0) > QUALITY_HEIGHTS[cap];
          if (above) speedInstance.controller.setRange(player, cap);
          limitMissed = false;
          if (above) return;
        } catch {
          return;
        }
      }
      if (ABOVE_1080.includes(player.getPlaybackQuality())) {
        speedInstance.controller.setRange(player, speedInstance.controller.capQuality());
      } else {
        speedInstance.controller.capNext(player);
      }
    });
  }
  return speedInstance;
}

/**
 * Each speed the viewer sets is kept: savedPlaybackSpeed for Remember Playback
 * Speed, and the last one other than 1x for Toggle Speed (1x / Last).
 */
function rememberSpeed(speed) {
  configWrite('savedPlaybackSpeed', speed);
  if (speed !== 1) configWrite('toggleSpeed', speed);
}

// The speed Toggle Speed goes to before any other was set.
const DEFAULT_TOGGLE_SPEED = 1.5;

export function toggleSpeed() {
  const other = Number(configRead('toggleSpeed'));
  initPlaybackSpeed()?.controller?.toggle(isSupportedSpeed(other) && other !== 1 ? other : DEFAULT_TOGGLE_SPEED);
}

export function stepSpeed(direction) {
  initPlaybackSpeed()?.controller?.step(direction);
}

export function resetSpeed() {
  initPlaybackSpeed()?.controller?.reset();
}

initPlaybackSpeed();
