/**
 * The clock in the corner (src/watch.js): the time or the date and time from
 * the Clock in UI setting, kept to the minute without a keypress, caught up
 * when the TV comes back from the background, OLED-Care's black style, and
 * when it hides over a playing video and shows again (focus, the player's
 * state, Keep the Clock On During Playback).
 *
 *   node bench/clock-test.cjs <bundle> [legacy|modern]
 *
 * watch-time-test covers the watch time after the clock; nothing ran the
 * date mode, the minute timer, the hiding or the switching off and on.
 * The page's clock is a fake the test sets (real time plus an offset); the
 * text is compared with what Intl gives for that time.
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
const GREEN = 404;
const MIN = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(cond, timeout = 3000) {
  const end = Date.now() + timeout;
  const poll = () => (cond() ? Promise.resolve(true) : Date.now() >= end ? Promise.resolve(false) : sleep(10).then(poll));
  return poll();
}

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric' });
const DATETIME = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' });

/** The bundle with the clock settings `cfg`; the page's time starts at `start`. */
// A time well inside a minute, for the cases that compare the clock's text
// with the time: with the real time, a minute turning between the drawing
// and the comparison failed them now and then (seen with the tests running
// side by side).
const MID = new Date(2026, 2, 7, 15, 0, 10);

function boot(cfg, start, hold = false) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.fetch = () => new Promise(() => {});
  win.requestAnimationFrame = (cb) => win.setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false, enableDeArrow: false,
    upgradeThumbnails: false, enableAutoLogin: false, checkForUpdates: false, showWhatsNew: false
  }, cfg)));

  const RealDate = win.Date;
  // The page's time stands still at `start` while the bundle loads (and, with
  // `hold`, until release()), so a slow start (CI, coverage) does not carry it
  // past the minute the test is about.
  const clock = { offset: 0, held: start ? start.getTime() : null };
  const pageNow = () => (clock.held !== null ? clock.held : RealDate.now() + clock.offset);
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(pageNow()); }
    static now() { return pageNow(); }
  }
  win.Date = FakeDate;
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.eval(code);
  const release = () => {
    if (clock.held === null) return;
    clock.offset = clock.held - RealDate.now();
    clock.held = null;
  };
  if (!hold) release();

  const doc = win.document;
  const now = () => new RealDate(pageNow());
  const el = () => doc.querySelector('.webOs-watch');
  const text = () => (el() || {}).textContent || '';
  const shown = () => !!el() && el().style.display === 'block';
  const hidden = () => !!el() && el().style.display === 'none';
  const key = (code) => {
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => code, configurable: true });
    dispatchTrusted(doc.body, e);
  };
  const panelOpen = () => { const p = doc.querySelector('.ytaf-ui-container'); return !!p && p.style.display !== 'none'; };
  // The panel row of a setting, by its label.
  const withPanel = (fn) => {
    if (!panelOpen()) key(GREEN);
    const out = fn();
    if (panelOpen()) key(GREEN);
    return out;
  };
  const toggle = (label) => withPanel(() => {
    const row = [...doc.querySelectorAll('.ytaf-ui-container label')].find((l) => l.textContent.trim() === label);
    const input = row.querySelector('input');
    input.checked = !input.checked;
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  // Clock in UI is a cycle row: OK steps Off -> Time -> Date and Time -> Off.
  const cycleClock = () => withPanel(() => {
    const row = [...doc.querySelectorAll('.ytaf-ui-container .shortcut-control-row')]
      .find((r) => /Clock in UI/.test(r.textContent));
    row.click();
    return row.querySelector('.current-value').textContent;
  });
  const stateChange = (state) => win.dispatchEvent(new win.CustomEvent('yt-player-state-change', { detail: { state } }));
  return { win, doc, errors, clock, release, now, el, text, shown, hidden, toggle, cycleClock, stateChange, stored: () => JSON.parse(win.localStorage.getItem('ytaf-configuration')) };
}

(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- The time, kept to the minute ----
  {
    // 1.5 s before a minute: the clock must turn over on its own.
    const start = new Date(2026, 2, 7, 14, 5, 58, 500);
    const env = boot({ clockMode: 'time' }, start, true);
    await sleep(100);
    t(n('Clock in UI on Time: the clock shows the time'), env.text() === TIME.format(env.now()) &&
      env.text() === TIME.format(start), JSON.stringify(env.text()));
    t(n('...shown on a browse page'), env.shown());
    t(n('...hidden from screen readers'), env.el().getAttribute('aria-hidden') === 'true');
    // The page's time runs from 14:05:58.5 only now.
    env.release();
    const before = env.text();
    // Due 1.5 s after the release; the wide limit only keeps a stalled CI
    // machine from failing a correct clock, the check itself is unchanged.
    t(n('the minute turns over without a key press'), await waitFor(() => env.text() !== before, 15000) &&
      env.text() === TIME.format(env.now()) && /:06/.test(env.text()), JSON.stringify(env.text()));

    // Back from the background: the time at once, not at the next minute.
    let isHidden = false;
    Object.defineProperty(env.doc, 'hidden', { get: () => isHidden, configurable: true });
    env.clock.offset += 10 * MIN;
    isHidden = true;
    env.doc.dispatchEvent(new env.win.Event('visibilitychange'));
    t(n('in the background nothing is redrawn'), /:06/.test(env.text()), env.text());
    isHidden = false;
    env.doc.dispatchEvent(new env.win.Event('visibilitychange'));
    t(n('back from the background: the time caught up at once'), env.text() === TIME.format(env.now()) && /:16/.test(env.text()),
      env.text());

    env.toggle('Show Watch Time With the Clock');
    t(n('Show Watch Time: the watch time after the time'), env.text() === TIME.format(env.now()) + ' \u00b7 0m watched',
      JSON.stringify(env.text()));
    env.toggle('Show Watch Time With the Clock');
    t(n('...and the time alone without it'), env.text() === TIME.format(env.now()), JSON.stringify(env.text()));

    // The setting, cycled in the panel.
    const mode = env.cycleClock();
    t(n('Date and Time: the date with the time, at once'), mode === 'Date and Time' &&
      env.text() === DATETIME.format(env.now()) && /^Mar 7/.test(env.text()), JSON.stringify(env.text()));
    t(n('...the setting is stored'), await waitFor(() => env.stored().clockMode === 'datetime', 1000));
    const els = env.doc.querySelectorAll('.webOs-watch').length;
    t(n('...in the same clock'), els === 1, String(els));

    // A focus change just before: its delayed check comes after the clock is gone.
    env.doc.body.dispatchEvent(new env.win.FocusEvent('focusin', { bubbles: true }));
    const off = env.cycleClock();
    t(n('Off: the clock is gone'), off === 'Off' && !env.el());
    env.stateChange(1);
    env.doc.body.dispatchEvent(new env.win.FocusEvent('focusin', { bubbles: true }));
    env.clock.offset += 5 * MIN;
    isHidden = false;
    env.doc.dispatchEvent(new env.win.Event('visibilitychange'));
    await sleep(100);
    t(n('...and stays gone through player, focus and visibility events'), !env.el());

    t(n('Time again: one clock, with the time'), env.cycleClock() === 'Time' &&
      env.doc.querySelectorAll('.webOs-watch').length === 1 && env.text() === TIME.format(env.now()), env.text());
    t(n('the clock: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- OLED-Care Mode ----
  {
    const env = boot({ clockMode: 'datetime', enableOledCareMode: true }, MID);
    await sleep(100);
    t(n('Date and Time from the start'), env.text() === DATETIME.format(env.now()), env.text());
    t(n('OLED-Care on: the clock in its black style'), env.el().classList.contains('oled-mode'));
    env.toggle('OLED-Care Mode (True Black UI)');
    t(n('OLED-Care off: the normal style'), !env.el().classList.contains('oled-mode'));
    env.toggle('OLED-Care Mode (True Black UI)');
    t(n('OLED-Care on again: black again'), env.el().classList.contains('oled-mode'));
  }

  // ---- Off, and the old on/off switch ----
  {
    const env = boot({}, MID);
    await sleep(100);
    t(n('Clock in UI off by default: no clock'), !env.el());
  }
  {
    const env = boot({ showWatch: true }, MID);
    await sleep(100);
    t(n('the old clock switch on: the clock shows the time'), env.text() === TIME.format(env.now()), env.text());
  }
  {
    const env = boot({ showWatch: false }, MID);
    await sleep(100);
    t(n('the old clock switch off: no clock'), !env.el());
  }

  // ---- Over a video ----
  {
    const env = boot({ clockMode: 'time' }, MID);
    await sleep(100);
    const { doc } = env;
    doc.body.className = 'WEB_PAGE_TYPE_WATCH';
    const player = doc.createElement('ytlr-watch-default');
    player.tabIndex = -1;
    const control = doc.createElement('button');
    player.appendChild(control);
    doc.querySelector('ytlr-app').appendChild(player);

    // Playing, with the focus on the page: hidden.
    if (doc.activeElement && doc.activeElement !== doc.body) doc.activeElement.blur();
    env.stateChange(1);
    t(n('a video playing, nothing focused: the clock hides'), await waitFor(env.hidden, 1000), env.el().style.display);

    // The controls up (a button in the player focused): shown.
    control.focus();
    t(n('the player controls focused: the clock shows'), await waitFor(env.shown, 1000), env.el().style.display);

    // Buffering (state 3) and an unknown state are no reason to look again.
    player.setAttribute('hybridnavfocusable', 'true');
    env.stateChange(3);
    await sleep(150);
    t(n('a buffering player does not move the clock'), env.shown(), env.el().style.display);
    env.stateChange(2);
    t(n('paused, the player taking the focus: hidden'), await waitFor(env.hidden, 1000), env.el().style.display);

    player.removeAttribute('hybridnavfocusable');
    env.stateChange(-1);
    t(n('...and shown again when it gives it back'), await waitFor(env.shown, 1000), env.el().style.display);

    player.focus();
    t(n('the player element itself focused: hidden'), await waitFor(env.hidden, 1000), env.el().style.display);
    control.focus();
    await waitFor(env.shown, 1000);

    // YouTube's full-screen overlay over the player.
    const overlay = doc.createElement('div');
    overlay.className = 'AmQJbe';
    player.appendChild(overlay);
    env.stateChange(1);
    t(n('the player overlay up: hidden'), await waitFor(env.hidden, 1000), env.el().style.display);

    // Keep the Clock On During Playback.
    env.toggle('Keep the Clock On During Playback');
    t(n('Keep the Clock On During Playback: shown at once over the video'), env.shown(), env.el().style.display);
    if (doc.activeElement && doc.activeElement !== doc.body) doc.activeElement.blur();
    env.stateChange(1);
    await sleep(150);
    t(n('...and stays shown while the video plays'), env.shown(), env.el().style.display);
    env.toggle('Keep the Clock On During Playback');
    t(n('switched off: hidden again over the video'), await waitFor(env.hidden, 1000), env.el().style.display);

    // The video closed: no player, the clock back.
    overlay.remove();
    player.remove();
    doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
    env.stateChange(-1);
    t(n('the player gone: shown again'), await waitFor(env.shown, 1000), env.el().style.display);
    t(n('over a video: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
