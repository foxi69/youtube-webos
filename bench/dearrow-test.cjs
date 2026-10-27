/**
 * DeArrow (src/dearrow) against the built bundle: a response goes through the
 * JSON.parse hook, branding comes from a stubbed API, and the tiles end up
 * with the right title and thumbnail, in the stored response and on screen.
 * The lookups name only a hash prefix (one request per prefix), except the
 * random frame's time of a video nobody submitted anything for; crowdsourced
 * titles and thumbnails when trusted (a downvoted title is not); the
 * thumbnail drawn as a 16:9 copy; the random frame with the start frame
 * standing in; the Original and Blank fallbacks; lockups as well as tiles;
 * the badge; a known video rewritten inside the parse; a big answer that does
 * not evict the asked video; DeArrow switched off putting back what it
 * replaced; the old thumbnail switch carried over; the panel section; and
 * title formatting in the webOS 22+ build only.
 *
 * Usage: node bench/dearrow-test.cjs [bundle] [legacy|modern]
 */
const fs = require('fs');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const modern = process.argv[3] === 'modern';
const GREEN = 404;
const pad = 'z'.repeat(600);
const prefixOf = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 4);

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Resolves once `fn()` holds, or after `ms` with whatever it says then. */
function waitFor(fn, ms) {
  const end = Date.now() + ms;
  const poll = () => (fn() || Date.now() >= end ? Promise.resolve(fn()) : wait(10).then(poll));
  return poll();
}

// What the branding server knows, by video id: the prefix answer holds the
// videos with a submission; the by-id answer is a 404 with the random time
// for the others.
const BRANDING = {
  // A crowdsourced title (with a ">" marker) and thumbnail.
  custom00001: {
    titles: [{ title: 'the >iPhone review', original: false, votes: 2, locked: false }],
    thumbnails: [{ timestamp: 12.5, original: false, votes: 1, locked: false }],
    randomTime: 0.3, videoDuration: 100
  },
  // A downvoted title and no thumbnail: the original title, the fallback thumbnail.
  downvoted01: {
    titles: [{ title: 'Bad', original: false, votes: -1, locked: false }],
    thumbnails: [], randomTime: 0.5, videoDuration: 200
  },
  // The community kept the original title.
  keepsorig01: {
    titles: [{ title: 'Original wins', original: true, votes: 5, locked: false }, { title: 'Worse', original: false, votes: 0 }],
    thumbnails: [], randomTime: 0.1, videoDuration: 50
  }
};
// Nobody submitted anything: not in any prefix answer.
const NOSUBMIT = { nosubmit001: { randomTime: 0.25, videoDuration: 120 } };

function boot(cfg, opts = {}) {
  const errors = [];
  const fetched = [];
  const images = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  let rafQ = [];
  win.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  win.cancelAnimationFrame = () => {};
  const NS = win.JSON.stringify;
  win.localStorage.setItem('ytaf-configuration', NS(Object.assign({
    enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false,
    enableDeArrow: true, dearrowTitleFormatting: 'disable', dearrowThumbnailFallback: 'original'
  }, cfg)));
  if (!modern) applyChrome38Downgrade(win);
  win.fetch = (url) => {
    url = String(url);
    fetched.push(url);
    const byId = /[?&]videoID=([\w-]{11})/.exec(url);
    if (byId) {
      const body = BRANDING[byId[1]] || NOSUBMIT[byId[1]] || { titles: [], thumbnails: [], randomTime: 0.5, videoDuration: 60 };
      const none = !BRANDING[byId[1]];
      return Promise.resolve({ ok: !none, status: none ? 404 : 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(body))) });
    }
    const prefix = url.split('/').pop();
    const answer = {};
    const all = Object.assign({}, BRANDING, opts.extra || {});
    for (const id of Object.keys(all)) if (prefixOf(id) === prefix) answer[id] = all[id];
    const any = Object.keys(answer).length > 0;
    return Promise.resolve(any
      ? { ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(answer))) }
      : { ok: false, status: 404, json: () => Promise.reject(new Error('not json')) });
  };
  // Images: submitted frames and YouTube's load; random frames still rendering do not (204).
  win.Image = class {
    set src(url) {
      images.push(url);
      this._src = url;
      const ytimg = url.indexOf('i.ytimg.com') !== -1;
      const ok = ytimg || url.indexOf('time=12.5') !== -1 || (opts.randomReady && url.indexOf('time=') !== -1);
      this.naturalWidth = ytimg ? 480 : 1280;
      this.naturalHeight = ytimg ? 360 : 720;
      setTimeout(() => (ok ? this.onload && this.onload() : this.onerror && this.onerror()), 0);
    }
    get src() { return this._src; }
  };
  win.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    return { drawImage: (img) => { canvas._src = img._src; } };
  };
  if (modern) {
    win.HTMLCanvasElement.prototype.toBlob = function (done) {
      const src = this._src;
      setTimeout(() => done({ size: this.width * this.height, src }), 0);
    };
    win.URL.createObjectURL = (b) => 'blob:https://www.youtube.com/COPY#' + encodeURIComponent(b.src);
    win.URL.revokeObjectURL = () => {};
  } else {
    // No toBlob, as on webOS 3 and 4: the data URL path.
    win.HTMLCanvasElement.prototype.toBlob = undefined;
    win.HTMLCanvasElement.prototype.toDataURL = function () {
      return 'data:image/jpeg;base64,COPY' + encodeURIComponent(this._src);
    };
  }
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  const parse = (obj) => win.JSON.parse(NS(obj));
  const config = () => JSON.parse(win.localStorage.getItem('ytaf-configuration'));
  const pump = () => { const q = rafQ; rafQ = []; for (const cb of q) cb(Date.now()); };
  return { win, errors, fetched, images, parse, config, pump };
}

