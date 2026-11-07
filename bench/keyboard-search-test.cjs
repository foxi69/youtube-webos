/**
 * Type in Search with a Keyboard (src/keyboard-search.js): the first character
 * is a probe of whether YouTube types by itself. A query box that went away
 * while it waited (Back pressed at once) settles nothing: the next character
 * decides, and on a TV that does not type by itself the on-screen keys are
 * still pressed. It used to read the missing box as YouTube typing natively,
 * and left the keyboard alone for the rest of the session.
 *
 * Usage: node bench/keyboard-search-test.cjs [bundle]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e.message));
const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_SEARCH"><ytlr-app>' +
  '<ytlr-search-text-box><span></span></ytlr-search-text-box>' +
  '<ytlr-keyboard-key aria-label="a">a</ytlr-keyboard-key><ytlr-keyboard-key aria-label="b">b</ytlr-keyboard-key>' +
  '</ytlr-app></body></html>',
{ runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/search', virtualConsole: vc, pretendToBeVisual: true });
const win = dom.window;
setUserAgent(win, UA.webos23);
win.launchParams = '{}';
win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
win.fetch = () => new Promise(() => {});
win.localStorage.setItem('ytaf-configuration', JSON.stringify({ enableAdBlock: false, checkForUpdates: false, showWhatsNew: false }));
win.Element.prototype.getBoundingClientRect = function () {
  return { top: 0, left: 0, right: 40, bottom: 40, width: 40, height: 40, x: 0, y: 0 };
};
applyChrome38Downgrade(win);
win.eval(fs.readFileSync(bundlePath, 'utf8'));

const doc = win.document;
const app = doc.querySelector('ytlr-app');
// An on-screen key types its label into the query; YouTube itself does
// nothing with a keyboard's keys on this TV.
for (const k of doc.querySelectorAll('ytlr-keyboard-key')) {
  k.addEventListener('click', () => {
    const box = doc.querySelector('ytlr-search-text-box span');
    if (box) box.textContent += k.getAttribute('aria-label');
  });
}
const type = (ch) => {
  const e = new win.KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => ch.toUpperCase().charCodeAt(0), configurable: true });
  dispatchTrusted(doc.body, e);
};
const query = () => (doc.querySelector('ytlr-search-text-box') || {}).textContent;

(async () => {
  await sleep(300);
  type('a');
  // The query box goes before the probe settles.
  const box = doc.querySelector('ytlr-search-text-box');
  box.parentNode.removeChild(box);
  await sleep(600);
  // Back again, with an empty query.
  const again = doc.createElement('ytlr-search-text-box');
  again.appendChild(doc.createElement('span'));
  app.insertBefore(again, app.firstChild);
  type('b');
  await sleep(1500);
  t('a query box gone during the probe settles nothing: the next character is typed on the on-screen keys',
    query() === 'b', JSON.stringify(query()));
  t('no jsdomError', errors.length === 0, errors[0]);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
