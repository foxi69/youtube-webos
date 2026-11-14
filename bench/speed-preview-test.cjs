/**
 * Playback speed and tile previews (playback-speed.js): a speed set on a video
 * is the watch page's (and Shorts'). A preview on Home plays at 1x, without
 * the engine, and the speed is kept for the next video opened. A playback set
 * up at 1x that goes on in the watch page (a preview YouTube carries on there,
 * or a MediaSource made before the page turned) is loaded again at the speed
 * once it plays, at most once per video.
 *
 * Found on a webOS 25 TV (2026-11-14): after 1.5x on a video, every Home
 * preview played at 1.5x with the engine running.
 *
 * Usage: node bench/speed-preview-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { UA, setUserAgent } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// RESUME_AFTER_PAGE_MS in playback-speed.js, with room for the page-update
// event, which the page's MutationObserver sends a moment after the class.
const AFTER_PAGE_MS = 1000 + 300;

let pass = 0;
let fail = 0;
const t = (n, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); }
};

function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_WATCH"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/watch?v=aaaaaaaaaaa', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.fetch = () => new Promise(() => {});
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    upgradeThumbnails: false, enableAutoLogin: false, checkForUpdates: false, showWhatsNew: false
  }));

  // WebCodecs, Web Audio and MSE, faked.
  win.AudioDecoder = class { configure() {} decode() {} flush() { return Promise.resolve(); } close() {} };
  win.AudioDecoder.isConfigSupported = () => Promise.resolve({ supported: true });
  win.AudioContext = class {
    constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; this.sampleRate = 48000; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    close() { this.state = 'closed'; }
  };
  const realSb = () => ({ updating: false, appendBuffer() {}, remove() {}, abort() {}, buffered: { length: 0 } });
  win.MediaSource = class {
    constructor() { this.readyState = 'open'; }
    addSourceBuffer() { return realSb(); }
    get sourceBuffers() { return { length: 0, item: () => undefined }; }
  };
  win.MediaSource.isTypeSupported = () => true;
  win.URL.createObjectURL = () => 'blob:fake';
  win.URL.revokeObjectURL = () => {};

  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, errors };
}

// YouTube's player element with the calls a reload makes, recorded.
function addPlayer(win, videoId) {
  const el = win.document.createElement('div');
  el.id = 'ytlr-player__player-container-player';
  el.loads = [];
  el.getVideoData = () => ({ video_id: videoId, isLive: false });
  el.getCurrentTime = () => 12;
  el.getPlayerState = () => 1;
  el.getPlaybackQuality = () => 'hd1080';
  el.getAvailableQualityLevels = () => ['hd1080'];
  el.setPlaybackQualityRange = () => {};
  el.seekTo = () => {};
  el.loadVideoById = (id, at) => el.loads.push(id + '@' + at);
  win.document.body.appendChild(el);
  return el;
}

// The shared <video>, playing or not.
function addVideo(win, playing) {
  const v = win.document.createElement('video');
  Object.defineProperty(v, 'paused', { configurable: true, get: () => !playing.now });
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => (playing.now ? 4 : 0) });
  win.document.body.appendChild(v);
  return v;
}

// The audio SourceBuffer a new MediaSource gets: the engine's stand-in off 1x
// (it has listeners), the native one at 1x.
const audioIsEngine = (win) =>
  typeof new win.MediaSource().addSourceBuffer('audio/mp4; codecs="mp4a.40.2"').addEventListener === 'function';

const setPage = async (win, cls) => { win.document.body.className = cls; await wait(20); };

(async () => {
  const { win, errors } = boot();
  await wait(100);
  const speed = win.ytafSpeed;
  t('precondition: the speed control is installed and supported', !!speed && speed.isSupported());

  // ---- getSpeed by page ----
  speed.setSpeed(1.5);
  t('watch page: the speed is 1.5x', speed.getSpeed() === 1.5, String(speed.getSpeed()));
  t('watch page: a new MediaSource gets the engine', audioIsEngine(win));
  speed.releaseAudioSink();

  await setPage(win, 'WEB_PAGE_TYPE_BROWSE');
  t('Home: the speed reads 1x', speed.getSpeed() === 1, String(speed.getSpeed()));
  t('Home: a preview\'s MediaSource plays the native audio, no engine', !audioIsEngine(win) && !speed.activeEngine());

  await setPage(win, 'WEB_PAGE_TYPE_SHORTS');
  t('Shorts: the speed is 1.5x', speed.getSpeed() === 1.5, String(speed.getSpeed()));
  speed.releaseAudioSink();

  await setPage(win, 'WEB_PAGE_TYPE_WATCH');
  t('back on the watch page: the speed set before is 1.5x again', speed.getSpeed() === 1.5, String(speed.getSpeed()));

  // ---- A preview carried on into the watch page, already playing ----
  const playing = { now: true };
  addVideo(win, playing);
  const player = addPlayer(win, 'pppppppppp1');
  await setPage(win, 'WEB_PAGE_TYPE_BROWSE');
  t('preview: the MediaSource is set up at 1x', !audioIsEngine(win));
  win.document.querySelector('video').dispatchEvent(new win.Event('playing'));
  await wait(50);
  t('preview playing on Home: no reload', player.loads.length === 0, player.loads.join());
  await setPage(win, 'WEB_PAGE_TYPE_WATCH');
  t('carried on into the watch page: no reload before the page has settled', player.loads.length === 0, player.loads.join());
  await wait(AFTER_PAGE_MS);
  t('carried on into the watch page: loaded again at the speed, at its position',
    player.loads.join() === 'pppppppppp1@12', player.loads.join());
  t('the reload is recorded (lastReloadAt)', Date.now() - speed.lastReloadAt() < AFTER_PAGE_MS + 500);

  // The reloaded video plays at 1x again (here: the faked engine is not there),
  // but the same video is not loaded a second time.
  speed.releaseAudioSink();
  win.document.querySelector('video').dispatchEvent(new win.Event('playing'));
  await wait(50);
  t('the same video is not loaded again (once per video)', player.loads.length === 1, player.loads.join());

  // ---- A video opened anew, its MediaSource made on the watch page ----
  player.getVideoData = () => ({ video_id: 'nnnnnnnnnn1', isLive: false });
  t('a video opened on the watch page gets the engine', audioIsEngine(win) && !!speed.activeEngine());
  win.document.querySelector('video').dispatchEvent(new win.Event('playing'));
  await wait(50);
  t('...and is not loaded again', player.loads.length === 1, player.loads.join());
  speed.releaseAudioSink();

  // ---- Not while paused or loading ----
  player.getVideoData = () => ({ video_id: 'qqqqqqqqqq1', isLive: false });
  playing.now = false;
  win.document.querySelector('video').dispatchEvent(new win.Event('playing'));
  await setPage(win, 'WEB_PAGE_TYPE_BROWSE');
  await setPage(win, 'WEB_PAGE_TYPE_WATCH');
  await wait(AFTER_PAGE_MS);
  t('a video not playing yet is not loaded again', player.loads.length === 1, player.loads.join());
  playing.now = true;
  win.document.querySelector('video').dispatchEvent(new win.Event('playing'));
  await wait(50);
  t('...until it plays at 1x on the watch page', player.loads.join() === 'pppppppppp1@12,qqqqqqqqqq1@12', player.loads.join());

  // ---- At 1x nothing is loaded again ----
  speed.releaseAudioSink();
  speed.setSpeed(1);
  await wait(1000);
  const before = player.loads.length;
  player.getVideoData = () => ({ video_id: 'oooooooooo1', isLive: false });
  win.document.querySelector('video').dispatchEvent(new win.Event('playing'));
  await setPage(win, 'WEB_PAGE_TYPE_BROWSE');
  await setPage(win, 'WEB_PAGE_TYPE_WATCH');
  await wait(AFTER_PAGE_MS);
  t('at 1x a video on the watch page is never loaded again', player.loads.length === before,
    player.loads.slice(before).join());

  t('no page errors', errors.length === 0, errors.join(' | '));
  win.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
