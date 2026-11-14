/**
 * Fix Search Results Font (ui.js): on by default, the search page's video
 * titles (.prqC5c, which YouTube TV's CSS sets in Roboto) get the TV's font;
 * other pages, and the setting off, leave them alone. The switch in the panel
 * applies at once.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
const GREEN = 404;
const LABEL = 'Fix Search Results Font';

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };

function boot(cfg, page) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e && e.message)));
  const dom = new JSDOM(`<!doctype html><html><body class="${page}"><ytlr-app>` +
    '<ytlr-tile-renderer><span class="prqC5c">A video title</span></ytlr-tile-renderer></ytlr-app></body></html>',
  { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.requestAnimationFrame = () => 0;
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableSponsorBlock: false, enableReturnYouTubeDislike: false, enableAutoLogin: false
  }, cfg)));
  applyChrome38Downgrade(win);
  win.fetch = () => Promise.reject(new Error('offline'));
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, errors };
}

const fontOf = (win) => win.getComputedStyle(win.document.querySelector('.prqC5c')).fontFamily || '';
const hasClass = (win) => win.document.documentElement.classList.contains('ytaf-fix-search-font');

function panelSwitch(win) {
  const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
  dispatchTrusted(win.document.body, e);
  for (const tab of win.document.querySelectorAll('.ytaf-tab-btn')) tab.click();
  return [...win.document.querySelectorAll('label')]
    .filter((l) => l.textContent.indexOf(LABEL) !== -1)
    .map((l) => l.querySelector('input[type=checkbox]'))[0];
}

{
  const { win, errors } = boot({}, 'WEB_PAGE_TYPE_SEARCH');
  t('default: the class is on <html>', hasClass(win));
  t('default, search page: the titles get the TV\'s font first', /^"?LG Display-Regular"?/.test(fontOf(win)), fontOf(win));
  t('no page errors', errors.length === 0, errors.join(' | '));
}
{
  const { win } = boot({}, 'WEB_PAGE_TYPE_BROWSE');
  t('control, another page: the titles are left alone', fontOf(win).indexOf('LG Display') === -1, fontOf(win));
}
{
  const { win, errors } = boot({ fixSearchFont: false }, 'WEB_PAGE_TYPE_SEARCH');
  t('off: no class', !hasClass(win));
  t('off, search page: the titles are left alone', fontOf(win).indexOf('LG Display') === -1, fontOf(win));
  const box = panelSwitch(win);
  t('the switch is in the panel, off', !!box && box.checked === false);
  if (box) {
    box.click();
    t('switched on in the panel: the font at once', hasClass(win) && /LG Display/.test(fontOf(win)), fontOf(win));
    box.click();
    t('switched off again: left alone', !hasClass(win) && fontOf(win).indexOf('LG Display') === -1, fontOf(win));
  }
  t('no page errors', errors.length === 0, errors.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
