/**
 * A speed change against the built bundle: the controller reloads the video
 * (loadVideoById) on a fake player whose reload turns the video's default
 * subtitles back on, as YouTube does. The subtitles in use before stay
 * (off stays off, on stays on), and the quality the viewer picked in YouTube's
 * menu (the yt-player-quality record) is kept: a pick below 1080p above 1x,
 * and the pick again, not Auto, back at 1x.
 *
 * Usage: node bench/speed-reload-state-test.cjs [bundle]
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { UA, setUserAgent, dispatchTrusted, applyChrome38Downgrade, applyChrome87Downgrade } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const bundle = fs.readFileSync(bundlePath, 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EN = { languageCode: 'en', vss_id: '.en', kind: '' };

// What YouTube writes to yt-player-quality on every quality range call (seen on a TV).
const HEIGHTS = { highres: 4320, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480 };
const writeQuality = (win, height, previous) => win.localStorage.setItem('yt-player-quality', JSON.stringify({
  data: JSON.stringify({ quality: height, previousQuality: previous }),
  creation: Date.now(), expiration: Date.now() + 1e9
}));

// A trusted key press, as the remote sends: the speed keys too.
const pressKey = (win) => dispatchTrusted(win.document.body, new win.KeyboardEvent('keydown', { bubbles: true }));

// lateRecord: the record follows each range call by 50 ms (true) or that many ms.
// reloadTrack: the subtitles YouTube's reload turns on (else it toggles them).
// oldRecord: a height already recorded a minute before the app started (the
// last session's speed cap, say).
function boot(pickHeight, { force = false, manualPlayback = false, lateRecord = false, reloadTrack, oldRecord } = {}) {
  const dom = new JSDOM('<body class="WEB_PAGE_TYPE_WATCH"><div id="ytlr-player__player-container-player"><video></video></div></body>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk',
      virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  win.launchParams = '{}';
  win.fetch = () => Promise.reject(new Error('offline'));
  win.XMLHttpRequest = class {
    open() {} send() { if (this.onerror) this.onerror(); }
    setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {}
  };
  let raf = [];
  win.requestAnimationFrame = (cb) => { raf.push(cb); return raf.length; };
  const pump = () => { const ready = raf; raf = []; ready.forEach((cb) => { cb(0); }); };
  win.cancelAnimationFrame = () => {};
  // What the speed feature needs to install (playback-speed.js).
  win.AudioDecoder = class {};
  win.AudioContext = class {};
  win.MediaSource = class { addSourceBuffer() {} };
  win.localStorage.setItem('ytaf-configuration', JSON.stringify({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    upgradeThumbnails: false, enableAutoLogin: false, forceHighResVideo: force
  }));
  if (oldRecord) {
    win.localStorage.setItem('yt-player-quality', JSON.stringify({
      data: JSON.stringify({ quality: oldRecord, previousQuality: 2160 }),
      creation: Date.now() - 60000, expiration: Date.now() + 1e9
    }));
  }
  win.eval(bundle);
  // The viewer's pick in YouTube's menu, made after the app started (Force Max
  // Quality writes its own record at start).
  if (pickHeight) writeQuality(win, pickHeight, 2160);

  const p = win.document.getElementById('ytlr-player__player-container-player');
  const log = { ranges: [], reloads: 0, sets: [] };
  let state = 1;
  let quality = 'hd720';
  let onStateChange = null;
  const addEventListener = p.addEventListener.bind(p);
  Object.assign(p, {
    track: {},
    reloadTrack,
    videoId: 'abcdefghijk',
    addEventListener(type, callback, ...args) {
      if (type === 'onStateChange') onStateChange = callback;
      else addEventListener(type, callback, ...args);
    },
    getOption(module, name) { return name === 'track' ? this.track : []; },
    setOption(module, name, value) { log.sets.push(value); this.track = value; },
    loadModule() {},
    setPlaybackQualityRange(a) {
      log.ranges.push(a);
      quality = a === 'highres' ? 'hd2160' : a === 'auto' ? 'hd720' : a;
      const write = () => {
        try { if (HEIGHTS[a]) writeQuality(win, HEIGHTS[a], 2160); } catch { /* storage denied */ }
      };
      // On a TV the record follows the call a moment later.
      if (lateRecord) win.setTimeout(write, lateRecord === true ? 50 : lateRecord); else write();
    },
    getPlaybackQuality: () => quality,
    getAvailableQualityLevels: () => ['hd2160', 'hd1080', 'hd720', 'auto'],
    getVideoData: () => ({ video_id: p.videoId }),
    getCurrentTime: () => 50,
    getPlayerState: () => state,
    seekTo() {},
    loadVideoById() {
      log.reloads++;
      // YouTube starts the reloaded video with its own subtitles choice.
      state = 3;
      if (this.reloadTrack !== undefined) this.track = this.reloadTrack;
      else this.track = EN === this.track ? {} : EN;
      if (!manualPlayback) win.setTimeout(() => { state = 1; }, 300);
    }
  });
  return {
    win, p, log, speed: win.ytafSpeed, pump,
    emit(next) { state = next; if (onStateChange) onStateChange(next); }
  };
}

