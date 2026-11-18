/**
 * Repeat Video, a shortcut action: the video playing now starts again from
 * its beginning at its end, instead of YouTube going on to the next video or
 * to its end screen. Pressed again, it is off. It belongs to the video it was
 * turned on for: another video, or leaving the watch page, ends it.
 *
 * YouTube's player takes the <video>'s 'ended' to the next video or the end
 * screen, so the video is sent back to the start just before it gets there.
 */
import { getVideo, isLiveStream, SELECTORS } from './utils.js';

// How close to the end, in seconds of playback at 1x, the video goes back to
// the start. 'timeupdate' comes about every 250 ms (not a promise of the
// spec), so the window holds about two of them; it grows with the playback
// rate, so it does too at 2x. A 'timeupdate' late by more than that misses it
// and YouTube takes the video's end as usual.
const END_MARGIN_S = 0.6;

// The id of the video being repeated, or null.
let repeatId = null;

function videoIdOf(hash) {
  const m = /[?&]v=([\w-]{11})/.exec(hash);
  return m ? m[1] : null;
}

function currentVideoId() {
  return videoIdOf(location.hash);
}

/** Whether the video open now is being repeated. */
export function isRepeatOn() {
  return repeatId !== null && repeatId === currentVideoId();
}

/**
 * Turns Repeat Video on for the video open now, or off. Returns true (on),
 * false (off) or null when no video is open (Shorts, which loop anyway).
 */
export function toggleRepeat() {
  if (isRepeatOn()) {
    repeatId = null;
    return false;
  }
  repeatId = currentVideoId();
  return repeatId === null ? null : true;
}

function onTimeUpdate(evt) {
  if (repeatId === null) return;
  const video = evt.target;
  if (video !== getVideo()) return;
  if (currentVideoId() !== repeatId) {
    repeatId = null;
    return;
  }
  // Paused or seeking: a viewer who put it near the end keeps it there.
  if (video.paused || video.seeking) return;
  const duration = video.duration;
  const margin = END_MARGIN_S * Math.max(1, video.playbackRate || 1);
  // No end (Infinity) or a very short video: left alone.
  if (!isFinite(duration) || duration <= margin * 2) return;
  if (video.currentTime < duration - margin) return;
  // A live stream's end is its live edge, where it plays all along; its
  // duration is not always Infinity, so the player is asked. Only a video it
  // says is not live goes back; when it cannot say, the video is left alone.
  if (isLiveStream(document.getElementById(SELECTORS.PLAYER_ID), video) !== false) return;
  video.currentTime = 0;
}

// Media events do not bubble; capturing on document covers every <video>.
document.addEventListener('timeupdate', onTimeUpdate, true);
window.addEventListener('ytaf-page-update', (evt) => {
  if (!evt.detail || !evt.detail.isWatch) repeatId = null;
});
// Another video ends it at once, whether or not that video ever played: back
// on the first one, repeat stays off. The event's own newURL is read, not
// location: after A -> B -> A in quick turns, both events would find A there.
window.addEventListener('hashchange', (evt) => {
  const url = evt.newURL || location.href;
  const hash = url.indexOf('#') < 0 ? '' : url.slice(url.indexOf('#'));
  if (repeatId !== null && videoIdOf(hash) !== repeatId) repeatId = null;
});
