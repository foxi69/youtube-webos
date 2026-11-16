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
//   stays so. So the check goes on after the video has played, and seeks to
//   just before the player's position when that lasts: a seek to the position
//   itself left it waiting (5 of 5 on webOS 25), 0.5 s before started it.
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
const STALL_BACK_S = 0.5;
// After the cap is set: how long a reload it causes is waited for (10 s).
// Such a reload a few seconds into a video starts it again from 0 (webOS 25:
// raised at 3.0 s, played on from 0.0; at 7.9 s it kept its place), so a
// video that starts over is put back where the cap was set, while it still
// loads: buffering there at once stops the picture for a moment, where a
// seek once it plays again added a second wait. Not after a key press of
// the viewer's (a seek of theirs), and not for less than RESUME_MIN_S.
const RESUME_TICKS = 40;
const RESUME_MIN_S = 0.5;

/**
 * @param {Window} win
 * @param {object} player YouTube's player
 * @param {number|null} at the position the reload should continue from, in
 *   seconds; null for a video that plays already (only stalls are corrected)
 * @param {() => void} onPlaying runs once, when the video first plays
 * @param {{isLow: () => boolean, setCap: () => void, keys?: () => number}} [quality]
 *   the speed's quality cap; keys counts the viewer's key presses
 * @param {string} [targetId] the video the speed changed on (else the one the player names now)
 * @param {() => void} [onEnd] runs when the check ends by itself (25 s, another
 *   video, a player that throws), not when the caller stops it
 * @returns {(() => void) & {running: () => boolean}} stops the check; running() is false once it ended
 */
export function watchPosition(win, player, at, onPlaying, quality, targetId, onEnd) {
  let ticks = 0;
  let stalled = 0;
  let seeks = 0;
  let played = false;
  let low = 0;
  let caps = 0;
  // Where the cap was last set, while its reload may still come (null: none).
  let resumeAt = null;
  let resumeTicks = 0;
  let resumeKeys = 0;
  const keys = () => (quality && typeof quality.keys === 'function' ? quality.keys() : 0);
  const armResume = (pos) => {
    resumeAt = pos;
    resumeTicks = 0;
    resumeKeys = keys();
  };

  const namesVideos = typeof player.getVideoData === 'function';
  const idOf = () => {
    const data = namesVideos ? player.getVideoData() : null;
    return (data && data.video_id) || null;
  };
  let videoId = targetId || null;
  if (!videoId) {
    try { videoId = idOf(); } catch { /* checked on each tick */ }
  }

  let running = true;
  const stop = () => { running = false; win.clearInterval(timer); };
  stop.running = () => running;
  const end = () => {
    stop();
    if (onEnd) onEnd();
  };
  const timer = win.setInterval(() => {
    let state;
    let now;
    let id;
    try {
      state = player.getPlayerState();
      now = player.getCurrentTime();
      id = idOf();
    } catch {
      end();
      return;
    }
    // Another video now (an id while it loads may still be missing).
    if (videoId && id && id !== videoId) {
      end();
      return;
    }
    if (!videoId) videoId = id;
    // No video named: it may be another one already, so nothing is corrected
    // on this tick; the check goes on.
    if (namesVideos && !id) {
      if (++ticks >= WATCH_TICKS) end();
      return;
    }

    if (resumeAt !== null) {
      if (++resumeTicks > RESUME_TICKS || keys() !== resumeKeys) {
        resumeAt = null;
      } else if (now <= OFF_BY_S && resumeAt - now > RESUME_MIN_S) {
        // The cap's reload started it over: back where it was set.
        player.seekTo(resumeAt, true);
        resumeAt = null;
      }
    }

    if (state === 1) {
      stalled = 0;
      if (!played) {
        played = true;
        const target = at !== null && Math.abs(now - at) > OFF_BY_S ? at : null;
        if (target !== null) player.seekTo(target, true);
        onPlaying();
        // onPlaying may set the cap (playback-speed.js), which can reload. Not
        // armed after a seek of our own: its position is not known yet.
        if (quality && target === null) armResume(now);
      }
      low = quality && quality.isLow() ? low + 1 : 0;
      if (low >= LOW_TICKS && caps < MAX_CAPS) {
        low = 0;
        caps++;
        // Armed first: a key pressed while the cap is set is the viewer's.
        armResume(now);
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
        player.seekTo(now - STALL_BACK_S, true);
      }
    }

    if (++ticks >= WATCH_TICKS) end();
  }, TICK_MS);
  return stop;
}
