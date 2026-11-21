/**
 * caption-style.js: YouTube's caption style record is renewed before it runs
 * out, copied to the settings and written back when it is gone; Subtitle
 * Position lifts the caption area with a class on <html>.
 *
 * Usage: node bench/caption-style-test.cjs [dist/webOSUserScripts/userScript.js] [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, wait, until, UA } = require('./harness.cjs');

const KEY = 'yt-player-caption-display-settings';
const DAY = 24 * 60 * 60 * 1000;
const STYLE = JSON.stringify({ fontSizeIncrement: 2, color: '#ffff00', background: '#000000' });

function boot(config, storage) {
  let NS;
  const page = bootPage({
    bodyClass: 'WEB_PAGE_TYPE_BROWSE',
    userAgent: UA.webos23,
    launchParams: '{}',
    raf: 'timer',
    config: Object.assign({ enableSponsorBlock: false, enableAutoLogin: false }, config),
    storage,
    consoleErrors: false,
    restoreRemove: false,
    setup: (w) => { NS = w.JSON.stringify; },
    fetch: () => Promise.reject(new Error('offline'))
  });
  page.parse = (obj) => page.win.JSON.parse(NS(obj));
  return page;
}

const record = (win) => JSON.parse(win.localStorage.getItem(KEY) || 'null');
const settings = (win) => JSON.parse(win.localStorage.getItem('ytaf-configuration') || '{}');

const { t, run } = createReporter();

run(async () => {
  // ---- A record about to run out ----
  {
    const now = Date.now();
    const { win, errors } = boot({}, { [KEY]: JSON.stringify({ data: STYLE, expiration: now + 2 * DAY, creation: now - 28 * DAY }) });
    await wait(400);
    const r = record(win);
    t('a record running out is moved a year on', !!r && r.data === STYLE && r.expiration > now + 300 * DAY, JSON.stringify(r));
    t('...keeping its creation time', !!r && r.creation === now - 28 * DAY);
    t('...and its style is copied to the settings', !!settings(win).captionStyleBackup && settings(win).captionStyleBackup[KEY] === STYLE,
      JSON.stringify(settings(win).captionStyleBackup));
    t('...with no page error', errors.length === 0, errors[0]);
  }

  // ---- A record far from running out is left alone ----
  {
    const now = Date.now();
    const raw = JSON.stringify({ data: STYLE, expiration: now + 200 * DAY, creation: now });
    const { win } = boot({ captionStyleBackup: { [KEY]: STYLE } }, { [KEY]: raw });
    await wait(400);
    t('a record with long to go is not rewritten', win.localStorage.getItem(KEY) === raw);
  }

  // ---- A record that is gone comes back from the copy ----
  {
    const now = Date.now();
    const { win } = boot({ captionStyleBackup: { [KEY]: STYLE } });
    await wait(50);
    const r = record(win);
    t('a record that is gone is written back from the copy', !!r && r.data === STYLE && r.expiration > now + 300 * DAY, JSON.stringify(r));
  }

  // ---- Nothing to keep, and a record that is not YouTube's ----
  {
    const { win, errors } = boot({});
    await wait(50);
    t('no record and no copy: nothing written', win.localStorage.getItem(KEY) === null && errors.length === 0);
    const odd = boot({}, { [KEY]: 'not json' });
    await wait(50);
    t('a record that is not JSON is left as it is', odd.win.localStorage.getItem(KEY) === 'not json' && odd.errors.length === 0);
  }

  // ---- Subtitle Position ----
  {
    const { win } = boot({ captionStyleBackup: { [KEY]: STYLE }, subtitlePosition: 'high' });
    await wait(50);
    t('Subtitle Position Highest puts its class on <html>', win.document.documentElement.classList.contains('ytaf-subs-high') &&
      !!win.document.getElementById('ytaf-subtitle-position'));
    const css = win.document.getElementById('ytaf-subtitle-position').textContent;
    t('...and its rule lifts the caption area', /html\.ytaf-subs-high \.ytp-caption-window-container \{ transform: translateY\(-16vh\)/.test(css), css);
  }
  {
    const { win } = boot({ subtitlePosition: 'default' });
    await wait(50);
    t('Subtitle Position Default: no class, no stylesheet',
      !win.document.documentElement.className.includes('ytaf-subs') && !win.document.getElementById('ytaf-subtitle-position'));
  }
  // ---- Subtitle Position changed in the panel ----
  {
    const { win, errors } = boot({ subtitlePosition: 'high' });
    const classes = () => [...win.document.documentElement.classList].filter((c) => c.startsWith('ytaf-subs')).join(' ');
    trustedKey(win, 404);
    await until(() => win.document.querySelector('.ytaf-ui-container'));
    const panel = win.document.querySelector('.ytaf-ui-container');
    for (let i = 0; i < 20; i++) panel.ensurePage(i);
    const row = [...panel.querySelectorAll('.shortcut-control-row')]
      .find((r) => (r.querySelector('.shortcut-label') || {}).textContent.trim() === 'Subtitle Position');
    t('the panel has the Subtitle Position row, on Highest', !!row && row.querySelector('.current-value').textContent === 'Highest' &&
      classes() === 'ytaf-subs-high', row ? row.querySelector('.current-value').textContent + ' ' + classes() : 'no row');
    if (!row) return;
    row.click();
    t('set back to Default: the lift is gone', row.querySelector('.current-value').textContent === 'Default' && classes() === '',
      row.querySelector('.current-value').textContent + ' [' + classes() + ']');
    row.click();
    t('...and on to Higher: its lift alone', row.querySelector('.current-value').textContent === 'Higher' && classes() === 'ytaf-subs-raised',
      row.querySelector('.current-value').textContent + ' [' + classes() + ']');
    t('...with no page error', errors.length === 0, errors[0]);
  }
  // ---- A style changed just before the app goes to the background ----
  {
    const now = Date.now();
    const { win } = boot({ captionStyleBackup: { [KEY]: STYLE } }, { [KEY]: JSON.stringify({ data: STYLE, expiration: now + 200 * DAY, creation: now }) });
    await wait(300);
    const NEW = JSON.stringify({ fontSizeIncrement: 3 });
    win.localStorage.setItem(KEY, JSON.stringify({ data: NEW, expiration: now + 200 * DAY, creation: now }));
    Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => true });
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    // At once, with no wait: the TV can suspend the app right after.
    const kept = settings(win).captionStyleBackup;
    t('going to the background: the new style is copied and written at once', !!kept && kept[KEY] === NEW, JSON.stringify(kept));
  }
  // ---- Subtitle Delay ----
  {
    const track = () => ({ wireMagic: 'pb3', events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'a' }] }, { tStartMs: 300 }, { id: 1 }] });
    const later = boot({ subtitleDelay: 'p500' });
    await wait(50);
    const shifted = later.parse(track());
    t('0.5 s Later: each event starts 500 ms later', shifted.events[0].tStartMs === 1500 && shifted.events[1].tStartMs === 800 &&
      shifted.events[0].dDurationMs === 2000, JSON.stringify(shifted.events));
    const earlier = boot({ subtitleDelay: 'm500' });
    await wait(50);
    const back = earlier.parse(track());
    t('0.5 s Earlier: 500 ms earlier, never before 0', back.events[0].tStartMs === 500 && back.events[1].tStartMs === 0,
      JSON.stringify(back.events));
    const reordered = later.parse({ events: [{ tStartMs: 1000, dDurationMs: 2000 }], wireMagic: 'pb3' });
    t('a track with wireMagic after its events is moved too', reordered.events[0].tStartMs === 1500, JSON.stringify(reordered.events));
    const other = later.parse({ responseContext: {}, events: [{ tStartMs: 1000 }] });
    t('a response that is no caption track is left alone', other.events[0].tStartMs === 1000);
    const off = boot({ subtitleDelay: 'off' });
    await wait(50);
    t('Off: the track as it came', off.parse(track()).events[0].tStartMs === 1000);
  }
});
