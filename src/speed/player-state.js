// What a speed change must not lose (playback-speed.js): the video is
// reloaded with loadVideoById, after which YouTube picks the subtitles and the
// quality again by itself.
// - Subtitles: the track (or none) in use before the reload is put back once
//   the reloaded video plays, and again while the captions module settles, so
//   subtitles turned off stay off and turned on stay on.
// - Quality: the one the viewer picked in YouTube's menu, which YouTube keeps
//   in the yt-player-quality record (video-quality.js writes its own there).

export const QUALITY_KEY = 'yt-player-quality';
export const QUALITY_HEIGHTS = {
  highres: 4320, hd2880: 2880, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720,
  large: 480, medium: 360, small: 240, tiny: 144
};

// After the reloaded video first plays: the captions module can still drop or
// change the track on its own within a few seconds.
export const CAPTION_CHECKS_MS = [1000, 2500, 5000];

/** Whether a captions track is a real one (on), not the empty one (off). */
const isOn = (track) => !!(track && (track.languageCode || track.vssId || track.vss_id));

/**
 * The subtitles in use: the track while on, {} while off; null when they
 * cannot be told (no captions API, or it throws).
 */
export function readCaptions(player) {
  if (!player || typeof player.getOption !== 'function' || typeof player.setOption !== 'function') return null;
  try {
    const track = player.getOption('captions', 'track');
    return isOn(track) ? track : {};
  } catch {
    return null;
  }
}

/** Whether two captions states show the same thing. */
export function sameCaptions(a, b) {
  if (!isOn(a) || !isOn(b)) return isOn(a) === isOn(b);
  const translated = (t) => (t.translationLanguage && t.translationLanguage.languageCode) || '';
  return a.languageCode === b.languageCode &&
    (a.vssId || a.vss_id || '') === (b.vssId || b.vss_id || '') &&
    (a.kind || '') === (b.kind || '') &&
    translated(a) === translated(b);
}

/** Puts `saved` back; returns an error only when applying the track failed. */
export function applyCaptions(player, saved) {
  if (!saved) return null;
  const now = readCaptions(player);
  // Unreadable now: only turning subtitles on is worth a try.
  if (now ? sameCaptions(now, saved) : !isOn(saved)) return null;
  try {
    if (isOn(saved) && typeof player.loadModule === 'function') player.loadModule('captions');
    player.setOption('captions', 'track', isOn(saved) ? saved : {});
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Restores this reload's subtitles while the module settles. The input
 * baseline is captured before reloading, not when playback finally resumes.
 * Another video, viewer input or explicit cancellation ends the cycle.
 */
export function keepCaptions(win, player, saved, userKeyAt, { videoId, keyAt }) {
  if (!saved || !videoId) return () => {};
  let stopped = false;
  const timers = [];
  const stop = () => {
    stopped = true;
    timers.forEach((timer) => { win.clearTimeout(timer); });
    timers.length = 0;
  };
  const check = (final) => {
    if (stopped) return;
    if (userKeyAt() !== keyAt || player.isConnected === false) {
      stop();
      return;
    }
    let currentId;
    try { currentId = player.getVideoData()?.video_id; } catch { /* still loading */ }
    if (currentId && currentId !== videoId) {
      stop();
      return;
    }
    // An unknown id may already be the next video: never apply the old track.
    if (!currentId) {
      if (final) stop();
      return;
    }
    const error = applyCaptions(player, saved);
    if (final) {
      const current = readCaptions(player);
      if (error || (current && !sameCaptions(current, saved))) {
        console.warn('[PlaybackSpeed] Could not restore subtitles: message: ' +
          (error?.message || 'the player did not keep the track'));
      }
      stop();
    }
  };
  CAPTION_CHECKS_MS.forEach((ms, index) => {
    timers.push(win.setTimeout(() => check(index === CAPTION_CHECKS_MS.length - 1), ms));
  });
  check(false);
  return stop;
}

/**
 * The yt-player-quality record: `level` the quality it names ('hd720'...),
 * null for 4320 (Force Max Quality's, video-quality.js, or a range of Max) or
 * a height not known; `at` when it was written. Null without a valid record,
 * undefined when storage access is denied (the caller keeps its known pick).
 * YouTube writes this for manual picks and quality range calls alike.
 */
export function readQualityRecord(storage, now) {
  if (!storage) return null;
  let stored;
  try { stored = storage.getItem(QUALITY_KEY); }
  catch { return undefined; }
  try {
    const record = JSON.parse(stored);
    if (!record || !record.data || Number(record.expiration) < now) return null;
    const data = JSON.parse(record.data);
    let level = null;
    if (data && data.quality !== 4320) {
      for (const name of Object.keys(QUALITY_HEIGHTS)) {
        if (QUALITY_HEIGHTS[name] === data.quality) level = name;
      }
    }
    return { level, at: Number(record.creation) || 0 };
  } catch {
    // A missing, expired or malformed record names no selection.
    return null;
  }
}
