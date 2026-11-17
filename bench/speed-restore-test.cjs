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
const { createReporter } = require('./harness.cjs');

const MODULE = pathToFileURL(path.resolve(__dirname, '../src/speed/position-watch.js')).href;

const { t, run: runTest } = createReporter();

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

runTest(() => import(MODULE).then(({ watchPosition }) => {
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
    // A next video raised a few seconds in (null: it plays already): the
    // cap's reload starts it again from 0 (webOS 25), so it is put back.
    const s = setup({ state: 1, t: 0.5, vt: 0.5 });
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; } });
    s.run(1750);
    s.player.time = 3;
    s.run(250);
    t('low for 2 s: the cap is set', caps === 1, caps);
    s.player.state = 3;
    s.player.time = 0;
    s.run(1000);
    s.player.state = 1;
    s.player.time = 0.2;
    s.run(250);
    t('started over from 0: put back where the cap was set', s.player.seeks.join() === '3', s.player.seeks.join());
    s.run(5000);
    t('once', s.player.seeks.length === 1, s.player.seeks.join());
  }
  {
    // Raised 1.5 s in: also put back, not played again from 0.
    const s = setup({ state: 1, t: 0.2, vt: 0.2 });
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; } });
    s.run(1750);
    s.player.time = 1.5;
    s.run(250);
    s.player.state = 3;
    s.player.time = 0;
    s.run(500);
    t('raised 1.5 s in: put back to 1.5 s', s.player.seeks.join() === '1.5', s.player.seeks.join());
  }
  {
    // A key of the viewer's after the cap is set: what follows is theirs.
    const s = setup({ state: 1, t: 0.5, vt: 0.5 });
    let caps = 0;
    let keys = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; }, keys: () => keys });
    s.run(1750);
    s.player.time = 3;
    s.run(250);
    keys++;
    s.player.state = 3;
    s.player.time = 0;
    s.run(1000);
    s.player.state = 1;
    s.run(1000);
    t('a key pressed after the raise: the start over is left alone', caps === 1 && s.player.seeks.length === 0, `caps ${caps}, seeks ${s.player.seeks.join()}`);
  }
  // A 7 s video that loops by itself (Shorts, a repeated video) at 1.5x.
  const loopRun = (s, ticks) => {
    for (let i = 0; i < ticks; i++) {
      s.run(250);
      s.player.time += 0.25 * 1.5;
      if (s.player.time >= 7) s.player.time = 0.05;
    }
  };
  {
    // Below the cap, the call sets no range (setCap: nothing); it loops.
    const s = setup({ state: 1, t: 0.2, vt: 0.2 });
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; }, keys: () => 0 }, 'abcdefghijk');
    loopRun(s, 26);
    t('a cap call that set no range: a loop is not moved on', s.player.seeks.length === 0, s.player.seeks.join());
  }
  {
    // A speed change 4 s into it, no cap at all; it loops.
    const s = setup({ state: 1, t: 4, vt: 4 });
    watchPosition(s.win, s.player, 4, () => {}, { isLow: () => false, setCap: () => {}, keys: () => 0 }, 'abcdefghijk');
    loopRun(s, 20);
    t('no cap set: a loop after a speed change is not moved on', s.player.seeks.length === 0, s.player.seeks.join());
  }
  {
    // The same two with the page buffering at 0 right after, as a reload shows
    // it: a wait that was started all the same would move it now.
    const s = setup({ state: 1, t: 3, vt: 3 });
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; }, keys: () => 0 }, 'abcdefghijk');
    s.run(2250);
    s.player.state = 3;
    s.player.time = 0;
    s.run(1000);
    t('a cap call that set no range: buffering at 0 after it is not moved', caps === 1 && s.player.seeks.length === 0,
      `caps ${caps}, seeks ${s.player.seeks.join()}`);
    const b = setup({ state: 1, t: 40, vt: 40 });
    watchPosition(b.win, b.player, 40, () => {}, { isLow: () => false, setCap: () => {}, keys: () => 0 }, 'abcdefghijk');
    b.run(500);
    b.player.state = 3;
    b.player.time = 0;
    b.run(1000);
    t('no cap set at the first play: buffering at 0 after it is not moved', b.player.seeks.length === 0, b.player.seeks.join());
  }
  {
    // The video not named for longer than the wait (4 s), then back at 0 and
    // buffering: the wait ran out meanwhile.
    const s = setup({ state: 1, t: 3, vt: 3 });
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; }, keys: () => 0 }, 'abcdefghijk');
    s.run(2250);
    const id = s.player.videoId;
    s.player.videoId = null;
    s.run(4000);
    s.player.videoId = id;
    s.player.state = 3;
    s.player.time = 0;
    s.run(1000);
    t('the video not named for longer than the wait: nothing is moved after it', caps === 1 && s.player.seeks.length === 0,
      `caps ${caps}, seeks ${s.player.seeks.join()}`);
    // Not named for a second only: the reload within the wait is still put back.
    const b = setup({ state: 1, t: 3, vt: 3 });
    let capsB = 0;
    watchPosition(b.win, b.player, null, () => {}, { isLow: () => capsB === 0, setCap: () => { capsB++; return true; }, keys: () => 0 }, 'abcdefghijk');
    b.run(2250);
    const at = b.player.time;
    b.player.videoId = null;
    b.run(1000);
    b.player.videoId = 'abcdefghijk';
    b.player.state = 3;
    b.player.time = 0;
    b.run(500);
    t('...not named for a second: the start over is still put back', b.player.seeks.join() === String(at), b.player.seeks.join());
  }
  {
    // A player whose seekTo throws: asked once, and the check goes on.
    const s = setup({ state: 1, t: 3, vt: 3 });
    let caps = 0;
    let asked = 0;
    s.player.seekTo = () => { asked++; throw new Error('no seek'); };
    let threw = null;
    const watch = watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; }, keys: () => 0 }, 'abcdefghijk');
    s.run(2250);
    s.player.state = 3;
    s.player.time = 0;
    try { s.run(2000); } catch (e) { threw = e; }
    t('a seek that throws is asked for once, and the check goes on', !threw && asked === 1 && watch.running() === true,
      `threw ${threw && threw.message}, asked ${asked}`);
  }
  {
    // The speed change's reload started at 0 instead of 5 s: the watch seeks to
    // 5 s, the cap set as it plays reloads to 0 again: back to 5 s.
    const s = setup({ state: 1, t: 0.1, vt: 0.1 });
    watchPosition(s.win, s.player, 5, () => true, { isLow: () => false, setCap: () => true, keys: () => 0 }, 'abcdefghijk');
    s.run(250);
    t('first play away from its place: moved there', s.player.seeks.join() === '5', s.player.seeks.join());
    // The seek still under way on the next two ticks (buffering near 0): not sent again.
    s.player.state = 3;
    s.run(500);
    t('...the seek under way is not sent a second time', s.player.seeks.join() === '5', s.player.seeks.join());
    // It landed and plays; then the cap's reload starts it over.
    s.player.state = 1;
    s.player.time = 5.2;
    s.run(250);
    s.player.state = 3;
    s.player.time = 0;
    s.run(500);
    t('...the cap\'s reload after it is put back to the same place', s.player.seeks.join() === '5,5', s.player.seeks.join());
    // With no cap set at that first play, nothing comes after the first seek.
    const b = setup({ state: 1, t: 0.1, vt: 0.1 });
    watchPosition(b.win, b.player, 5, () => false, { isLow: () => false, setCap: () => false, keys: () => 0 }, 'abcdefghijk');
    b.run(250);
    b.player.state = 1;
    b.player.time = 5.2;
    b.run(250);
    b.player.state = 3;
    b.player.time = 0;
    b.run(1000);
    t('...and with no cap set, a start over after it is left alone', b.player.seeks.join() === '5', b.player.seeks.join());
    // The first seek still under way on a third tick (the hold ran out): sent
    // again, and the cap's reload once it landed is still put back.
    const c = setup({ state: 1, t: 0.1, vt: 0.1 });
    watchPosition(c.win, c.player, 5, () => true, { isLow: () => false, setCap: () => true, keys: () => 0 }, 'abcdefghijk');
    c.run(250);
    c.player.state = 3;
    c.run(750);
    t('...a seek under way past the hold is sent again', c.player.seeks.join() === '5,5', c.player.seeks.join());
    c.player.state = 1;
    c.player.time = 5.2;
    c.run(250);
    c.player.state = 3;
    c.player.time = 0;
    c.run(500);
    t('...and the cap\'s reload after it lands is still put back', c.player.seeks.join() === '5,5,5', c.player.seeks.join());
    // A seek to 3 s still under way reads 1.5 s while buffering: within reach
    // of 3 s, but not landed; the cap's reload after it lands is put back.
    const d = setup({ state: 1, t: 0.5, vt: 0.5 });
    watchPosition(d.win, d.player, 3, () => true, { isLow: () => false, setCap: () => true, keys: () => 0 }, 'abcdefghijk');
    d.run(250);
    d.player.state = 3;
    d.player.time = 1.5;
    d.run(750);
    d.player.state = 1;
    d.player.time = 3.2;
    d.run(250);
    d.player.state = 3;
    d.player.time = 0;
    d.run(750);
    t('...a seek under way reading near its target is not taken as landed', d.player.seeks.join() === '3,3,3', d.player.seeks.join());
  }
  {
    // The TV busy for 4 s right after the cap: one late tick, not sixteen.
    // The wait (3 s) is over by the clock: nothing is moved.
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const s = setup({ state: 1, t: 0.5, vt: 0.5 });
      let caps = 0;
      watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; }, keys: () => 0 }, 'abcdefghijk');
      s.run(1750);
      s.player.time = 3;
      s.run(250);
      shift = 4000;
      s.player.state = 3;
      s.player.time = 0;
      s.run(250);
      t('a tick 4 s late after the cap: the wait is over, nothing moved', caps === 1 && s.player.seeks.length === 0,
        `caps ${caps}, seeks ${s.player.seeks.join()}`);
    } finally {
      Date.now = realNow;
    }
  }
  {
    // The cap set (a range really asked for), no reload, then it loops on playing.
    const s = setup({ state: 1, t: 0.2, vt: 0.2 });
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; }, keys: () => 0 }, 'abcdefghijk');
    loopRun(s, 26);
    t('the cap set, the video loops while playing: not moved on', caps === 1 && s.player.seeks.length === 0, `caps ${caps}, seeks ${s.player.seeks.join()}`);
  }
  {
    // The loop passes through buffering at 0, from the end of the video.
    const s = setup({ state: 1, t: 5.6, vt: 5.6 });
    s.player.getDuration = () => 7;
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; }, keys: () => 0 }, 'abcdefghijk');
    s.run(2000);
    t('raised near the end', caps === 1, caps);
    s.player.time = 6.6;
    s.run(250);
    s.player.state = 3;
    s.player.time = 0;
    s.run(500);
    s.player.state = 1;
    s.run(500);
    t('a loop from the end (buffering at 0) is no reload: not moved on', s.player.seeks.length === 0, s.player.seeks.join());
  }
  {
    // The same start over in mid-video (not from its end) is the reload: put back.
    const s = setup({ state: 1, t: 2.5, vt: 2.5 });
    s.player.getDuration = () => 60;
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; }, keys: () => 0 }, 'abcdefghijk');
    s.run(1750);
    s.player.time = 3;
    s.run(250);
    s.player.state = 3;
    s.player.time = 0;
    s.run(500);
    t('with a duration known, a start over mid-video is still put back', s.player.seeks.join() === '3', s.player.seeks.join());
  }
  {
    // While playing, 0 is never taken for the reload (it reads 0 buffering).
    const s = setup({ state: 1, t: 0.5, vt: 0.5 });
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; } });
    s.run(1750);
    s.player.time = 3;
    s.run(250);
    s.player.time = 0.1;
    s.run(1000);
    t('back at 0 while playing: not moved (only a loading start over is)', s.player.seeks.length === 0, s.player.seeks.join());
  }
  {
    // The cap set without a reload: nothing to put back.
    const s = setup({ state: 1, t: 0.5, vt: 0.5 });
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; } });
    s.run(2000);
    s.player.time = 4;
    s.run(12000);
    s.player.state = 2;
    s.player.time = 0;
    s.run(500);
    s.player.state = 1;
    s.run(500);
    t('no reload: nothing seeks, also not at a later stop', caps === 1 && s.player.seeks.length === 0, `caps ${caps}, seeks ${s.player.seeks.join()}`);
  }
  {
    // The viewer's own seek back right after the cap (not to the start) stays.
    const s = setup({ state: 1, t: 30, vt: 30 });
    let caps = 0;
    watchPosition(s.win, s.player, null, () => {}, { isLow: () => caps === 0, setCap: () => { caps++; return true; } });
    s.run(2000);
    s.player.state = 3;
    s.player.time = 20;
    s.run(500);
    s.player.state = 1;
    s.run(500);
    t('a seek back of the viewer is left alone', caps === 1 && s.player.seeks.length === 0, `caps ${caps}, seeks ${s.player.seeks.join()}`);
  }
  {
    // The speed reload's own cap (onPlaying) at a position a few seconds in.
    const s = setup({ state: 3, t: 3.5, vt: 3.5 });
    let sets = 0;
    watchPosition(s.win, s.player, 3.5, () => { sets++; return true; }, { isLow: () => false, setCap: () => {} });
    s.run(250);
    s.player.state = 1;
    s.run(250);
    t('the reload plays where it should: onPlaying runs, no seek', sets === 1 && s.player.seeks.length === 0, s.player.seeks.join());
    s.player.state = 3;
    s.player.time = 0;
    s.run(500);
    s.player.state = 1;
    s.player.time = 0.1;
    s.run(250);
    t('its cap starting it over is put back too', s.player.seeks.join() === '3.5', s.player.seeks.join());
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
}));
