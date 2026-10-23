/**
 * Mono Audio (mono-audio.js): the <video> is routed through Web Audio only
 * once the option is on, into a node that mixes to one channel; off connects
 * it straight to the destination; a TV that hands the graph only silence is
 * reported once. jsdom has no Web Audio, so a recording fake stands in.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';

function boot(cfg) {
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_WATCH"><ytlr-app></ytlr-app><video></video></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){ return null; } addEventListener(){} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  win.cancelAnimationFrame = () => {};
  win.fetch = () => Promise.reject(new Error('offline'));

  const audio = { contexts: 0, sources: 0, silent: true };
  class Node {
    constructor(name) { this.name = name; this.out = []; this.channelCount = 2; this.channelCountMode = 'max'; this.channelInterpretation = 'speakers'; }
    connect(n) { this.out.push(n); }
    disconnect() { this.out = []; }
  }
  win.AudioContext = class {
    constructor() { audio.contexts++; this.state = 'running'; this.destination = new Node('destination'); audio.ctx = this; }
    createGain() { const n = new Node('gain'); n.gain = { value: 1 }; return n; }
    createMediaElementSource(el) { audio.sources++; const n = new Node('source'); n.el = el; audio.source = n; return n; }
    createAnalyser() {
      const n = new Node('analyser');
      n.fftSize = 2048;
      n.getByteTimeDomainData = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = audio.silent ? 128 : 128 + (i % 7); };
      return n;
    }
    resume() { return Promise.resolve(); }
  };
  win.localStorage.setItem('ytaf-configuration', win.JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    upgradeThumbnails: false, enableAutoLogin: false
  }, cfg)));
  applyChrome38Downgrade(win);
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, audio };
}

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = (win) => [...win.document.querySelectorAll('*')].map((e) => e.childElementCount ? '' : e.textContent).join('|');

function play(win, video) {
  Object.defineProperty(video, 'paused', { value: false, configurable: true });
  video.dispatchEvent(new win.Event('play'));
}

setTimeout(async () => {
  // ---- Off: Web Audio is never touched ----
  {
    const { win, audio } = boot({});
    play(win, win.document.querySelector('video'));
    await wait(50);
    t('off: no audio context, the <video> plays its own sound', audio.contexts === 0 && audio.sources === 0,
      `contexts=${audio.contexts} sources=${audio.sources}`);
  }

  // ---- On: routed through a one-channel mix; off goes straight to the speakers ----
  {
    const { win, audio } = boot({ monoAudio: true });
    const video = win.document.querySelector('video');
    play(win, video);
    await wait(50);
    const mix = audio.source && audio.source.out.find((n) => n.name === 'gain');
    t('on: the <video> is routed through Web Audio', audio.sources === 1 && audio.source.el === video, `sources=${audio.sources}`);
    t('on: into a node that mixes to one channel',
      !!mix && mix.channelCount === 1 && mix.channelCountMode === 'explicit' && mix.channelInterpretation === 'speakers',
      mix && `${mix.channelCount} ${mix.channelCountMode} ${mix.channelInterpretation}`);
    t('on: the mix plays on the destination', !!mix && mix.out[0] === audio.ctx.destination);

    play(win, video);
    await wait(20);
    t('a second play does not make a second source', audio.sources === 1, `sources=${audio.sources}`);

    // Sound comes through: no report, and the check stops.
    audio.silent = false;
    await wait(700);
    t('sound comes through: nothing reported', !/Mono Audio/.test(notes(win)));

  }

  // ---- Turning it off: straight to the destination, no new source ----
  {
    const { win, audio } = boot({ monoAudio: true });
    const video = win.document.querySelector('video');
    play(win, video);
    await wait(50);
    // Through the panel's checkbox, as on the TV: Green, then the Player tab.
    const ev = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => 404 });
    dispatchTrusted(win.document.body, ev);
    win.document.querySelectorAll('.ytaf-tab-btn')[1].click();
    const input = [...win.document.querySelectorAll('#ytaf-page-player label')].find((l) => /Mono Audio/.test(l.textContent))?.querySelector('input');
    t('the checkbox is on the panel and checked', !!input && input.checked === true);
    if (input) input.click();
    await wait(20);
    t('off: the source goes straight to the destination',
      audio.source.out.length >= 1 && audio.source.out[0] === audio.ctx.destination,
      audio.source.out.map((n) => n.name).join(','));
    t('off: no second source', audio.sources === 1, `sources=${audio.sources}`);
    t('off: the silence check still listens', audio.source.out.some((n) => n.name === 'analyser'),
      audio.source.out.map((n) => n.name).join(','));
  }

  // ---- A TV that gives the graph only silence is reported once ----
  {
    const { win } = boot({ monoAudio: true });
    play(win, win.document.querySelector('video'));
    await wait(5800);
    t('silence for 5 s is reported', /Mono Audio: no sound on this TV/.test(notes(win)), notes(win).replace(/\|+/g, '|').slice(0, 200));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 500);
