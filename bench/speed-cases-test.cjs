/**
 * Playback speed (src/playback-speed.js) against the built bundle, case by
 * case: the speed's steps (cycle, step, reset, and the remote keys mapped to
 * Playback Speed +, - and Reset) and the one reload a burst of them makes, the
 * notices (switched off, a live stream, an error), the switch turned off
 * mid-video, the stretched audio following the TV's volume, the speed button
 * and menu YouTube is made to show, its own rate changes (a player API
 * object, the player element) taken as the viewer's speed, the audio offer
 * off 1x, and the 1080p cap on the next video.
 *
 * The reload's subtitles and quality are speed-reload-state-test's; the
 * previews' speed speed-preview-test's; a TV without WebCodecs
 * speed-legacy-install-test's. Web Audio, WebCodecs and MSE are faked, and
 * YouTube's player is a stand-in that records its calls.
 *
 * Usage: node bench/speed-cases-test.cjs <bundle> [legacy|modern]
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

const GREEN = 404;
// RELOAD_DELAY_MS in playback-speed.js, with room.
const AFTER_DELAY_MS = 800 + 150;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};
// Every boot's jsdomErrors (a script error on the page), checked at the end.
const allErrors = [];

function boot(cfg = {}, { live = false, page = 'WEB_PAGE_TYPE_WATCH' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { errors.push(e.message); allErrors.push(e.message); });
  const dom = new JSDOM(`<!doctype html><html><body class="${page}"><ytlr-app>` +
    '<div id="ytlr-player__player-container-player"><video></video></div></ytlr-app></body></html>',
  { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  // Chrome 23 has it; the Chrome 38 environment takes it away all the same.
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.launchParams = '{}';
  win.fetch = () => Promise.reject(new Error('offline'));
  win.XMLHttpRequest = class {
    open() {} send() { if (this.onerror) this.onerror(); }
    setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {}
  };
  let rafQ = [];
  win.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  win.cancelAnimationFrame = () => {};
  // What the speed feature needs to install.
  win.AudioDecoder = class {};
  win.AudioContext = class {
    constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; this.sampleRate = 48000; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    close() { this.state = 'closed'; }
  };
  win.MediaSource = class { addSourceBuffer() {} };
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    upgradeThumbnails: false, enableAutoLogin: false
  }, cfg)));

  // YouTube's player, before the bundle: the speed binds its rate a second in.
  const p = win.document.getElementById('ytlr-player__player-container-player');
  const log = { loads: [], ranges: [], rates: [] };
  let quality = 'hd2160';
  Object.assign(p, {
    live,
    videoId: 'abcdefghijk',
    rate: 1,
    getVideoData() { return { video_id: this.videoId, isLive: this.live }; },
    getCurrentTime: () => 42,
    getPlayerState: () => 1,
    seekTo() {},
    getOption() { return {}; },
    setOption() {},
    loadVideoById(id, at) { log.loads.push(id + '@' + at); },
    setPlaybackQualityRange(a) { log.ranges.push(a); quality = a === 'highres' || a === 'auto' ? 'hd2160' : a; },
    getPlaybackQuality: () => quality,
    getAvailableQualityLevels: () => ['hd2160', 'hd1080', 'hd720', 'auto'],
    setPlaybackRate(r) { log.rates.push(r); this.rate = r; },
    getPlaybackRate() { return this.rate; }
  });
  win.eval(bundle);
  const pump = () => { const q = rafQ; rafQ = []; for (const cb of q) cb(Date.now()); };
  const toasts = () => Array.from(win.document.querySelectorAll('.ytaf-notification-container .message')).map((m) => m.textContent);
  const parse = (obj) => win.JSON.parse(win.JSON.stringify(obj));
  const toggle = (label, on) => {
    if (!win.document.querySelector('.ytaf-ui-container')) {
      const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
      dispatchTrusted(win.document.body, e);
      for (let i = 0; i < 20; i++) pump();
    }
    const input = Array.from(win.document.querySelectorAll('.ytaf-ui-container label'))
      .find((l) => l.querySelector('.label-text')?.textContent === label)?.querySelector('input');
    if (!input) throw new Error(label + ' switch missing');
    input.checked = on;
    input.dispatchEvent(new win.Event('change'));
  };
  return { win, p, log, errors, speed: win.ytafSpeed, toasts, parse, toggle, quality: (q) => { quality = q; } };
}

(async () => {
  // ---- The speed keys ----
  {
    const { win, speed, log, toasts, errors } = boot();
    t('the speed controller is installed', !!speed && speed.isSupported());
    speed.cycle();
    speed.cycle();
    t('a key press steps the speed at once, with a notice', speed.getSpeed() === 1.5 &&
      toasts().includes('Playback speed 1.25×') && toasts().includes('Playback speed 1.5×'), toasts().join(' | '));
    t('the video is not reloaded on every press', log.loads.length === 0, log.loads.join());
    await wait(AFTER_DELAY_MS);
    t('one reload for the burst, at the position it started from', log.loads.join() === 'abcdefghijk@42', log.loads.join());
    t('above 1x the reload is capped at 1080p', log.ranges[0] === 'hd1080', log.ranges.join());
    speed.cycle(); speed.cycle(); speed.cycle();
    t('cycling past 2x comes back to 1x', speed.getSpeed() === 1, String(speed.getSpeed()));
    await wait(AFTER_DELAY_MS);
    t('back at 1x a reload, with the quality range back to Auto',
      log.loads.length === 2 && log.ranges[log.ranges.length - 1] === 'auto', `${log.loads.join()} / ${log.ranges.join()}`);

    speed.step(1);
    speed.step(1);
    speed.step(-1);
    t('step: up twice and down once is 1.25x', speed.getSpeed() === 1.25, String(speed.getSpeed()));
    speed.reset();
    await wait(AFTER_DELAY_MS);
    t('back where the burst started: no reload', log.loads.length === 2, log.loads.join());
    for (let i = 0; i < 10; i++) speed.step(-1);
    t('step down stops at 0.25x', speed.getSpeed() === 0.25, String(speed.getSpeed()));
    for (let i = 0; i < 10; i++) speed.step(1);
    t('step up stops at 2x', speed.getSpeed() === 2, String(speed.getSpeed()));
    speed.setSpeed(3);
    t('a speed it cannot play is ignored', speed.getSpeed() === 2, String(speed.getSpeed()));
    await wait(AFTER_DELAY_MS);
    t('no jsdomError (keys)', errors.length === 0, errors[0]);
    win.close();
  }

  // ---- Switched off, a live stream, an error ----
  {
    const { win, speed, log, toasts } = boot({ enablePlaybackSpeed: false });
    speed.setSpeed(1.5);
    await wait(AFTER_DELAY_MS);
    t('switched off: a speed key only says so', toasts().includes('Playback speed is disabled in YTAF settings') &&
      speed.getSpeed() === 1 && log.loads.length === 0, toasts().join(' | '));
    t('switched off: YouTube\'s speed menu is not offered', win.eval('({}).enableSpeedOptions') === false);
    win.close();
  }
  {
    const { win, speed, log, toggle } = boot();
    speed.setSpeed(1.5, { immediate: true });
    t('a speed set at once reloads at once', log.loads.length === 1, log.loads.join());
    toggle('Playback Speed Control', false);
    t('switched off mid-video: back to 1x at once', log.loads.length === 2 && speed.getSpeed() === 1, log.loads.join());
    toggle('Playback Speed Control', true);
    toggle('Playback Speed Control', false);
    t('switched off at 1x: nothing to reload', log.loads.length === 2, log.loads.join());
    win.close();
  }
  {
    const { win, p, speed, log, toasts } = boot({}, { live: true });
    speed.setSpeed(1.5);
    t('a live stream: the speed is refused with a notice', toasts().includes('Playback speed is not available on a live stream') &&
      speed.getSpeed() === 1, toasts().join(' | '));
    // YouTube's own rate change on the live stream (its player API object).
    const api = win.eval('({})');
    const calls = [];
    api.setPlaybackRate = function (r) { calls.push(r); };
    api.setPlaybackRate(1.5);
    api.setPlaybackRate(1.03);
    t('YouTube\'s rate change to a speed plays 1x on a live stream; a catch-up rate passes', calls.join() === '1,1.03',
      calls.join());
    // Refused, not kept for later: the next video, not live, plays at 1x.
    p.live = false;
    p.videoId = 'notlive0001';
    await wait(AFTER_DELAY_MS);
    t('a speed refused on a live stream is not taken up by the next video', speed.getSpeed() === 1 && log.loads.length === 0,
      `${speed.getSpeed()} ${log.loads.join()}`);
    win.close();
  }
  {
    const { win, speed, log, toasts } = boot();
    speed.setSpeed(1.5, { immediate: true });
    speed.onError(new Error('decoder failed'));
    t('an engine error: a notice, and back to 1x', toasts().includes('Playback speed not available for this video') &&
      speed.getSpeed() === 1, toasts().join(' | '));
    await wait(AFTER_DELAY_MS);
    t('and the video reloaded at 1x', log.loads.length === 2, log.loads.join());
    speed.onError(new Error('again'));
    t('an error at 1x changes nothing', log.loads.length === 2 && toasts().filter((x) => /not available for this/.test(x)).length === 1);
    win.close();
  }

  // ---- The remote's keys mapped to the speed ----
  {
    const { win, speed, toasts } = boot({ shortcut_key_1: 'speed_up', shortcut_key_2: 'speed_down', shortcut_key_3: 'speed_reset' });
    const press = async (keyCode) => {
      for (const type of ['keydown', 'keyup']) {
        const e = new win.KeyboardEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'keyCode', { get: () => keyCode, configurable: true });
        dispatchTrusted(win.document.activeElement || win.document.body, e);
      }
      await wait(450);
    };
    await wait(600);
    await press(49);
    await press(49);
    t('Playback Speed + twice: 1.5x', speed.getSpeed() === 1.5, `${speed.getSpeed()} ${toasts().join(' | ')}`);
    await press(50);
    t('Playback Speed -: 1.25x', speed.getSpeed() === 1.25, String(speed.getSpeed()));
    await press(51);
    t('Playback Speed Reset: 1x', speed.getSpeed() === 1, String(speed.getSpeed()));
    win.close();
  }

  // ---- The stretched audio follows the TV's volume ----
  {
    const { win, speed } = boot();
    const video = win.document.querySelector('video');
    speed.createAudioSink({ speed: 1.5, element: video });
    const engine = speed.activeEngine();
    video.volume = 0.3;
    video.dispatchEvent(new win.Event('volumechange'));
    t('the engine\'s volume follows the video\'s', !!engine && engine.gain.gain.value === 0.3, engine && engine.gain.gain.value);
    video.muted = true;
    video.dispatchEvent(new win.Event('volumechange'));
    t('muted: silent', engine.gain.gain.value === 0, engine.gain.gain.value);
    speed.releaseAudioSink();
    video.muted = false;
    video.dispatchEvent(new win.Event('volumechange'));
    t('released: closed, and no longer told the volume', speed.activeEngine() === null && engine.ctx.state === 'closed' &&
      engine.gain.gain.value === 0, `${engine.ctx.state} ${engine.gain.gain.value}`);
    const bare = speed.createAudioSink({ speed: 1.25 });
    t('an engine without a video element', !!bare && speed.activeEngine() === bare);
    speed.releaseAudioSink();
    win.close();
  }

  // ---- What YouTube is made to show ----
  {
    const { win, parse } = boot();
    const button = () => ({ type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED_BUTTON', button: { buttonRenderer: { isDisabled: true } } });
    const overlays = parse({ playerOverlays: { playerOverlayRenderer: { transportControls: { transportControlsRenderer: {
      bottomActions: [button(), { type: 'OTHER', button: { buttonRenderer: { isDisabled: true } } }], label: 'x' } } } } });
    const actions = overlays.playerOverlays.playerOverlayRenderer.transportControls.transportControlsRenderer.bottomActions;
    t('the speed button is enabled and opens the speed menu',
      actions[0].button.buttonRenderer.isDisabled === false &&
      actions[0].button.buttonRenderer.command.openClientOverlayAction.type === 'CLIENT_OVERLAY_TYPE_VIDEO_PLAYBACK_SPEED' &&
      actions[1].button.buttonRenderer.isDisabled === true, JSON.stringify(actions));
    const bare = parse({ transportControls: { transportControlsRenderer: { actions: [button()] } } });
    t('also where the controls come on their own',
      bare.transportControls.transportControlsRenderer.actions[0].button.buttonRenderer.isDisabled === false);
    t('YouTube\'s speed menu is offered', win.eval('({}).enableSpeedOptions') === true);
    const own = win.eval('(function () { const o = {}; o.enableSpeedOptions = false; return o.enableSpeedOptions; })()');
    t('an object that sets its own value keeps it', own === false);
    win.close();
  }
  {
    const { win, parse } = boot({ enablePlaybackSpeed: false });
    const off = parse({ transportControls: { transportControlsRenderer: { actions: [
      { type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED_BUTTON', button: { buttonRenderer: { isDisabled: true } } }] } } });
    t('switched off: the speed button stays as YouTube sent it',
      off.transportControls.transportControlsRenderer.actions[0].button.buttonRenderer.isDisabled === true);
    win.close();
  }

  // ---- YouTube's own rate changes ----
  {
    const { win, p, speed, log } = boot();
    // The player element's own setPlaybackRate is bound a second in.
    await wait(1100);
    t('the player\'s setPlaybackRate is bound', p.__ytafSpeedBound === true && typeof p.__ytafOriginalSetPlaybackRate === 'function');
    // A player API object YouTube builds: the rate it is told is the viewer's pick in the menu.
    const api = win.eval('({})');
    const calls = [];
    api.setPlaybackRate = function (r) { calls.push(r); };
    api.setPlaybackRate(1.75);
    t('a rate picked in YouTube\'s menu becomes the speed', speed.getSpeed() === 1.75 && calls.join() === '1.75' &&
      log.loads.length === 1, `${speed.getSpeed()} ${calls.join()} ${log.loads.join()}`);
    api.setPlaybackRate(1.25);
    t('within 3 s of a reload YouTube\'s own rate calls are not taken as a pick', speed.getSpeed() === 1.75,
      String(speed.getSpeed()));
    // A class instance's setPlaybackRate is its own business.
    const inst = win.eval('(function () { class Player {} const x = new Player(); x.setPlaybackRate = function (r) { this.r = r; }; return x; })()');
    inst.setPlaybackRate(1.5);
    t('a class instance\'s setPlaybackRate is left alone', inst.r === 1.5 && speed.getSpeed() === 1.75);

    // After the reload YouTube's menu is told the real speed.
    log.rates.length = 0;
    p.rate = 1;
    await wait(2600);
    t('once the reloaded video started, the menu shows the speed', log.rates.join() === '1.75', log.rates.join());
    await wait(500);
    p.setPlaybackRate(2);
    t('a rate picked on the player (3 s after the reload) becomes the speed', speed.getSpeed() === 2 && log.rates.includes(2),
      `${speed.getSpeed()} ${log.rates.join()}`);
    win.close();
  }

  // ---- The audio offer off 1x, the cap on the next video ----
  {
    const { win, p, speed, log, parse, quality } = boot();
    const offer = () => ({ streamingData: { adaptiveFormats: [
      { mimeType: 'video/mp4; codecs="avc1.640028"' },
      { mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
      { mimeType: 'audio/mp4; codecs="ac-3"' }
    ] } });
    const mimes = (r) => r.streamingData.adaptiveFormats.map((f) => f.mimeType).join(' | ');
    t('at 1x the audio offer is left as it is', /ac-3/.test(mimes(parse(offer()))), mimes(parse(offer())));
    speed.setSpeed(1.5, { immediate: true });
    const fast = parse(offer());
    t('off 1x the audio the engine cannot stretch is left out', !/ac-3/.test(mimes(fast)) && /mp4a/.test(mimes(fast)), mimes(fast));
    // The next video starts at 2160p: capped once it plays.
    p.videoId = 'nextvideo01';
    quality('hd2160');
    log.ranges.length = 0;
    win.dispatchEvent(new win.CustomEvent('yt-player-state-change', { detail: { state: 1, videoId: 'nextvideo01' } }));
    t('the next video at 2160p is capped at 1080p once it plays', log.ranges.join() === 'hd1080', log.ranges.join());
    win.dispatchEvent(new win.CustomEvent('yt-player-state-change', { detail: { state: 1 } }));
    t('at 1080p it is left alone', log.ranges.join() === 'hd1080', log.ranges.join());
    win.close();
  }

  t('no jsdomError in any case', allErrors.length === 0, allErrors[0]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
