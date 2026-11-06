/**
 * Remove Black Text Boxes (app-quality-fix.js, from NicholasBly/youtube-webos#215):
 * YouTube's low-memory class comes off <body> at start and each time YouTube
 * puts it back, the setting turned off gives it back, and with it off from the
 * start the class is left alone. OLED-Care's rules for those elements no longer
 * need the class.
 *
 * Usage: node bench/low-memory-style-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const GREEN = 404;
const CLS = 'app-quality-root';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(cfg) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(`<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE ${CLS}"><ytlr-app></ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', win.JSON.stringify(Object.assign({
    enableAdBlock: false, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false,
    checkForUpdates: false, showWhatsNew: false
  }, cfg)));
  applyChrome38Downgrade(win);
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.fetch = () => new Promise(() => {});
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  const has = () => win.document.body.classList.contains(CLS);
  const openPanel = () => {
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
    dispatchTrusted(win.document.body, e);
    const tab = [...win.document.querySelectorAll('.ytaf-tab-btn')].find((b) => b.textContent.trim() === 'UI Tweaks');
    if (tab) tab.click();
  };
  // The panel's Remove Black Text Boxes checkbox, set as the remote would.
  const setBox = (on) => {
    const label = [...win.document.querySelectorAll('.ytaf-ui-container label')]
      .find((l) => l.textContent.trim() === 'Remove Black Text Boxes');
    const box = label && label.querySelector('input[type=checkbox]');
    if (!box) return false;
    box.checked = on;
    box.dispatchEvent(new win.Event('change', { bubbles: true }));
    return true;
  };
  return { win, errors, has, openPanel, setBox };
}

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};

setTimeout(async () => {
  {
    const { win, errors, has, openPanel, setBox } = boot({});
    await wait(20);
    t('on by default: the class is off <body> at start', !has());
    t('the page\'s own classes stay', win.document.body.classList.contains('WEB_PAGE_TYPE_BROWSE'));

    // YouTube writes body.className whole on navigation.
    win.document.body.className = `WEB_PAGE_TYPE_WATCH ${CLS}`;
    await wait(20);
    t('a className rewrite with the class loses it again', !has());
    t('and keeps the rest of the rewrite', win.document.body.classList.contains('WEB_PAGE_TYPE_WATCH'));
    win.document.body.classList.add(CLS);
    await wait(20);
    t('a classList.add of it is taken off too', !has());

    openPanel();
    await wait(20);
    t('the setting is in the panel, checked', setBox(true));
    setBox(false);
    await wait(20);
    t('turned off: YouTube gets its class back', has());
    win.document.body.className = `WEB_PAGE_TYPE_BROWSE ${CLS}`;
    await wait(20);
    t('and keeps it after a rewrite', has());
    setBox(true);
    await wait(20);
    t('turned on again: the class goes', !has());
    win.document.body.className = `WEB_PAGE_TYPE_BROWSE ${CLS}`;
    await wait(20);
    t('and stays off after a rewrite', !has());
    t('no page errors', errors.length === 0, errors.join(' | '));
  }

  {
    const { win, errors, has } = boot({ removeLowMemoryStyle: false });
    await wait(20);
    t('off from the start: the class stays', has());
    win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
    await wait(20);
    t('and is not put on a body that has none', !has());
    t('off: no page errors', errors.length === 0, errors.join(' | '));
  }

  {
    // OLED-Care's true black and transparent shelf, with the class gone.
    const { win } = boot({ enableOledCareMode: true, videoShelfOpacity: 100 });
    await wait(20);
    win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    // YouTube's own grey backgrounds, for OLED-Care to override.
    win.document.body.insertAdjacentHTML('beforeend',
      '<style>.DnwJH, .UGcxnc .dxLAmd, .UGcxnc .Dc2Zic .JkDfAc { background-color: rgb(33, 33, 33); }</style>' +
      '<div class="DnwJH"></div><div class="UGcxnc"><div class="dxLAmd"></div>' +
      '<div class="Dc2Zic"><div class="JkDfAc"></div></div></div>');
    const bg = (sel) => win.getComputedStyle(win.document.querySelector(sel)).backgroundColor;
    t('OLED-Care: the element under the player is black without the class',
      /^(?:rgb\(0, 0, 0\)|#000)$/.test(bg('.DnwJH')), bg('.DnwJH'));
    t('OLED-Care: the transparent shelf without the class',
      /rgba\(0, 0, 0, 0\)|transparent/.test(bg('.dxLAmd')), bg('.dxLAmd'));
    t('OLED-Care: the shelf\'s inner backdrop too',
      /rgba\(0, 0, 0, 0\)|transparent/.test(bg('.JkDfAc')), bg('.JkDfAc'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 0);
