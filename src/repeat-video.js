/**
 * Repeat Video, a shortcut action: the video playing now starts again from
 * its beginning at its end, instead of YouTube going on to the next video or
 * to its end screen. Pressed again, it is off. It belongs to the video it was
 * turned on for: another video, or leaving the watch page, ends it.
 *
 * YouTube's player takes the <video>'s 'ended' to the next video or the end
 * screen, so the video is sent back to the start just before it gets there.
 * When no 'timeupdate' fell close enough to the end, 'ended' itself is caught
 * before YouTube's player hears it.
 */
import { getVideo, isLiveStream, SELECTORS } from './utils.js';

// How close to the end, in seconds of playback at 1x, the video goes back to
// the start. 'timeupdate' comes about every 250 ms (not a promise of the
// spec), so the window holds about two of them; it grows with the playback
// rate, so it does too at 2x. One late by more than that leaves it to 'ended'.
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

/** Whether this <video> is the one being repeated, and may start again. */
function repeats(video) {
  if (repeatId === null || video !== getVideo()) return false;
  if (currentVideoId() !== repeatId) {
    repeatId = null;
    return false;
  }
  // No end (Infinity) or a very short video: left alone.
  if (!isFinite(video.duration) || video.duration <= END_MARGIN_S * 2) return false;
  // A live stream's end is its live edge, where it plays all along; its
  // duration is not always Infinity, so the player is asked. Only a video it
  // says is not live goes back; when it cannot say, the video is left alone.
  return isLiveStream(document.getElementById(SELECTORS.PLAYER_ID), video) === false;
}

function onTimeUpdate(evt) {
  if (repeatId === null) return;
  const video = evt.target;
  // Paused or seeking: a viewer who put it near the end keeps it there.
  if (video.paused || video.seeking) return;
  // At most a quarter of the video, so a short one at 2x still plays through.
  const margin = Math.min(END_MARGIN_S * Math.max(1, video.playbackRate || 1), video.duration / 4);
  if (!(video.currentTime >= video.duration - margin)) return;
  if (repeats(video)) video.currentTime = 0;
}

// The end reached all the same: it starts again, and YouTube's player, which
// listens on the <video> itself, never hears of it.
function onEnded(evt) {
  const video = evt.target;
  if (!repeats(video)) return;
  evt.stopImmediatePropagation();
  video.currentTime = 0;
  const playing = video.play();
  if (playing && playing.catch) playing.catch(() => {});
}

// Media events do not bubble; capturing covers every <video>, and on window
// it runs before the listeners on the <video>.
document.addEventListener('timeupdate', onTimeUpdate, true);
window.addEventListener('ended', onEnded, true);
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
