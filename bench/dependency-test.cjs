/**
 * Ad Blocking off must NOT take the emoji fix down with it (webOS 3/4 needs it
 * regardless), and Tracking Block must genuinely stop when Ad Blocking is off
 * rather than merely looking enabled.
 *
 *   node bench/dependency-test.cjs <legacy bundle>
 *
 * Only the legacy build has the emoji fix: the page is always the webOS 3 one
 * in the Chrome 38 environment, whatever follows the bundle's path.
 */
const { createReporter, bootPage, trustedKey, wait } = require('./harness.cjs');

function boot(cfg) {
  const opened = [];
  // The page's own JSON.stringify, from before the bundle hooks it.
  let NS;
  const { win, frames } = bootPage({
    modern: false,
    xhr: class {
      open(m, u) { opened.push(String(u)); } send() {} setRequestHeader() {}
      getResponseHeader() { return null; } addEventListener() {}
    },
    config: Object.assign({
      enableAdBlock: true, enableTrackingBlock: false, enableLegacyEmojiFix: true,
      enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      thumbnailQuality: 'off', enableAutoLogin: false
    }, cfg),
    // The frames wait until the test runs them (pump), each called with 0.
    raf: 'manual',
    frameTime: 0,
    setup(win) { NS = win.JSON.stringify; },
    // The page stays without Element#remove, as before this test moved to the
    // harness.
    restoreRemove: false
  });
  return { win, NS, opened, pump: frames.pump };
}

const pad = 'z'.repeat(600);
function emojiPayload(NS) {
  const shelf = { shelfRenderer: {
    title: { runs: [{ text: 'Music \uD83D\uDE00 mix' }] },
    content: { horizontalListRenderer: { items: [
      { tileRenderer: { trackingParams: 'tp-tile' } }, { adSlotRenderer: {} }
    ] } } } };
  const o = { responseContext: { _pad: pad }, trackingParams: 'tp-root' };
  o.contents = { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: {
    content: { sectionListRenderer: { contents: [shelf] } } } } } };
  return NS(o);
}
const shelfOf = (r) => r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer
  .content.sectionListRenderer.contents[0].shelfRenderer;

const { t, run } = createReporter();

run(async () => {
  await wait(500);
  // --- Ad Blocking OFF, emoji fix ON: emoji must still be wrapped ---
  {
    const { win, NS } = boot({ enableAdBlock: false, enableLegacyEmojiFix: true });
    t('JSON.parse still hooked with Ad Blocking off',
      win.JSON.parse.toString().indexOf('native code') === -1);
    const out = win.JSON.parse(emojiPayload(NS));
    const txt = shelfOf(out).title.runs.map((r) => r.text).join('');
    t('emoji fix runs with Ad Blocking off', /\u200B\uD83D\uDE00\u200C/.test(txt), JSON.stringify(txt));
    const items = shelfOf(out).content.horizontalListRenderer.items;
    t('ads NOT filtered with Ad Blocking off', items.length === 2, 'items ' + items.length);
  }

  // --- Both off: the hook passes responses through untouched ---
  // It is not taken out of JSON.parse: hooks installed after it
  // (force-codec.js, subtitle-translate.js) wrap it, so src/adblock.js turns
  // it into a pass-through instead of writing the original back over them.
  {
    const { win, NS } = boot({ enableAdBlock: false, enableLegacyEmojiFix: false,
                               hideGuestSignInPrompts: false, hideEndcards: false });
    const text = emojiPayload(NS);
    t('JSON.parse passes responses through when nothing needs it',
      NS(win.JSON.parse(text)) === text);
  }

  // --- Ad Blocking ON: everything works as before ---
  {
    const { win, NS } = boot({ enableAdBlock: true, enableLegacyEmojiFix: true });
    const out = win.JSON.parse(emojiPayload(NS));
    const items = shelfOf(out).content.horizontalListRenderer.items;
    t('ads filtered with Ad Blocking on', items.length === 1, 'items ' + items.length);
    const txt = shelfOf(out).title.runs.map((r) => r.text).join('');
    t('emoji fix also runs with Ad Blocking on', /\u200B\uD83D\uDE00\u200C/.test(txt));
  }

  // --- Tracking Block is gated on Ad Blocking ---
  {
    const { win, opened } = boot({ enableAdBlock: false, enableTrackingBlock: true });
    const x = new win.XMLHttpRequest();
    x.open('POST', 'https://www.youtube.com/youtubei/v1/log_event?k=1');
    t('telemetry NOT blocked when Ad Blocking is off',
      opened[0].indexOf('log_event') !== -1, opened[0]);
  }
  {
    const { win, opened } = boot({ enableAdBlock: true, enableTrackingBlock: true });
    const x = new win.XMLHttpRequest();
    x.open('POST', 'https://www.youtube.com/youtubei/v1/log_event?k=1');
    t('telemetry blocked when both are on',
      opened[0].indexOf('log_event') === -1, opened[0]);
  }

  // --- The settings UI must show Tracking Block as unavailable ---
  {
    const { win, pump } = boot({ enableAdBlock: false, enableTrackingBlock: true });
    trustedKey(win, 404);
    for (let i = 0; i < 20; i++) pump();
    const inputs = win.document.querySelectorAll('#ytaf-page-filters input[type=checkbox]');
    // Cosmetic Filtering order: Ad Block, Tracking Block, Shorts, LiveGames, MostRelevant
    const tracking = inputs[1];
    t('Tracking Block checkbox disabled when Ad Blocking is off',
      !!tracking && tracking.disabled === true);
    t('Tracking Block row greyed out',
      !!tracking && tracking.closest('label').style.opacity === '0.5',
      tracking && tracking.closest('label').style.opacity);
    t('Ad Blocking checkbox itself stays enabled', inputs[0].disabled === false);
  }
});
