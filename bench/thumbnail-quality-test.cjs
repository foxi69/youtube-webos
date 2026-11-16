/**
 * Max Thumbnail Quality (src/thumbnail-quality.js) against the built bundle,
 * case by case: the response shapes whose thumbnails it rewrites (and the
 * ones it leaves alone), the names it maps and the ones it does not (a Shorts
 * crop, a thumbnail test variant), the probes that verify an unproven rung
 * (HEAD, then the image when a HEAD cannot tell) and what each answer does to
 * the response and to the tiles on screen, the verification cache across
 * sessions, and the panel's switch and strategy.
 *
 * module-behaviour-test checks the three strategies on one tile and the probe
 * order; this test is for the rest. The network is faked: a HEAD answers what
 * `head(url)` says, an image loads as `image(url)` says.
 *
 * Usage: node bench/thumbnail-quality-test.cjs <bundle> [legacy|modern]
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');
const { createReporter, trustedKey, wait } = require('./harness.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const bundle = fs.readFileSync(bundlePath, 'utf8');

const GREEN = 404;
const pad = 'z'.repeat(600);
// The idle gate (PROBE_IDLE_DELAY, 1.2 s after the last response) with room.
const SETTLE_MS = 1700;

const { t, run } = createReporter();
// Every boot's jsdomErrors (a script error on the page), checked at the end.
const allErrors = [];

const big = { status: 200, length: 90000 };
const grey = { status: 200, length: 1000 };

/**
 * The bundle on Home with `cfg`. head(url): what a HEAD answers ({ status,
 * length } or { error } or { timeout }; length null for no readable size).
 * image(url): what loading it gives ({ width } or { error }). stored: the
 * verification cache already in storage ({ cache, cap }).
 */
function boot(cfg, { head = () => big, image = () => ({ width: 1280 }), stored, html = '' } = {}) {
  const errors = [];
  const heads = [];
  const images = [];
  // Both kinds of probe, in the order they started: 'head <url>' or 'image <url>'.
  const probes = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { errors.push(e.message); allErrors.push(e.message); });
  const dom = new JSDOM(`<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app>${html}</ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  // Chrome 23 has it; the Chrome 38 environment takes it away all the same.
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.launchParams = '{}';
  win.fetch = () => Promise.reject(new Error('offline'));
  win.XMLHttpRequest = class {
    open(method, url) { this._method = method; this._url = url; }
    send() {
      if (this._method !== 'HEAD') { if (this.onerror) setTimeout(() => this.onerror(), 0); return; }
      heads.push(this._url);
      probes.push('head ' + this._url);
      const answer = head(this._url);
      setTimeout(() => {
        if (answer.error) { if (this.onerror) this.onerror(); return; }
        if (answer.timeout) { if (this.ontimeout) this.ontimeout(); return; }
        this.status = answer.status;
        this._length = answer.length;
        if (this.onload) this.onload();
      }, answer.delay || 0);
    }
    setRequestHeader() {}
    getResponseHeader(name) {
      return name === 'Content-Length' && this._length != null ? String(this._length) : null;
    }
    addEventListener() {}
  };
  win.Image = class {
    set src(url) {
      images.push(url);
      probes.push('image ' + url);
      this._src = url;
      const answer = image(url);
      this.naturalWidth = answer.width || 0;
      this.naturalHeight = answer.width ? Math.round(answer.width * 0.75) : 0;
      setTimeout(() => (answer.error ? this.onerror && this.onerror() : this.onload && this.onload()), 0);
    }
    get src() { return this._src; }
  };
  let rafQ = [];
  win.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  win.cancelAnimationFrame = () => {};
  if (stored) {
    if (stored.cache !== undefined) win.localStorage.setItem('ytaf-thumb-quality', stored.cache);
    if (stored.cap !== undefined) win.localStorage.setItem('ytaf-thumb-quality-cap', stored.cap);
  }
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, enableAutoLogin: false, enableDeArrow: false,
    upgradeThumbnails: true, thumbnailQualityMode: 'eager'
  }, cfg)));
  win.eval(bundle);
  const NS = win.JSON.stringify;
  const parse = (obj) => win.JSON.parse(NS(obj));
  const pump = () => { const q = rafQ; rafQ = []; for (const cb of q) cb(Date.now()); };
  /** Opens the panel once (the Interface page has the switch and the strategy). */
  const panel = () => {
    if (win.document.querySelector('.ytaf-ui-container')) return;
    trustedKey(win, GREEN);
    for (let i = 0; i < 20; i++) pump();
  };
  const toggle = (label, on) => {
    panel();
    const input = Array.from(win.document.querySelectorAll('.ytaf-ui-container label'))
      .find((l) => l.querySelector('.label-text')?.textContent === label)?.querySelector('input');
    if (!input) throw new Error(label + ' switch missing');
    input.checked = on;
    input.dispatchEvent(new win.Event('change'));
  };
  /** Steps the Thumbnail Strategy row to `mode` ('safe', 'eager', 'sd'). */
  const strategy = (mode) => {
    panel();
    const names = { safe: 'Original', eager: 'Fast', sd: 'Smooth (SD)' };
    const row = Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
      .find((r) => /Thumbnail Strategy/.test(r.textContent));
    if (!row) throw new Error('Thumbnail Strategy row missing');
    for (let i = 0; i < 3 && row.querySelector('.current-value').textContent !== names[mode]; i++) row.click();
  };
  return { win, errors, heads, images, probes, parse, pump, toggle, strategy };
}

const url = (id, name = 'hqdefault') => `https://i.ytimg.com/vi/${id}/${name}.jpg`;
const thumbs = (id, name) => ({ thumbnails: [{ url: url(id, name), width: 480, height: 360 }] });
const tile = (id, name) => ({ tileRenderer: { contentId: id, header: { tileHeaderRenderer: { thumbnail: thumbs(id, name) } } } });
const tileUrl = (item) => item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url;
const home = (sections) => ({ responseContext: { _pad: pad },
  contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: { contents: sections } } } } } } });
