/**
 * DeArrow's settings and memory (src/dearrow/index.js) against the built
 * bundle: the logo switch alone redraws the badges without deciding anything
 * again; the thumbnail copies at their budget make DeArrow start over (YouTube's
 * own back on screen, then the videos decided anew); a player response is not
 * looked at; and a key press brings a tile drawn since the answer in line.
 *
 * dearrow-test checks the lookups, titles, thumbnails and DeArrow switched
 * off; this test the rest of the feature's life. The branding server and the
 * images are faked.
 *
 * Usage: node bench/dearrow-cases-test.cjs <bundle> [legacy|modern]
 */
const fs = require('fs');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const GREEN = 404;
const BADGE = '◉';
const pad = 'z'.repeat(600);
const prefixOf = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 4);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(fn, ms) {
  const end = Date.now() + ms;
  const poll = () => (fn() || Date.now() >= end ? Promise.resolve(fn()) : wait(10).then(poll));
  return poll();
}

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};
// Every boot's jsdomErrors (a script error on the page), checked at the end.
const allErrors = [];

/** Every video has a crowdsourced title ("Calm <id>") and thumbnail (frame at 12.5 s). */
function boot(cfg, { copySize = 1000 } = {}) {
  const errors = [];
  const fetched = [];
  const images = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { errors.push(e.message); allErrors.push(e.message); });
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  // Chrome 23 has it; the Chrome 38 environment takes it away all the same.
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  let rafQ = [];
  win.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false,
    enableDeArrow: true, dearrowTitleFormatting: 'disable', dearrowThumbnailFallback: 'original'
  }, cfg)));
  const known = new Set();
  win.fetch = (url) => {
    url = String(url);
    fetched.push(url);
    const prefix = url.split('/').pop();
    const answer = {};
    known.forEach((id) => {
      if (prefixOf(id) === prefix) {
        answer[id] = { titles: [{ title: 'Calm ' + id, original: false, votes: 1 }], thumbnails: [{ timestamp: 12.5, original: false, votes: 1 }] };
      }
    });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
  };
  win.Image = class {
    set src(url) {
      images.push(url);
      this._src = url;
      this.naturalWidth = 1280;
      this.naturalHeight = 720;
      setTimeout(() => this.onload && this.onload(), 0);
    }
    get src() { return this._src; }
  };
  win.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    return { drawImage: (img) => { canvas._src = img._src; } };
  };
  // Each copy weighs copySize: blob bytes (webOS 22+), data URL characters
  // (legacy; jsdom's style parser drops a url() of about a thousand characters,
  // so only the budget case, which looks at titles, pads them that far).
  if (modern) {
    win.HTMLCanvasElement.prototype.toBlob = function (done) {
      const src = this._src;
      setTimeout(() => done({ size: copySize, src }), 0);
    };
    win.URL.createObjectURL = (b) => 'blob:https://www.youtube.com/COPY#' + encodeURIComponent(b.src);
    win.URL.revokeObjectURL = () => {};
  } else {
    win.HTMLCanvasElement.prototype.toBlob = undefined;
    win.HTMLCanvasElement.prototype.toDataURL = function () {
      const head = 'data:image/jpeg;base64,COPY' + encodeURIComponent(this._src);
      return copySize > 1000 ? head + 'A'.repeat(copySize - head.length) : head;
    };
  }
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.__box || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  const parse = (obj) => win.JSON.parse(win.JSON.stringify(obj));
  const pump = () => { const q = rafQ; rafQ = []; for (const cb of q) cb(Date.now()); };
  const toggle = (label, on) => {
    if (!win.document.querySelector('#ytaf-page-ui-tweaks')) {
      const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
      dispatchTrusted(win.document.body, e);
      for (let i = 0; i < 20; i++) pump();
    }
    const input = Array.from(win.document.querySelectorAll('#ytaf-page-ui-tweaks label'))
      .find((l) => l.querySelector('.label-text')?.textContent === label)?.querySelector('input');
    if (!input) throw new Error(label + ' switch missing');
    input.checked = on;
    input.dispatchEvent(new win.Event('change'));
  };
  return { win, errors, fetched, images, parse, toggle, known };
}

function tile(id, title) {
  return { tileRenderer: {
    contentId: id, contentType: 'TILE_CONTENT_TYPE_VIDEO',
    onSelectCommand: { watchEndpoint: { videoId: id } },
    header: { tileHeaderRenderer: { thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' }] } } },
    metadata: { tileMetadataRenderer: { title: { simpleText: title },
      lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { runs: [{ text: 'Channel' }] } } }] } }] } }
  } };
}
const browse = (items) => ({ responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: {
  sectionListRenderer: { contents: [{ shelfRenderer: { content: { horizontalListRenderer: { items } } } }] } } } } } } });
const itemsOf = (r) => r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content
  .sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items;
const tileTitle = (item) => item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText;
const lineItems = (item) => item.tileRenderer.metadata.tileMetadataRenderer.lines[0].lineRenderer.items;

/** A tile as the TV app draws it, with the DeArrow badge YouTube drew from the response when `badge`. */
function render(win, id, title, { badge = false, onScreen = true } = {}) {
  const el = win.document.createElement('ytlr-tile-renderer');
  el.innerHTML = '<ytlr-thumbnail-details></ytlr-thumbnail-details><ytlr-tile-metadata-renderer>' +
    '<div><yt-formatted-string></yt-formatted-string></div><ytlr-line>Channel' +
    (badge ? `<span class="badge"><span>${BADGE}</span></span>` : '') + '</ytlr-line></ytlr-tile-metadata-renderer>';
  el.querySelector('ytlr-thumbnail-details').style.backgroundImage = `url("https://i.ytimg.com/vi/${id}/hqdefault.jpg")`;
  el.querySelector('yt-formatted-string').textContent = title;
  if (onScreen) el.__box = { left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200 };
  win.document.querySelector('ytlr-app').appendChild(el);
  return el;
}
const shownTitle = (el) => el.querySelector('yt-formatted-string').textContent;
const shownThumb = (el) => decodeURIComponent(el.querySelector('ytlr-thumbnail-details').style.backgroundImage);

