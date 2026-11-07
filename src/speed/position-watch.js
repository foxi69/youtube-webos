// After a speed change reloads the video, on webOS 25:
// - loadVideoById(id, at) starts up to ~25 s before `at`, even at 1x without
//   the engine: once the video plays, it is moved back.
// - Above CAP_ABOVE (playback-speed.js) the 1080p cap is set again then: the
//   reload drops it, and with a 60 fps video the frames a 60 Hz screen cannot
//   show count as dropped, so YouTube falls to 480p. 2160p cannot keep up at
//   1.5x (85% dropped).
// - YouTube can still fall to 480p after that: it counts those frames for a
//   while. Setting the cap again brings the picture back at once, so that is done
//   when it lasts, a few times at most (on a slow line it may be right to fall).
// - Setting the cap can reload the video again, and a reload sometimes leaves
//   the <video> waiting at 0 while the player buffers at its position, and
//   stays so. So the check goes on after the video has played, and seeks to the
//   player's position (which starts it) when that lasts.
// - It is about the video the speed changed on: another one opened within
//   those 25 s ends it, so nothing seeks or caps that one. The video is named
//   by the caller (the player may name none yet right after the reload), and
//   a tick on which the player names no video corrects nothing.

const TICK_MS = 250;
const WATCH_TICKS = 100; // 25 s
const STALL_TICKS = 12; // 3 s: the player gets a chance to seek on its own first.
const MAX_SEEKS = 2;
const LOW_TICKS = 8; // 2 s
const MAX_CAPS = 3;
const OFF_BY_S = 2;

/**
 * @param {Window} win
 * @param {object} player YouTube's player
 * @param {number} at the position the reload should continue from, in seconds
 * @param {() => void} onPlaying runs once, when the video first plays
 * @param {{isLow: () => boolean, setCap: () => void}} [quality] the speed's quality cap
 * @param {string} [targetId] the video the speed changed on (else the one the player names now)
 * @returns {() => void} stops the check
 */
export function watchPosition(win, player, at, onPlaying, quality, targetId) {
  let ticks = 0;
  let stalled = 0;
  let seeks = 0;
  let played = false;
  let low = 0;
  let caps = 0;

  const namesVideos = typeof player.getVideoData === 'function';
  const idOf = () => {
    const data = namesVideos ? player.getVideoData() : null;
    return (data && data.video_id) || null;
  };
  let videoId = targetId || null;
  if (!videoId) {
    try { videoId = idOf(); } catch { /* checked on each tick */ }
  }

  const stop = () => win.clearInterval(timer);
  const timer = win.setInterval(() => {
    let state;
    let now;
    let id;
    try {
      state = player.getPlayerState();
      now = player.getCurrentTime();
      id = idOf();
    } catch {
      stop();
      return;
    }
    // Another video now (an id while it loads may still be missing).
    if (videoId && id && id !== videoId) {
      stop();
      return;
    }
    if (!videoId) videoId = id;
    // No video named: it may be another one already, so nothing is corrected
    // on this tick; the check goes on.
    if (namesVideos && !id) {
      if (++ticks >= WATCH_TICKS) stop();
      return;
    }

    if (state === 1) {
      stalled = 0;
      if (!played) {
        played = true;
        if (Math.abs(now - at) > OFF_BY_S) player.seekTo(at, true);
        onPlaying();
      }
      low = quality && quality.isLow() ? low + 1 : 0;
      if (low >= LOW_TICKS && caps < MAX_CAPS) {
        low = 0;
        caps++;
        quality.setCap();
      }
    } else {
      const video = win.document.querySelector('video');
      const waiting = state === 3 && !!video && !video.seeking &&
        now > OFF_BY_S && Math.abs(video.currentTime - now) > OFF_BY_S;
      stalled = waiting ? stalled + 1 : 0;
      if (stalled >= STALL_TICKS && seeks < MAX_SEEKS) {
        stalled = 0;
        seeks++;
        player.seekTo(now, true);
      }
    }

    if (++ticks >= WATCH_TICKS) stop();
  }, TICK_MS);
  return stop;
}
