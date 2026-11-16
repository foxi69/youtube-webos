/**
 * Auto Login (src/auto-login.js), in the bundle: what it writes to the TV
 * app's own storage and what it presses on the account selector.
 *
 *   - "Who's watching": dated 7 days ahead with Auto Login on (the app thinks
 *     it has just been shown), 7 days back with it off ("always ask", the app
 *     thinks it is due), kept back by a refresh every minute, and put back to
 *     now when Bypass Nag Screens is turned off.
 *   - The Premium upsell: its "last shown" and "times shown" records, in every
 *     namespace, seeded on a fresh install and reset when turned off.
 *   - The selector: Enter pressed for the viewer (Down, Enter for a guest),
 *     the page hidden meanwhile; nothing when the option goes off in between.
 *   - Video Previews: YouTube's inline playback record forced on or off,
 *     given back as it was on Default, and the two old settings it replaced.
 *   - Bypass Nag Screens off: nothing of the above.
 *
 * upstream-fixes-test covers the selector's time window and the relaunch;
 * per-account-test the settings profiles. Neither is repeated here.
 *
 *   node bench/auto-login-test.cjs <bundle> [legacy|modern]
 *
 * The page's timers run ten times faster; the minute's refresh is run by hand.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const code = fs.readFileSync(bundlePath, 'utf8');

const SPEED = 10;
const GREEN = 404;
const DAY = 24 * 60 * 60 * 1000;
const RECURRING = 'yt.leanback.default::recurring_actions';
const TARGETS = ['startup-screen-account-selector-with-guest', 'whos_watching_fullscreen_zero_accounts',
  'startup-screen-signed-out-welcome-back'];
const PROMO_TS = 'yt.leanback.default::promo-coupon-shown-timestamp';
const PROMO_TIMES = 'yt.leanback.default::promo-coupon-shown-times';
const PROMO_OTHER = 'yt.leanback.profile-2::promo-coupon-shown-times';
const INLINE = 'yt.leanback.default::inline-playback-enabled';
const IDENTITY = 'yt.leanback.default::last-identity-used';
const LABEL_BYPASS = 'Bypass Nag Screens';
const LABEL_SELECT = 'Auto Login (off: always ask who is watching)';
const LABEL_PREVIEWS = 'Video Previews';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A real time for N of the page's (sped up) milliseconds.
const pageMs = (ms) => wait(ms / SPEED + 20);

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

/** The app's recurring-actions record: the three selector screens and one other. */
function recurring(lastFired = 0) {
  const data = { 'some-other-action': { lastFired } };
  for (const k of TARGETS) data[k] = { lastFired };
  return { data: { data }, expiration: 9e12, creation: 1 };
}

