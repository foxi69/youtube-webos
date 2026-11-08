/**
 * Logo selector, Live-video filter, Shorts guide entry, Hide Left Menu Entries
 * and page-1 sizing.
 * DOM fixtures are copied verbatim from real webOS 25 captures.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';

const PREMIUM_URL = 'https://www.gstatic.com/youtube/img/branding/livingroom/premium/wordmark_truncated/fullcolor_white_57_2x_v2.png';
const DEFAULT_URL = 'https://www.gstatic.com/youtube/img/branding/livingroom/youtube/wordmark/fullcolor_white_57_2x_v2.png';

// Verbatim from the capture (the "Normal" variant).
const LOGO_HTML =
  '<ytlr-logo-entity tabindex="-1" class="wnwire lJjg6 bYrvBd" style="left: 66.375rem; width: 10.125rem;">' +
  '<ytlr-thumbnail-details tabindex="-1" class="cFXl0 XVmJGe cFrowd" ' +
  `style="background-image: url(&quot;${DEFAULT_URL}&quot;);"></ytlr-thumbnail-details></ytlr-logo-entity>`;

function boot(cfg, extraHtml = '', storage = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app>${extraHtml}</ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv',
      virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  let rafQ = [];
  win.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  win.cancelAnimationFrame = () => {};
  win.fetch = () => Promise.reject(new Error('offline'));
  const NS = win.JSON.stringify;
  win.localStorage.setItem('ytaf-configuration', NS(Object.assign({
    enableAdBlock: true, enableTrackingBlock: false, removeGlobalShorts: false,
    removeLiveVideos: false, removeAiVideos: false, markAiVideos: false, removeTopLiveGames: false, removeMostRelevant: false,
    hideGuestSignInPrompts: false, hideEndcards: false, enableLegacyEmojiFix: false,
    enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    upgradeThumbnails: false, enableAutoLogin: false, logoStyle: 'default'
  }, cfg)));
  for (const k in storage) win.localStorage.setItem(k, storage[k]);
  applyChrome38Downgrade(win);
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, NS, pump: () => { const q = rafQ; rafQ = []; for (const cb of q) cb(0); } };
}

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = 'z'.repeat(600);

// A shelf item in the lockupViewModel shape, with an optional LIVE badge.
function lockupItem(id, live, extraOverlayFirst) {
  const overlays = [];
  // Deliberately put a non-badge overlay first: the badge is not always [0].
  if (extraOverlayFirst) overlays.push({ thumbnailOverlayProgressBarViewModel: { p: 1 } });
  overlays.push({ thumbnailBottomOverlayViewModel: { badges: [
    { thumbnailBadgeViewModel: { badgeStyle: live
        ? 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE'
        : 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT', text: live ? 'LIVE' : '12:34' } }
  ] } });
  return { lockupViewModel: { contentId: id, contentImage: { thumbnailViewModel: { overlays } } } };
}

function browse(items, extra) {
  const o = { responseContext: { _pad: pad } };
  o.contents = { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: {
    sectionListRenderer: { contents: [
      { shelfRenderer: { title: { runs: [{ text: 'Recommended' }] },
        content: { horizontalListRenderer: { items } } } }
    ] } } } } } };
  if (extra) Object.assign(o, extra);
  return o;
}
const shelfItems = (r) => r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer
  .content.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items;

(async () => {
  // ---------- 1. Logo selector ----------
  // The wordmark comes from a stylesheet rule gated by a class on <html>, so
  // what counts is the computed style: it must beat the inline style YouTube
  // writes, also on a header YouTube paints again later.
  const shown = (win) => {
    const logo = win.document.querySelector('ytlr-logo-entity');
    const img = logo.querySelector('ytlr-thumbnail-details');
    const ls = win.getComputedStyle(logo);
    return { url: win.getComputedStyle(img).backgroundImage, left: ls.left, width: ls.width };
  };
  // jsdom computes rem at 16px: 66.375rem = 1062px, 10.125rem = 162px,
  // 65.75rem = 1052px, 10.75rem = 172px.
  for (const [style, expectUrl, expectLeft, expectWidth] of [
    ['default', DEFAULT_URL, '1062px', '162px'],
    ['premium', PREMIUM_URL, '1052px', '172px']
  ]) {
    // The fixture is YouTube's default wordmark; for Premium, start from the
    // other one so the rule has something to beat.
    const html = style === 'default' ? LOGO_HTML.split(DEFAULT_URL).join(PREMIUM_URL)
      .replace('left: 66.375rem; width: 10.125rem;', 'left: 65.75rem; width: 10.75rem;') : LOGO_HTML;
    const { win } = boot({ logoStyle: style }, html);
    await wait(50);
    const s = shown(win);
    t(`[logo:${style}] correct wordmark`, s.url.indexOf(expectUrl) !== -1, s.url);
    t(`[logo:${style}] left repositioned`, s.left === expectLeft, s.left);
    t(`[logo:${style}] width matches the asset`, s.width === expectWidth, s.width);
    t(`[logo:${style}] not hidden`,
      !win.document.documentElement.classList.contains('ytaf-hide-logo'));
    t(`[logo:${style}] YouTube's element is not written`,
      win.document.querySelector('ytlr-thumbnail-details').style.backgroundImage.indexOf(expectUrl) === -1);
  }
  {
    const { win } = boot({ logoStyle: 'hidden' }, LOGO_HTML);
    await wait(50);
    const cl = win.document.documentElement.classList;
    t('[logo:hidden] hide class applied', cl.contains('ytaf-hide-logo'));
    t('[logo:hidden] no wordmark class', !cl.contains('ytaf-logo-default') && !cl.contains('ytaf-logo-premium'));
    t('[logo:hidden] logo rendered hidden',
      win.getComputedStyle(win.document.querySelector('ytlr-logo-entity')).visibility === 'hidden');
  }
  {
    // A stored value that is not a wordmark falls back to Default, also one
    // that names an inherited property.
    const { win } = boot({ logoStyle: 'toString' }, LOGO_HTML);
    await wait(50);
    t('[logo] unknown value shows the Default wordmark', shown(win).url.indexOf(DEFAULT_URL) !== -1 &&
      win.document.documentElement.classList.contains('ytaf-logo-default'), shown(win).url);
  }
  {
    // Header not painted yet at startup, and painted again later with
    // YouTube's own wordmark long after any page change (app resumed, idle):
    // nothing has to run again for the rule to hold.
    const { win } = boot({ logoStyle: 'premium' }, '');
    await wait(50);
    const app = win.document.querySelector('ytlr-app');
    app.innerHTML = LOGO_HTML;
    t('[logo] applied to a header that appears late', shown(win).url.indexOf(PREMIUM_URL) !== -1, shown(win).url);
    await wait(20);
    app.innerHTML = '';
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    app.innerHTML = LOGO_HTML;
    const s = shown(win);
    t('[logo] holds on a header repainted without a page change',
      s.url.indexOf(PREMIUM_URL) !== -1 && s.left === '1052px' && s.width === '172px', JSON.stringify(s));
  }
  {
    // One wordmark class on <html>, and one stylesheet.
    const { win } = boot({ logoStyle: 'premium' }, LOGO_HTML);
    await wait(50);
    const cl = win.document.documentElement.classList;
    t('[logo] one wordmark class at a time',
      cl.contains('ytaf-logo-premium') && !cl.contains('ytaf-logo-default'));
    t('[logo] stylesheet injected once', win.document.querySelectorAll('#ytaf-logo-style').length === 1);
  }

  // ---------- 2. Live filter ----------
  {
    const { win, NS } = boot({ removeLiveVideos: true });
    await wait(300);
    const out = win.JSON.parse(NS(browse([
      lockupItem('a', false), lockupItem('b', true),
      lockupItem('c', true, true),           // badge NOT at overlays[0]
      lockupItem('d', false)
    ])));
    const ids = shelfItems(out).map((i) => i.lockupViewModel.contentId);
    t('[live] live items removed', JSON.stringify(ids) === JSON.stringify(['a', 'd']), JSON.stringify(ids));
    t('[live] badge found even when it is not overlays[0]', ids.indexOf('c') === -1);
  }
  {
    const { win, NS } = boot({ removeLiveVideos: false });
    await wait(300);
    const out = win.JSON.parse(NS(browse([lockupItem('a', false), lockupItem('b', true)])));
    t('[live] nothing removed when the filter is off', shelfItems(out).length === 2);
  }
  {
    // Fallback shapes, for when the viewModel schema changes again.
    const { win, NS } = boot({ removeLiveVideos: true });
    await wait(300);
    const out = win.JSON.parse(NS(browse([
      { tileRenderer: { contentType: 'TILE_CONTENT_TYPE_VIDEO', x: 1 } },
      { tileRenderer: { header: { tileHeaderRenderer: { thumbnailOverlays: [
        { thumbnailOverlayTimeStatusRenderer: { style: 'LIVE' } }] } } } },
      { tileRenderer: { contentType: 'TILE_CONTENT_TYPE_LIVE' } }
    ])));
    t('[live] tileRenderer fallbacks also filtered', shelfItems(out).length === 1,
      'left ' + shelfItems(out).length);
  }

  // ---------- 4. Shorts guide entry ----------
  {
    const { win, NS } = boot({ removeGlobalShorts: true });
    await wait(300);
    const guide = { responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: {
      tvSecondaryNavRenderer: { sections: [{ tvSecondaryNavSectionRenderer: { tabs: [
        { tabRenderer: { title: 'Home', endpoint: { browseEndpoint: { browseId: 'FEwhat_to_watch' } } } },
        { tabRenderer: { title: 'Shorts', endpoint: { browseEndpoint: { browseId: 'FEshorts' } } } },
        { tabRenderer: { title: 'Subscriptions', endpoint: { browseEndpoint: { browseId: 'FEsubscriptions' } } } }
      ] } }] } } } } };
    const out = win.JSON.parse(NS(guide));
    const tabs = out.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer
      .sections[0].tvSecondaryNavSectionRenderer.tabs.map((x) => x.tabRenderer.title);
    t('[guide] Shorts tab removed', JSON.stringify(tabs) === JSON.stringify(['Home', 'Subscriptions']),
      JSON.stringify(tabs));
  }
  {
    const { win, NS } = boot({ removeGlobalShorts: true });
    await wait(300);
    // guideEntryRenderer shape, identified by endpoint rather than title.
    const guide = { responseContext: { _pad: pad }, items: [
      { guideEntryRenderer: { title: { simpleText: 'Home' } } },
      { guideEntryRenderer: { title: { simpleText: 'Kurzfilme' },
        navigationEndpoint: { browseEndpoint: { browseId: 'FEshorts' } } } },
      { guideEntryRenderer: { title: { simpleText: 'Library' } } }
    ] };
    const out = win.JSON.parse(NS(guide));
    const titles = out.items.map((x) => x.guideEntryRenderer.title.simpleText);
    t('[guide] localized Shorts entry removed by endpoint',
      JSON.stringify(titles) === JSON.stringify(['Home', 'Library']), JSON.stringify(titles));
  }
  {
    // A null met before the guide (any falsy value) must not end the search
    // for it: counted again at each meeting, it used to fill the count early.
    const { win, NS } = boot({ removeGlobalShorts: true });
    await wait(300);
    const guide = { responseContext: { _pad: pad },
      a: { items: null, sections: null }, b: { items: null, sections: null }, c: { items: null, sections: null },
      d: { e: { guideRenderer: { items: [
        { guideEntryRenderer: { title: { simpleText: 'Home' } } },
        { guideEntryRenderer: { title: { simpleText: 'Shorts' }, navigationEndpoint: { browseEndpoint: { browseId: 'FEshorts' } } } }
      ] } } } };
    const out = win.JSON.parse(NS(guide));
    const titles = out.d.e.guideRenderer.items.map((x) => x.guideEntryRenderer.title.simpleText);
    t('[guide] nulls on the way do not stop the search for the guide: Shorts goes, Home stays',
      JSON.stringify(titles) === JSON.stringify(['Home']) && out.a.items === null, JSON.stringify(titles));
  }
  {
    // A flat guide `items` list met after an `items: null` is still the one
    // filtered: the null is not kept in its place.
    const { win, NS } = boot({ removeGlobalShorts: true });
    await wait(300);
    const guide = { responseContext: { _pad: pad }, a: { items: null },
      b: { c: { items: [
        { guideEntryRenderer: { title: { simpleText: 'Home' } } },
        { guideEntryRenderer: { title: { simpleText: 'Shorts' }, navigationEndpoint: { browseEndpoint: { browseId: 'FEshorts' } } } }
      ] } } };
    const out = win.JSON.parse(NS(guide));
    const titles = out.b.c.items.map((x) => x.guideEntryRenderer.title.simpleText);
    t('[guide] a flat items list after an items: null is filtered: Shorts goes, Home stays',
      JSON.stringify(titles) === JSON.stringify(['Home']) && out.a.items === null, JSON.stringify(titles));
  }
  {
    const { win, NS } = boot({ removeGlobalShorts: false });
    await wait(300);
    const guide = { responseContext: { _pad: pad }, items: [
      { guideEntryRenderer: { title: { simpleText: 'Shorts' },
        navigationEndpoint: { browseEndpoint: { browseId: 'FEshorts' } } } }
    ] };
    const out = win.JSON.parse(NS(guide));
    t('[guide] left alone when Remove Shorts is off', out.items.length === 1);
  }

  // ---------- Hide Left Menu Entries ----------
  // The guide in the shape MickLesk's fork filters: sections of entries.
  const navEntry = (title, endpoint, extra) => ({ guideEntryRenderer: Object.assign(
    { formattedTitle: { simpleText: title }, navigationEndpoint: endpoint }, extra) });
  const browseTo = (id) => ({ browseEndpoint: { browseId: id } });
  const sideGuide = () => ({ responseContext: { _pad: pad }, items: [
    { guideSectionRenderer: { items: [
      navEntry('Search', { searchEndpoint: {} }),
      navEntry('Home', browseTo('FEwhat_to_watch')),
      navEntry('Subscriptions', browseTo('FEsubscriptions'))
    ] } },
    { guideSectionRenderer: { items: [
      navEntry('Some Channel', browseTo('UCabcdefghijklmnopqrstuv'),
        { thumbnail: { thumbnails: [{ url: 'https://yt3.ggpht.com/x' }] } })
    ] } },
    { guideSectionRenderer: { items: [
      navEntry('Music', browseTo('FEtopics_music')),
      navEntry('Gaming', browseTo('FEtopics_gaming'))
    ] } }
  ] });
  const sideTitles = (r) => r.items.map((s) => s.guideSectionRenderer.items
    .map((x) => x.guideEntryRenderer.formattedTitle.simpleText));
  const LEARNT = JSON.stringify([
    { id: 'search', title: 'Search' }, { id: 'FEsubscriptions', title: 'Subscriptions' },
    { id: 'FEtopics_music', title: 'Music' }, { id: 'FEtopics_gaming', title: 'Gaming' }
  ]);
  {
    // Ad Blocking off: the menu is a UI setting, not one of its filters.
    const { win, NS } = boot({ enableAdBlock: false });
    await wait(300);
    const out = win.JSON.parse(NS(sideGuide()));
    t('[sidebar] nothing hidden by default', JSON.stringify(sideTitles(out)) ===
      JSON.stringify([['Search', 'Home', 'Subscriptions'], ['Some Channel'], ['Music', 'Gaming']]),
      JSON.stringify(sideTitles(out)));
    const stored = win.localStorage.getItem('ytaf-sidebar-entries');
    t('[sidebar] the entries are learnt for the panel, without Home and the channels',
      stored === LEARNT, stored);
    win.close();
  }
  {
    // webOS 25's Home is FEtopics: never listed, so it cannot be hidden; a
    // list saved by an older version, with Home switched off, loses it.
    const { win, NS } = boot({ enableAdBlock: false, hiddenSidebarEntries: ['FEtopics'] }, '', {
      'ytaf-sidebar-entries': JSON.stringify([{ id: 'FEtopics', title: 'Home' }, { id: 'FEtopics_music', title: 'Music' }]) });
    await wait(300);
    const out = win.JSON.parse(NS({ responseContext: { _pad: pad }, items: [{ guideSectionRenderer: { items: [
      navEntry('Home', browseTo('FEtopics')), navEntry('Music', browseTo('FEtopics_music'))] } }] }));
    const stored = win.localStorage.getItem('ytaf-sidebar-entries');
    t('[sidebar] webOS 25 Home (FEtopics) stays and is not listed, also from an older saved list',
      JSON.stringify(sideTitles(out)) === '[["Home","Music"]]' &&
      stored === JSON.stringify([{ id: 'FEtopics_music', title: 'Music' }]), JSON.stringify(sideTitles(out)) + ' ' + stored);
    win.close();
  }
  {
    const { win, NS } = boot({ enableAdBlock: false,
      hiddenSidebarEntries: ['FEtopics_music', 'FEtopics_gaming', 'search'] });
    await wait(300);
    const out = win.JSON.parse(NS(sideGuide()));
    t('[sidebar] hidden entries, and the section they empty, are taken out',
      JSON.stringify(sideTitles(out)) === JSON.stringify([['Home', 'Subscriptions'], ['Some Channel']]),
      JSON.stringify(sideTitles(out)));
    t('[sidebar] the hidden ones stay listed for the panel',
      win.localStorage.getItem('ytaf-sidebar-entries') === LEARNT, win.localStorage.getItem('ytaf-sidebar-entries'));
    // A flat list of entries, the shape the Shorts tests use.
    const flat = win.JSON.parse(NS({ responseContext: { _pad: pad }, items: [
      navEntry('Home', browseTo('FEwhat_to_watch')), navEntry('Music', browseTo('FEtopics_music'))] }));
    t('[sidebar] a flat guide is filtered too', flat.items.length === 1 &&
      flat.items[0].guideEntryRenderer.formattedTitle.simpleText === 'Home');
    // Hidden ids are only looked for in the guide.
    const other = win.JSON.parse(NS({ responseContext: { _pad: pad }, items: [
      { tileRenderer: { onSelectCommand: browseTo('FEtopics_music') } }] }));
    t('[sidebar] other responses are left alone', other.items.length === 1);
    win.close();
  }
  {
    // The panel lists the learnt entries; ticking one hides it from the next guide on.
    const { win, NS, pump } = boot({ enableAdBlock: false }, '', { 'ytaf-sidebar-entries': LEARNT });
    await wait(300);
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 404, configurable: true });
    dispatchTrusted(win.document.body, e);
    for (let i = 0; i < 20; i++) pump();
    const section = Array.from(win.document.querySelectorAll('#ytaf-page-ui-tweaks .ytaf-settings-section'))
      .find((s) => s.querySelector('.section-title')?.textContent === 'Hide Left Menu Entries');
    t('[sidebar] a Hide Left Menu Entries section on UI Tweaks', !!section);
    const rows = section ? Array.from(section.querySelectorAll('label')) : [];
    t('[sidebar] one switch per learnt entry, all off',
      JSON.stringify(rows.map((l) => l.textContent)) === JSON.stringify(['Search', 'Subscriptions', 'Music', 'Gaming']) &&
      rows.every((l) => !l.querySelector('input').checked), JSON.stringify(rows.map((l) => l.textContent)));
    const music = rows.find((l) => l.textContent === 'Music');
    if (music) {
      const input = music.querySelector('input');
      input.checked = true;
      input.dispatchEvent(new win.Event('change'));
    }
    await wait(300);
    const saved = JSON.parse(win.localStorage.getItem('ytaf-configuration'));
    t('[sidebar] ticking a switch saves the entry as hidden',
      JSON.stringify(saved.hiddenSidebarEntries) === JSON.stringify(['FEtopics_music']), JSON.stringify(saved.hiddenSidebarEntries));
    const out = win.JSON.parse(NS(sideGuide()));
    t('[sidebar] and the next guide comes without it',
      JSON.stringify(sideTitles(out)[2]) === JSON.stringify(['Gaming']), JSON.stringify(sideTitles(out)));
    t('[sidebar] the switch stays ticked', !!music && music.querySelector('input').checked);
    win.close();
  }
  {
    // A smaller menu (fewer entries) keeps a hidden entry listed, so it can be shown again.
    const { win, NS } = boot({ enableAdBlock: false, hiddenSidebarEntries: ['FEtopics_music'] }, '',
      { 'ytaf-sidebar-entries': LEARNT });
    await wait(300);
    win.JSON.parse(NS({ responseContext: { _pad: pad }, items: [{ guideSectionRenderer: { items: [
      navEntry('Search', { searchEndpoint: {} }), navEntry('Subscriptions', browseTo('FEsubscriptions'))] } }] }));
    const list = JSON.parse(win.localStorage.getItem('ytaf-sidebar-entries')).map((e) => e.id).join(',');
    t('[sidebar] a smaller menu keeps the hidden entry listed, and drops the others',
      list === 'search,FEsubscriptions,FEtopics_music', list);
    win.close();
  }
  {
    // A stored value that is not a list counts as nothing hidden; the switches still work.
    const { win, NS, pump } = boot({ enableAdBlock: false, hiddenSidebarEntries: 'oops' }, '',
      { 'ytaf-sidebar-entries': LEARNT });
    await wait(300);
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 404, configurable: true });
    dispatchTrusted(win.document.body, e);
    for (let i = 0; i < 20; i++) pump();
    const section = Array.from(win.document.querySelectorAll('#ytaf-page-ui-tweaks .ytaf-settings-section'))
      .find((s) => s.querySelector('.section-title')?.textContent === 'Hide Left Menu Entries');
    const music = section && Array.from(section.querySelectorAll('label')).find((l) => l.textContent === 'Music');
    t('[sidebar] with a broken stored value the section is still built', !!music);
    if (music) {
      const input = music.querySelector('input');
      input.checked = true;
      input.dispatchEvent(new win.Event('change'));
    }
    const out = win.JSON.parse(NS(sideGuide()));
    t('[sidebar] and ticking a switch still hides the entry',
      JSON.stringify(sideTitles(out)[2]) === JSON.stringify(['Gaming']), JSON.stringify(sideTitles(out)));
    win.close();
  }
  {
    // Everything else on the JSON.parse hook off: the hook stays for the menu
    // while an entry is hidden or none is learnt yet.
    const bare = { enableAdBlock: false, loadRowsAhead: false, enableAutoLogin: false };
    const a = boot(Object.assign({ hiddenSidebarEntries: ['FEtopics_music'] }, bare), '',
      { 'ytaf-sidebar-entries': LEARNT });
    await wait(300);
    const out = a.win.JSON.parse(a.NS(sideGuide()));
    t('[sidebar] a hidden entry keeps the hook in with nothing else on',
      JSON.stringify(sideTitles(out)[2]) === JSON.stringify(['Gaming']), JSON.stringify(sideTitles(out)));
    a.win.close();
    const b = boot(bare);
    await wait(300);
    b.win.JSON.parse(b.NS(sideGuide()));
    t('[sidebar] and so does an empty list to learn',
      b.win.localStorage.getItem('ytaf-sidebar-entries') === LEARNT);
    b.win.close();
  }
  {
    const { win, pump } = boot({}, '');
    await wait(300);
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 404, configurable: true });
    dispatchTrusted(win.document.body, e);
    for (let i = 0; i < 20; i++) pump();
    const section = Array.from(win.document.querySelectorAll('#ytaf-page-ui-tweaks .ytaf-settings-section'))
      .find((s) => s.querySelector('.section-title')?.textContent === 'Hide Left Menu Entries');
    t('[sidebar] before the menu has loaded, the section says so',
      !!section && /None yet/.test(section.textContent) && !section.querySelector('label'));
    win.JSON.parse(win.JSON.stringify(sideGuide()));
    const rows = section ? section.querySelectorAll('label').length : 0;
    t('[sidebar] and lists the entries once it has', rows === 4, String(rows));
    win.close();
  }

  // ---------- 3. Page 1 sizing ----------
  {
    const { win, pump } = boot({});
    await wait(300);
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 404, configurable: true });
    dispatchTrusted(win.document.body, e);
    for (let i = 0; i < 20; i++) pump();
    const filters = win.document.querySelector('#ytaf-page-filters');
    const ui = win.document.querySelector('#ytaf-page-interface');
    t('[panel] Remove Live Videos row present',
      !!filters && /Remove Live Videos/.test(filters.textContent), filters && filters.textContent.slice(0, 80));
    t('[panel] Remove AI Videos and Mark AI Videos rows present',
      !!filters && /Remove AI Videos/.test(filters.textContent) && /Mark AI Videos/.test(filters.textContent));
    t('[panel] YouTube Logo is now a selector, not a checkbox',
      !!ui && /YouTube Logo/.test(ui.textContent) &&
      !/Hide YouTube Logo/.test(ui.textContent));
    const css = Array.from(win.document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    t('[panel] sectioned-page density rules shipped', /\.ytaf-page-sectioned label/.test(css));
    t('[panel] settings page can scroll rather than clip', /overflow-y:\s*auto/.test(css));
  }

  {
    const h = boot({ enableAdBlock: false, removeAiVideos: true, markAiVideos: false });
    await wait(300);
    const e = new h.win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 404, configurable: true });
    dispatchTrusted(h.win.document.body, e);
    for (let i = 0; i < 20; i++) h.pump();
    const remove = h.win.document.querySelector('#ytaf-remove-ai');
    const mark = h.win.document.querySelector('#ytaf-mark-ai');
    t('[panel] Remove AI Videos disabled when Ad Blocking is off', !!remove && remove.disabled);
    t('[panel] Mark AI Videos remains available without Ad Blocking', !!mark && !mark.disabled);
    h.win.close();
  }
  {
    const h = boot({ enableAdBlock: true, removeAiVideos: false, markAiVideos: false });
    await wait(300);
    const e = new h.win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 404, configurable: true });
    dispatchTrusted(h.win.document.body, e);
    for (let i = 0; i < 20; i++) h.pump();
    const remove = h.win.document.querySelector('#ytaf-remove-ai');
    const mark = h.win.document.querySelector('#ytaf-mark-ai');
    mark.click();
    remove.click();
    await wait(300);
    t('[panel] selecting Remove clears and disables Mark', remove.checked && !mark.checked && mark.disabled);
    const saved = JSON.parse(h.win.localStorage.getItem('ytaf-configuration'));
    t('[panel] Remove choice persists and Mark is off', saved.removeAiVideos === true && saved.markAiVideos === false);
    h.win.close();
    const h2 = boot(saved);
    await wait(300);
    const e2 = new h2.win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e2, 'keyCode', { get: () => 404, configurable: true });
    dispatchTrusted(h2.win.document.body, e2);
    for (let i = 0; i < 20; i++) h2.pump();
    const remove2 = h2.win.document.querySelector('#ytaf-remove-ai');
    const mark2 = h2.win.document.querySelector('#ytaf-mark-ai');
    t('[panel] persisted Remove remains selected and Mark disabled', remove2.checked && !mark2.checked && mark2.disabled);
    h2.win.close();
  }

  {
    // Keep App Open When Paused: YouTube's exit after 20 minutes paused is
    // not started; other timers are. Off, YouTube's timer runs as before.
    const exit = function () { return 'Exiting app due to playback idleness, last state = 2'; };
    const off = boot({});
    t("Keep App Open When Paused off: YouTube's exit timer is started", off.win.setTimeout(exit, 1200000) !== 0);
    off.win.close();
    const h = boot({ keepAppOpenWhenPaused: true });
    let ran = 0;
    const idle = h.win.setTimeout(function () { h.win.console.info('Exiting app due to playback idleness, last state = 2'); ran++; }, 1200000);
    const other = h.win.setTimeout(function () { ran++; }, 1200000);
    const short = h.win.setTimeout(function () { ran++; }, 1);
    await wait(20);
    t('the paused-idle exit timer is not started', idle === 0, String(idle));
    t('other timers, 20 minutes long or not, are started', other !== 0 && short !== 0 && ran === 1, `other=${other} ran=${ran}`);
    h.win.clearTimeout(other);
    h.win.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
