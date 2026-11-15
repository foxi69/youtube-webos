/**
 * Search results font (ui.js): the search page's video titles (.prqC5c,
 * which YouTube TV's CSS sets in Roboto) get the TV's font; other pages are
 * left alone. Always on, with no switch in the panel.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted, applyChrome87Downgrade } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const GREEN = 404;

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
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  win.fetch = () => Promise.reject(new Error('offline'));
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, errors };
}

const fontOf = (win) => win.getComputedStyle(win.document.querySelector('.prqC5c')).fontFamily || '';

// The panel's labels, every tab opened.
function panelLabels(win) {
  const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
  dispatchTrusted(win.document.body, e);
  for (const tab of win.document.querySelectorAll('.ytaf-tab-btn')) tab.click();
  return [...win.document.querySelectorAll('label')].map((l) => l.textContent);
}

{
  const { win, errors } = boot({}, 'WEB_PAGE_TYPE_SEARCH');
  t('search page: the titles get the TV\'s font first', /^"?LG Display-Regular"?/.test(fontOf(win)), fontOf(win));
  // The panel must have opened: a UI Tweaks switch that stays is there first.
  const labels = panelLabels(win);
  t('precondition: the panel is open, with Fix Multiline Titles on UI Tweaks',
    labels.some((l) => /Fix Multiline Titles/.test(l)), labels.length + ' labels');
  t('no switch for the search font in it', !labels.some((l) => /Search Results Font/.test(l)));
  t('no page errors', errors.length === 0, errors.join(' | '));
}
{
  const { win } = boot({}, 'WEB_PAGE_TYPE_BROWSE');
  t('control, another page: the titles are left alone', fontOf(win).indexOf('LG Display') === -1, fontOf(win));
}
{
  // A stored value from the build that had the switch does not count.
  const { win, errors } = boot({ fixSearchFont: false }, 'WEB_PAGE_TYPE_SEARCH');
  t('an old stored "off": the font all the same', /LG Display/.test(fontOf(win)), fontOf(win));
  t('no page errors', errors.length === 0, errors.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
