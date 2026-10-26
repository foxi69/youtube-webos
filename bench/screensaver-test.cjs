/**
 * The frozen-picture nudge in screensaver-fix.js: only a resume after a long
 * pause (when a video screensaver can have taken the decoder) whose clock
 * stands still gets a seek in place. First plays, short pauses and a resume
 * paused again before the check are left alone, and a stall met during
 * another video's cooldown is nudged once the cooldown is over.
 *
 * Usage: node bench/screensaver-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const dom = new JSDOM('<!doctype html><html><body><ytlr-app></ytlr-app></body></html>', {
  runScripts: 'outside-only', url: 'https://www.youtube.com/tv',
  virtualConsole: new VirtualConsole(), pretendToBeVisual: true
});
const win = dom.window;
setUserAgent(win, UA.webos3);
win.launchParams = '{}';
win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} addEventListener() {} };
applyChrome38Downgrade(win);
win.fetch = () => Promise.reject(new Error('offline'));

// The page's clock: real time plus an offset the cases move forward.
let offset = 0;
const realNow = win.Date.now.bind(win.Date);
win.Date.now = () => realNow() + offset;

win.eval(fs.readFileSync(process.argv[2] || path.resolve(__dirname, '../dist/webOSUserScripts/userScript.js'), 'utf8'));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A <video> that reports playing and ready, with a clock that never moves:
// what the element looks like once a screensaver took its decoder.
function frozenVideo() {
  const v = win.document.createElement('video');
  win.document.body.appendChild(v);
  v.seeks = 0;
  Object.defineProperty(v, 'paused', { get: () => false });
  Object.defineProperty(v, 'seeking', { get: () => false });
  Object.defineProperty(v, 'readyState', { get: () => 4 });
  Object.defineProperty(v, 'currentTime', { get: () => 5, set: () => { v.seeks++; } });
  return v;
}
const fire = (v, type) => v.dispatchEvent(new win.Event(type));
const pauseFor = (v, ms) => { fire(v, 'pause'); offset += ms; };
// Past the 10s cooldown a previous case's nudge started.
const clearCooldown = () => { offset += 20000; };

(async () => {
  {
    const v = frozenVideo();
    fire(v, 'playing');
    await sleep(2300);
    t('first play: left alone', v.seeks === 0, 'seeks ' + v.seeks);
  }
  {
    const v = frozenVideo();
    pauseFor(v, 5000);
    fire(v, 'playing');
    await sleep(2300);
    t('resume after a short pause: left alone', v.seeks === 0, 'seeks ' + v.seeks);
  }
  {
    const v = frozenVideo();
    pauseFor(v, 120000);
    fire(v, 'playing');
    await sleep(2300);
    t('resume after a long pause, clock stuck: one seek in place', v.seeks === 1, 'seeks ' + v.seeks);
    clearCooldown();
  }
  {
    const v = frozenVideo();
    pauseFor(v, 120000);
    fire(v, 'playing');
    await sleep(500);
    fire(v, 'pause');
    await sleep(1800);
    t('paused again before the check: the check is dropped', v.seeks === 0, 'seeks ' + v.seeks);
    clearCooldown();
  }
  {
    // Two stalls 300ms apart: the first is nudged and starts the cooldown;
    // the second, checked while it runs, waits it out instead of giving up.
    const a = frozenVideo();
    const b = frozenVideo();
    fire(a, 'pause');
    pauseFor(b, 120000);
    fire(a, 'playing');
    await sleep(300);
    fire(b, 'playing');
    await sleep(1850);
    t('first of two stalls: nudged', a.seeks === 1, 'seeks ' + a.seeks);
    // 150ms after the first nudge; let all but ~50ms of its cooldown pass.
    offset += 9800;
    await sleep(500);
    t('second stall during the cooldown: nudged once the cooldown is over', b.seeks === 1, 'seeks ' + b.seeks);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
