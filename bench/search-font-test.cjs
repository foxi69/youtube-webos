/**
 * Search results font (ui.js): the search page's video titles (.prqC5c,
 * which YouTube TV's CSS sets in Roboto) get the TV's font; other pages are
 * left alone. And titles over more than one line get tighter lines in the
 * black boxes of YouTube's memory saving. Both always on, with no switch in
 * the panel.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
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
  applyChrome38Downgrade(win);
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
  t('precondition: the panel is open, with New Liquid Glass UI on UI Tweaks',
    labels.some((l) => /New Liquid Glass UI/.test(l)), labels.length + ' labels');
  t('no switch for the search font in it', !labels.some((l) => /Search Results Font/.test(l)));
  t('no switch for the multiline titles in it', !labels.some((l) => /Multiline Titles/.test(l)));
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
{
  // Multiline titles in the black boxes of YouTube's memory saving (kept with
  // Remove Black Text Boxes off): tighter lines, with no switch, and an old
  // stored Fix Multiline Titles "off" does not count.
  const { win, errors } = boot({ removeLowMemoryStyle: false, fixMultilineTitles: false },
    'WEB_PAGE_TYPE_WATCH app-quality-root');
  const box = win.document.createElement('div');
  box.className = 'SK1srf';
  box.innerHTML = '<div class="WVWtef">A title over</div><div class="niS3yd">two lines</div>';
  win.document.body.appendChild(box);
  // 0.37vh, which jsdom gives in pixels.
  const want = (0.37 * win.innerHeight) / 100;
  const pads = [...box.children].flatMap((el) => {
    const cs = win.getComputedStyle(el);
    return [cs.paddingTop, cs.paddingBottom];
  });
  t('multiline titles: tighter lines in the boxes, an old "off" all the same',
    pads.length === 4 && pads.every((p) => Math.abs(parseFloat(p) - want) < 0.01), pads.join(' | '));
  t('multiline titles: no page errors', errors.length === 0, errors.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
