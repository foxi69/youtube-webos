/**
 * Fix Black Tile Previews on every webOS (preview-fix.js): on by default on
 * webOS 3-6 (fixBlackPreviews), off by default on webOS 22 and newer, where
 * it has a key of its own (fixBlackPreviews22) because the old key is stored
 * as true there too (its old default) and must not turn it on.
 *
 * On, while a preview plays, what draws over the middle of the video loses
 * its paint (class ytaf-pfix-cleared); jsdom has no layout, so the stack at
 * that point (elementsFromPoint) and the video's box are given here.
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(ua, cfg) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e && e.message)));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app>' +
    '<ytlr-surface-page id="cover" style="background-color: rgb(0, 0, 0)"></ytlr-surface-page><video></video></ytlr-app></body></html>',
  { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, ua);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.requestAnimationFrame = () => 0;
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableSponsorBlock: false, enableReturnYouTubeDislike: false, enableAutoLogin: false
  }, cfg)));
  applyChrome38Downgrade(win);
  win.fetch = () => Promise.reject(new Error('offline'));
  // Layout: the black surface page over the middle of the playing preview.
  const cover = win.document.getElementById('cover');
  const video = win.document.querySelector('video');
  video.getBoundingClientRect = () => ({ left: 100, top: 100, width: 640, height: 360, right: 740, bottom: 460 });
  Object.defineProperty(video, 'paused', { get: () => false, configurable: true });
  win.document.elementsFromPoint = () => [cover, video];
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, errors, cover, video };
}

const on = (win) => win.document.documentElement.classList.contains('ytaf-pfix-clear');

async function preview(b) {
  b.video.dispatchEvent(new b.win.Event('playing'));
  await wait(20);
  return b.cover.classList.contains('ytaf-pfix-cleared');
}

function panelSwitch(win) {
  const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
  dispatchTrusted(win.document.body, e);
  for (const tab of win.document.querySelectorAll('.ytaf-tab-btn')) tab.click();
  return [...win.document.querySelectorAll('label')]
    .filter((l) => l.textContent.indexOf('Fix Black Tile Previews') !== -1)
    .map((l) => l.querySelector('input[type=checkbox]'));
}

(async () => {
  // ---- webOS 22 and newer ----
  {
    const b = boot(UA.webos23, {});
    t('webOS 23, default: off', !on(b.win));
    t('webOS 23, default: a preview leaves the surface as it is', !(await preview(b)));
    t('no page errors', b.errors.length === 0, b.errors.join(' | '));
  }
  {
    const b = boot(UA.webos23, { fixBlackPreviews: true });
    t('webOS 23, the old key stored as true (its old default): still off', !on(b.win) && !(await preview(b)));
  }
  {
    const b = boot(UA.webos23, { fixBlackPreviews22: true });
    t('webOS 23, switched on: on', on(b.win));
    t('webOS 23, switched on: the surface over the preview loses its paint', await preview(b));
    t('no page errors', b.errors.length === 0, b.errors.join(' | '));
  }
  {
    const b = boot(UA.webos23, {});
    const boxes = panelSwitch(b.win);
    t('webOS 23: one switch in the panel, off', boxes.length === 1 && boxes[0].checked === false, String(boxes.length));
    if (boxes.length === 1) {
      // A preview already playing while it is off: switching on clears it
      // without waiting for another 'playing'.
      t('webOS 23, off: a playing preview is left as it is', !(await preview(b)));
      boxes[0].click();
      await wait(20);
      t('webOS 23: switched on in the panel, on at once', on(b.win));
      t('...and the preview already playing is cleared at once', b.cover.classList.contains('ytaf-pfix-cleared'));
      await wait(400);
      t('...and stored under its own key', JSON.parse(b.win.localStorage.getItem('ytaf-configuration')).fixBlackPreviews22 === true);
      boxes[0].click();
      await wait(20);
      t('webOS 23: switched off again', !on(b.win) && !b.cover.classList.contains('ytaf-pfix-cleared'));
    }
  }
  // ---- webOS 3-6 ----
  {
    const b = boot(UA.webos4, {});
    t('webOS 4, default: on', on(b.win));
    t('webOS 4, default: the surface over the preview loses its paint', await preview(b));
  }
  {
    const b = boot(UA.webos4, { fixBlackPreviews: false, fixBlackPreviews22: true });
    t('webOS 4: its own key off turns it off, the webOS 22 key does not count', !on(b.win) && !(await preview(b)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
