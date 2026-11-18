/**
 * Repeat Video, a shortcut action: the video playing now starts again from
 * its beginning at its end, instead of YouTube going on to the next video or
 * to its end screen. Pressed again, it is off. It belongs to the video it was
 * turned on for: another video, or leaving the watch page, ends it.
 *
 * YouTube's player goes on by itself at the video's end: on the TV (webOS 25)
 * it went on to the queued video even with 'ended' stopped before it, when no
 * 'timeupdate' came in the last 2 s. So the video is sent back to the start
 * just before it gets there, from a timer of its own that runs while repeat
 * is on, not from the media events.
 */
import { getVideo, isLiveStream, SELECTORS } from './utils.js';

// How often the timer looks, and how close to the end, in seconds of playback
// at 1x, the video goes back to the start: three looks fall within it. It
// grows with the playback rate, so at 2x too.
const CHECK_MS = 200;
const END_MARGIN_S = 0.6;

// The id of the video being repeated, or null.
let repeatId = null;
let timer = null;

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
  if (repeatId === null) return null;
  if (timer === null) timer = setInterval(check, CHECK_MS);
  return true;
}

function check() {
  if (repeatId !== null && currentVideoId() !== repeatId) repeatId = null;
  if (repeatId === null) {
    clearInterval(timer);
    timer = null;
    return;
  }
  const video = getVideo();
  // Paused or seeking: a viewer who put it near the end keeps it there.
  if (!video || video.paused || video.seeking) return;
  const duration = video.duration;
  // No end (Infinity) or a very short video: left alone.
  if (!isFinite(duration) || duration <= END_MARGIN_S * 2) return;
  // At most a quarter of the video, so a short one at 2x still plays through.
  const margin = Math.min(END_MARGIN_S * Math.max(1, video.playbackRate || 1), duration / 4);
  if (video.currentTime < duration - margin) return;
  // A live stream's end is its live edge, where it plays all along; its
  // duration is not always Infinity, so the player is asked. Only a video it
  // says is not live goes back; when it cannot say, the video is left alone.
  if (isLiveStream(document.getElementById(SELECTORS.PLAYER_ID), video) !== false) return;
  video.currentTime = 0;
}

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
