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
  // webOS 4: the buffer limit (hooks/buffer-limit.js) wraps addSourceBuffer
  // as well, around the speed code's own wrapper.
  setUserAgent(win, UA.webos4);
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
  // appendBuffer on the prototype, as on a real engine; an append while
  // updating throws, as InvalidStateError does.
  class FakeSourceBuffer {
    constructor() {
      this.updating = false; this.appended = []; this.listeners = []; this.buffered = { length: 0 };
      this._ts = 0; this._aws = 0; this._awe = Infinity;
    }
    // Accessors on the prototype, as a real engine has them: the speed code
    // rescales these off 1x.
    get timestampOffset() { return this._ts; }
    set timestampOffset(v) { this._ts = v; }
    get appendWindowStart() { return this._aws; }
    set appendWindowStart(v) { this._aws = v; }
    get appendWindowEnd() { return this._awe; }
    set appendWindowEnd(v) { this._awe = v; }
    appendBuffer(data) {
      if (this.updating) throw new Error('InvalidStateError');
      this.appended.push(data);
      this.updating = true;
    }
    remove() { this.updating = true; }
    abort() {}
    addEventListener(type, fn) { if (type === 'updateend') this.listeners.push(fn); }
    removeEventListener(type, fn) { const i = this.listeners.indexOf(fn); if (i !== -1) this.listeners.splice(i, 1); }
    finish() { this.updating = false; this.listeners.slice().forEach((fn) => { fn(); }); }
  }
  win.FakeSourceBuffer = FakeSourceBuffer;
  win.MediaSource = class {
    constructor() { this.readyState = 'open'; }
    addSourceBuffer() { return new FakeSourceBuffer(); }
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
  t('the webOS 4 buffer limit is on as well', typeof win.__ytafBufferStats === 'function');

  // YouTube builds its player API with a plain object: obj.setPlaybackRate = fn.
  let built;
  try {
    built = win.eval('(function () { var api = {}; api.setPlaybackRate = function (r) { return r; }; return typeof api.setPlaybackRate; })()');
  } catch (e) {
    built = 'threw: ' + e.message;
  }
  t('a player API object takes its setPlaybackRate (no Object.hasOwn needed)', built === 'function', built);

  // The buffer limit's append deferral: an append that comes while its trim
  // runs waits, and the player's own updateend listener, which runs first and
  // appends the next piece, does not make it throw and drop the data.
  {
    const ms = new win.MediaSource();
    const vsb = ms.addSourceBuffer('video/mp4; codecs="avc1.640028"');
    let playerTurn = true;
    vsb.addEventListener('updateend', () => {
      if (playerTurn) { playerTurn = false; vsb.appendBuffer('B'); }
    });
    vsb.remove(0, 10);
    vsb.__ytafTrimming = true;
    let threw = null;
    try { vsb.appendBuffer('A'); } catch (e) { threw = e.message; }
    vsb.finish(); // the trim ends: the player appends B first
    vsb.finish(); // B ends: the held-back A goes in
    t('a held-back append waits for the player\'s own append, and is not lost',
      !threw && vsb.appended.join() === 'B,A', threw || vsb.appended.join());
  }

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
  // The speed code gives the video SourceBuffer an appendBuffer of its own,
  // which hides the prototype's: the deferral must wrap that one too.
  {
    const ms = new win.MediaSource();
    ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const vsb = ms.addSourceBuffer('video/mp4; codecs="avc1.640028"');
    t('off 1x, the video SourceBuffer\'s own appendBuffer gets the deferral',
      Object.prototype.hasOwnProperty.call(vsb, 'appendBuffer') && vsb.appendBuffer.__ytafAppendDeferral === true);
    vsb.remove(0, 10);
    vsb.__ytafTrimming = true;
    let threw = null;
    try { vsb.appendBuffer(new Uint8Array(16)); } catch (e) { threw = e.message; }
    t('and an append during the trim is held back, not thrown', !threw && vsb.appended.length === 0, threw || String(vsb.appended.length));
    vsb.finish();
    t('and goes in once the trim ends', vsb.appended.length === 1, String(vsb.appended.length));
  }
  if (win.ytafSpeed.releaseAudioSink) win.ytafSpeed.releaseAudioSink();
  win.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