async function boot(cfg, opts = {}) {
  const errors = [];
  const warnings = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));
  vc.on('warn', (...a) => warnings.push(a.map(String).join(' ')));
  const dom = new JSDOM(`<!doctype html><html><body class="${opts.page || 'WEB_PAGE_TYPE_BROWSE'}"><ytlr-app></ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.fetch = () => new Promise(() => {});
  const store = win.localStorage;
  store.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    enableDeArrow: false, upgradeThumbnails: false, checkForUpdates: false, showWhatsNew: false
  }, cfg)));
  if (opts.recurring !== null) store.setItem(RECURRING, JSON.stringify(opts.recurring || recurring()));
  if (opts.identity) store.setItem(IDENTITY, JSON.stringify({ data: opts.identity }));
  for (const [k, v] of Object.entries(opts.storage || {})) store.setItem(k, JSON.stringify(v));
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  // Chrome 23 has it; the Chrome 38 environment takes it away all the same
  // (as in upstream-fixes-test).
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 1);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  const st = win.setTimeout.bind(win);
  const si = win.setInterval.bind(win);
  const ci = win.clearInterval.bind(win);
  // opts.holdMs: the timeouts of that length are held, for the test to run (held).
  const held = [];
  win.setTimeout = (fn, ms, ...a) => {
    if (opts.holdMs !== undefined && ms === opts.holdMs) { held.push(() => fn(...a)); return -held.length; }
    return st(fn, (ms || 0) / SPEED, ...a);
  };
  // Every interval the page sets, and whether it is still running. The
  // minute's ones are not started: the test runs them when it wants.
  const intervals = [];
  win.setInterval = (fn, ms, ...a) => {
    const entry = { fn, ms, live: true };
    entry.id = ms === 60000 ? -(intervals.length + 1) : si(fn, (ms || 0) / SPEED, ...a);
    intervals.push(entry);
    return entry.id;
  };
  win.clearInterval = (id) => {
    for (const e of intervals) if (e.id === id) e.live = false;
    if (id >= 0) ci(id);
  };
  win.eval(code);
  // The module starts on DOMContentLoaded.
  if (win.document.readyState === 'loading') await new Promise((r) => win.document.addEventListener('DOMContentLoaded', r));
  await wait(0);
  // The keys the bundle sends itself (sendKey marks them).
  const keys = [];
  win.document.addEventListener('keydown', (e) => {
    if (e.__ytafSynthetic && (e.keyCode === 13 || e.keyCode === 40)) keys.push({ code: e.keyCode, at: Date.now() });
  }, true);
  const read = (k) => { const v = store.getItem(k); return v === null ? null : JSON.parse(v); };
  const lastFired = (k) => read(RECURRING).data.data[k].lastFired;
  /** Every target's lastFired is within 5 s of `when`; the other action kept its own. */
  const firedNear = (when, other = 0) => {
    const r = read(RECURRING);
    return TARGETS.every((k) => Math.abs(r.data.data[k].lastFired - when) < 5000) &&
      r.data.data['some-other-action'].lastFired === other;
  };
  const alwaysAsk = () => intervals.filter((e) => e.ms === 60000 && e.live);
  const body = win.document.body;
  const bypassing = () => body.classList.contains('ytaf-bypassing-login');
  const openSelector = () => { body.className = 'WEB_PAGE_TYPE_ACCOUNT_SELECTOR'; };
  const pressGreen = () => {
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
    dispatchTrusted(body, e);
  };
  const checkbox = (text) => {
    for (const label of win.document.querySelectorAll('.ytaf-ui-container label')) {
      const span = label.querySelector('.label-text');
      if (span && span.textContent === text) return label.querySelector('input');
    }
    return null;
  };
  const toggle = (text) => {
    const input = checkbox(text);
    if (!input) throw new Error('no switch "' + text + '" in the panel');
    input.checked = !input.checked;
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  // Panel pages past the first are built when their tab is opened.
  const openTab = async (i) => { win.document.querySelectorAll('.ytaf-tab-btn')[i].click(); await wait(20); };
  /** One step of a cycle control: the row clicked (next), or its '<' (back). */
  const cycle = (text, back = false) => {
    for (const row of win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row')) {
      if ((row.querySelector('.shortcut-label') || {}).textContent !== text) continue;
      (back ? row.querySelector('.arrow-btn') : row).click();
      return row.querySelector('.current-value').textContent;
    }
    throw new Error('no control "' + text + '" in the panel');
  };
  return { win, store, errors, warnings, held, keys, read, lastFired, firedNear, alwaysAsk, intervals, bypassing, openSelector,
    pressGreen, toggle, cycle, checkbox, openTab };
}

(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- Auto Login on (the defaults) ----
  {
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: true }, {
      storage: { [PROMO_OTHER]: { data: 1, creation: 42, expiration: 5 } }
    });
    const now = Date.now();
    t(n('on: the "Who\'s watching" screens are dated 7 days ahead'), env.firedNear(now + 7 * DAY),
      JSON.stringify(env.read(RECURRING).data.data));
    t(n('...the rest of the record kept'), env.read(RECURRING).creation === 1 && env.read(RECURRING).expiration === 9e12);
    t(n('on: no "always ask" refresh'), env.alwaysAsk().length === 0);
    const ts = env.read(PROMO_TS);
    const times = env.read(PROMO_TIMES);
    t(n('on: the upsell is dated a year ahead, on a fresh install too'),
      !!ts && Math.abs(ts.data - (now + 365 * DAY)) < 5000 && Math.abs(ts.expiration - (now + 360 * DAY)) < 5000, JSON.stringify(ts));
    t(n('...and counted as shown 99 times'), !!times && times.data === 99, JSON.stringify(times));
    const other = env.read(PROMO_OTHER);
    t(n('...in another namespace too, the record\'s own fields kept'),
      other.data === 99 && other.creation === 42 && other.expiration > now, JSON.stringify(other));

    env.openSelector();
    await wait(10);
    t(n('the selector: hidden at once'), env.bypassing());
    t(n('...nothing pressed yet'), env.keys.length === 0);
    await pageMs(500);
    t(n('...then Enter is pressed for the viewer'), env.keys.map((k) => k.code).join() === '13', JSON.stringify(env.keys));
    await pageMs(2000);
    t(n('...and the selector shown again once done'), !env.bypassing());
    t(n('on: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  {
    // The viewer leaves the selector during the delay: no key goes to the page now on screen.
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: true });
    env.openSelector();
    await wait(5);
    env.win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await pageMs(1000);
    t(n('the selector left during the delay: nothing pressed, nothing left hidden'),
      env.keys.length === 0 && !env.bypassing(), JSON.stringify(env.keys));
    env.win.close();
  }

  // ---- The selector already on screen when the bundle starts ----
  {
    // A start without launch parameters: the page-state event that reports
    // the selector goes out before the module listens for it.
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: true }, { page: 'WEB_PAGE_TYPE_ACCOUNT_SELECTOR' });
    await pageMs(1000);
    t(n('the selector on screen at the start: Enter is pressed for the viewer'),
      env.keys.map((k) => k.code).join() === '13', JSON.stringify(env.keys));
    env.win.close();
  }
  {
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: false }, { page: 'WEB_PAGE_TYPE_ACCOUNT_SELECTOR' });
    await pageMs(1000);
    t(n('...not with always ask'), env.keys.length === 0 && !env.bypassing(), JSON.stringify(env.keys));
    env.win.close();
  }

  // ---- A guest: Down to the guest entry, then Enter ----
  {
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: true },
      { identity: { identityType: 'UNAUTHENTICATED_IDENTITY_TYPE_GUEST' } });
    env.openSelector();
    await pageMs(1000);
    const codes = env.keys.map((k) => k.code).join();
    const gap = env.keys.length === 2 ? env.keys[1].at - env.keys[0].at : -1;
    t(n('a guest: Down, then Enter a moment later'), codes === '40,13' && gap >= 200 / SPEED - 5, `${codes} gap=${gap}`);
    env.win.close();
  }

  // ---- Auto Login turned off between the selector and the key ----
  {
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: true });
    env.pressGreen();
    await wait(20);
    env.openSelector();
    await wait(5);
    t(n('turned off meanwhile: the selector was hidden'), env.bypassing());
    env.toggle(LABEL_SELECT);
    await pageMs(1000);
    t(n('...nothing is pressed'), env.keys.length === 0, JSON.stringify(env.keys));
    t(n('...and the selector is shown again'), !env.bypassing());
    env.win.close();
  }

  // ---- Always ask who is watching ----
  {
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: false });
    const now = Date.now();
    t(n('always ask: the screens are dated 7 days back'), env.firedNear(now - 7 * DAY), JSON.stringify(env.read(RECURRING).data.data));
    t(n('...with a refresh every minute'), env.alwaysAsk().length === 1, JSON.stringify(env.intervals.map((i) => i.ms)));
    t(n('...the upsell still suppressed'), env.read(PROMO_TIMES) && env.read(PROMO_TIMES).data === 99);
    // The app stamps the screen as shown; the minute's refresh puts it back.
    env.store.setItem(RECURRING, JSON.stringify(recurring(now)));
    for (const i of env.alwaysAsk()) i.fn();
    t(n('...and the app\'s own stamp is dated back again'), env.firedNear(Date.now() - 7 * DAY, now),
      JSON.stringify(env.read(RECURRING).data.data));
    env.openSelector();
    await pageMs(1000);
    t(n('always ask: the selector is left to the viewer'), env.keys.length === 0 && !env.bypassing(), JSON.stringify(env.keys));
    t(n('always ask: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  // ---- Bypass Nag Screens off: nothing is written or pressed ----
  {
    const before = JSON.stringify(recurring());
    const env = await boot({ enableAutoLogin: false, autoSelectAccount: true });
    await pageMs(3000);
    t(n('off: the "Who\'s watching" record is not touched'), env.store.getItem(RECURRING) === before, env.store.getItem(RECURRING));
    t(n('off: no upsell records'), env.read(PROMO_TS) === null && env.read(PROMO_TIMES) === null);
    t(n('off: the inline playback record is not written'), env.read(INLINE) === null);
    env.openSelector();
    await pageMs(1000);
    t(n('off: the selector is left alone'), env.keys.length === 0 && !env.bypassing(), JSON.stringify(env.keys));
    t(n('off: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  // ---- "Always ask" is its own switch: it works with Bypass Nag Screens off ----
  {
    const env = await boot({ enableAutoLogin: false, autoSelectAccount: false });
    t(n('always ask with Bypass Nag Screens off: dated back all the same'), env.firedNear(Date.now() - 7 * DAY) &&
      env.alwaysAsk().length === 1 && env.read(PROMO_TIMES) === null, JSON.stringify(env.read(RECURRING).data.data));
    env.win.close();
  }

  // ---- No recurring-actions record yet ----
  {
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: true }, { recurring: null });
    t(n('no "Who\'s watching" record: none is made up'), env.store.getItem(RECURRING) === null);
    t(n('...a warning, no errors'), env.warnings.some((w) => /No recurring actions found/.test(w)) && env.errors.length === 0,
      env.warnings.concat(env.errors).join(' | '));
    env.win.close();
  }

  // ---- Switched in the panel ----
  {
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: true });
    env.pressGreen();
    await wait(20);
    env.toggle(LABEL_SELECT);
    t(n('Auto Login switched off: always ask, dated back, refreshed'), env.firedNear(Date.now() - 7 * DAY) && env.alwaysAsk().length === 1,
      JSON.stringify(env.read(RECURRING).data.data));
    env.toggle(LABEL_SELECT);
    t(n('...and on again: dated ahead, the refresh stopped'), env.firedNear(Date.now() + 7 * DAY) && env.alwaysAsk().length === 0,
      JSON.stringify(env.read(RECURRING).data.data));

    env.toggle(LABEL_BYPASS);
    t(n('Bypass Nag Screens switched off: the screens dated now'), env.firedNear(Date.now()), JSON.stringify(env.read(RECURRING).data.data));
    t(n('...and the upsell records reset'), env.read(PROMO_TS).data === 0 && env.read(PROMO_TIMES).data === 0,
      JSON.stringify([env.read(PROMO_TS), env.read(PROMO_TIMES)]));
    env.toggle(LABEL_BYPASS);
    t(n('...and on again: dated ahead, the upsell suppressed'),
      env.firedNear(Date.now() + 7 * DAY) && env.read(PROMO_TIMES).data === 99, JSON.stringify(env.read(PROMO_TIMES)));
    t(n('switched in the panel: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }
  {
    // Turned off while "always ask" holds the screens back: they stay back.
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: false });
    env.pressGreen();
    await wait(20);
    env.toggle(LABEL_BYPASS);
    t(n('Bypass Nag Screens off during always ask: the screens stay dated back'), env.firedNear(Date.now() - 7 * DAY),
      JSON.stringify(env.read(RECURRING).data.data));
    env.win.close();
  }
  {
    // Off at the start, turned on later: the selector is then skipped.
    const env = await boot({ enableAutoLogin: false, autoSelectAccount: true });
    env.pressGreen();
    await wait(20);
    env.toggle(LABEL_BYPASS);
    t(n('Bypass Nag Screens switched on: dated ahead'), env.firedNear(Date.now() + 7 * DAY), JSON.stringify(env.read(RECURRING).data.data));
    env.pressGreen();   // the panel closed
    await wait(20);
    env.openSelector();
    await pageMs(1000);
    t(n('...and the selector is skipped from then on'), env.keys.map((k) => k.code).join() === '13', JSON.stringify(env.keys));
    env.win.close();
  }

  // ---- Video Previews ----
  for (const [mode, want] of [['sound', true], ['muted', true], ['off', false]]) {
    const env = await boot({ enableAutoLogin: false, videoPreviews: mode });
    t(n(`previews ${mode}: not written before YouTube has loaded its own`), env.read(INLINE) === null);
    await pageMs(3000);
    t(n(`previews ${mode}: inline playback forced ${want ? 'on' : 'off'}`),
      JSON.stringify(env.read(INLINE)) === JSON.stringify({ data: want }), env.store.getItem(INLINE));
    env.win.close();
  }
  {
    // Set back to Default before the delayed start-up write: that write must
    // not force the old mode. The write is held until Default is set, so the
    // order cannot come about by the machine's timing.
    const env = await boot({ enableAutoLogin: false, videoPreviews: 'sound' }, { holdMs: 2500 });
    env.pressGreen();
    await wait(20);
    await env.openTab(5);   // UI Tweaks
    const back = env.cycle(LABEL_PREVIEWS);
    const startup = env.held.length;
    env.held.forEach((fn) => { fn(); });
    await wait(20);
    t(n('previews With sound, set to Default before the start-up write: not forced on'),
      back === 'Default' && startup === 1 && env.read(INLINE) === null, `${back} ${startup} held ${env.store.getItem(INLINE)}`);
    env.win.close();
  }
  {
    // A cold start on Default over a record forced earlier (another account's
    // setting, say): YouTube's own record is given back at start-up.
    const own = { data: false, expiration: 9e12, creation: 7 };
    const env = await boot({ enableAutoLogin: false, videoPreviews: 'default' },
      { storage: { [INLINE]: { data: true }, 'ytaf-inline-playback-saved': { value: JSON.stringify(own) } } });
    await pageMs(3000);
    t(n('previews Default at a cold start over a forced record: YouTube\'s own given back'),
      JSON.stringify(env.read(INLINE)) === JSON.stringify(own) && env.read('ytaf-inline-playback-saved') === null,
      env.store.getItem(INLINE));
    env.win.close();
  }
  {
    const env = await boot({ enableAutoLogin: false, videoPreviews: 'default' });
    await pageMs(3000);
    t(n('previews default: the record is not written'), env.read(INLINE) === null, env.store.getItem(INLINE));
    env.pressGreen();
    await wait(20);
    await env.openTab(5);   // UI Tweaks
    const off = env.cycle(LABEL_PREVIEWS);
    t(n('previews set to Off in the panel: written at once'), off === 'Off' &&
      JSON.stringify(env.read(INLINE)) === '{"data":false}', `${off} ${env.store.getItem(INLINE)}`);
    const muted = env.cycle(LABEL_PREVIEWS);
    t(n('...Without sound: written on'), muted === 'Without sound' &&
      JSON.stringify(env.read(INLINE)) === '{"data":true}', `${muted} ${env.store.getItem(INLINE)}`);
    const back = env.cycle(LABEL_PREVIEWS, true);
    const def = env.cycle(LABEL_PREVIEWS, true);
    t(n('...back to Default: YouTube\'s own record given back (there was none)'), back === 'Off' && def === 'Default' &&
      env.read(INLINE) === null, `${back} ${def} ${env.store.getItem(INLINE)}`);
    t(n('previews: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }
  {
    // YouTube's own setting, as it stores it: forced on and off, then
    // Default gives back what it was before the first force.
    const own = { data: false, expiration: 9e12, creation: 7 };
    const env = await boot({ enableAutoLogin: false, videoPreviews: 'sound' }, { storage: { [INLINE]: own } });
    await pageMs(3000);
    t(n('previews forced on over YouTube\'s own record'), JSON.stringify(env.read(INLINE)) === '{"data":true}',
      env.store.getItem(INLINE));
    env.pressGreen();
    await wait(20);
    await env.openTab(5);   // UI Tweaks
    env.cycle(LABEL_PREVIEWS, true);   // Without sound
    const off = env.cycle(LABEL_PREVIEWS, true);
    t(n('...then Off'), off === 'Off' && JSON.stringify(env.read(INLINE)) === '{"data":false}',
      `${off} ${env.store.getItem(INLINE)}`);
    const def = env.cycle(LABEL_PREVIEWS, true);
    t(n('...Default: YouTube\'s own record as it was before the first force'), def === 'Default' &&
      JSON.stringify(env.read(INLINE)) === JSON.stringify(own), `${def} ${env.store.getItem(INLINE)}`);
    const on = env.cycle(LABEL_PREVIEWS, true);
    const again = env.cycle(LABEL_PREVIEWS);
    t(n('...and so again after another force'), on === 'With sound' && again === 'Default' &&
      JSON.stringify(env.read(INLINE)) === JSON.stringify(own), `${on} ${again} ${env.store.getItem(INLINE)}`);
    t(n('previews given back: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }
  // The two settings Video Previews replaced, as a stored configuration has them.
  for (const [old, want, mutes] of [
    [{ forcePreviews: 'force_on', mutePreviews: false }, true, false],
    [{ forcePreviews: 'disabled', mutePreviews: true }, true, true],
    [{ forcePreviews: 'force_off', mutePreviews: true }, false, false],
    [{ forcePreviews: 'disabled', mutePreviews: false }, null, false]
  ]) {
    const env = await boot(Object.assign({ enableAutoLogin: false }, old));
    await pageMs(3000);
    const video = env.win.document.createElement('video');
    env.win.document.body.appendChild(video);
    video.dispatchEvent(new env.win.Event('playing'));
    const name = `old ${old.forcePreviews}${old.mutePreviews ? ' + mute' : ''}`;
    t(n(`${name}: previews ${want === null ? 'left to YouTube' : want ? 'on' : 'off'}${mutes ? ', muted' : ''}`),
      JSON.stringify(env.read(INLINE)) === JSON.stringify(want === null ? null : { data: want }) && video.muted === mutes,
      `${env.store.getItem(INLINE)} muted=${video.muted}`);
    env.win.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
