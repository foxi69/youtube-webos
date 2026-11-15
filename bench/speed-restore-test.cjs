/**
 * Behaviour test for the position check after a speed change
 * (src/speed/position-watch.js), with a fake player, video element and timers.
 * The stuck case is what a webOS 25 TV showed: the player buffering at its
 * position while the reloaded <video> waits at 0.
 *
 * Usage: node bench/speed-restore-test.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(path.resolve(__dirname, '../src/speed/position-watch.js')).href;

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

/** A fake player and <video> on fake timers; run(ms) moves the clock. */
function setup(start) {
  const timers = new Map();
  let id = 0;
  let clock = 0;
  const video = { currentTime: start.vt, seeking: false };
  const player = {
    state: start.state,
    time: start.t,
    seeks: [],
    videoId: 'abcdefghijk',
    getVideoData() { return { video_id: this.videoId }; },
    getPlayerState() { return this.state; },
    getCurrentTime() { return this.time; },
    seekTo(to) { this.seeks.push(to); }
  };
  const win = {
    document: { querySelector: (s) => (s === 'video' ? video : null) },
    setInterval: (fn, ms) => { timers.set(++id, { fn, at: clock + ms, ms }); return id; },
    clearInterval: (i) => timers.delete(i)
  };
  const run = (ms) => {
    const end = clock + ms;
    for (;;) {
      let next = null;
      for (const v of timers.values()) if (v.at <= end && (!next || v.at < next.at)) next = v;
      if (!next) break;
      clock = next.at;
      next.at += next.ms;
      next.fn();
    }
    clock = end;
  };
  return { win, player, video, run, timers };
}

