/**
 * Behaviour test for What's New (src/about.js): the seen version is stored only
 * when the window opens, so an update whose window never got its browse page
 * (a long stay on "Who's watching") still shows it on the next start.
 *
 * Usage: node bench/whats-new-test.cjs [bundle]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const INSTALLED = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const SEEN = 'ytaf-seen-version';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polls until cond() holds or the time runs out; returns whether it held.
function waitFor(cond, timeout = 5000, step = 25) {
  const end = Date.now() + timeout;
  const poll = () => (cond() ? Promise.resolve(true)
    : Date.now() >= end ? Promise.resolve(false)
      : sleep(step).then(poll));
  return poll();
}

function boot(bodyClass, storage, setup) {
  const dom = new JSDOM(`<!doctype html><html><body class="${bodyClass}"><ytlr-app></ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  for (const k of Object.keys(storage)) win.localStorage.setItem(k, storage[k]);
  if (setup) setup(win);
  applyChrome38Downgrade(win);
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return win;
}

const open = (win) => !!win.document.querySelector('.ytaf-dialog');
const seen = (win) => win.localStorage.getItem(SEEN);
const CONFIG = JSON.stringify({ enableAdBlock: true });

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

(async () => {
  // An update, still on "Who's watching".
  const picker = boot('WEB_PAGE_TYPE_ACCOUNT_SELECTOR', { 'ytaf-configuration': CONFIG, [SEEN]: '0.1.0' });
  await sleep(3600);
  t('no window on the account picker', !open(picker));
  t('the seen version waits for the window', seen(picker) === '0.1.0', seen(picker));
  picker.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
  await sleep(2500);
  t('the window opens on the browse page', open(picker));
  t('and the version counts as seen then', seen(picker) === INSTALLED, seen(picker));

  // No update: nothing to show.
  const same = boot('WEB_PAGE_TYPE_BROWSE', { 'ytaf-configuration': CONFIG, [SEEN]: INSTALLED });
  await sleep(3600);
  t('same version: no window', !open(same));

  // A first install shows nothing and starts counting from here.
  const fresh = boot('WEB_PAGE_TYPE_BROWSE', {});
  await sleep(3600);
  t('first install: no window', !open(fresh));
  t('first install: the version is stored', seen(fresh) === INSTALLED, seen(fresh));

  // The option off: not shown, and not owed later.
  const off = boot('WEB_PAGE_TYPE_BROWSE', { 'ytaf-configuration': JSON.stringify({ showWhatsNew: false }), [SEEN]: '0.1.0' });
  await sleep(3600);
  t('option off: no window', !open(off));
  t('option off: the version is stored', seen(off) === INSTALLED, seen(off));

  // An update offered while What's New is owed, both waiting on "Who's
  // watching": the Update window waits its turn instead of opening over What's
  // New. Timers run ten times faster here, What's New's own start on another
  // beat, so the update offer is the first to see the browse page.
  {
    const bridgeErrors = [];
    let hbAnswered = false;
    const update = boot('WEB_PAGE_TYPE_ACCOUNT_SELECTOR', {
      'ytaf-configuration': CONFIG, [SEEN]: '0.1.0',
      'ytaf-update-check': JSON.stringify({ at: Date.now(), latest: '99.0.0', ipk: { url: 'https://example.com/a.ipk' } })
    }, (win) => {
      const realTimeout = win.setTimeout.bind(win);
      win.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 3000 ? 350 : (ms || 0) / 10, ...args);
      win.PalmServiceBridge = function () {
        this.call = (uri) => {
          const hb = /getAppInfo/.test(uri);
          const answer = hb ? JSON.stringify({ returnValue: true, appInfo: { id: 'hb' } }) : 'null';
          // The Homebrew Channel answers a little late; the installer with
          // something that is not an object.
          setTimeout(() => {
            try { this.onservicecallback(answer); } catch (e) { bridgeErrors.push(e.message); }
            if (hb) hbAnswered = true;
          }, hb ? 400 : 10);
        };
      };
    });
    await sleep(1600);
    update.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    const titles = () => Array.from(update.document.querySelectorAll('.ytaf-dialog-title')).map((n) => n.textContent);
    // Both windows must have had their chance: What's New is open and the
    // Homebrew Channel has answered the update offer. Only then does "one
    // window" say the Update window waited, whatever the timing on CI.
    const whatsNewOpen = await waitFor(() => titles().some((x) => /What's new/.test(x)));
    const hbDone = await waitFor(() => hbAnswered);
    // The answer's window, had it not waited, opens on the next turns.
    await sleep(300);
    t('update offered during What\'s New: one window at a time',
      whatsNewOpen && hbDone && titles().length === 1 && /What's new/.test(titles()[0]),
      JSON.stringify({ whatsNewOpen, hbDone, titles: titles() }));
    update.dispatchEvent(new update.KeyboardEvent('keydown', { keyCode: 27, bubbles: true }));
    const updateOpen = await waitFor(() => titles().some((x) => /Update/.test(x)));
    t('and the Update window comes once What\'s New closes',
      updateOpen && titles().length === 1 && /Update/.test(titles()[0]), JSON.stringify(titles()));
    const button = Array.from(update.document.querySelectorAll('.ytaf-dialog-btn')).find((b) => b.textContent === 'Update');
    if (button) button.click();
    await sleep(100);
    t('an installer answer that is not an object throws nothing', !!button && bridgeErrors.length === 0, button ? bridgeErrors.join(' | ') : 'no Update button');
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
