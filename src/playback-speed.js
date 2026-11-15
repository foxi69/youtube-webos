import { AudioEngine } from './speed/audio-engine.js';
import { installMseHook, isSupportedSpeed, SUPPORTED_SPEEDS } from './speed/mse-hook.js';
import { keepStretchableAudio, allowSpeedMenuOnSurround, LEGACY_STRETCHABLE_AUDIO_RE } from './speed/containers.js';
import { legacyAudioCodecs } from './speed/legacy-decoder.js';
import { watchPosition } from './speed/position-watch.js';
import { readCaptions, keepCaptions, readQualityRecord, QUALITY_KEY } from './speed/player-state.js';
import { showNotification } from './notifications.js';
import { configRead, configAddChangeListener } from './config.js';
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
const ABOVE_1080 = ['highres', 'hd2880', 'hd2160', 'hd1440'];
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
  win, getPlayer, notify, configRead, codecs, userKeyAt = () => 0, keyPressedBetween = () => true
}) {
  let currentSpeed = 1;
  let activeSink = null;
  let pending = null;
  let lastReloadAt = 0;
  let stopPositionWatch = null;
  // The subtitles to put back after a reload: { videoId, captions, landed, keyAt }.
  // Kept until the reload plays, so a second speed change meanwhile does not
  // read the subtitles YouTube put on the half-loaded video; dropped when its
  // position check ends without the video having played.
  let keptCaptions = null;
  // Stops the caption checks of the last reload (player-state.js).
  let stopCaptions = () => {};
  // When this controller asked for each quality level ({ from, last, until }
  // by level), the level it asked for last, and the viewer's last pick read
  // from YouTube's record (see viewerPick), with the record it was read from.
  const ownRanges = new Map();
  let ownRangeLevel;
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
    if (!ours) lastPick = record.level;
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
    ownRanges.set(level, { from, last: now, until: now + OWN_RECORD_MS });
    ownRangeLevel = level;
    if (level) {
      try { win.localStorage.setItem(OWN_RANGE_KEY, JSON.stringify({ level, from, last: now })); } catch { /* storage denied */ }
    }
    player.setPlaybackQualityRange(quality, quality);
  }

  // Above CAP_ABOVE: 1080p, or the viewer's own pick when it is lower.
  function capQuality() {
    const pick = viewerPick();
    return pick && BELOW_1080.indexOf(pick) !== -1 ? pick : 'hd1080';
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
    if (currentSpeed > CAP_ABOVE) {
      const cap = capQuality();
      setRange(player, cap);
    } else if (fromSpeed > CAP_ABOVE) {
      // A pick in YouTube's menu wins over Force Max Quality.
      const quality = viewerPick() || (configRead('forceHighResVideo') ? 'highres' : 'auto');
      setRange(player, quality);
    }
    if (!videoId) return;
    lastReloadAt = Date.now();
    player.loadVideoById(videoId, at);
    restorePosition(player, at, videoId, keptCaptions);
    // If YouTube's own menu is bound (native-menu.js), keep what it shows in
    // line with the real speed once the reloaded video has started.
    const setRate = player.__ytafOriginalSetPlaybackRate;
    if (setRate && typeof player.getPlaybackRate === 'function') {
      win.setTimeout(() => {
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
    const setCap = () => {
      if (currentSpeed > CAP_ABOVE) {
        const cap = capQuality();
        qualityPickVideoId = lastPick ? videoId : null;
        setRange(player, cap);
      }
    };
    const onPlaying = () => {
      setCap();
      kept.landed = true;
      stopCaptions = keepCaptions(win, player, kept.captions, userKeyAt, kept);
    };
    stopPositionWatch = watchPosition(win, player, at, onPlaying, {
      isLow() {
        // Every tick for 25 s: the player first, the stored record (capQuality)
        // only once the picture is below 1080p.
        if (currentSpeed <= CAP_ABOVE) return false;
        const levels = player.getAvailableQualityLevels ? player.getAvailableQualityLevels() : [];
        if (levels.indexOf('hd1080') === -1 || BELOW_1080.indexOf(player.getPlaybackQuality()) === -1) return false;
        // A lower quality the viewer picked is not a fall to fight.
        return capQuality() === 'hd1080';
      },
      setCap
    }, videoId, () => {
      // Never played (another video opened, or the check gave up): those
      // subtitles belong to that reload only, not to a later one of the video.
      if (keptCaptions === kept && !kept.landed) keptCaptions = null;
    });
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
    const previousSpeed = currentSpeed;
    currentSpeed = speed;
    notify(`Playback speed ${speed}×`);
    scheduleReload(pending ? pending.fromSpeed : previousSpeed, immediate);
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
    stop,
    onRateRequest,
    onError,
    createAudioSink,
    releaseAudioSink,
    capQuality,
    setRange,
    keepsQuality,
    clearQualityPick,
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

/** Explicitly enabling Force Max Quality releases the previously retained pick. */
export function clearSpeedQualityPick() {
  if (speedInstance) speedInstance.controller.clearQualityPick();
}

export function installSpeedFeature(win, { notify, configRead: cfgRead, getPlayer }) {
  if (typeof win.AudioContext === 'undefined' || typeof win.MediaSource === 'undefined') {
    return null;
  }
  // Without WebCodecs (webOS 4-6 and 22): AAC decoded with decodeAudioData.
  const codecs = typeof win.AudioDecoder === 'undefined' ? legacyAudioCodecs(win) : null;
  if (typeof win.AudioDecoder === 'undefined' && !codecs) return null;

  // The keys the viewer pressed: a change of subtitles by hand after a reload
  // ends putting the old ones back (player-state.js), and a quality record
  // written after a key press is a pick in the menu (viewerPick). The times are
  // the last few, newest last.
  let lastUserKeyAt = 0;
  const keyTimes = [];
  const onKey = (evt) => {
    if (evt.isTrusted === false || evt[SYNTHETIC_KEY_FLAG]) return;
    lastUserKeyAt++;
    keyTimes.push(Date.now());
    if (keyTimes.length > KEY_TIMES) keyTimes.shift();
  };
  win.addEventListener('keydown', onKey, true);
  const ctrl = createSpeedController({
    win, getPlayer, notify, configRead: cfgRead, codecs, userKeyAt: () => lastUserKeyAt,
    keyPressedBetween: (from, to) => keyTimes.some((at) => at > from && at <= to)
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
      if (win.document) win.document.removeEventListener('playing', resume, true);
      win.removeEventListener('ytaf-page-update', onPageUpdate);
      if (resumeTimer !== null) win.clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  };
}

export function initPlaybackSpeed() {
  if (speedInstance || typeof window === 'undefined') return speedInstance;
  speedInstance = installSpeedFeature(window, {
    notify: showNotification,
    configRead,
    getPlayer: () =>
      document.getElementById(SELECTORS.PLAYER_ID) ||
      document.querySelector('.html5-video-player')
  });
  window.ytafSpeed = speedInstance ? speedInstance.controller : null;
  if (speedInstance) {
    configAddChangeListener('enablePlaybackSpeed', ({ detail }) => {
      if (!detail.newValue) speedInstance.controller.stop();
    });
    // The next video (autoplay, a tile) keeps the speed but starts at the
    // quality YouTube picks, 2160p on a 4K TV: cap it once it plays.
    window.addEventListener('yt-player-state-change', ({ detail }) => {
      if (!detail || detail.state !== 1 || !speedCapsQuality()) return;
      const player =
        document.getElementById(SELECTORS.PLAYER_ID) ||
        document.querySelector('.html5-video-player');
      if (player && ABOVE_1080.includes(player.getPlaybackQuality())) {
        const cap = speedInstance.controller.capQuality();
        speedInstance.controller.setRange(player, cap);
      }
    });
  }
  return speedInstance;
}

export function stepSpeed(direction) {
  initPlaybackSpeed()?.controller?.step(direction);
}

export function resetSpeed() {
  initPlaybackSpeed()?.controller?.reset();
}

initPlaybackSpeed();