(async () => {
  // ---- The logo switch alone ----
  {
    const { win, fetched, parse, toggle, known, errors } = boot({});
    known.add('badgevideo1');
    const el = render(win, 'badgevideo1', 'Loud title', { badge: true });
    const r = parse(browse([tile('badgevideo1', 'Loud title')]));
    await waitFor(() => shownTitle(el) === 'Calm badgevideo1' && shownThumb(el).includes('COPY'), 2000);
    t('the tile on screen shows DeArrow\'s title and thumbnail', shownTitle(el) === 'Calm badgevideo1' && shownThumb(el).includes('COPY'),
      `${shownTitle(el)} ${shownThumb(el).slice(0, 120)}`);
    const mark = el.querySelector('.badge span');
    t('a crowdsourced title: the badge in the response and its logo on the tile',
      lineItems(itemsOf(r)[0]).length === 2 && mark.classList.contains('ytaf-dearrow-badge'), JSON.stringify(lineItems(itemsOf(r)[0])));
    const asked = fetched.length;
    toggle('Show the DeArrow Logo on Crowdsourced Titles/Thumbnails', false);
    await wait(400);
    t('logo off: the badge YouTube drew is hidden', el.querySelector('.badge').style.display === 'none');
    t('logo off: the stored response loses its badge', lineItems(itemsOf(r)[0]).length === 1, JSON.stringify(lineItems(itemsOf(r)[0])));
    t('logo off: nothing is decided again (no request, title and thumbnail stay)',
      fetched.length === asked && shownTitle(el) === 'Calm badgevideo1' && shownThumb(el).includes('COPY'),
      `${fetched.length - asked} requests, ${shownTitle(el)}`);
    toggle('Show the DeArrow Logo on Crowdsourced Titles/Thumbnails', true);
    await wait(400);
    t('logo on again: the badge shows again', el.querySelector('.badge').style.display === '' &&
      lineItems(itemsOf(r)[0]).length === 2);
    t('no jsdomError (badge)', errors.length === 0, errors[0]);
    win.close();
  }

  // ---- The thumbnail copies at their budget ----
  {
    // Copies of a third of the budget each: the fourth fills it.
    const copySize = modern ? 17 * 1024 * 1024 : Math.ceil(4 * 1024 * 1024 / 3);
    const { win, fetched, parse, known } = boot({}, { copySize });
    const ids = [];
    const prefixes = new Set();
    for (let i = 0; ids.length < 4; i++) {
      const id = 'budget' + String(i).padStart(5, '0');
      if (!prefixes.has(prefixOf(id))) { prefixes.add(prefixOf(id)); ids.push(id); known.add(id); }
    }
    const el = render(win, ids[0], 'Loud ' + ids[0]);
    const first = parse(browse(ids.map((id) => tile(id, 'Loud ' + id))));
    const thumbUrls = () => itemsOf(first).map((item) => item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url);
    const allCopied = await waitFor(() => thumbUrls().length === 4 && thumbUrls().every((url) => url.includes('COPY')), 3000);
    await waitFor(() => shownTitle(el) === 'Calm ' + ids[0], 1000);
    t('four videos decided, their copies kept', allCopied && shownTitle(el) === 'Calm ' + ids[0],
      `${shownTitle(el)} / ${thumbUrls().map((url) => url.slice(0, 40)).join(' ')}`);
    const asked = fetched.length;
    // The next response finds the copies at their budget: everything starts over.
    const next = parse(browse([tile(ids[0], 'Loud ' + ids[0])]));
    t('at the budget, the next response finds YouTube\'s own title on the tile on screen and in the stored response',
      shownTitle(el) === 'Loud ' + ids[0] && tileTitle(itemsOf(first)[0]) === 'Loud ' + ids[0],
      `${shownTitle(el)} / ${tileTitle(itemsOf(first)[0])}`);
    await waitFor(() => tileTitle(itemsOf(next)[0]) === 'Calm ' + ids[0], 2000);
    t('then the video is looked up and decided anew', tileTitle(itemsOf(next)[0]) === 'Calm ' + ids[0] && fetched.length > asked,
      `${tileTitle(itemsOf(next)[0])}, ${fetched.length - asked} requests`);
    win.close();
  }

  // ---- What is not looked at, and a key press ----
  {
    const { win, fetched, parse, known } = boot({});
    known.add('playerresp1');
    parse({ responseContext: { _pad: pad }, streamingData: {}, contents: browse([tile('playerresp1', 'Loud')]).contents });
    await wait(100);
    t('a player response is not looked at', fetched.length === 0, fetched.join(' '));
    parse(browse([tile('playerresp1', 'Loud')]));
    await waitFor(() => fetched.length > 0, 1000);
    await wait(400);
    // Drawn after the answer and its sweep: a key press brings it in line.
    const el = render(win, 'playerresp1', 'Loud');
    await wait(400);
    t('a tile drawn after the sweep keeps YouTube\'s title until something happens', shownTitle(el) === 'Loud');
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true }));
    await waitFor(() => shownTitle(el) === 'Calm playerresp1', 1000);
    t('a key press: the tile gets DeArrow\'s title', shownTitle(el) === 'Calm playerresp1', shownTitle(el));
    win.close();
  }

  t('no jsdomError in any case', allErrors.length === 0, allErrors[0]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
