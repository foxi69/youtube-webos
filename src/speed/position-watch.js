// After a speed change reloads the video, on webOS 25:
// - loadVideoById(id, at) starts up to ~25 s before `at`, even at 1x without
//   the engine: once the video plays, it is moved back.
// - Above CAP_ABOVE (playback-speed.js) the 1080p cap is set again then: the
//   reload drops it, and with a 60 fps video the frames a 60 Hz screen cannot
//   show count as dropped, so YouTube falls to 480p. 2160p cannot keep up at
//   1.5x (85% dropped).
// - Setting the cap can reload the video again, and a reload sometimes leaves
//   the <video> waiting at 0 while the player buffers at its position, and
//   stays so. So the check goes on after the video has played, and seeks to the
//   player's position (which starts it) when that lasts.

const TICK_MS = 250;
const WATCH_TICKS = 100; // 25 s
const STALL_TICKS = 12; // 3 s: the player gets a chance to seek on its own first.
const MAX_SEEKS = 2;
const OFF_BY_S = 2;

/**
 * @param {Window} win
 * @param {object} player YouTube's player
 * @param {number} at the position the reload should continue from, in seconds
 * @param {() => void} onPlaying runs once, when the video first plays
 * @returns {() => void} stops the check
 */
export function watchPosition(win, player, at, onPlaying) {
  let ticks = 0;
  let stalled = 0;
  let seeks = 0;
  let played = false;

  const stop = () => win.clearInterval(timer);
  const timer = win.setInterval(() => {
    let state;
    let now;
    try {
      state = player.getPlayerState();
      now = player.getCurrentTime();
    } catch {
      stop();
      return;
    }

    if (state === 1) {
      stalled = 0;
      if (!played) {
        played = true;
        if (Math.abs(now - at) > OFF_BY_S) player.seekTo(at, true);
        onPlaying();
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
