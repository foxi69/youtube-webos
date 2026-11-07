/**
 * Playback speed as it installs on a TV without WebCodecs (webOS 4-6 and 22):
 * the bundle in an engine like Chromium 53's - no AudioDecoder, no
 * Object.hasOwn, no flatMap, and an EventTarget that cannot be constructed
 * (before Chromium 64) - with the Web Audio and MSE objects faked.
 *
 * Before #112 the speed code never ran there, so what it used of newer
 * engines went unnoticed: Object.hasOwn in the setPlaybackRate setter (every
 * player YouTube builds, at 1x too) and `extends EventTarget` for the audio
 * SourceBuffer stand-in.
 *
 * Usage: node bench/speed-legacy-install-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { UA, setUserAgent } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk', virtualConsole: vc, pretendToBeVisual: true });
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

  // An engine like Chromium 53's.
  delete win.Object.hasOwn;
  delete win.Array.prototype.flatMap;
  delete win.AudioDecoder;
  const Native = win.EventTarget;
  win.EventTarget = function EventTarget() { throw new win.TypeError('Illegal constructor'); };
  win.EventTarget.prototype = Native.prototype;

  // Web Audio and MSE, faked.
  win.AudioContext = class {
    constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    close() { this.state = 'closed'; }
  };
  win.OfflineAudioContext = class { decodeAudioData() {} };
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

(async () => {
  const { win } = boot();
  await wait(100);
  t('the speed control installs without WebCodecs', !!win.ytafSpeed && win.ytafSpeed.isSupported(), String(!!win.ytafSpeed));

  // YouTube builds its player API with a plain object: obj.setPlaybackRate = fn.
  let built;
  try {
    built = win.eval('(function () { var api = {}; api.setPlaybackRate = function (r) { return r; }; return typeof api.setPlaybackRate; })()');
  } catch (e) {
    built = 'threw: ' + e.message;
  }
  t('a player API object takes its setPlaybackRate (no Object.hasOwn needed)', built === 'function', built);

  // Off 1x, the audio SourceBuffer is the engine's stand-in.
  win.ytafSpeed.setSpeed(1.5);
  let sb;
  try {
    const ms = new win.MediaSource();
    sb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  } catch (e) {
    sb = 'threw: ' + e.message;
  }
  t('off 1x, the audio SourceBuffer stand-in is built without a constructible EventTarget',
    !!sb && typeof sb === 'object' && typeof sb.addEventListener === 'function' && typeof sb.appendBuffer === 'function', String(sb));
  if (sb && typeof sb === 'object') {
    let ended = 0;
    sb.addEventListener('updateend', () => ended++);
    sb.remove(0, 1);
    await wait(50);
    t('and it reports updateend to its listeners', ended === 1, String(ended));
  }
  if (win.ytafSpeed.releaseAudioSink) win.ytafSpeed.releaseAudioSink();
  win.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