function tile(id, title, { badge } = {}) {
  const items = [{ lineItemRenderer: { text: { runs: [{ text: 'Channel' }] } } }];
  if (badge) items.push({ lineItemRenderer: { badge: { metadataBadgeRenderer: { label: '4K', style: 'BADGE_STYLE_TYPE_SIMPLE' } } } });
  return { tileRenderer: {
    contentId: id, contentType: 'TILE_CONTENT_TYPE_VIDEO',
    onSelectCommand: { watchEndpoint: { videoId: id } },
    header: { tileHeaderRenderer: {
      thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '10:00' } } }],
      thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' }] } } },
    metadata: { tileMetadataRenderer: { title: { simpleText: title }, lines: [{ lineRenderer: { items } }] } }
  } };
}

function lockup(id, title) {
  return { lockupViewModel: {
    contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: { image: { sources: [{ url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' }] } } },
    metadata: { lockupMetadataViewModel: { title: { content: title } } }
  } };
}

function browse(items) {
  return { responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: {
    sectionListRenderer: { contents: [{ shelfRenderer: { title: { runs: [{ text: 'Recommended' }] },
      content: { horizontalListRenderer: { items } } } }] } } } } } } };
}
const itemsOf = (r) => r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content
  .sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items;
const tileTitle = (item) => item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText;
const tileThumb = (item) => item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url;

/** Draws a tile the way the TV app does: the thumbnail as a background, the title as text. */
function render(win, item) {
  const tr = item.tileRenderer;
  const el = win.document.createElement('ytlr-tile-renderer');
  el.setAttribute('data-id', tr.contentId);
  el.innerHTML = '<ytlr-thumbnail-details></ytlr-thumbnail-details>' +
    '<ytlr-tile-metadata-renderer><div><yt-formatted-string></yt-formatted-string></div></ytlr-tile-metadata-renderer>';
  el.querySelector('ytlr-thumbnail-details').style.backgroundImage = `url("${tileThumb(item)}")`;
  el.querySelector('yt-formatted-string').textContent = tileTitle(item);
  win.document.querySelector('ytlr-app').appendChild(el);
  return el;
}
const shownTitle = (el) => el.querySelector('yt-formatted-string').textContent;
const shownThumb = (el) => decodeURIComponent(el.querySelector('ytlr-thumbnail-details').style.backgroundImage);

