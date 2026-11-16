/**
 * Search results font (ui.js): the search page's video titles (.prqC5c,
 * which YouTube TV's CSS sets in Roboto) get the TV's font; other pages are
 * left alone. And titles over more than one line get tighter lines in the
 * black boxes of YouTube's memory saving. Both always on, with no switch in
 * the panel.
 *
 * Usage: node bench/search-font-test.cjs <bundle> [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, UA } = require('./harness.cjs');

const GREEN = 404;

const { t, done } = createReporter();

// The bundle of the build the command line names, in the Chrome 87 (modern)
// or Chrome 38 (legacy) environment; the user agent is webOS 23 on both.
function boot(cfg, page) {
  const { win, errors } = bootPage({
    bodyClass: page,
    inner: '<ytlr-tile-renderer><span class="prqC5c">A video title</span></ytlr-tile-renderer>',
    userAgent: UA.webos23,
    consoleErrors: false,
    restoreRemove: false,
    config: Object.assign({
      enableSponsorBlock: false, enableReturnYouTubeDislike: false, enableAutoLogin: false
    }, cfg),
    setup(w) {
      // Frames never run.
      w.requestAnimationFrame = () => 0;
      w.cancelAnimationFrame = () => {};
    },
    fetch: () => Promise.reject(new Error('offline'))
  });
  return { win, errors };
}

const fontOf = (win) => win.getComputedStyle(win.document.querySelector('.prqC5c')).fontFamily || '';

// The panel's labels, every tab opened.
function panelLabels(win) {
  trustedKey(win, GREEN);
  for (const tab of win.document.querySelectorAll('.ytaf-tab-btn')) tab.click();
  return [...win.document.querySelectorAll('label')].map((l) => l.textContent);
}

{
  const { win, errors } = boot({}, 'WEB_PAGE_TYPE_SEARCH');
  t('search page: the titles get the TV\'s font first', /^"?LG Display-Regular"?/.test(fontOf(win)), fontOf(win));
  // The panel must have opened: a UI Tweaks switch that stays is there first.
  const labels = panelLabels(win);
  t('precondition: the panel is open, with New Liquid Glass UI on UI Tweaks',
    labels.some((l) => /New Liquid Glass UI/.test(l)), labels.length + ' labels');
  t('no switch for the search font in it', !labels.some((l) => /Search Results Font/.test(l)));
  t('no switch for the multiline titles in it', !labels.some((l) => /Multiline Titles/.test(l)));
  t('no page errors', errors.length === 0, errors.join(' | '));
}
{
  const { win } = boot({}, 'WEB_PAGE_TYPE_BROWSE');
  t('control, another page: the titles are left alone', fontOf(win).indexOf('LG Display') === -1, fontOf(win));
}
{
  // A stored value from the build that had the switch does not count.
  const { win, errors } = boot({ fixSearchFont: false }, 'WEB_PAGE_TYPE_SEARCH');
  t('an old stored "off": the font all the same', /LG Display/.test(fontOf(win)), fontOf(win));
  t('no page errors', errors.length === 0, errors.join(' | '));
}
{
  // Multiline titles in the black boxes of YouTube's memory saving (kept with
  // Remove Black Text Boxes off): tighter lines, with no switch, and an old
  // stored Fix Multiline Titles "off" does not count.
  const { win, errors } = boot({ removeLowMemoryStyle: false, fixMultilineTitles: false },
    'WEB_PAGE_TYPE_WATCH app-quality-root');
  const box = win.document.createElement('div');
  box.className = 'SK1srf';
  box.innerHTML = '<div class="WVWtef">A title over</div><div class="niS3yd">two lines</div>';
  win.document.body.appendChild(box);
  // 0.37vh, which jsdom gives in pixels.
  const want = (0.37 * win.innerHeight) / 100;
  const pads = [...box.children].flatMap((el) => {
    const cs = win.getComputedStyle(el);
    return [cs.paddingTop, cs.paddingBottom];
  });
  t('multiline titles: tighter lines in the boxes, an old "off" all the same',
    pads.length === 4 && pads.every((p) => Math.abs(parseFloat(p) - want) < 0.01), pads.join(' | '));
  t('multiline titles: no page errors', errors.length === 0, errors.join(' | '));
}

done();