const shelf = (items) => ({ shelfRenderer: { content: { horizontalListRenderer: { items } } } });
const homeItems = (r) => r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents[0]
  .shelfRenderer.content.horizontalListRenderer.items;
const MAX = (id) => url(id, 'maxresdefault');
const HQ = (id) => url(id, 'hqdefault');

run(async () => {
  // ---- Where the thumbnails are, response by response ----
  {
    const { parse, errors } = boot({});
    const r = parse(home([
      shelf([tile('shelfhoriz1')]),
      { shelfRenderer: { content: { gridRenderer: { items: [tile('shelfgrid01')] } } } },
      { shelfRenderer: { content: { expandedShelfContentsRenderer: { items: [tile('shelfexpand')] } } } },
      { gridRenderer: { items: [tile('sectiongrid')] } },
      { horizontalListRenderer: { items: [tile('sectionhorz')] } },
      null
    ]));
    const s = r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents;
    const got = [
      tileUrl(s[0].shelfRenderer.content.horizontalListRenderer.items[0]),
      tileUrl(s[1].shelfRenderer.content.gridRenderer.items[0]),
      tileUrl(s[2].shelfRenderer.content.expandedShelfContentsRenderer.items[0]),
      tileUrl(s[3].gridRenderer.items[0]),
      tileUrl(s[4].horizontalListRenderer.items[0])
    ];
    const want = ['shelfhoriz1', 'shelfgrid01', 'shelfexpand', 'sectiongrid', 'sectionhorz'].map(MAX);
    t('Home: shelves (row, grid, expanded) and bare grids and rows', got.join() === want.join(), got.join(' '));

    // Every kind of item it knows.
    const lockup = { lockupViewModel: { contentImage: { thumbnailViewModel: { image: { sources: [{ url: HQ('lockupvm001') }] } } } } };
    const items = [
      { playlistPanelVideoWrapperRenderer: { primaryRenderer: tile('playlistrow') } },
      { tileRenderer: { header: { tileHeaderRenderer: { thumbnailViewModel: { image: { sources: [{ url: HQ('tileviewmod') }] } } } } } },
      { tileRenderer: { header: { tileHeaderRenderer: { thumbnail: thumbs('longpress01') } },
        onLongPressCommand: { showMenuCommand: { thumbnail: thumbs('longpress01') } } } },
      { previewButtonRenderer: { thumbnail: thumbs('previewbtn1') } },
      { pivotVideoRenderer: { thumbnail: thumbs('pivotvideo1') } },
      lockup,
      { gridVideoRenderer: { thumbnail: thumbs('gridvideo01') } },
      { compactVideoRenderer: { thumbnail: thumbs('compactvid1') } },
      { videoRenderer: { thumbnail: thumbs('videorender') } },
      'not an item'
    ];
    const kinds = homeItems(parse(home([shelf(items)])));
    const read = [
      tileUrl(kinds[0].playlistPanelVideoWrapperRenderer.primaryRenderer),
      kinds[1].tileRenderer.header.tileHeaderRenderer.thumbnailViewModel.image.sources[0].url,
      kinds[2].tileRenderer.onLongPressCommand.showMenuCommand.thumbnail.thumbnails[0].url,
      kinds[3].previewButtonRenderer.thumbnail.thumbnails[0].url,
      kinds[4].pivotVideoRenderer.thumbnail.thumbnails[0].url,
      kinds[5].lockupViewModel.contentImage.thumbnailViewModel.image.sources[0].url,
      kinds[6].gridVideoRenderer.thumbnail.thumbnails[0].url,
      kinds[7].compactVideoRenderer.thumbnail.thumbnails[0].url,
      kinds[8].videoRenderer.thumbnail.thumbnails[0].url
    ];
    const ids = ['playlistrow', 'tileviewmod', 'longpress01', 'previewbtn1', 'pivotvideo1', 'lockupvm001', 'gridvideo01',
      'compactvid1', 'videorender'];
    t('every item kind: a playlist row, a view model tile, the long-press menu\'s copy, a preview button, a pivot, ' +
      'a lockup and the legacy renderers', read.join() === ids.map(MAX).join(), read.join(' '));

    // Browse tabs (a channel, the library).
    const tabs = parse({ responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: { tvSecondaryNavRenderer: { sections: [
      { tvSecondaryNavSectionRenderer: { tabs: [
        { tabRenderer: { content: { sectionListRenderer: { contents: [shelf([tile('tabsection1')])] } } } },
        { tabRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: { contents: [shelf([tile('tabsurface1')])] } } } } } },
        { tabRenderer: {} }
      ] } },
      {}
    ] } } } } });
    const tabList = tabs.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections[0].tvSecondaryNavSectionRenderer.tabs;
    t('browse tabs: both kinds of tab content',
      tileUrl(tabList[0].tabRenderer.content.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items[0]) === MAX('tabsection1') &&
      tileUrl(tabList[1].tabRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents[0]
        .shelfRenderer.content.horizontalListRenderer.items[0]) === MAX('tabsurface1'));

    // Search: shelves with bare items among them.
    const search = parse({ responseContext: { _pad: pad }, contents: { sectionListRenderer: { contents: [
      shelf([tile('searchshelf')]), tile('searchbare1')] } } });
    const sc = search.contents.sectionListRenderer.contents;
    t('search: a shelf and a bare item among the shelves',
      tileUrl(sc[0].shelfRenderer.content.horizontalListRenderer.items[0]) === MAX('searchshelf') && tileUrl(sc[1]) === MAX('searchbare1'));

    // Continuations, in all four shapes, and the two action lists.
    const cont = (contents) => parse({ responseContext: { _pad: pad }, continuationContents: contents });
    const c1 = cont({ sectionListContinuation: { contents: [shelf([tile('contsection')])] } });
    const c2 = cont({ tvSurfaceContentContinuation: { content: { sectionListRenderer: { contents: [shelf([tile('contsurface')])] } } } });
    const c3 = cont({ gridContinuation: { items: [tile('contgrid001')] } });
    const c4 = cont({ horizontalListContinuation: { items: [tile('conthoriz01')] } });
    t('continuations: section list, surface, grid and row',
      tileUrl(c1.continuationContents.sectionListContinuation.contents[0].shelfRenderer.content.horizontalListRenderer.items[0]) === MAX('contsection') &&
      tileUrl(c2.continuationContents.tvSurfaceContentContinuation.content.sectionListRenderer.contents[0]
        .shelfRenderer.content.horizontalListRenderer.items[0]) === MAX('contsurface') &&
      tileUrl(c3.continuationContents.gridContinuation.items[0]) === MAX('contgrid001') &&
      tileUrl(c4.continuationContents.horizontalListContinuation.items[0]) === MAX('conthoriz01'));
    const chat = cont({ liveChatContinuation: { actions: [{ item: { thumbnail: thumbs('livechat001') } }] } });
    t('a live chat poll is not searched for thumbnails',
      chat.continuationContents.liveChatContinuation.actions[0].item.thumbnail.thumbnails[0].url === HQ('livechat001'));
    const actions = parse({ responseContext: { _pad: pad },
      onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [tile('appendaction')] } }, null],
      onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [tile('reloadcomand')] } }] });
    t('actions: append and reload items, both lists',
      tileUrl(actions.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems[0]) === MAX('appendaction') &&
      tileUrl(actions.onResponseReceivedEndpoints[0].reloadContinuationItemsCommand.continuationItems[0]) === MAX('reloadcomand'));

    // Shorts: the sequence's entries; their portrait crop is left as sent.
    const shorts = parse({ responseContext: { _pad: pad }, entries: [tile('shortsentry'), tile('shortscrop1', 'oar2')] });
    t('Shorts: a sequence entry is upgraded, its oar2 crop left as sent',
      tileUrl(shorts.entries[0]) === MAX('shortsentry') && tileUrl(shorts.entries[1]) === url('shortscrop1', 'oar2'),
      tileUrl(shorts.entries[1]));

    // The watch page: what plays next and the player itself.
    const autoplayItem = (id) => ({ nextVideoRenderer: { autoplayVideoWrapperRenderer: { primaryEndpointRenderer: {
      autoplayEndpointRenderer: { item: tile(id) } } } } });
    const next = parse({ responseContext: { _pad: pad }, contents: { singleColumnWatchNextResults: {
      pivot: { sectionListRenderer: { contents: [shelf([tile('pivotshelf1')])] } },
      autoplay: { autoplay: { sets: [autoplayItem('autoplayset'), {}], modifiedSets: [autoplayItem('modifiedset')],
        replayVideoRenderer: { pivotVideoRenderer: { thumbnail: thumbs('replayvideo') } } } } } },
      playerOverlays: { playerOverlayRenderer: { replay: { playerOverlayReplayRenderer: { background: thumbs('replaybackg') } } } },
      currentVideoThumbnail: thumbs('currentthmb') });
    const ap = next.contents.singleColumnWatchNextResults.autoplay.autoplay;
    const apUrl = (set) => tileUrl(set.nextVideoRenderer.autoplayVideoWrapperRenderer.primaryEndpointRenderer.autoplayEndpointRenderer.item);
    t('watch page: the pivot, autoplay (sets, modified sets, replay), the replay background and the current video',
      tileUrl(next.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents[0]
        .shelfRenderer.content.horizontalListRenderer.items[0]) === MAX('pivotshelf1') &&
      apUrl(ap.sets[0]) === MAX('autoplayset') && apUrl(ap.modifiedSets[0]) === MAX('modifiedset') &&
      ap.replayVideoRenderer.pivotVideoRenderer.thumbnail.thumbnails[0].url === MAX('replayvideo') &&
      next.playerOverlays.playerOverlayRenderer.replay.playerOverlayReplayRenderer.background.thumbnails[0].url === MAX('replaybackg') &&
      next.currentVideoThumbnail.thumbnails[0].url === MAX('currentthmb'));
    const player = parse({ responseContext: { _pad: pad }, streamingData: {}, videoDetails: { thumbnail: thumbs('playervideo') },
      microformat: { playerMicroformatRenderer: { thumbnail: thumbs('microformat') } } });
    t('player response: the video details and the microformat',
      player.videoDetails.thumbnail.thumbnails[0].url === MAX('playervideo') &&
      player.microformat.playerMicroformatRenderer.thumbnail.thumbnails[0].url === MAX('microformat'));

    // A shape it does not know: the bounded walk finds the thumbnails.
    const unknown = parse({ responseContext: { _pad: pad }, somethingNew: { deep: { list: [{ thumbnail: thumbs('unknownshp') }] } } });
    t('an unknown shape: the fallback walk rewrites what it finds',
      unknown.somethingNew.deep.list[0].thumbnail.thumbnails[0].url === MAX('unknownshp'));
    // A known type whose content moved: the walk too.
    const moved = parse({ responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: {
      newPlace: { items: [{ thumbnail: thumbs('movedshape1') }] } } } } } });
    t('a known type whose content moved: the fallback walk too',
      moved.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.newPlace.items[0].thumbnail.thumbnails[0].url === MAX('movedshape1'));
    t('no jsdomError (shapes)', errors.length === 0, errors[0]);
  }

  // ---- The names it maps, and the ones it does not ----
  {
    const { parse } = boot({ thumbnailQualityMode: 'safe' });
    const items = homeItems(parse(home([shelf([
      tile('oarcropvid1', 'oar2'),
      tile('frameonly01', 'hq1'),
      tile('testvarnt01', 'hqdefault_custom_1'),
      // The watch page ships hq720: proof it exists, no probe needed for it.
      { tileRenderer: { header: { tileHeaderRenderer: { thumbnail: { thumbnails: [
        { url: HQ('shipped7201') }, { url: url('shipped7201', 'hq720') }] } } } } },
      tile('alreadymax1', 'maxresdefault'),
      { tileRenderer: { header: { tileHeaderRenderer: { thumbnail: { thumbnails: [{ url: 'https://example.com/a.jpg' }, null, { url: 5 }] } } } } }
    ])])));
    t('a Shorts crop (oar2) and a frame (hq1) are left as sent',
      tileUrl(items[0]) === url('oarcropvid1', 'oar2') && tileUrl(items[1]) === url('frameonly01', 'hq1'));
    t('a thumbnail test variant becomes the video\'s own rung', tileUrl(items[2]) === HQ('testvarnt01'), tileUrl(items[2]));
    const shipped = items[3].tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails.map((x) => x.url);
    t('Original strategy: a rung the response ships (hq720) is used without proof',
      shipped.every((u) => u === url('shipped7201', 'hq720')), shipped.join());
    t('never worse than YouTube sent: maxresdefault stays', tileUrl(items[4]) === MAX('alreadymax1'));
    t('other addresses are left alone',
      items[5].tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url === 'https://example.com/a.jpg');
  }

  // ---- What a probe answers ----
  {
    // eager: a grey placeholder (a tiny body) is a miss, corrected in the response it was drawn into.
    const { parse, heads, win } = boot({}, { head: (u) => (u.includes('nomaxres001') ? grey : big) });
    const r = parse(home([shelf([tile('nomaxres001'), tile('hasmaxres01')])]));
    t('Fast: maxresdefault is drawn at once', tileUrl(homeItems(r)[0]) === MAX('nomaxres001'));
    await wait(SETTLE_MS);
    t('Fast: both are verified by a HEAD', heads.includes(MAX('nomaxres001')) && heads.includes(MAX('hasmaxres01')), heads.join(' '));
    t('a miss (a grey placeholder) is corrected to hqdefault in the response', tileUrl(homeItems(r)[0]) === HQ('nomaxres001'),
      tileUrl(homeItems(r)[0]));
    t('a hit stays', tileUrl(homeItems(r)[1]) === MAX('hasmaxres01'));
    const again = parse(home([shelf([tile('nomaxres001'), tile('hasmaxres01')])]));
    const asked = heads.length;
    await wait(SETTLE_MS);
    t('known since: drawn at its rung, not probed again',
      tileUrl(homeItems(again)[0]) === HQ('nomaxres001') && tileUrl(homeItems(again)[1]) === MAX('hasmaxres01') && heads.length === asked,
      `${tileUrl(homeItems(again)[0])} ${heads.length - asked} more`);
    // Backgrounded: the answers are saved at once (webOS gives no pagehide).
    Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => true });
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    const saved = win.localStorage.getItem('ytaf-thumb-quality') || '';
    t('backgrounded: the answers are saved', saved.split(',').sort().join() === 'hasmaxres01:5,nomaxres001:2', saved);
    t('with the ladder they were measured against', win.localStorage.getItem('ytaf-thumb-quality-cap') === '5r2',
      win.localStorage.getItem('ytaf-thumb-quality-cap'));
  }
  {
    // A 404, an error, a timeout, a HEAD that cannot tell (no size): the image is asked then.
    const answers = {
      notfound001: { status: 404 },
      noheadsize1: { status: 200, length: null },
      headerror01: { error: true },
      headtimeout: { timeout: true }
    };
    const imageAnswers = { noheadsize1: { width: 120 }, headerror01: { error: true } };
    const idOf = (u) => /\/vi\/([\w-]{11})\//.exec(u)[1];
    const { parse, images } = boot({}, {
      head: (u) => answers[idOf(u)] || big,
      image: (u) => imageAnswers[idOf(u)] || { width: 1280 }
    });
    const r = parse(home([shelf(Object.keys(answers).map((id) => tile(id)))]));
    await wait(SETTLE_MS);
    const got = homeItems(r).map(tileUrl);
    t('a 404 is a miss', got[0] === HQ('notfound001'), got[0]);
    t('no readable size: the image is loaded, and its 120 px placeholder is a miss',
      images.includes(MAX('noheadsize1')) && got[1] === HQ('noheadsize1'), got[1]);
    t('a request error and an image that fails too: nothing learned, Fast keeps maxresdefault',
      images.includes(MAX('headerror01')) && got[2] === MAX('headerror01'), got[2]);
    t('a timeout: nothing learned, Fast keeps maxresdefault', got[3] === MAX('headtimeout'), got[3]);
  }
  {
    // Original: an unproven rung waits for its probe; a probe that learned nothing holds the floor.
    const { parse, heads } = boot({ thumbnailQualityMode: 'safe' }, { head: (u) => (u.includes('timeoutsafe') ? { timeout: true } : big) });
    const first = parse(home([shelf([tile('provensafe1'), tile('timeoutsafe')])]));
    t('Original: hqdefault until it is proven', homeItems(first).map(tileUrl).join() === [HQ('provensafe1'), HQ('timeoutsafe')].join());
    await wait(SETTLE_MS);
    const second = parse(home([shelf([tile('provensafe1'), tile('timeoutsafe')])]));
    t('Original: proven, the next response gets maxresdefault', tileUrl(homeItems(second)[0]) === MAX('provensafe1'),
      tileUrl(homeItems(second)[0]));
    t('Original: nothing learned, it stays at hqdefault', tileUrl(homeItems(second)[1]) === HQ('timeoutsafe'),
      tileUrl(homeItems(second)[1]));
    // A probe the second response queued would run in the next window.
    await wait(SETTLE_MS);
    t('...and is not asked again this session', heads.filter((u) => u.includes('timeoutsafe')).length === 1, heads.join(' '));
  }
  {
    // Smooth (SD): the ladder stops at sddefault.
    const { parse, heads } = boot({ thumbnailQualityMode: 'sd' });
    const r = parse(home([shelf([tile('smoothsd001')])]));
    await wait(SETTLE_MS);
    t('Smooth (SD): sddefault, and it is what the probe asks for',
      tileUrl(homeItems(r)[0]) === url('smoothsd001', 'sddefault') && heads.includes(url('smoothsd001', 'sddefault')), heads.join(' '));
  }

  // ---- The tiles already on screen ----
  {
    // Drawn at maxresdefault before the answer; the answer is a miss.
    const shown = (id, name) => `<ytlr-thumbnail-details data-id="${id}-${name}" style="background-image: url(&quot;${url(id, name)}&quot;)"></ytlr-thumbnail-details>`;
    const html = shown('missingmax1', 'maxresdefault') + shown('missingmax1', 'oar2') + shown('missingmax1', 'hq1');
    const { win, parse } = boot({}, { html, head: () => grey });
    parse(home([shelf([tile('missingmax1')])]));
    await wait(SETTLE_MS + 300);
    const bg = (name) => win.document.querySelector(`[data-id="missingmax1-${name}"]`).style.backgroundImage;
    t('a tile on screen gets the rung the video has, layered over what it shows',
      bg('maxresdefault').indexOf(`url("${HQ('missingmax1')}"), `) === 0, bg('maxresdefault'));
    t('a Shorts tile of the same video keeps its portrait crop', bg('oar2') === `url("${url('missingmax1', 'oar2')}")`, bg('oar2'));
    t('a frame (hq1, as DeArrow shows) is left alone too', bg('hq1') === `url("${url('missingmax1', 'hq1')}")`, bg('hq1'));
  }
  {
    // The remote's arrow keys: no probe while the rows move.
    const { win, parse, heads } = boot({});
    parse(home([shelf([tile('navpaused01')])]));
    const arrow = () => {
      trustedKey(win, 40);
    };
    for (let i = 0; i < 8; i++) { arrow(); await wait(200); }
    t('while the arrow keys are pressed, no probe', heads.length === 0, heads.join(' '));
    await wait(SETTLE_MS);
    t('once the remote is quiet, the probe', heads.includes(MAX('navpaused01')), heads.join(' '));
  }

  {
    // The arrow keys also hold a correction for a tile on screen until the rows stop.
    const html = `<ytlr-thumbnail-details style="background-image: url(&quot;${MAX('heldpromote')}&quot;)"></ytlr-thumbnail-details>`;
    const { win, parse } = boot({}, { html, head: () => ({ status: 200, length: 1000, delay: 300 }) });
    parse(home([shelf([tile('heldpromote')])]));
    const el = win.document.querySelector('ytlr-thumbnail-details');
    // The probe is out at once (the top of a new response); its answer comes in 300 ms.
    await wait(100);
    const arrow = () => {
      trustedKey(win, 39);
    };
    for (let i = 0; i < 6; i++) { arrow(); await wait(150); }
    t('while the rows move, a correction for a tile on screen waits', el.style.backgroundImage === `url("${MAX('heldpromote')}")`,
      el.style.backgroundImage);
    await wait(800);
    t('and lands once they stop', el.style.backgroundImage.indexOf(`url("${HQ('heldpromote')}")`) === 0, el.style.backgroundImage);
  }
  {
    // Many queued, a few of them on screen: those go first, by loading the
    // image (the browser has it already), the rest by a HEAD.
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push('queuedvid' + String(i).padStart(2, '0'));
    const html = [ids[8], ids[9]].map((id) =>
      `<ytlr-thumbnail-details style="background-image: url(&quot;${MAX(id)}&quot;)"></ytlr-thumbnail-details>`).join('');
    const { parse, heads, images, probes } = boot({}, { html });
    parse(home([shelf(ids.map((id) => tile(id)))]));
    await wait(100);
    t('the tiles on screen are probed first, by their image', images.includes(MAX(ids[8])) && images.includes(MAX(ids[9])) &&
      !heads.includes(MAX(ids[8])), `images ${images.join(' ')} heads ${heads.join(' ')}`);
    await wait(SETTLE_MS + 1500);
    t('the others by a HEAD once the surface is quiet', ids.slice(0, 8).every((id) => heads.includes(MAX(id))), heads.join(' '));
    // One history of both: the two on screen before any HEAD.
    const firstHead = probes.findIndex((p) => p.indexOf('head ') === 0);
    const onScreen = [ids[8], ids[9]].map((id) => probes.indexOf('image ' + MAX(id)));
    t('...both images before every HEAD', firstHead !== -1 && onScreen.every((i) => i !== -1 && i < firstHead), probes.join(' | '));
  }
  {
    // A HEAD that cannot even be opened: nothing learned.
    const { win, parse } = boot({});
    win.XMLHttpRequest = class { open() { throw new Error('blocked'); } };
    const r = parse(home([shelf([tile('headblocked')])]));
    await wait(SETTLE_MS);
    win.XMLHttpRequest = class { open() {} send() { throw new Error('offline'); } };
    const r2 = parse(home([shelf([tile('sendblocked')])]));
    await wait(SETTLE_MS);
    t('a HEAD that cannot be opened or sent: Fast keeps maxresdefault',
      tileUrl(homeItems(r)[0]) === MAX('headblocked') && tileUrl(homeItems(r2)[0]) === MAX('sendblocked'));
  }
  {
    // Backgrounded while probes wait, then back: they go on.
    let hidden = false;
    const { win, parse, heads } = boot({});
    Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => hidden });
    hidden = true;
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    parse(home([shelf([tile('backgrnd001')])]));
    await wait(SETTLE_MS);
    t('in the background, no probe', heads.length === 0, heads.join(' '));
    hidden = false;
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    await wait(SETTLE_MS);
    t('back in front, the probe', heads.includes(MAX('backgrnd001')), heads.join(' '));
  }
  {
    // The strategy changes while a probe is out: its answer was for the old ladder.
    const { parse, strategy, heads } = boot({}, { head: () => ({ status: 200, length: 1000, delay: 400 }) });
    parse(home([shelf([tile('inflight001')])]));
    await wait(100);
    t('a probe is out', heads.includes(MAX('inflight001')), heads.join(' '));
    strategy('sd');
    await wait(500);
    const r = parse(home([shelf([tile('inflight001')])]));
    t('its answer, for the old ladder, is not used on the new one', tileUrl(homeItems(r)[0]) === url('inflight001', 'sddefault'),
      tileUrl(homeItems(r)[0]));
  }

  // ---- The cache across sessions ----
  {
    const { parse, heads } = boot({}, { stored: { cache: 'cachedhq001:2,cachedmax01:5,bad,:3', cap: '5r2' } });
    const r = parse(home([shelf([tile('cachedhq001'), tile('cachedmax01')])]));
    await wait(SETTLE_MS);
    t('a stored answer is used: a known miss is drawn at hqdefault', tileUrl(homeItems(r)[0]) === HQ('cachedhq001'),
      tileUrl(homeItems(r)[0]));
    t('known videos are not probed again', heads.length === 0, heads.join(' '));
  }
  {
    // Stored by an older revision (it saved timeouts as misses): dropped once.
    const { win, parse, heads } = boot({}, { stored: { cache: 'oldrevision:2', cap: '5r1' } });
    const r = parse(home([shelf([tile('oldrevision')])]));
    await wait(SETTLE_MS);
    t('a cache of an older revision is dropped', tileUrl(homeItems(r)[0]) === MAX('oldrevision') && heads.includes(MAX('oldrevision')) &&
      win.localStorage.getItem('ytaf-thumb-quality-cap') === '5r2', `${tileUrl(homeItems(r)[0])}, ${heads.join(' ')}`);
  }

  // ---- The panel ----
  {
    const { parse, toggle, strategy, heads, win } = boot({}, { head: () => grey });
    parse(home([shelf([tile('strategy001')])]));
    await wait(SETTLE_MS);
    t('Fast: the miss is known', tileUrl(homeItems(parse(home([shelf([tile('strategy001')])])))[0]) === HQ('strategy001'));
    // Smooth (SD) measures another rung: what Fast learned is dropped.
    strategy('sd');
    const sd = parse(home([shelf([tile('strategy001')])]));
    t('switched to Smooth (SD): the answers of the other ladder are dropped, sddefault drawn',
      tileUrl(homeItems(sd)[0]) === url('strategy001', 'sddefault'), tileUrl(homeItems(sd)[0]));
    t('and its stored cache with them', !win.localStorage.getItem('ytaf-thumb-quality') &&
      win.localStorage.getItem('ytaf-thumb-quality-cap') === '3r2', win.localStorage.getItem('ytaf-thumb-quality-cap'));
    await wait(SETTLE_MS);
    t('the video is probed again on the new ladder', heads.includes(url('strategy001', 'sddefault')), heads.join(' '));
    // Fast and Original measure the same rung: nothing is dropped between them.
    strategy('eager');
    strategy('safe');
    // Switched off with probes still waiting for the surface to settle.
    parse(home([shelf([tile('waitingoff1')])]));
    toggle('Max Thumbnail Quality', false);
    const off = parse(home([shelf([tile('switchedoff')])]));
    await wait(SETTLE_MS);
    t('switched off: responses are left as sent and nothing is probed',
      tileUrl(homeItems(off)[0]) === HQ('switchedoff') && !heads.some((u) => u.includes('switchedoff') || u.includes('waitingoff1')),
      heads.join(' '));
    toggle('Max Thumbnail Quality', true);
    const on = parse(home([shelf([tile('switchedon1')])]));
    await wait(SETTLE_MS);
    t('switched on again (Original): a new video is probed', tileUrl(homeItems(on)[0]) === HQ('switchedon1') &&
      heads.includes(MAX('switchedon1')), heads.join(' '));
  }

  t('no jsdomError in any case', allErrors.length === 0, allErrors[0]);
});
