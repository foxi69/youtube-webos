/**
 * Verifies the --env perf bundle:
 *   1. loads without "require is not defined" (the reported crash)
 *   2. installs __PERF
 *   3. toggles on 0-0-0 within the window, and NOT on fewer/slower presses
 *   4. does NOT toggle on YELLOW (real or synthetic) - YouTube owns that key
 *   5. lets presses 1 and 2 reach ui.js, so a user shortcut bound to 0 survives
 *   6. charges YouTube's own timers to YouTube, not to the mod
 *   7. reads an account's own settings with Separate Settings for Each Account on
 *   8. counts past 64/s, and lists critical findings first
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2];
const legacy = process.argv[3] !== 'modern';

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));

const dom = new JSDOM(
  '<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app><div id="ytlr-player__player-container"><video></video></div></ytlr-app></body></html>',
  { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true }
);
const win = dom.window;
setUserAgent(win, legacy ? UA.webos3 : UA.webos23);
win.launchParams = '{}';
if (!win.requestAnimationFrame) win.requestAnimationFrame = (cb) => win.setTimeout(() => cb(Date.now()), 16);
if (!win.cancelAnimationFrame) win.cancelAnimationFrame = (i) => win.clearTimeout(i);
win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
if (legacy) applyChrome38Downgrade(win);

// Separate Settings for Each Account on, and an account whose own SponsorBlock
// setting is off while the shared one is on. The account's key is worked out
// with config.js's own functions, so perf_mon's copy of them must agree.
const configSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8').replace(/\r\n/g, '\n');
// From `from` up to and including `to`.
const take = (from, to) => {
  const at = configSrc.indexOf(from);
  const end = configSrc.indexOf(to, at);
  if (at === -1 || end === -1) throw new Error('config.js has no ' + from);
  return configSrc.slice(at, end + to.length);
};
const profileOf = new Function('data', [
  take('const VOLATILE_FIELD_RE', '\n'),
  take('function collectIdFields', '\n}\n'),
  take('function hashString', '\n}\n'),
  "const parts = []; collectIdFields(data, /id$/i, '', parts, 0); parts.sort(); return hashString(parts.join('|'));"
].join('\n'));
const identity = { id: 'test-account-1' };
win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: identity }));
win.localStorage.setItem('ytaf-configuration', JSON.stringify({ perAccountSettings: true, enableSponsorBlock: true, upgradeThumbnails: true }));
win.localStorage.setItem('ytaf-configuration::' + profileOf(identity), JSON.stringify({ enableSponsorBlock: false }));

let threw = null;
try { win.eval(fs.readFileSync(bundlePath, 'utf8')); } catch (e) { threw = e; }

// A timer set by YouTube's own script, which is not ours.
vm.runInContext('setTimeout(function ytTick() {}, 0);', dom.getInternalVMContext(),
  { filename: 'https://www.youtube.com/s/_/kabuki/base.js' });

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};

// jsdom (correctly, per spec) makes isTrusted an unforgeable own property on
// every Event, so a harness can never simulate a real remote press. perf_mon
// exposes OPTIONS.requireTrustedKeys for exactly this; the SYNTHETIC_KEY_FLAG
// guard that actually matters stays active and is asserted separately below.
function key(code, synthetic = false) {
  const evt = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'keyCode', { get: () => code, configurable: true });
  Object.defineProperty(evt, 'which', { get: () => code, configurable: true });
  if (synthetic) evt.__ytafSynthetic = true;
  win.document.body.dispatchEvent(evt);
  return evt;
}
// The cluster root is created once and shown/hidden via style.display, so
// look at that rather than counting body children.
function findRoot() {
  const kids = win.document.body.children;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    if (el.tagName === 'YTLR-APP') continue;
    if (el.style && el.style.zIndex && +el.style.zIndex > 1000) return el;
    if (el.textContent && el.textContent.indexOf('tab') !== -1) return el;
  }
  return null;
}
const visible = () => { const r = findRoot(); return !!r && r.style.display !== 'none'; };

setTimeout(() => {
  t('bundle loads without throwing', !threw, threw && String(threw.message));
  t('no "require is not defined"', !(threw && /require is not defined/.test(String(threw.message))),
    threw && String(threw.message));
  t('no jsdomError during load', errors.length === 0, errors[0]);
  t('__PERF installed', !!win.__PERF);
  if (!win.__PERF) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  win.__PERF.options.requireTrustedKeys = false;

  const entries = Object.keys(win.__PERF.ledger).map((k) => win.__PERF.ledger[k]);
  const yt = entries.filter((e) => e.origin.fn === 'ytTick');
  t('YouTube\'s own timer is charged to YouTube', yt.length > 0 && yt.every((e) => !e.origin.ours),
    JSON.stringify(yt.map((e) => e.origin)));
  t('the mod\'s own callbacks are still ours', entries.some((e) => e.origin.ours));

  t('an account\'s own settings are read', win.__PERF.config().enableSponsorBlock === false,
    'enableSponsorBlock=' + win.__PERF.config().enableSponsorBlock);

  // 1000 layout reads at once: 500/s over 2 s, past the critical line (400/s).
  // A DOM size in the warning band gives a second, lower finding.
  for (let i = 0; i < 1000; i++) win.__PERF.stats.layout.rect.hit();
  win.__PERF.stats.domNodes = 7000;
  const found = win.__PERF.bottlenecks().map((b) => b.id + ':' + b.severity);
  t('a layout-read storm is found', found.indexOf('layout-read-storm:critical') !== -1, found.join(', '));
  t('critical findings come first', found[0] === 'layout-read-storm:critical', found.join(', '));
  // A window longer than the 6.4 s the slots keep is cut to 6.4 s.
  const longRate = win.__PERF.stats.layout.rect.rate(30000);
  t('a long window is cut to what is kept', Math.round(longRate) === 156, 'rate(30000)=' + longRate);
  win.__PERF.stats.domNodes = 0;

  // Max Thumbnail Quality: the module rewrites the URLs in the responses, so
  // an upgraded tile is a plain url() of a larger size.
  ['maxresdefault.jpg', 'hq720.jpg', 'hqdefault.jpg'].forEach((name, i) => {
    const tile = win.document.createElement('ytlr-thumbnail-details');
    tile.style.backgroundImage = `url("https://i.ytimg.com/vi/video${i}abcd/${name}")`;
    win.document.body.appendChild(tile);
  });
  const thumbs = win.__PERF.features().filter((f) => f.key === 'upgradeThumbnails')[0];
  t('Max Thumbnail Quality counts the tiles above hqdefault', !!thumbs && thumbs.state === 'firing' && /^2 of 3 tiles/.test(thumbs.detail),
    thumbs && thumbs.state + ': ' + thumbs.detail);

  // Find the cluster root by probing before/after a toggle.
  const before = false; // cluster starts hidden

  // 1 press: must NOT toggle
  key(48);
  t('single 0 press does not open cluster', visible() === false);

  // 2 presses: must NOT toggle
  key(48);
  t('two 0 presses do not open cluster', visible() === false);

  // 3rd press within the window: MUST toggle
  key(48);
  t('three 0 presses open the cluster', visible() === true,
    'root=' + (findRoot() ? findRoot().tagName + ' display=' + findRoot().style.display : 'not found') +
    ' bodyKids=' + win.document.body.children.length);

  // 3 more closes it
  key(48); key(48); key(48);
  t('three more 0 presses close the cluster', visible() === false);

  // Synthetic (untrusted) presses must be ignored entirely
  key(48, true); key(48, true); key(48, true);
  t('mod-synthesised 0 presses ignored', visible() === false);

  // YELLOW must never toggle - YouTube owns it, and screensaver-fix fakes it
  key(405); key(405); key(405);
  key(170); key(170, true);
  t('YELLOW never opens the cluster', visible() === false);

  // Presses 1 and 2 must reach a downstream capture listener (ui.js does this)
  let seen = 0;
  win.document.addEventListener('keydown', (e) => { if (e.keyCode === 48) seen++; }, true);
  key(48); key(48);
  t('presses 1-2 propagate to other handlers', seen === 2, 'saw ' + seen);
  key(48); // third consumed
  t('third press is consumed', seen === 2, 'saw ' + seen);

  // Timing out the window resets the counter
  key(48); key(48);
  const st = Date.now();
  while (Date.now() - st < 1600) { /* let the 1.5s window lapse */ }
  const beforeSlow = visible();
  key(48);
  t('presses outside the 1.5s window do not toggle', visible() === beforeSlow);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 600);