(async () => {
  {
    // Subtitles off, a 720p pick; to 1.5x.
    const { win, p, log, speed } = boot(720);
    t('the speed controller is installed', !!speed);
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('the video was reloaded', log.reloads === 1, log.reloads);
      t('subtitles turned off stay off after the reload', !p.track.languageCode, JSON.stringify(p.track));
      t('above 1x a 720p pick stays 720p, not 1080p', log.ranges.length > 0 && log.ranges.every((r) => r === 'hd720'),
        log.ranges.join());
      // Subtitles on by hand, then back to 1x: the reload drops them.
      p.track = EN;
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t('returning to 1x reloads the video before checking restored subtitles', log.reloads === 2, log.reloads);
      t('subtitles turned on stay on after the reload', p.track === EN, JSON.stringify(p.track));
      t('back at 1x the pick returns, not Auto', log.ranges.join() === 'hd720', log.ranges.join());
    }
    win.close();
  }
  {
    // No pick: the 1080p cap and Auto as before.
    const { win, log, speed } = boot(0);
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('without a pick, above 1x is capped at 1080p', log.ranges.length > 0 && log.ranges.every((r) => r === 'hd1080'),
        log.ranges.join());
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t('without a pick, back at 1x is Auto', log.ranges.join() === 'auto', log.ranges.join());
    }
    win.close();
  }
  {
    // Force Max Quality on, 480p picked in the menu: the pick wins back at 1x (seen on a TV going to 2160p).
    const { win, log, speed } = boot(480, { force: true });
    if (speed) {
      speed.setSpeed(1.25, { immediate: true });
      await sleep(900);
      t('Force Max Quality on, a 480p pick stays 480p above 1x', log.ranges.length > 0 && log.ranges.every((r) => r === 'large'),
        log.ranges.join());
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t('Force Max Quality on, back at 1x the 480p pick wins over Max', log.ranges.join() === 'large', log.ranges.join());
    }
    win.close();
  }
  {
    // Force Max Quality on, no pick: Max back at 1x, even after the 1080p cap was recorded.
    const { win, log, speed } = boot(0, { force: true });
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t('Force Max Quality on, no pick: back at 1x is Max, not the recorded 1080p cap', log.ranges.join() === 'highres',
        log.ranges.join());
    }
    win.close();
  }
  {
    const { win, p, speed, emit } = boot(720, { manualPlayback: true });
    speed.setSpeed(1.5, { immediate: true });
    // A real key during buffering changes the viewer's choice before PLAYING.
    dispatchTrusted(win.document.body, new win.KeyboardEvent('keydown', { bubbles: true }));
    p.track = EN;
    emit(1);
    await sleep(600);
    t('the reload controller preserves a subtitle choice made during buffering', p.track === EN);
    win.close();
  }
  {
    const { win, speed, log } = boot(720);
    speed.setSpeed(1.5, { immediate: true });
    Object.defineProperty(win, 'localStorage', { configurable: true, get() { throw new Error('storage denied'); } });
    let error = null;
    try { speed.setSpeed(1, { immediate: true }); } catch (err) { error = err; }
    t('denied storage does not prevent a second reload using the remembered quality',
      !error && log.reloads === 2 && log.ranges[log.ranges.length - 1] === 'hd720', String(error));
    win.close();
  }
  {
    const { win, speed, log } = boot(720);
    speed.setSpeed(1.5, { immediate: true });
    win.Storage.prototype.getItem = () => { throw new Error('storage method denied'); };
    speed.setSpeed(1, { immediate: true });
    t('a denied storage method retains the last known quality on return to 1x',
      log.reloads === 2 && log.ranges[log.ranges.length - 1] === 'hd720', log.ranges.join());
    win.close();
  }
  {
    // The player between two videos: the live check reads its metadata, and the
    // reload's own read then throws.
    const { win, p, speed, log } = boot(720);
    let reads = 0;
    p.getVideoData = () => {
      if (++reads > 1) throw new Error('no video data');
      return { video_id: p.videoId };
    };
    let error = null;
    try { speed.setSpeed(1.5, { immediate: true }); } catch (err) { error = err; }
    t('a throwing getVideoData skips the reload instead of breaking the speed change',
      !error && reads >= 2 && log.ranges.join() === 'hd720' && log.reloads === 0,
      `${error} reads=${reads} ranges=${log.ranges.join()} reloads=${log.reloads}`);
    win.close();
  }
  {
    const { win, p, speed, log, emit } = boot(720, { manualPlayback: true });
    speed.setSpeed(1.5, { immediate: true });
    // YouTube writes the new manual choice within the old heuristic's 1s window.
    p.setPlaybackQualityRange('large');
    log.ranges.length = 0;
    emit(1);
    await sleep(650);
    t('a new 480p choice during buffering is not overwritten by the old 720p cap',
      p.getPlaybackQuality() === 'large' && log.ranges.includes('large') && !log.ranges.includes('hd720'),
      log.ranges.join());
    speed.setSpeed(1, { immediate: true });
    t('the newer buffering-time choice is also restored at 1x',
      log.ranges[log.ranges.length - 1] === 'large', log.ranges.join());
    win.close();
  }
  {
    // A 2160p pick; YouTube writes each range call's record a moment after it.
    // The cap set again when the reload plays is then still unrecorded: the
    // first cap's record is the controller's too, not a 1080p pick.
    const { win, speed, log } = boot(2160, { lateRecord: true });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    t('the cap is set again once the reload plays', log.ranges.join() === 'hd1080,hd1080', log.ranges.join());
    log.ranges.length = 0;
    speed.setSpeed(1, { immediate: true });
    t('back at 1x a 2160p pick returns, not the cap recorded late', log.ranges.join() === 'hd2160', log.ranges.join());
    win.close();
  }
  {
    const { win, p, speed, log, emit, pump } = boot(480, { force: true });
    speed.setSpeed(1.5, { immediate: true });
    // Attach Force Max Quality while speed still suppresses it.
    win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
    await sleep(300);
    speed.setSpeed(1, { immediate: true });
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    p.querySelector('video').dispatchEvent(new win.Event('resize', { bubbles: true }));
    t('Force Max Quality state and resize handlers leave the restored manual choice alone',
      p.getPlaybackQuality() === 'large' && log.ranges.length === 0, log.ranges.join());
    p.videoId = 'nextvideo01';
    emit(-1); emit(3); emit(1); pump(); pump();
    t('the next video is not held back by the previous video quality override',
      log.ranges.includes('highres'), log.ranges.join());
    const open = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(open, 'keyCode', { get: () => 404 });
    dispatchTrusted(win.document.body, open);
    for (let i = 0; i < 20; i++) pump();
    const input = Array.from(win.document.querySelectorAll('label'))
      .find((label) => label.querySelector('.label-text')?.textContent === 'Force Max Quality')?.querySelector('input');
    if (!input) throw new Error('Force Max Quality control missing');
    const flip = (on) => { input.checked = on; input.dispatchEvent(new win.Event('change')); };
    // Capture a fresh retained choice on this video, then explicitly override it.
    writeQuality(win, 480, 2160);
    speed.setSpeed(1.5, { immediate: true });
    speed.setSpeed(1, { immediate: true });
    log.ranges.length = 0;
    flip(false); flip(true);
    emit(3); pump(); pump();
    t('explicitly enabling Force Max Quality releases the retained manual choice',
      log.ranges.includes('highres'), log.ranges.join());
    win.close();
  }
  {
    // Subtitles off; YouTube's reload turns its default ones on. A second
    // speed key while the first reload still buffers: once the video plays,
    // the subtitles from before the first reload are put back.
    const { win, p, speed, emit } = boot(0, { manualPlayback: true, reloadTrack: EN });
    pressKey(win);
    speed.setSpeed(1.5, { immediate: true });
    pressKey(win);
    speed.setSpeed(2, { immediate: true });
    emit(1);
    await sleep(600);
    t('a second speed change while the first reload buffers still keeps the subtitles off',
      !p.track.languageCode, JSON.stringify(p.track));
    win.close();
  }
  {
    // A reload that never played: another video was opened while it buffered.
    // Back on the first video the viewer turns subtitles on, and the next speed
    // change keeps them on, not the off state from before that reload.
    const { win, p, speed, emit } = boot(0, { manualPlayback: true, reloadTrack: EN });
    pressKey(win);
    speed.setSpeed(1.5, { immediate: true });
    p.videoId = 'othervideo1';
    await sleep(400);
    p.videoId = 'abcdefghijk';
    emit(1);
    pressKey(win);
    p.track = EN;
    // This time YouTube's reload drops them.
    p.reloadTrack = {};
    pressKey(win);
    speed.setSpeed(2, { immediate: true });
    emit(1);
    await sleep(600);
    t('a reload that never played does not hand its subtitles to a later speed change',
      p.track === EN, JSON.stringify(p.track));
    win.close();
  }
  {
    // The last session ended at 1.5x: its 1080p cap is still recorded when the
    // app starts. No pick of the viewer's: back at 1x is Auto.
    const { win, log, speed } = boot(0, { oldRecord: 1080 });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    log.ranges.length = 0;
    speed.setSpeed(1, { immediate: true });
    t('a record from before the app started is no pick: back at 1x is Auto', log.ranges.join() === 'auto',
      log.ranges.join());
    win.close();
  }
  {
    // YouTube records the cap more than a second after the call.
    const { win, log, speed } = boot(0, { lateRecord: 1200 });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(2200);
    log.ranges.length = 0;
    pressKey(win);
    speed.setSpeed(1, { immediate: true });
    t('the cap recorded over a second late is no pick: back at 1x is Auto', log.ranges.join() === 'auto',
      log.ranges.join());
    win.close();
  }
  {
    // Force Max Quality on, the cap recorded late: Max back at 1x, and the
    // next playing state is not held back for this video.
    const { win, log, speed } = boot(0, { lateRecord: 1200, force: true });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(2200);
    log.ranges.length = 0;
    pressKey(win);
    speed.setSpeed(1, { immediate: true });
    t('Force Max Quality on, the cap recorded late: back at 1x is Max', log.ranges.join() === 'highres',
      log.ranges.join());
    win.close();
  }
  {
    // The viewer picks 1080p in the menu (keys pressed) after the cap: that is a pick.
    const { win, log, speed } = boot(0, { lateRecord: 1200 });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(2200);
    pressKey(win);
    writeQuality(win, 1080, 2160);
    await sleep(10);
    log.ranges.length = 0;
    speed.setSpeed(1, { immediate: true });
    t('1080p picked by the viewer after the cap is kept back at 1x', log.ranges.join() === 'hd1080',
      log.ranges.join());
    win.close();
  }
  {
    // The position check runs every 250 ms for 25 s after a reload: while the
    // picture is at the cap, the stored record is not read on every tick.
    const { win, p, log, speed } = boot(0);
    let reads = 0;
    const getItem = win.Storage.prototype.getItem;
    win.Storage.prototype.getItem = function (key) {
      if (key === 'yt-player-quality') reads++;
      return getItem.call(this, key);
    };
    speed.setSpeed(1.5, { immediate: true });
    await sleep(800);
    reads = 0;
    await sleep(1500);
    t('at the cap, the position check does not read the quality record', reads === 0, `${reads} reads`);
    // YouTube falls to 720p: the cap is set again (after 2 s of it).
    log.ranges.length = 0;
    p.getPlaybackQuality = () => 'hd720';
    await sleep(2600);
    t('fallen below the cap, the cap is set again', log.ranges.join() === 'hd1080', log.ranges.join());
    win.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
