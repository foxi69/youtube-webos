/**
 * Show Video Quality Next to the Title (quality-tag.js): a stylesheet rule
 * puts the quality the video plays in after the metadata line under the
 * title, follows the picture when the stream switches quality, and is
 * cleared off the watch page and with the option off.
 *
 * Usage: node bench/quality-tag-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const GREEN = 404;

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
  showQualityInTitle: true
}));
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
function toggle(label) {
  const row = [...doc.querySelectorAll('.ytaf-ui-container label')].find((l) => l.textContent.trim() === label);
  const input = row.querySelector('input');
  input.checked = !input.checked;
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  return row;
}
const rule = () => (doc.getElementById('ytaf-quality-tag') || {}).textContent || '';
const video = doc.querySelector('video');
let size = [0, 0];
Object.defineProperty(video, 'videoWidth', { get: () => size[0] });
Object.defineProperty(video, 'videoHeight', { get: () => size[1] });
// The picture changing size, as the adaptive stream switching quality does.
function picture(w, h) {
  size = [w, h];
  video.dispatchEvent(new win.Event('resize'));
}

(async () => {
  await sleep(300);
  t('nothing before the picture is known', rule() === '', rule());

  picture(1920, 1080);
  t('1080p after the metadata line', /ytlr-video-metadata-line::after/.test(rule()) && /content:"1080p"/.test(rule()), rule());

  picture(3840, 2160);
  t('follows a switch to 2160p', /content:"2160p"/.test(rule()), rule());

  picture(1080, 1920);
  t('a portrait video reads by its shorter side', /content:"1080p"/.test(rule()), rule());

  doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
  await sleep(50);
  t('cleared off the watch page', rule() === '', rule());

  doc.body.className = 'WEB_PAGE_TYPE_WATCH';
  await sleep(50);
  t('back on the watch page', /content:"1080p"/.test(rule()), rule());

  key(GREEN);
  await sleep(100);
  toggle('Show Video Quality Next to the Title');
  t('cleared with the option off', rule() === '', rule());
  toggle('Show Video Quality Next to the Title');
  t('shown again with the option on', /content:"1080p"/.test(rule()), rule());

  t('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
