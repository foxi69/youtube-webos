/**
 * Force Max Quality and a preview carried over to the watch page
 * (video-quality.js): the playback a hand-over keeps going is not forced to
 * the top quality, which would load it again (on a webOS 25 TV 4 of 8 OK
 * presses handed over with Force Max Quality on, 8 of 8 with it off). A video
 * loaded anew is forced as before, and so is one opened with no preview.
 *
 * Runs on the MODERN bundle, as quality-reload-test.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { UA, setUserAgent } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
const bundle = fs.readFileSync(bundlePath, 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// scenario: 'carried' (a preview plays on Home, then the page turns to watch
// with the same source still playing), 'reloaded' (the same, but the element
// gets a new source first), 'direct' (no preview: the watch page from the start).
async function run(scenario) {
  const startPage = scenario === 'direct' ? 'WEB_PAGE_TYPE_WATCH' : 'WEB_PAGE_TYPE_BROWSE';
  const dom = new JSDOM(`<body class="${startPage}"><div id="ytlr-player__player-container-player"><video></video></div></body>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/', virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.fetch = () => Promise.reject(new Error('offline'));
  win.XMLHttpRequest = class {
    open() {} send() { if (this.onerror) this.onerror(); }
    setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {}
  };
  let rafQ = [];
  win.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  win.cancelAnimationFrame = () => {};
  const pump = () => { const qd = rafQ; rafQ = []; for (const cb of qd) cb(0); };
  win.localStorage.setItem('ytaf-configuration', JSON.stringify({
    forceHighResVideo: true, enableAdBlock: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false
  }));
  win.eval(bundle);

  const p = win.document.getElementById('ytlr-player__player-container-player');
  const v = p.querySelector('video');
  let src = 'blob:https://www.youtube.com/preview-1';
  Object.defineProperty(v, 'currentSrc', { get: () => src, configurable: true });
  Object.defineProperty(v, 'paused', { get: () => false, configurable: true });
  Object.defineProperty(v, 'readyState', { get: () => 4, configurable: true });
  let q = 'hd720';
  let rangeCalls = 0;
  let onState = null;
  Object.assign(p, {
    setPlaybackQualityRange() { rangeCalls++; q = 'hd2160'; }, setPlaybackQuality() {},
    getPlaybackQuality: () => q, getPlaybackQualityLabel: () => q,
    getAvailableQualityLevels: () => ['hd2160', 'hd1080', 'hd720', 'auto'],
    getVideoData: () => ({ video_id: 'abc' }), getPlayerState: () => 1, getCurrentTime: () => 12,
    pauseVideo() {}, playVideo() {}, isInline: () => false,
    addEventListener(name, fn) { if (name === 'onStateChange') onState = fn; }
  });

  if (scenario !== 'direct') {
    // The preview plays on Home.
    v.dispatchEvent(new win.Event('playing'));
    if (scenario === 'reloaded') {
      v.dispatchEvent(new win.Event('emptied'));
      src = 'blob:https://www.youtube.com/watch-1';
    }
    win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
    win.location.hash = '#/watch?v=abc';
    await sleep(30);
    if (scenario === 'reloaded') v.dispatchEvent(new win.Event('playing'));
  }
  win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
  await sleep(300);
  pump(); pump();
  await sleep(1700);
  pump();
  const first = { rangeCalls, q };
  let next = null;
  if (scenario === 'carried') {
    // The next video on the same watch page (autoplay): loaded anew.
    v.dispatchEvent(new win.Event('emptied'));
    src = 'blob:https://www.youtube.com/watch-2';
    q = 'hd720';
    p.getVideoData = () => ({ video_id: 'def' });
    // The player says so as it loads it: unstarted, buffering, playing.
    if (onState) for (const state of [-1, 3]) onState(state);
    v.dispatchEvent(new win.Event('playing'));
    if (onState) onState(1);
    await sleep(300);
    pump(); pump();
    await sleep(1700);
    pump();
    next = { rangeCalls: rangeCalls - first.rangeCalls, q };
  }
  win.close();
  return Object.assign(first, { next });
}

(async () => {
  const direct = await run('direct');
  t('control, a video opened with no preview: forced to the top quality', direct.rangeCalls >= 1 && direct.q === 'hd2160',
    JSON.stringify(direct));
  const reloaded = await run('reloaded');
  t('control, a preview opened by loading the video again: forced as before', reloaded.rangeCalls >= 1,
    JSON.stringify(reloaded));
  const carried = await run('carried');
  t('a preview carried over to the watch page: not forced, so not loaded again', carried.rangeCalls === 0 && carried.q === 'hd720',
    JSON.stringify(carried));
  t('...and the next video loaded on that watch page is forced again', !!carried.next && carried.next.rangeCalls >= 1 &&
    carried.next.q === 'hd2160', JSON.stringify(carried.next));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
