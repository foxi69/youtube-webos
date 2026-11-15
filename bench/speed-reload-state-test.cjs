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
const { UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
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

function boot(pickHeight, { force = false, manualPlayback = false, lateRecord = false } = {}) {
  const dom = new JSDOM('<body class="WEB_PAGE_TYPE_WATCH"><div id="ytlr-player__player-container-player"><video></video></div></body>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk',
      virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
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
      if (lateRecord) win.setTimeout(write, 50); else write();
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
      this.track = EN === this.track ? {} : EN;
      if (!manualPlayback) win.setTimeout(() => { state = 1; }, 300);
    }
  });
  return {
    win, p, log, speed: win.ytafSpeed, pump,
    emit(next) { state = next; if (onStateChange) onStateChange(next); },
    // YouTube's own choice, with no record written (no range call).
    setQuality(q) { quality = q; }
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
    // A 720p pick at 1.5x; on a TV the next video then started at 480p, though YouTube holds 720p at 1x.
    const { win, p, speed, log, emit, pump, setQuality } = boot(720);
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    p.videoId = 'nextvideo01';
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    // Raised as it started, the <video> stayed at 0 on a TV: only once it has played.
    t('a next video below the pick is not raised as it starts', log.ranges.length === 0, log.ranges.join());
    // The watch raises it after 2 s of play (8 ticks of 250 ms), not sooner.
    await sleep(1500);
    t('nor after 1.5 s of play', log.ranges.length === 0, log.ranges.join());
    await sleep(1100);
    t('a next video that plays below the 720p pick above 1x gets the pick',
      log.ranges.join() === 'hd720' && p.getPlaybackQuality() === 'hd720', log.ranges.join());
    // The viewer picks 480p on that video: it is theirs.
    await sleep(1100);
    writeQuality(win, 480, 2160);
    setQuality('large');
    log.ranges.length = 0;
    emit(2); emit(1); pump(); pump();
    await sleep(2600);
    t('a 480p pick made on the next video is left alone', log.ranges.length === 0, log.ranges.join());
    win.close();
  }
  {
    // No pick: a 60 fps video started at 1.5x came at 480p30 on a TV, where 1080p60 played 1.5x at 60 fps.
    const { win, p, speed, log, emit, pump, setQuality } = boot(0);
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    p.videoId = 'nextvideo01';
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    await sleep(2600);
    t('without a pick a next video at 480p above 1x gets the 1080p cap',
      log.ranges.join() === 'hd1080' && p.getPlaybackQuality() === 'hd1080', log.ranges.join());
    // A video whose top is 720p gets that, not a 1080p it does not have.
    p.videoId = 'nextvideo02';
    p.getAvailableQualityLevels = () => ['hd720', 'large', 'auto'];
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    await sleep(2600);
    t('a next video with 720p at most gets 720p', log.ranges.join() === 'hd720', log.ranges.join());
    win.close();
  }
  {
    // A raise can still leave the <video> at 0 while the player buffers at its position.
    const { win, p, speed, emit, pump, setQuality } = boot(0);
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    const seeks = [];
    p.seekTo = (s) => { seeks.push(s); };
    p.videoId = 'nextvideo01';
    setQuality('large');
    emit(-1); emit(3); emit(1); pump(); pump();
    await sleep(2600);
    emit(3);
    await sleep(3600);
    t('a next video left at 0 after the raise is moved to just before the player position', seeks.join() === '49.5', seeks.join());
    win.close();
  }
  {
    // The speed reload's own first play below the cap: its watch (subtitles back) is not cut short.
    const { p, win, speed, emit, pump, setQuality } = boot(0);
    p.track = EN;
    speed.setSpeed(1.5, { immediate: true });
    setQuality('large');
    emit(1); pump(); pump();
    await sleep(900);
    t('a raise on the reloaded video keeps the reload restoring the subtitles', p.track === EN, JSON.stringify(p.track));
    win.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