(async () => {
  // ---- Titles, by hash prefix ----
  {
    const { win, fetched, parse, errors } = boot({});
    const original = tile('custom00001', "You WON'T believe THIS phone");
    const el = render(win, original);
    const first = parse(browse([original, tile('downvoted01', 'Original title'), lockup('keepsorig01', 'Original wins')]));
    await waitFor(() => tileTitle(itemsOf(first)[0]) !== "You WON'T believe THIS phone", 2000);
    t('the lookups name hash prefixes only',
      fetched.length > 0 && fetched.every((u) => /^https:\/\/sponsor\.ajay\.app\/api\/branding\/[0-9a-f]{4}$/.test(u)), fetched.join(' '));
    t('one request per prefix', new Set(fetched).size === fetched.length, fetched.join(' '));
    const [custom, downvoted, kept] = itemsOf(first);
    t('the crowdsourced title, its ">" marker taken out', tileTitle(custom) === 'the iPhone review', tileTitle(custom));
    t('a downvoted title is not shown', tileTitle(downvoted) === 'Original title', tileTitle(downvoted));
    t('a title the community kept original stays (lockup)',
      kept.lockupViewModel.metadata.lockupMetadataViewModel.title.content === 'Original wins');
    t('with the Original fallback, the thumbnail of a video without a submitted one stays',
      tileThumb(downvoted) === 'https://i.ytimg.com/vi/downvoted01/hqdefault.jpg', tileThumb(downvoted));
    await waitFor(() => shownTitle(el) === 'the iPhone review', 1500);
    t('the tile on screen gets the title too', shownTitle(el) === 'the iPhone review', shownTitle(el));

    // A known video: rewritten inside the parse, no request.
    const asked = fetched.length;
    const again = parse(browse([lockup('custom00001', "You WON'T believe THIS phone")]));
    t('a known video is rewritten before YouTube sees it, without a request',
      itemsOf(again)[0].lockupViewModel.metadata.lockupMetadataViewModel.title.content === 'the iPhone review' && fetched.length === asked,
      fetched.length - asked);
    t('no jsdomError (titles)', errors.length === 0, errors[0]);
  }

  // ---- Thumbnails: the submitted frame, the badge ----
  {
    const { win, images, parse } = boot({ dearrowThumbnailFallback: 'original' });
    const item = tile('custom00001', 'Clickbait', { badge: true });
    const el = render(win, item);
    const r = parse(browse([item]));
    await waitFor(() => tileThumb(itemsOf(r)[0]).indexOf('COPY') !== -1, 2000);
    const thumb = tileThumb(itemsOf(r)[0]);
    t('the thumbnail is a copy of the submitted frame', thumb.indexOf('COPY') !== -1 &&
      decodeURIComponent(thumb).indexOf('dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=custom00001&time=12.5') !== -1, thumb);
    t('the submitted frame is asked for with officialTime', images.some((u) => u.indexOf('time=12.5&officialTime=true') !== -1), images.join(' '));
    const items = itemsOf(r)[0].tileRenderer.metadata.tileMetadataRenderer.lines[0].lineRenderer.items;
    t('the DeArrow badge joins the line after "4K"', items.length === 3 &&
      items[2].lineItemRenderer.badge.metadataBadgeRenderer.label === '◉', JSON.stringify(items));
    await waitFor(() => shownThumb(el).indexOf('COPY') !== -1, 1500);
    t('the tile on screen gets the thumbnail', shownThumb(el).indexOf('COPY') !== -1, shownThumb(el));
  }

  // ---- Off in the panel: YouTube's own back everywhere ----
  {
    const { win, parse, pump } = boot({});
    const item = tile('custom00001', 'Clickbait title');
    const el = render(win, item);
    const r = parse(browse([item]));
    await waitFor(() => shownTitle(el) === 'the iPhone review', 2000);
    // The switch in the panel.
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
    dispatchTrusted(win.document.body, e);
    for (let i = 0; i < 20; i++) pump();
    const sw = Array.from(win.document.querySelectorAll('#ytaf-page-ui-tweaks label'))
      .find((l) => l.querySelector('.label-text')?.textContent === 'DeArrow');
    t('the DeArrow switch is on the UI Tweaks page', !!sw);
    if (sw) {
      const input = sw.querySelector('input');
      input.checked = false;
      input.dispatchEvent(new win.Event('change'));
    }
    await wait(50);
    t('turned off: the stored response has YouTube\'s title back', tileTitle(itemsOf(r)[0]) === 'Clickbait title', tileTitle(itemsOf(r)[0]));
    t('turned off: the tile on screen too', shownTitle(el) === 'Clickbait title', shownTitle(el));

    const labels = Array.from(win.document.querySelectorAll('#ytaf-page-ui-tweaks .section-title')).map((x) => x.textContent);
    t('a DeArrow section on UI Tweaks', labels.indexOf('DeArrow') !== -1, labels.join('|'));
    const rows = Array.from(win.document.querySelectorAll('#ytaf-page-ui-tweaks .label-text, #ytaf-page-ui-tweaks .shortcut-label'))
      .map((x) => x.textContent.trim());
    const formatting = rows.some((l) => l.indexOf('Title Formatting') !== -1);
    t(modern ? 'title formatting offered in the webOS 22+ build' : 'no title formatting in the legacy build',
      formatting === modern, rows.join('|'));
    t('the thumbnail fallback row', rows.some((l) => l.indexOf('Without a Crowdsourced Thumbnail') !== -1), rows.join('|'));
    const fallbackRow = Array.from(win.document.querySelectorAll('#ytaf-page-ui-tweaks .shortcut-control-row'))
      .find((x) => x.textContent.indexOf('Without a Crowdsourced Thumbnail') !== -1);
    t('the DeArrow rows are greyed out while it is off', fallbackRow && fallbackRow.tabIndex === -1);
    const heading = win.document.querySelector('.ytaf-ui-container h1 span').textContent;
    t('the panel heading shows the version', /^YouTube Extended \d+\.\d+\.\d+$/.test(heading), heading);
  }

  // ---- The random frame, by id for a video with no submission ----
  {
    const { fetched, images, parse } = boot({ dearrowThumbnailFallback: 'random' });
    const r = parse(browse([tile('nosubmit001', 'Nothing submitted')]));
    await waitFor(() => tileThumb(itemsOf(r)[0]).indexOf('COPY') !== -1, 2000);
    t('the random time of a video with no submission is asked by id',
      fetched.some((u) => u === 'https://sponsor.ajay.app/api/branding?videoID=nosubmit001'), fetched.join(' '));
    t('the random frame is asked for at randomTime x length', images.some((u) => u.indexOf('videoID=nosubmit001&time=30&generateNow=true') !== -1), images.join(' '));
    const thumb = decodeURIComponent(tileThumb(itemsOf(r)[0]));
    t('the start frame stands in while it renders', thumb.indexOf('i.ytimg.com/vi/nosubmit001/hq1.jpg') !== -1, thumb);
  }

  // ---- Blank fallback; crowd thumbnails off keeps YouTube's ----
  {
    const blank = boot({ dearrowThumbnailFallback: 'blank' });
    const r = blank.parse(browse([tile('downvoted01', 'Original title')]));
    await waitFor(() => tileThumb(itemsOf(r)[0]).indexOf('data:image/gif') === 0, 2000);
    t('the Blank fallback', tileThumb(itemsOf(r)[0]).indexOf('data:image/gif') === 0 && blank.fetched.every((u) => u.indexOf('videoID=') === -1),
      tileThumb(itemsOf(r)[0]));

    const off = boot({ dearrowCrowdThumbnails: false, dearrowThumbnailFallback: 'random' });
    const r2 = off.parse(browse([tile('custom00001', 'Clickbait')]));
    await waitFor(() => tileTitle(itemsOf(r2)[0]) === 'the iPhone review', 2000);
    await wait(50);
    t('crowdsourced thumbnails off: YouTube\'s thumbnail, no frame asked for',
      tileThumb(itemsOf(r2)[0]) === 'https://i.ytimg.com/vi/custom00001/hqdefault.jpg' && off.images.length === 0, off.images.join(' '));
  }

  // ---- The old thumbnail switch carries over ----
  {
    const old = boot({ enableDeArrowThumbnails: false });
    const r = old.parse(browse([tile('custom00001', 'Clickbait')]));
    await waitFor(() => tileTitle(itemsOf(r)[0]) === 'the iPhone review', 2000);
    await wait(50);
    t('a TV that had DeArrow thumbnails off keeps YouTube\'s', tileThumb(itemsOf(r)[0]) === 'https://i.ytimg.com/vi/custom00001/hqdefault.jpg', tileThumb(itemsOf(r)[0]));
  }

  // ---- Off: no request ----
  {
    const off = boot({ enableDeArrow: false });
    off.parse(browse([tile('qwertyuiopa', 'x')]));
    await wait(30);
    t('DeArrow off: no request', off.fetched.length === 0, off.fetched.join(' '));
  }

  // ---- A big answer does not evict the asked video ----
  {
    const crowded = 'crowdedvid1';
    const extra = { [crowded]: { titles: [{ title: 'Calm title', original: false, votes: 1 }], thumbnails: [] } };
    // Thousands of other videos under the same prefix.
    for (let i = 0; i < 2500; i++) {
      const id = 'f' + String(i).padStart(10, '0');
      extra[id] = { titles: [{ title: 'x', original: false, votes: 1 }], thumbnails: [] };
    }
    const target = prefixOf(crowded);
    const busy = boot({});
    // The answer for the crowded video's prefix names thousands of videos.
    const fetch = busy.win.fetch;
    busy.win.fetch = (url) => {
      if (String(url).endsWith('/' + target)) {
        busy.fetched.push(String(url));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(extra))) });
      }
      return fetch(url);
    };
    const r = busy.parse(browse([tile(crowded, 'Loud title')]));
    await waitFor(() => tileTitle(itemsOf(r)[0]) === 'Calm title', 2000);
    const asked = busy.fetched.length;
    const seen = busy.parse(browse([lockup(crowded, 'Loud title')]));
    t('a big answer does not evict the asked video',
      itemsOf(seen)[0].lockupViewModel.metadata.lockupMetadataViewModel.title.content === 'Calm title' && busy.fetched.length === asked,
      busy.fetched.length - asked);
  }

  // ---- Title formatting (webOS 22+ build only) ----
  {
    const f = boot({ dearrowTitleFormatting: 'sentence_case', dearrowCleanEmojis: true });
    const r = f.parse(browse([tile('downvoted01', 'THIS IS AN AMAZING VIDEO')]));
    await wait(200);
    const title = tileTitle(itemsOf(r)[0]);
    if (modern) t('Sentence case applies to YouTube\'s own titles', title === 'This is an amazing video', title);
    else t('the legacy build leaves YouTube\'s titles as written', title === 'THIS IS AN AMAZING VIDEO', title);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
