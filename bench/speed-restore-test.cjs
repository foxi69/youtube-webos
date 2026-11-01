/**
 * Behaviour test for the position check after a speed change
 * (src/speed/position-watch.js), with a fake player, video element and timers.
 * The stuck case is what a webOS 25 TV showed: the player buffering at its
 * position while the reloaded <video> waits at 0.
 *
 * Usage: node bench/speed-restore-test.cjs
 */
/* global __dirname */
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
    watchPosition(s.win, s.player, AT, () => {});
    s.run(2000);
    t('not at once: the player may still seek by itself', s.player.seeks.length === 0, s.player.seeks.join());
    s.run(2000);
    t('stuck at 0: seeks to the player\'s position', s.player.seeks.join() === '11.2', s.player.seeks.join());
    s.video.currentTime = AT;
    s.player.state = 1;
    s.run(30000);
    t('once it plays it is left alone', s.player.seeks.length === 1, s.player.seeks.join());
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
    t('stuck after the cap\'s reload: seeks too', s.player.seeks.join() === '11.2', s.player.seeks.join());
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
    const s = setup({ state: 3, t: AT, vt: 0 });
    s.player.getCurrentTime = () => { throw new Error('player gone'); };
    watchPosition(s.win, s.player, AT, () => {});
    s.run(1000);
    t('a player that went away ends the check', s.timers.size === 0, s.timers.size);
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((err) => {
  console.log(`FAIL could not run: ${err && err.message}`);
  process.exit(1);
});