import(MODULE).then(({ watchPosition }) => {
  const AT = 11.2;

  {
    // The picture at 0, the player buffering at 11.2 s.
    const s = setup({ state: 3, t: AT, vt: 0 });
    const watch = watchPosition(s.win, s.player, AT, () => {});
    t('the check says it runs', watch.running() === true);
    s.run(2000);
    t('not at once: the player may still seek by itself', s.player.seeks.length === 0, s.player.seeks.join());
    s.run(2000);
    // Just before: a seek to the position itself left it waiting on a TV.
    t('stuck at 0: seeks to just before the player\'s position', s.player.seeks.join() === '10.7', s.player.seeks.join());
    s.video.currentTime = AT;
    s.player.state = 1;
    s.run(30000);
    t('once it plays it is left alone', s.player.seeks.length === 1, s.player.seeks.join());
    // A reload's watch is kept by capNext while it runs: it must say when it ended on its own.
    t('ended on its own after 25 s, it says so', watch.running() === false);
  }
  {
    // Plays first, then the reload of the quality cap leaves the picture at 0.
    const s = setup({ state: -1, t: AT, vt: AT });
    let caps = 0;
    watchPosition(s.win, s.player, AT, () => { caps++; });
    s.player.state = 1;
    s.run(500);
    t('the cap is set once when it plays', caps === 1, caps);
    s.player.state = 3;
    s.video.currentTime = 0;
    s.run(4000);
    t('stuck after the cap\'s reload: seeks too', s.player.seeks.join() === '10.7', s.player.seeks.join());
    t('the cap is not set again', caps === 1, caps);
  }
  {
    // Never recovers: a couple of tries, not a seek every few seconds for ever.
    const s = setup({ state: 3, t: AT, vt: 0 });
    watchPosition(s.win, s.player, AT, () => {});
    s.run(60000);
    t('gives up after two tries', s.player.seeks.length === 2, s.player.seeks.join());
    t('and stops its timer', s.timers.size === 0, s.timers.size);
  }
  {
    const s = setup({ state: 3, t: AT, vt: AT });
    watchPosition(s.win, s.player, AT, () => {});
    s.run(30000);
    t('buffering at the right place is left alone', s.player.seeks.length === 0, s.player.seeks.join());
  }
  {
    const s = setup({ state: 3, t: AT, vt: 0 });
    s.video.seeking = true;
    watchPosition(s.win, s.player, AT, () => {});
    s.run(30000);
    t('a seek under way is left alone', s.player.seeks.length === 0, s.player.seeks.join());
  }
  {
    const s = setup({ state: 3, t: 1, vt: 0 });
    watchPosition(s.win, s.player, 1, () => {});
    s.run(30000);
    t('the very start of a video is left alone', s.player.seeks.length === 0, s.player.seeks.join());
  }
  {
    // No position to restore (a next video's quality check): the viewer seeked
    // to 60 s as it started, before the first tick.
    const s = setup({ state: 1, t: 60, vt: 60 });
    watchPosition(s.win, s.player, null, () => {});
    s.run(1000);
    t('no position to restore: a seek made as it starts is not undone', s.player.seeks.length === 0,
      s.player.seeks.join());
  }
  {
    const s = setup({ state: 3, t: AT, vt: 0 });
    watchPosition(s.win, s.player, null, () => {});
    s.run(4000);
    t('no position to restore: a stall is still started', s.player.seeks.join() === '10.7', s.player.seeks.join());
  }
  {
    // webOS 25 starts the reload up to 25 s early: back to the position, once.
    const s = setup({ state: -1, t: AT, vt: AT });
    watchPosition(s.win, s.player, AT, () => {});
    s.player.state = 1;
    s.player.time = 2;
    s.video.currentTime = 2;
    s.run(500);
    t('a reload that starts early is moved back', s.player.seeks.join() === '11.2', s.player.seeks.join());
    s.player.time = 40;
    s.video.currentTime = 40;
    s.run(5000);
    t('normal playback later is not moved back', s.player.seeks.length === 1, s.player.seeks.join());
  }
  {
    // A second speed change stops the first one's check.
    const s = setup({ state: 3, t: AT, vt: 0 });
    const stop = watchPosition(s.win, s.player, AT, () => {});
    stop();
    t('stop() ends the check', s.timers.size === 0, s.timers.size);
    s.run(10000);
    t('and nothing seeks after it', s.player.seeks.length === 0, s.player.seeks.join());
  }
  {
    // YouTube falls below the cap while it plays: the cap again, not for ever.
    const s = setup({ state: 1, t: AT, vt: AT });
    let isLow = false;
    let caps = 0;
    watchPosition(s.win, s.player, AT, () => {}, { isLow: () => isLow, setCap: () => { caps++; } });
    s.run(3000);
    t('at the cap: nothing to do', caps === 0, caps);
    isLow = true;
    // Exactly 2 s: 7 low ticks of 250 ms are not enough, the 8th sets it.
    s.run(1750);
    t('a short dip (7 ticks, 1.75 s) is left alone', caps === 0, caps);
    s.run(250);
    t('it lasts 2 s (the 8th tick): the cap is set again', caps === 1, caps);
    isLow = false;
    s.run(5000);
    t('back up: no more', caps === 1, caps);
    isLow = true;
    s.run(15000);
    t('a few times at most', caps === 3, caps);
  }
  {
    const s = setup({ state: 3, t: AT, vt: 0 });
    s.player.getCurrentTime = () => { throw new Error('player gone'); };
    watchPosition(s.win, s.player, AT, () => {});
    s.run(1000);
    t('a player that went away ends the check', s.timers.size === 0, s.timers.size);
  }

  {
    // Another video opened within the check's 25 s: it is not touched.
    const s = setup({ state: 3, t: AT, vt: AT });
    let caps = 0;
    watchPosition(s.win, s.player, AT, () => { caps++; }, { isLow: () => true, setCap: () => { caps++; } });
    s.run(1000);
    s.player.videoId = 'otherother1';
    s.player.state = 1;
    s.player.time = 3;
    s.video.currentTime = 3;
    s.run(5000);
    t('another video opened meanwhile is neither moved nor capped', s.player.seeks.length === 0 && caps === 0,
      `seeks ${s.player.seeks.join()}, caps ${caps}`);
    t('and the check ends', s.timers.size === 0, s.timers.size);
  }
  {
    // While the reload loads, the player may name no video yet.
    const s = setup({ state: -1, t: AT, vt: AT });
    watchPosition(s.win, s.player, AT, () => {});
    s.player.videoId = '';
    s.run(1000);
    s.player.videoId = 'abcdefghijk';
    s.player.state = 1;
    s.player.time = 2;
    s.video.currentTime = 2;
    s.run(500);
    t('a moment with no video named does not end the check', s.player.seeks.join() === '11.2', s.player.seeks.join());
  }
  {
    // Right after the reload the player names no video yet; the caller names
    // the one the speed changed on, so another one opened later is still seen.
    const s = setup({ state: -1, t: AT, vt: AT });
    s.player.videoId = '';
    let caps = 0;
    watchPosition(s.win, s.player, AT, () => { caps++; }, { isLow: () => true, setCap: () => { caps++; } }, 'abcdefghijk');
    s.run(1000);
    s.player.videoId = 'otherother1';
    s.player.state = 1;
    s.player.time = 3;
    s.video.currentTime = 3;
    s.run(5000);
    t('no video named at the start: another one opened later is neither moved nor capped',
      s.player.seeks.length === 0 && caps === 0, `seeks ${s.player.seeks.join()}, caps ${caps}`);
    t('and the check ends', s.timers.size === 0, s.timers.size);
  }
  {
    // A video plays before the player names it: it may be another one, so
    // nothing is corrected until it is named.
    const s = setup({ state: -1, t: AT, vt: AT });
    let caps = 0;
    watchPosition(s.win, s.player, AT, () => { caps++; }, { isLow: () => true, setCap: () => { caps++; } }, 'abcdefghijk');
    s.player.videoId = '';
    s.player.state = 1;
    s.player.time = 3;
    s.video.currentTime = 3;
    s.run(3000);
    t('playing with no video named: nothing moved or capped', s.player.seeks.length === 0 && caps === 0,
      `seeks ${s.player.seeks.join()}, caps ${caps}`);
    t('and the check goes on', s.timers.size === 1, s.timers.size);
    s.player.videoId = 'abcdefghijk';
    s.run(250);
    t('named as the reloaded video: moved back then', s.player.seeks.join() === '11.2' && caps === 1,
      `seeks ${s.player.seeks.join()}, caps ${caps}`);
  }

  {
    // onEnd: the check ending by itself, not stopped by the caller.
    const ends = [];
    const a = setup({ state: 3, t: AT, vt: AT });
    watchPosition(a.win, a.player, AT, () => {}, null, 'abcdefghijk', () => ends.push('25 s'));
    a.run(30000);
    const b = setup({ state: 3, t: AT, vt: AT });
    watchPosition(b.win, b.player, AT, () => {}, null, 'abcdefghijk', () => ends.push('other video'));
    b.player.videoId = 'otherother1';
    b.run(500);
    const c = setup({ state: 3, t: AT, vt: AT });
    const stop = watchPosition(c.win, c.player, AT, () => {}, null, 'abcdefghijk', () => ends.push('stopped'));
    stop();
    c.run(30000);
    t('onEnd runs when the check ends by itself, not when it is stopped',
      ends.join() === '25 s,other video', ends.join());
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((err) => {
  console.log(`FAIL could not run: ${err && err.message}`);
  process.exit(1);
});
