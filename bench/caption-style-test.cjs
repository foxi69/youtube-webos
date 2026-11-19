/**
 * caption-style.js: YouTube's caption style record is renewed before it runs
 * out, copied to the settings and written back when it is gone; Subtitle
 * Position lifts the caption area with a class on <html>.
 *
 * Usage: node bench/caption-style-test.cjs [dist/webOSUserScripts/userScript.js] [legacy|modern]
 */
const { createReporter, bootPage, wait, UA } = require('./harness.cjs');

const KEY = 'yt-player-caption-display-settings';
const DAY = 24 * 60 * 60 * 1000;
const STYLE = JSON.stringify({ fontSizeIncrement: 2, color: '#ffff00', background: '#000000' });

function boot(config, storage) {
  return bootPage({
    bodyClass: 'WEB_PAGE_TYPE_BROWSE',
    userAgent: UA.webos23,
    launchParams: '{}',
    raf: 'timer',
    config: Object.assign({ enableSponsorBlock: false, enableAutoLogin: false }, config),
    storage,
    consoleErrors: false,
    restoreRemove: false,
    fetch: () => Promise.reject(new Error('offline'))
  });
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
});
