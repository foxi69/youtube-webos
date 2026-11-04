/**
 * Reset All Settings (About tab): two presses, every setting back to its
 * default in the storage and in the panel, the accounts' setup left alone.
 *
 * Usage: node bench/settings-reset-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const GREEN = 404;
const LABEL = 'Reset All Settings';
const PROFILE_PREFIX = 'ytaf-configuration::';
const IDENTITY = JSON.stringify({ data: { identityType: 'SIGNED_IN', obfuscatedGaiaId: '1111', accessToken: 'tok' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(cfg, storage = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.requestAnimationFrame = () => 0;
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', win.JSON.stringify(cfg));
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  applyChrome38Downgrade(win);
  win.fetch = () => Promise.reject(new Error('offline'));
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
  dispatchTrusted(win.document.body, e);
  const tabs = win.document.querySelectorAll('.ytaf-tab-btn');
  tabs[tabs.length - 1].click();
  const button = [...win.document.querySelectorAll('#ytaf-page-about button')]
    .find((b) => b.textContent === LABEL);
  return { win, errors, button, stored: () => JSON.parse(win.localStorage.getItem('ytaf-configuration')) };
}

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};

const CHANGED = {
  enableAdBlock: false, removeGlobalShorts: true, blockedChannels: ['Some Channel'], blockedKeywords: ['word'],
  logoStyle: 'premium', seekStep: '10', showWhatsNew: false, checkForUpdates: false,
  foxThemeApplied: true
};

setTimeout(async () => {
  {
    const { win, errors, button, stored } = boot(CHANGED);
    t('the button is on the About tab', !!button);
    button.click();
    await sleep(300);
    t('one press changes no setting', stored().enableAdBlock === false && stored().blockedChannels.length === 1,
      JSON.stringify(stored()).slice(0, 120));
    t('one press asks for a second', /press again/i.test(button.textContent), button.textContent);
    button.dispatchEvent(new win.Event('blur'));
    t('leaving the button takes the first press back', button.textContent === LABEL, button.textContent);
    button.click();
    button.dispatchEvent(new win.Event('blur'));
    button.click();
    await sleep(300);
    t('a press after leaving counts as the first', stored().enableAdBlock === false, String(stored().enableAdBlock));
    button.click();
    t('the label is back after the reset', button.textContent === LABEL, button.textContent);
    await sleep(300);
    const s = stored();
    t('a boolean is back at its default', s.enableAdBlock === true && s.removeGlobalShorts === false,
      `${s.enableAdBlock} ${s.removeGlobalShorts}`);
    t('the lists are empty', s.blockedChannels.length === 0 && s.blockedKeywords.length === 0);
    t('a multi-value setting is back at its default', s.logoStyle !== 'premium' && s.seekStep === '0', `${s.logoStyle} ${s.seekStep}`);
    t('the About tab\'s own switches are back on', s.showWhatsNew === true && s.checkForUpdates === true);
    t('the one-time theme flag stays', s.foxThemeApplied === true, String(s.foxThemeApplied));
    const box = win.document.querySelector('#ytaf-page-about input[type=checkbox]');
    t('the panel shows the defaults', box && box.checked === true);
    t('no page errors', errors.length === 0, errors.join(' | '));
  }
  {
    const { button, stored } = boot(CHANGED);
    button.click();
    await sleep(6300);
    t('the first press runs out', button.textContent === LABEL, button.textContent);
    button.click();
    await sleep(300);
    t('a press after that counts as the first', /press again/i.test(button.textContent) && stored().enableAdBlock === false,
      button.textContent + ' ' + stored().enableAdBlock);
  }
  {
    const other = PROFILE_PREFIX + 'other-account';
    const otherValues = JSON.stringify({ enableAdBlock: false, blockedChannels: ['Theirs'] });
    const { win, button, stored } = boot({ perAccountSettings: true, enableAdBlock: false, blockedChannels: ['Mine'] },
      { 'yt.leanback.default::last-identity-used': IDENTITY, [other]: otherValues });
    await sleep(300);
    const keys = Object.keys(win.localStorage).filter((k) => k.startsWith(PROFILE_PREFIX) && k !== other);
    t('the account has its own settings', keys.length === 1, keys.join());
    t('they start changed', JSON.parse(win.localStorage.getItem(keys[0])).enableAdBlock === false);
    button.click();
    button.click();
    await sleep(300);
    const own = JSON.parse(win.localStorage.getItem(keys[0]));
    t('this account\'s settings are back at their defaults', own.enableAdBlock === true && own.blockedChannels.length === 0,
      JSON.stringify(own).slice(0, 120));
    t('another account\'s settings are left alone', win.localStorage.getItem(other) === otherValues, win.localStorage.getItem(other));
    t('separate settings for each account stays on', stored().perAccountSettings === true, String(stored().perAccountSettings));
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 0);
