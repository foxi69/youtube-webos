import { isWatchPage, isShortsPage, getVideo } from './utils.js';

/**
 * Watch time: how long videos have played since the app started, for the
 * clock in the corner ("14:05 · 1h 05m watched"). Asked for in
 * NicholasBly/youtube-webos#203 (fork watch #51).
 *
 * Counted is the wall time a <video> plays on the watch or Shorts page: from
 * its 'playing' event to the pause, the end or a stall, so buffering, a
 * paused video, the browse pages and their previews do not count. It lives in
 * memory only and starts again with the app.
 */

let totalMs = 0;
// The <video> being counted, and since when.
let playingVideo = null;
let playingSince = 0;

function start(video) {
  if (playingVideo === video) return;
  stop();
  playingVideo = video;
  playingSince = Date.now();
}

function stop() {
  if (!playingVideo) return;
  totalMs += Math.max(0, Date.now() - playingSince);
  playingVideo = null;
}

function onPlaying(evt) {
  const video = evt.target;
  if (!(video instanceof HTMLVideoElement)) return;
  if ((isWatchPage() || isShortsPage()) && !document.hidden) start(video);
}

function onStopped(evt) {
  if (evt.target === playingVideo) stop();
}

/** Milliseconds of playback this session, the running stretch included. */
export function watchTimeMs() {
  return totalMs + (playingVideo ? Math.max(0, Date.now() - playingSince) : 0);
}

/** "42m", or "1h 05m" from an hour on. */
export function formatWatchTime(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return `${h}h ${m < 10 ? '0' : ''}${m}m`;
}

// Media events do not bubble; capturing on document covers every <video>.
document.addEventListener('playing', onPlaying, true);
['pause', 'ended', 'waiting', 'emptied', 'abort', 'error'].forEach((type) => {
  document.addEventListener(type, onStopped, true);
});
// Leaving the player, or the app going to the background, ends a stretch;
// the next 'playing' starts one.
window.addEventListener('ytaf-page-update', () => {
  if (!isWatchPage() && !isShortsPage()) {
    stop();
    return;
  }
  // A video that started a moment before the page type changed.
  const video = getVideo();
  if (video && !video.paused && !video.ended && !document.hidden) start(video);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
});
