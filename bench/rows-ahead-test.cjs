/**
 * Load Rows Ahead (rows-ahead.js, from mirijanristic's fork), through the
 * bundle's JSON.parse hook. The app asks for the next rows of a list once
 * fewer than autoloadThresholdItemsFromEnd rows are left below the focused
 * one; YouTube sends 1, so a quick run down the home screen reaches rows that
 * have not arrived. The hook raises it to 4 on every section list a response
 * carries. Until this test nothing checked the value the app reads: per
 * response shape (home, search, both continuation shapes, the browse tabs in
 * both content shapes), a value already high enough left as sent, the lists
 * it must not touch, the Shorts page, and the setting turned off.
 *
 *   node bench/rows-ahead-test.cjs <bundle> [legacy|modern]
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, dispatchTrusted, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();
const GREEN = 404;

const { t, run } = createReporter();

function boot(cfg, opts = {}) {
  const { win, errors } = bootPage({
    code,
    bodyClass: opts.bodyClass || 'WEB_PAGE_TYPE_BROWSE',
    config: Object.assign({
      enableAdBlock: true, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, enableLegacyEmojiFix: false
    }, cfg),
    fetch: 'pending'
  });
  // A response as the app parses it: through the page's JSON.parse.
  const parse = (obj) => win.JSON.parse(JSON.stringify(obj));
  return { win, errors, parse };
}

// What YouTube sends with a section list: the next rows' token, with the
// threshold or without it.
const next = (threshold) => {
  const data = { continuation: 'next-rows' };
  if (threshold !== undefined) data.autoloadThresholdItemsFromEnd = threshold;
  return { nextContinuationData: data };
};
const list = (...continuations) => ({ contents: [{ shelfRenderer: {} }], continuations });
const ctx = { responseContext: { _pad: 'z'.repeat(600) } };
const home = (l) => Object.assign({}, ctx, { contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: l } } } } } });
const search = (l) => Object.assign({}, ctx, { contents: { sectionListRenderer: l } });
const contA = (l) => Object.assign({}, ctx, { continuationContents: { sectionListContinuation: l } });
const contB = (l) => Object.assign({}, ctx, { continuationContents: { tvSurfaceContentContinuation: { content: { sectionListRenderer: l } } } });
const tabs = (sections) => Object.assign({}, ctx, { contents: { tvBrowseRenderer: { content: { tvSecondaryNavRenderer: { sections } } } } });
const thresholds = (l) => l.continuations.map((c) => c && c.nextContinuationData ? c.nextContinuationData.autoloadThresholdItemsFromEnd : '-').join(',');

const homeList = (r) => r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer;

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  {
    const h = boot({});
    await wait(20);
    // YouTube's 1, none at all, and 0 (the flag then decides): all raised.
    const r = h.parse(home(list(next(1))));
    t(n('home: YouTube\'s threshold of 1 is raised to 4'), thresholds(homeList(r)) === '4', thresholds(homeList(r)));
    const r2 = h.parse(home(list(next(), next(0))));
    t(n('home: a missing threshold and a 0 are set to 4'), thresholds(homeList(r2)) === '4,4', thresholds(homeList(r2)));
    t(n('...and the token is kept'), homeList(r2).continuations[0].nextContinuationData.continuation === 'next-rows');
    const r3 = h.parse(home(list(next(4), next(7))));
    t(n('home: a threshold of 4 or more is left as sent'), thresholds(homeList(r3)) === '4,7', thresholds(homeList(r3)));
    // A reload token and an empty entry carry no threshold the app reads.
    const r4 = h.parse(home(list({ reloadContinuationData: { continuation: 'reload' } }, null, next(2))));
    t(n('home: a reload token is left as sent, the next-rows one beside it raised'),
      JSON.stringify(homeList(r4).continuations[0]) === '{"reloadContinuationData":{"continuation":"reload"}}' &&
      thresholds(homeList(r4)) === '-,-,4', JSON.stringify(homeList(r4).continuations));
    const r5 = h.parse(home({ contents: [], continuations: 'not-a-list' }));
    t(n('home: continuations that are not a list are left alone'), homeList(r5).continuations === 'not-a-list');
    const r6 = h.parse(home(undefined));
    t(n('home: no section list, nothing breaks'), r6.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer === undefined);

    const s = h.parse(search(list(next(1))));
    t(n('search results: raised to 4'), thresholds(s.contents.sectionListRenderer) === '4', thresholds(s.contents.sectionListRenderer));
    const a = h.parse(contA(list(next(1))));
    t(n('next rows (sectionListContinuation): raised to 4'),
      thresholds(a.continuationContents.sectionListContinuation) === '4', thresholds(a.continuationContents.sectionListContinuation));
    const b = h.parse(contB(list(next())));
    const bl = b.continuationContents.tvSurfaceContentContinuation.content.sectionListRenderer;
    t(n('next rows (tvSurfaceContentContinuation): raised to 4'), thresholds(bl) === '4', thresholds(bl));

    // The browse tabs (Subscriptions, a channel): every tab, either content shape.
    const bt = h.parse(tabs([
      { tvSecondaryNavSectionRenderer: { tabs: [
        { tabRenderer: { content: { sectionListRenderer: list(next(1)) } } },
        { tabRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: list(next(2)) } } } } },
        { tabRenderer: { title: 'not loaded yet' } },
        null
      ] } },
      { somethingElse: {} },
      { tvSecondaryNavSectionRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: list(next()) } } }] } }
    ]));
    const sec = bt.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections;
    const tabList = (i, j) => sec[i].tvSecondaryNavSectionRenderer.tabs[j].tabRenderer.content;
    t(n('browse tabs: a tab\'s own section list is raised'), thresholds(tabList(0, 0).sectionListRenderer) === '4',
      thresholds(tabList(0, 0).sectionListRenderer));
    t(n('browse tabs: a tab\'s surface section list is raised'),
      thresholds(tabList(0, 1).tvSurfaceContentRenderer.content.sectionListRenderer) === '4');
    t(n('browse tabs: a later section\'s tabs too, past a section with no tabs and a tab with no content'),
      thresholds(tabList(2, 0).sectionListRenderer) === '4' && sec[0].tvSecondaryNavSectionRenderer.tabs[2].tabRenderer.content === undefined);
    const bt2 = h.parse(tabs('not-a-list'));
    t(n('browse tabs: sections that are not a list are left alone'),
      bt2.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections === 'not-a-list');

    // The rows under the player fill as they come into view: left as sent.
    const watchNext = h.parse(Object.assign({}, ctx, { contents: { singleColumnWatchNextResults: { pivot: { sectionListRenderer: list(next(1)) } } } }));
    t(n('the rows under the player are left as sent'),
      thresholds(watchNext.contents.singleColumnWatchNextResults.pivot.sectionListRenderer) === '1');
    t(n('no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }

  // The Shorts player gets search results unfiltered; their rows ahead still count.
  {
    const h = boot({}, { bodyClass: 'WEB_PAGE_TYPE_SHORTS' });
    await wait(20);
    const s = h.parse(search(list(next(1))));
    t(n('on the Shorts page: search results raised all the same'), thresholds(s.contents.sectionListRenderer) === '4',
      thresholds(s.contents.sectionListRenderer));
  }

  // Ad Blocking off: the hook still runs for this.
  {
    const h = boot({ enableAdBlock: false });
    await wait(20);
    const r = h.parse(home(list(next(1))));
    t(n('Ad Blocking off: still raised'), thresholds(homeList(r)) === '4', thresholds(homeList(r)));
  }

  // No switch any more: a value stored off by an earlier version is no
  // longer read, the rows are raised all the same.
  {
    const h = boot({ loadRowsAhead: false });
    await wait(20);
    const r = h.parse(home(list(next(1), next())));
    t(n('stored off by an earlier version: still raised'), thresholds(homeList(r)) === '4,4', thresholds(homeList(r)));
  }

  // The panel has no Load Rows Ahead row.
  {
    const h = boot({});
    await wait(20);
    const e = new h.win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
    dispatchTrusted(h.win.document.body, e);
    await wait(20);
    const labels = [...h.win.document.querySelectorAll('.ytaf-ui-container label')].map((l) => l.textContent.trim());
    t(n('the panel is open'), labels.length > 0, labels.length);
    t(n('no Load Rows Ahead row in the panel'), !labels.includes('Load Rows Ahead'), labels.filter((l) => /rows/i.test(l)).join());
    t(n('panel: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }
});
