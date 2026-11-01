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

function boot(bodyClass, storage) {
  const dom = new JSDOM(`<!doctype html><html><body class="${bodyClass}"><ytlr-app></ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  for (const k of Object.keys(storage)) win.localStorage.setItem(k, storage[k]);
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

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
