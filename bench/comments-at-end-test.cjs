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
      'yt.leanback.default::AUTONAV_FOR_LIVING_ROOM': JSON.stringify({ data: { [GAIA]: opts.autoplay === true, 999: true } })
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
  return { win, doc, errors, clicks, state, toasts };
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
    // The event with no detail (not the player's): ignored, and the listener goes on working.
    const env = await boot();
    env.win.dispatchEvent(new env.win.CustomEvent('yt-player-state-change'));
    t(n('an event with no detail: no error'), env.errors.length === 0, env.errors.join(' | '));
    env.state(1);
    env.state(0);
    await wait(SETTLE_MS);
    t(n('...and the next end still opens the comments'), env.clicks.length === 1, env.clicks.join());
  }
});
