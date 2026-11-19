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
// at 1x, the video goes back to the start. The window grows with the playback
// rate and is at most a quarter of the video; for the shortest video repeated
// (over 1.2 s) that is over 0.3 s, more than the 0.2 s a look moves at 2x.
const CHECK_MS = 100;
const END_MARGIN_S = 0.6;
// A seek this close to the end while it plays is sent to the start: on the TV
// (webOS 25) YouTube moved on about 0.5 s after a seek into the last 0.5, 0.8
// or 1.0 s, with repeat on or not, and not after one to 1.3 s or more before
// the end. At most a quarter of the video.
const END_SNAP_S = 1.2;
const snapWindow = (duration) => Math.min(END_SNAP_S, duration / 4);

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

/**
 * Turns Repeat Video on for the video open now, or off, and returns the
 * message for it. Not on a page with no video id (Shorts, which loop anyway),
 * a live stream or a very short video; a video whose length is not known yet
 * can be turned on.
 */
export function toggleRepeat() {
  const id = currentVideoId();
  if (repeatId !== null && repeatId === id) {
    repeatId = null;
    return 'Repeat Video Off';
  }
  if (id === null) return 'Repeat Video: no video to repeat here';
  const video = getVideo();
  if (video && isLiveStream(document.getElementById(SELECTORS.PLAYER_ID), video) === true) {
    return 'Repeat Video: not on a live stream';
  }
  if (video && video.duration <= END_MARGIN_S * 2) return 'Repeat Video: the video is too short';
  repeatId = id;
  if (timer === null) timer = setInterval(check, CHECK_MS);
  return 'Repeat Video On';
}

function check() {
  if (repeatId !== null && currentVideoId() !== repeatId) repeatId = null;
  if (repeatId === null) {
    clearInterval(timer);
    timer = null;
    return;
  }
  const video = getVideo();
  if (!video) return;
  const duration = video.duration;
  // No end (Infinity) or a very short video: left alone.
  if (!isFinite(duration) || duration <= END_MARGIN_S * 2) return;
  // A seek to the very end while it plays (on modern builds SponsorBlock's
  // auto-skip of an outro goes there) or an ended video goes back too: the
  // player moves on from there. Otherwise, paused or seeking: a viewer who put
  // it near the end keeps it there.
  const atEnd = video.ended || (!video.paused && video.seeking && video.currentTime >= duration - snapWindow(duration));
  if (!atEnd && (video.paused || video.seeking)) return;
  // At most a quarter of the video, so a short one at 2x still plays through.
  const margin = Math.min(END_MARGIN_S * Math.max(1, video.playbackRate || 1), duration / 4);
  if (!atEnd && video.currentTime < duration - margin) return;
  // A live stream's end is its live edge, where it plays all along; its
  // duration is not always Infinity, so the player is asked. Only a video it
  // says is not live goes back; when it cannot say, the video is left alone.
  if (isLiveStream(document.getElementById(SELECTORS.PLAYER_ID), video) !== false) return;
  video.currentTime = 0;
  // An ended video stays paused at the start without this.
  if (video.paused) {
    const played = video.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  }
}

// A seek to the end while it plays (on modern builds SponsorBlock's auto-skip
// of an outro goes there, or the viewer seeks into the last second) ends the
// video, and the player or the queue moves on before the timer looks (seen on
// the TV). The seek is sent
// to the start while it begins. A paused video is the viewer's: left where it
// was put. Media events do not bubble: caught on the way down.
document.addEventListener('seeking', (evt) => {
  const video = evt.target;
  if (repeatId === null || currentVideoId() !== repeatId || video !== getVideo() || video.paused) return;
  const duration = video.duration;
  if (!isFinite(duration) || duration <= END_MARGIN_S * 2) return;
  if (video.currentTime < duration - snapWindow(duration)) return;
  if (isLiveStream(document.getElementById(SELECTORS.PLAYER_ID), video) !== false) return;
  video.currentTime = 0;
}, true);

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
