/**
 * Remove Black Text Boxes (app-quality-fix.js) when the bundle runs before
 * the parser has reached <body> (a userscript run at document start; on a TV
 * the page is further along, see late-injection-preload.cjs).
 * low-memory-style-test covers the fix with the page already there; this one
 * covers the wait for <body>: YouTube's low-memory class (app-quality-root)
 * must come off the body that appears, and stay off when YouTube puts it back,
 * with the setting on; with it off, the class stays. Until this test the wait
 * itself never ran.
 *
 *   node bench/app-quality-fix-test.cjs <bundle> [legacy|modern]
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();
const CLS = 'app-quality-root';

const { t, run } = createReporter();

const until = async (check, ms) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await wait(20);
  }
  return true;
};

/** The bundle run on a document with no <body> yet. */
function boot(cfg) {
  const { win, doc, errors } = bootPage({
    code,
    html: '<!doctype html><html><head></head><body></body></html>',
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, upgradeThumbnails: false, enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, enableLegacyEmojiFix: false
    }, cfg),
    setup(win) { win.document.documentElement.removeChild(win.document.body); },
    fetch: 'pending'
  });
  const ranWithoutBody = !doc.body;
  // The parser reaching <body>, with YouTube's low-memory class on it: before
  // DOMContentLoaded, as in a browser.
  const body = doc.createElement('body');
  body.className = `WEB_PAGE_TYPE_BROWSE ${CLS}`;
  body.appendChild(doc.createElement('ytlr-app'));
  doc.documentElement.appendChild(body);
  const has = () => body.classList.contains(CLS);
  return { win, doc, errors, body, has, ranWithoutBody };
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  {
    const h = boot({});
    t(n('the bundle ran before the page had a <body>'), h.ranWithoutBody);
    // No timer has run yet: the wait has not seen the new <body>.
    t(n('the class is still on the <body> the moment it appears'), h.has(), h.body.className);
    const gone = await until(() => !h.has(), 3000);
    t(n('...and comes off once the wait finds the <body>'), gone, h.body.className);
    t(n('...the page\'s own classes kept'), h.body.classList.contains('WEB_PAGE_TYPE_BROWSE'), h.body.className);
    // YouTube writes body.className whole on navigation.
    h.body.className = `WEB_PAGE_TYPE_WATCH ${CLS}`;
    // At once (the observer on <body>), not at the wait's next 100 ms tick.
    await wait(0);
    t(n('...and it comes off again at once when YouTube puts it back'), !h.has() && h.body.classList.contains('WEB_PAGE_TYPE_WATCH'),
      h.body.className);
    t(n('no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }

  {
    const h = boot({ removeLowMemoryStyle: false });
    // Long enough for the wait (every 100 ms) to have taken it off.
    await wait(400);
    t(n('setting off: the <body> that appears keeps the class'), h.has(), h.body.className);
    h.body.className = `WEB_PAGE_TYPE_WATCH ${CLS}`;
    await wait(50);
    t(n('setting off: and keeps it after a rewrite'), h.has(), h.body.className);
    t(n('setting off: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }
});
