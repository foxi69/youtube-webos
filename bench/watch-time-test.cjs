/**
 * Show Watch Time With the Clock (watch-time.js, watch.js): the clock reads
 * "<time> · 1h 05m watched", where only playback on the watch and Shorts
 * pages counts - not pauses, buffering or previews on the browse pages - and
 * the panel row is off while the clock is.
 *
 * Usage: node bench/watch-time-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const GREEN = 404;
const MIN = 60000;

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e.message));
const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_WATCH"><ytlr-app><video></video></ytlr-app></body></html>',
  { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
const win = dom.window;
setUserAgent(win, UA.webos3);
win.launchParams = '{}';
win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
win.requestAnimationFrame = (cb) => win.setTimeout(() => cb(Date.now()), 0);
win.cancelAnimationFrame = () => {};
win.localStorage.setItem('ytaf-configuration', win.JSON.stringify({
  enableAdBlock: false, enableLegacyEmojiFix: false, enableSponsorBlock: false,
  enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false,
  clockMode: 'time', showWatchTime: true
}));

// The page's clock: real time plus an offset the cases move forward.
const RealDate = win.Date;
let offset = 0;
class FakeDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset); }
  static now() { return RealDate.now() + offset; }
}
win.Date = FakeDate;

applyChrome38Downgrade(win);
win.eval(fs.readFileSync(bundlePath, 'utf8'));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = win.document;

function key(code) {
  const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => code, configurable: true });
  dispatchTrusted(doc.body, e);
}
// The panel row of a setting, found by its label.
function row(label) {
  return [...doc.querySelectorAll('.ytaf-ui-container label')].find((l) => l.textContent.trim() === label);
}
function toggle(label) {
  const input = row(label).querySelector('input');
  input.checked = !input.checked;
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
}
const clockText = () => (doc.querySelector('.webOs-watch') || {}).textContent || '';
// Switching the setting off and on again redraws the clock now, not at the minute.
function refresh() {
  toggle('Show Watch Time With the Clock');
  toggle('Show Watch Time With the Clock');
  return clockText();
}
const fire = (el, type) => el.dispatchEvent(new win.Event(type));

(async () => {
  await sleep(300);
  key(GREEN);
  await sleep(100);
  const video = doc.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => false, configurable: true });

  t('panel has the row', !!row('Show Watch Time With the Clock'));
  t('clock starts at 0m', / · 0m watched$/.test(clockText()), JSON.stringify(clockText()));

  fire(video, 'playing');
  offset += 5 * MIN + 1000;
  t('5 minutes of playback count', / · 5m watched$/.test(refresh()), JSON.stringify(clockText()));

  fire(video, 'pause');
  offset += 10 * MIN;
  t('a pause does not count', / · 5m watched$/.test(refresh()), JSON.stringify(clockText()));

  fire(video, 'playing');
  offset += 61 * MIN;
  t('past an hour: "1h 06m"', / · 1h 06m watched$/.test(refresh()), JSON.stringify(clockText()));

  fire(video, 'waiting');
  offset += 5 * MIN;
  t('buffering does not count', / · 1h 06m watched$/.test(refresh()), JSON.stringify(clockText()));

  // A preview on a browse page plays a <video> too.
  doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
  await sleep(50);
  fire(video, 'playing');
  offset += 5 * MIN;
  t('a preview on a browse page does not count', / · 1h 06m watched$/.test(refresh()), JSON.stringify(clockText()));

  // Back to a video that already plays: counting picks up with the page.
  doc.body.className = 'WEB_PAGE_TYPE_WATCH';
  await sleep(50);
  offset += 2 * MIN;
  t('a video already playing when the watch page shows counts', / · 1h 08m watched$/.test(refresh()), JSON.stringify(clockText()));

  toggle('Show Watch Time With the Clock');
  t('switched off: the time alone', !/watched/.test(clockText()) && clockText().length > 0, JSON.stringify(clockText()));

  t('row enabled while the clock is on', !row('Show Watch Time With the Clock').querySelector('input').disabled);

  t('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
