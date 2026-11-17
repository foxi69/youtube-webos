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
// A cap that was really set (setCap returned true) reloads the video; a few
// seconds into it that reload starts it again from 0 (webOS 25: raised at
// 3.0 s, on from 0.0; at 7.9 s it kept its place), so it is put back where
// the cap was set, while it still loads: buffering there at once stops the
// picture for a moment, where a seek once it plays again added a second
// wait. Only a start over while not playing counts: on the TV the reload
// read 0 in state 3 (buffering) 0.3-0.7 s after the call, three times of
// three, before it played again. A video that plays on from 0 by itself (a
// loop: Shorts, a repeated video) is no reload, and Shorts are left out.
// Not after a key press of the viewer's, nor for less than RESUME_MIN_S.
// RESUME_TICKS (3 s) is over four times the 0.7 s measured.
const RESUME_TICKS = 12;
const RESUME_MIN_S = 0.5;
// After a seek of the watch's own (the reload did not start where it should
// go on), the place to come back to is that seek's target; the check waits
// this many ticks first, for the seek to land, so it is not sent twice.
const RESUME_HOLD_TICKS = 2;
// The last position this close to the end, then near 0: the video looped.
const LOOP_END_S = 1;
// The highest speed (SUPPORTED_SPEEDS in mse-hook.js): how far a video can
// have played between two ticks, a late one too, when telling a loop.
const MAX_RATE = 2;

/**
 * @param {Window} win
 * @param {object} player YouTube's player
 * @param {number|null} at the position the reload should continue from, in
 *   seconds; null for a video that plays already (only stalls are corrected)
 * @param {() => boolean|void} onPlaying runs once, when the video first plays;
 *   true when it set the quality cap (which can reload the video)
 * @param {{isLow: () => boolean, setCap: () => boolean|void, keys?: () => number}} [quality]
 *   the speed's quality cap: setCap returns true when it set a range; keys
 *   counts the viewer's key presses
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
  let resumeSince = 0;
  let resumeKeys = 0;
  let resumeHold = 0;
  // Seen playing at resumeAt since it was set (so for a cap set where the video is).
  // Before that a start over may be the watch's own seek still under way: it
  // is sent again and the wait goes on, so the cap's reload after it is caught.
  let resumeLanded = true;
  // The position on the tick before and when it was read, to tell a loop from a reload.
  let lastNow = null;
  let lastNowAt = 0;
  // The page's clock (the window's, so a test can drive it with its timers).
  const clock = () => (win.Date || Date).now();
  const keys = () => (quality && typeof quality.keys === 'function' ? quality.keys() : 0);
  const onShorts = () => {
    const body = win.document && win.document.body;
    return !!body && !!body.classList && body.classList.contains('WEB_PAGE_TYPE_SHORTS');
  };
  // keysBefore: the count before the cap was set, so a key pressed while it
  // is set is the viewer's.
  const armResume = (pos, keysBefore, hold) => {
    if (onShorts()) return;
    resumeAt = pos;
    resumeTicks = 0;
    resumeSince = clock();
    resumeKeys = keysBefore;
    resumeHold = hold || 0;
    resumeLanded = !hold;
  };
  // The wait ends after RESUME_TICKS ticks, or that long by the clock: a TV
  // busy for seconds runs a late tick once, not once for each it missed.
  const resumeOver = () => ++resumeTicks > RESUME_TICKS || clock() - resumeSince > RESUME_TICKS * TICK_MS;
  const looped = (now) => {
    if (lastNow === null || typeof player.getDuration !== 'function') return false;
    let duration;
    try { duration = player.getDuration(); } catch { return false; }
    // As far as it can have played since (a late tick may have missed the end).
    const reach = lastNow + Math.max(0, clock() - lastNowAt) / 1000 * MAX_RATE;
    return duration > 0 && reach >= duration - LOOP_END_S && now <= OFF_BY_S;
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
      // The wait for the cap's reload runs on meanwhile: it ends on time, and
      // nothing is moved while no video is named.
      if (resumeAt !== null && resumeOver()) resumeAt = null;
      if (++ticks >= WATCH_TICKS) end();
      return;
    }

    if (resumeAt !== null) {
      // Playing there: buffering near it may still be the seek under way (a
      // seek to 3 s reading 1.5 s), which a start over is told by as well.
      if (state === 1 && Math.abs(now - resumeAt) <= OFF_BY_S) resumeLanded = true;
      if (resumeOver() || keys() !== resumeKeys || looped(now) || onShorts()) {
        resumeAt = null;
      } else if (resumeHold > 0) {
        resumeHold--;
      } else if (state !== 1 && now <= OFF_BY_S && resumeAt - now > RESUME_MIN_S) {
        // The cap's reload started it over: back where it was set. Once: a
        // player that cannot seek is not asked again on every tick. Our own
        // seek not seen landing yet: sent again after the hold, and waited for.
        const to = resumeAt;
        if (resumeLanded) resumeAt = null;
        else resumeHold = RESUME_HOLD_TICKS;
        try { player.seekTo(to, true); } catch { /* left where it is */ }
      }
    }
    lastNow = now;
    lastNowAt = clock();

    if (state === 1) {
      stalled = 0;
      if (!played) {
        played = true;
        const target = at !== null && Math.abs(now - at) > OFF_BY_S ? at : null;
        if (target !== null) {
          player.seekTo(target, true);
          // The read before the seek tells nothing of a loop after it.
          lastNow = null;
        }
        const keysBefore = keys();
        // onPlaying may set the cap (playback-speed.js), which can reload.
        // After a seek of our own the place to come back to is its target.
        if (onPlaying() === true && quality) {
          if (target === null) armResume(now, keysBefore);
          else armResume(target, keysBefore, RESUME_HOLD_TICKS);
        }
      }
      low = quality && quality.isLow() ? low + 1 : 0;
      if (low >= LOW_TICKS && caps < MAX_CAPS) {
        low = 0;
        caps++;
        const keysBefore = keys();
        if (quality.setCap() === true) armResume(now, keysBefore);
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
