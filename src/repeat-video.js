/**
 * Repeat Video, a shortcut action: the video playing now starts again from
 * its beginning at its end, instead of YouTube going on to the next video or
 * to its end screen. Pressed again, it is off. It belongs to the video it was
 * turned on for: another video, or leaving the watch page, ends it.
 *
 * YouTube's player takes the <video>'s 'ended' to the next video or the end
 * screen, so the video is sent back to the start just before it gets there.
 */
import { getVideo } from './utils.js';

// How close to the end the video goes back to the start. 'timeupdate' comes
// about every 250 ms, so the last one before the end always falls within it.
const END_MARGIN_S = 0.6;

// The id of the video being repeated, or null.
let repeatId = null;

function currentVideoId() {
  const m = /[?&]v=([\w-]{11})/.exec(location.hash);
  return m ? m[1] : null;
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
  const duration = video.duration;
  // A live stream has no end (Infinity); a very short video is left alone.
  if (!isFinite(duration) || duration <= END_MARGIN_S * 2) return;
  if (video.currentTime >= duration - END_MARGIN_S) video.currentTime = 0;
}

// Media events do not bubble; capturing on document covers every <video>.
document.addEventListener('timeupdate', onTimeUpdate, true);
window.addEventListener('ytaf-page-update', (evt) => {
  if (!evt.detail || !evt.detail.isWatch) repeatId = null;
});
