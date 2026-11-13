// What a speed change must not lose (playback-speed.js): the video is
// reloaded with loadVideoById, after which YouTube picks the subtitles and the
// quality again by itself.
// - Subtitles: the track (or none) in use before the reload is put back once
//   the reloaded video plays, and again while the captions module settles, so
//   subtitles turned off stay off and turned on stay on.
// - Quality: the one the viewer picked in YouTube's menu, which YouTube keeps
//   in the yt-player-quality record (video-quality.js writes its own there).

import { diag, describeTrack, captionsInfo } from './diag.js';

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

/** Puts `saved` (from readCaptions) back when the player shows something else. */
export function applyCaptions(player, saved) {
  if (!saved) {
    diag('captions: nothing kept (unreadable before the reload)');
    return;
  }
  const now = readCaptions(player);
  // Unreadable now: only turning subtitles on is worth a try.
  if (now ? sameCaptions(now, saved) : !isOn(saved)) {
    diag(`captions: left as is, now: ${describeTrack(now)}, kept: ${describeTrack(saved)}`);
    return;
  }
  try {
    if (isOn(saved) && typeof player.loadModule === 'function') player.loadModule('captions');
    player.setOption('captions', 'track', isOn(saved) ? saved : {});
    diag(`captions: set ${isOn(saved) ? 'on' : 'off'}, was: ${describeTrack(now)}, after: ${captionsInfo(player)}`);
  } catch (e) {
    diag(`captions: setOption failed: ${e && e.message}`);
  }
}

/**
 * Puts the subtitles back now and at CAPTION_CHECKS_MS; a key the viewer
 * presses meanwhile (`userKeyAt` after now) ends it, so a change by hand stays.
 * Returns what stops the checks still to come (the next reload calls it).
 */
export function keepCaptions(win, player, saved, userKeyAt) {
  if (!saved) return () => {};
  const startedAt = Date.now();
  let stopped = false;
  const check = () => {
    if (stopped || userKeyAt() > startedAt || player.isConnected === false) {
      diag(`captions check skipped: stopped: ${stopped}, key pressed: ${userKeyAt() > startedAt}, ` +
        `connected: ${player.isConnected}`);
      return;
    }
    applyCaptions(player, saved);
  };
  applyCaptions(player, saved);
  for (const ms of CAPTION_CHECKS_MS) win.setTimeout(check, ms);
  return () => {
    stopped = true;
  };
}

/**
 * The yt-player-quality record: `level` the quality it names ('hd720'...),
 * null for 4320 (Force Max Quality's, video-quality.js, or a range of Max) or
 * a height not known; `at` when it was written. Null without a record or once
 * it expired. YouTube writes it when the viewer picks a quality in its menu,
 * and also on every quality range call (playback-speed.js tells those apart).
 */
export function readQualityRecord(storage, now) {
  try {
    const record = JSON.parse(storage.getItem(QUALITY_KEY));
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
    // No storage, or a record of another shape.
    return null;
  }
}
