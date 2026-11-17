/**
 * Open Comments at the End of a Video (#160), end to end in the bundle: at the
 * player's end (state 0) the comments button is pressed, once a video, only
 * with YouTube's autoplay off for the account in use, and not on Shorts.
 *
 *   node bench/comments-at-end-test.cjs <bundle> [legacy|modern]
 *
 * The comments button is a stand-in with the shape the TV app gives it (a
 * ytlr-button-renderer whose __instance carries its data); clicks are counted.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, trustedKey, wait } = require('./harness.cjs');

const { modern } = flavorFromArgs();
const code = readBundle();
const { t, run } = createReporter();

const VIDEO_ID = 'abcdefghijk';
const GAIA = '115436911888583517051';
// The wait after the end before it opens (END_OPEN_DELAY_MS), and some.
const SETTLE_MS = 1400;
// Past END_KEY_WINDOW_MS: a key pressed this long before the end does not hold it back.
const KEY_WINDOW_PAST_MS = 3200;
const GREEN = 404;
// Every page booted, so a handler that threw is not read as one that held back.
const envs = [];

async function boot(cfg = {}, opts = {}) {
  const page = opts.page || 'WEB_PAGE_TYPE_WATCH';
  const { win, errors, evaluate } = bootPage({
    code,
    bodyClass: page,
    inner: '\n    <div id="ytlr-player__player-container-player"><video></video></div>',
    url: page === 'WEB_PAGE_TYPE_SHORTS' ? `https://www.youtube.com/tv#/shorts/${VIDEO_ID}` : `https://www.youtube.com/tv#/watch?v=${VIDEO_ID}`,
    ignoreNavigation: true,
    consoleErrors: false,
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, upgradeThumbnails: false, enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, openCommentsAtEnd: true
    }, cfg),
    storage: {
      'yt.leanback.default::last-identity-used': JSON.stringify({ data: { identityType: 'CORE_ID', effectiveObfuscatedGaiaId: GAIA } }),
      'yt.leanback.default::AUTONAV_FOR_LIVING_ROOM': JSON.stringify(
        'autonav' in opts ? opts.autonav : { data: { [GAIA]: opts.autoplay === true, 999: true } })
    },
    evaluate: false
  });
  evaluate();
  await wait(300);
  const doc = win.document;
  const clicks = [];
  const actions = doc.createElement('ytlr-player-actions-container');
  const renderer = doc.createElement('ytlr-button-renderer');
  renderer.__instance = { props: { data: { icon: { iconType: 'COMMENT' } } } };
  const button = doc.createElement('yt-button-container');
  button.addEventListener('click', () => clicks.push('comments'));
  renderer.appendChild(button);
  actions.appendChild(renderer);
  doc.querySelector('ytlr-app').appendChild(actions);
  const state = (s, id = VIDEO_ID) =>
    win.dispatchEvent(new win.CustomEvent('yt-player-state-change', { detail: { state: s, videoId: id } }));
  const toasts = () => (doc.querySelector('.ytaf-notification-container') || {}).textContent || '';
  const env = { win, doc, errors, clicks, state, toasts };
  envs.push(env);
  return env;
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  {
    const env = await boot();
    env.state(1);
    env.state(0);
    await wait(SETTLE_MS);
    t(n('the end of a video, autoplay off: the comments button is pressed'), env.clicks.length === 1, env.clicks.join());
    t(n('...with no toast'), env.toasts() === '', env.toasts());
    env.state(0);
    await wait(SETTLE_MS);
    t(n('...not twice for the same video'), env.clicks.length === 1, env.clicks.join());
    t(n('no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }
  {
    const env = await boot({ openCommentsAtEnd: false });
    env.state(1);
    env.state(0);
    await wait(SETTLE_MS);
    t(n('setting off: not opened'), env.clicks.length === 0, env.clicks.join());
  }
  {
    const env = await boot({}, { page: 'WEB_PAGE_TYPE_SHORTS' });
    env.state(1);
    env.state(0);
    await wait(SETTLE_MS);
    t(n('a Short: not opened'), env.clicks.length === 0, env.clicks.join());
  }
  {
    const env = await boot({}, { autoplay: true });
    env.state(1);
    env.state(0);
    await wait(SETTLE_MS);
    t(n('autoplay on for this account: not opened'), env.clicks.length === 0, env.clicks.join());
  }
  {
    const env = await boot();
    env.state(1);
    trustedKey(env.win, 13);
    env.state(0);
    await wait(SETTLE_MS);
    t(n('a key pressed just before the end: not opened'), env.clicks.length === 0, env.clicks.join());
  }
  {
    // Played again within the delay, with no key (a pointer on Replay): not
    // opened over the playing video; its next end opens them.
    const env = await boot();
    env.state(1);
    env.state(0);
    await wait(200);
    env.state(1);
    await wait(SETTLE_MS);
    t(n('played again before the delay ran out: not opened'), env.clicks.length === 0, env.clicks.join());
    env.state(0);
    await wait(SETTLE_MS);
    t(n('...and opened at its next end'), env.clicks.length === 1, env.clicks.join());
  }
  {
    // Replayed with the pointer on the TV: -1, 5, 3 within the delay, 1 only
    // after it (end at 21.2 s, 1 at 23.1 s). Leaving the end is enough.
    const env = await boot();
    env.state(1);
    env.state(0);
    await wait(200);
    env.state(-1);
    env.state(5);
    env.state(3);
    await wait(SETTLE_MS);
    env.state(1);
    t(n('replayed, still loading when the delay ran out: not opened'), env.clicks.length === 0, env.clicks.join());
  }
  {
    // The event with no detail (not the player's): ignored, and the listener goes on working.
    const env = await boot();
    env.win.dispatchEvent(new env.win.CustomEvent('yt-player-state-change'));
    t(n('an event with no detail: no error'), env.errors.length === 0, env.errors.join(' | '));
    env.state(1);
    env.state(0);
    await wait(SETTLE_MS);
    t(n('...and the next end still opens the comments'), env.clicks.length === 1, env.clicks.join());
  }
  {
    // An autoplay record of another shape is not known: on, so not opened.
    const env = await boot({}, { autonav: { data: false } });
    env.state(1);
    env.state(0);
    await wait(SETTLE_MS);
    t(n('an autoplay record {data: false}: counted as on, not opened'), env.clicks.length === 0, env.clicks.join());
  }
  {
    // Switched off with the pointer during the delay (no key counted then):
    // not opened. The panel is opened by key once, long enough before the end.
    const env = await boot();
    trustedKey(env.win, GREEN);
    trustedKey(env.win, GREEN);
    await wait(KEY_WINDOW_PAST_MS);
    env.state(1);
    env.state(0);
    await wait(200);
    const row = [...env.doc.querySelectorAll('.ytaf-ui-container label')]
      .find((l) => l.textContent.trim() === 'Open Comments at the End of a Video');
    const input = row && row.querySelector('input');
    t(n('the setting has a row in the panel'), !!input && input.checked);
    if (input) {
      input.checked = false;
      input.dispatchEvent(new env.win.Event('change', { bubbles: true }));
    }
    await wait(SETTLE_MS);
    t(n('switched off during the delay: not opened'), env.clicks.length === 0, env.clicks.join());
  }
  t(n('no page errors in any case'), envs.every((e) => e.errors.length === 0),
    envs.map((e) => e.errors.join(' | ')).filter(Boolean).join(' || '));
});
