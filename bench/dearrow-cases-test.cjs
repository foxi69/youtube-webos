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
const crypto = require('crypto');
const { createReporter, flavorFromArgs, readBundle, bootPage, trustedKey, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const bundle = readBundle();
const GREEN = 404;
const BADGE = '◉';
const pad = 'z'.repeat(600);
const prefixOf = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 4);
function waitFor(fn, ms) {
  const end = Date.now() + ms;
  const poll = () => (fn() || Date.now() >= end ? Promise.resolve(fn()) : wait(10).then(poll));
  return poll();
}

const { t, run } = createReporter();
// Every boot's jsdomErrors (a script error on the page), checked at the end.
const allErrors = [];

/** Every video has a crowdsourced title ("Calm <id>") and thumbnail (frame at 12.5 s). */
function boot(cfg, { copySize = 1000 } = {}) {
  const errors = [];
  const fetched = [];
  const images = [];
  // The page in its environment (the user agent, the Chrome 38 or 87 one,
  // Element#remove); the stubs below go in before the bundle runs.
  const page = bootPage({
    code: bundle,
    launchParams: '{}',
    consoleErrors: false,
    onError: (text) => { errors.push(text); allErrors.push(text); },
    evaluate: false
  });
  const win = page.win;
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  let rafQ = [];
  win.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, thumbnailQuality: 'off', enableAutoLogin: false,
    enableDeArrow: true, dearrowTitleFormatting: 'disable', dearrowThumbnailFallback: 'original'
  }, cfg)));
  const known = new Set();
  // Casual votes by video id: [{ id, count, title }] in the branding answer.
  const casual = new Map();
  // Titles as uploaded, by video id, for YouTube's oEmbed answer.
  const uploaded = new Map();
  // Video ids whose next oEmbed request fails (no connection), once each.
  const oembedFails = new Set();
  win.fetch = (url) => {
    url = String(url);
    fetched.push(url);
    if (url.indexOf('https://www.youtube.com/oembed?') === 0) {
      const id = decodeURIComponent(url).split('v=').pop();
      if (oembedFails.delete(id)) return Promise.reject(new Error('offline'));
      const title = uploaded.get(id);
      return Promise.resolve(title ? { ok: true, status: 200, json: () => Promise.resolve({ title }) }
        : { ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    const prefix = url.split('/').pop();
    const answer = {};
    known.forEach((id) => {
      if (prefixOf(id) === prefix) {
        answer[id] = { titles: [{ title: 'Calm ' + id, original: false, votes: 1 }], thumbnails: [{ timestamp: 12.5, original: false, votes: 1 }] };
        if (casual.has(id)) answer[id].casualVotes = casual.get(id);
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
  page.evaluate();
  const parse = (obj) => win.JSON.parse(win.JSON.stringify(obj));
  const pump = () => { const q = rafQ; rafQ = []; for (const cb of q) cb(Date.now()); };
  const toggle = (label, on) => {
    if (!win.document.querySelector('#ytaf-page-ui-tweaks')) {
      trustedKey(win, GREEN);
      for (let i = 0; i < 20; i++) pump();
    }
    const input = Array.from(win.document.querySelectorAll('#ytaf-page-ui-tweaks label'))
      .find((l) => l.querySelector('.label-text')?.textContent === label)?.querySelector('input');
    if (!input) throw new Error(label + ' switch missing');
    input.checked = on;
    input.dispatchEvent(new win.Event('change'));
  };
  return { win, errors, fetched, images, parse, toggle, known, casual, uploaded, oembedFails };
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

run(async () => {
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
  // ---- Casual Mode ----
  {
    const { win, parse, known, casual, errors } = boot({ dearrowCasualMode: true });
    for (const id of ['casualfine1', 'casualold01', 'nocasual001']) known.add(id);
    casual.set('casualfine1', [{ id: 'funny', count: 1, title: 'loud casualfine1' }]);
    // A vote for the title the video had before: it does not count.
    casual.set('casualold01', [{ id: 'descriptive', count: 2, title: 'An older title' }]);
    const els = ['casualfine1', 'casualold01', 'nocasual001'].map((id) => render(win, id, 'Loud ' + id));
    parse(browse(['casualfine1', 'casualold01', 'nocasual001'].map((id) => tile(id, 'Loud ' + id))));
    await waitFor(() => shownTitle(els[1]) === 'Calm casualold01' && shownTitle(els[2]) === 'Calm nocasual001', 2000);
    await wait(200);
    t('casual: a title casual voters found fine stays YouTube\'s', shownTitle(els[0]) === 'Loud casualfine1', shownTitle(els[0]));
    t('casual: a vote for an earlier title does not count', shownTitle(els[1]) === 'Calm casualold01', shownTitle(els[1]));
    t('casual: a video with no casual votes gets the crowdsourced title', shownTitle(els[2]) === 'Calm nocasual001', shownTitle(els[2]));
    t('casual: the thumbnail is still DeArrow\'s', shownThumb(els[0]).includes('COPY'), shownThumb(els[0]).slice(0, 80));
    t('no jsdomError (casual)', errors.length === 0, errors[0]);
    win.close();
  }
  {
    const { win, parse, known, casual } = boot({ dearrowCasualMode: false });
    known.add('casualfine2');
    casual.set('casualfine2', [{ id: 'funny', count: 1, title: 'loud casualfine2' }]);
    const el = render(win, 'casualfine2', 'Loud casualfine2');
    parse(browse([tile('casualfine2', 'Loud casualfine2')]));
    await waitFor(() => shownTitle(el) === 'Calm casualfine2', 2000);
    t('casual off: the crowdsourced title, casual votes or not', shownTitle(el) === 'Calm casualfine2', shownTitle(el));
    win.close();
  }
  // ---- Untranslated Titles ----
  {
    const { win, parse, known, uploaded, fetched, errors } = boot({ dearrowUntranslatedTitles: true, dearrowCrowdTitles: false });
    for (const id of ['translated1', 'sametitle01']) known.add(id);
    uploaded.set('translated1', 'How I built a boat');
    uploaded.set('sametitle01', 'Hogyan építettem hajót');
    const els = [render(win, 'translated1', 'Hogyan építettem csónakot'), render(win, 'sametitle01', 'Hogyan építettem hajót')];
    parse(browse([tile('translated1', 'Hogyan építettem csónakot'), tile('sametitle01', 'Hogyan építettem hajót')]));
    await waitFor(() => shownTitle(els[0]) === 'How I built a boat', 2000);
    t('untranslated: a translated title shows as uploaded', shownTitle(els[0]) === 'How I built a boat', shownTitle(els[0]));
    t('untranslated: a title YouTube did not translate stays', shownTitle(els[1]) === 'Hogyan építettem hajót', shownTitle(els[1]));
    const asked = fetched.filter((u) => u.indexOf('/oembed?') !== -1);
    t('untranslated: YouTube is asked once per video, on its own origin',
      asked.length === 2 && asked.every((u) => u.indexOf('https://www.youtube.com/oembed?') === 0), asked.join(' '));
    t('no jsdomError (untranslated)', errors.length === 0, errors[0]);
    win.close();
  }
  {
    const { win, parse, known, uploaded, fetched } = boot({ dearrowUntranslatedTitles: false, dearrowCrowdTitles: false });
    known.add('translated2');
    uploaded.set('translated2', 'How I built a boat');
    const el = render(win, 'translated2', 'Hogyan építettem csónakot');
    parse(browse([tile('translated2', 'Hogyan építettem csónakot')]));
    // The crowdsourced thumbnail on the tile: the lookup has run its course.
    await waitFor(() => shownThumb(el).includes('COPY'), 2000);
    t('untranslated off: precondition: the lookup finished', shownThumb(el).includes('COPY'), shownThumb(el).slice(0, 120));
    t('untranslated off: nothing asked, the title as shown',
      shownTitle(el) === 'Hogyan építettem csónakot' && !fetched.some((u) => u.indexOf('/oembed?') !== -1), shownTitle(el));
    win.close();
  }
  {
    // The first tile already shows the title as uploaded, a later one a translation.
    const { win, parse, known, uploaded, fetched } = boot({ dearrowUntranslatedTitles: true, dearrowCrowdTitles: false });
    known.add('boatvideo01');
    uploaded.set('boatvideo01', 'How I built a boat');
    const first = render(win, 'boatvideo01', 'How I built a boat');
    parse(browse([tile('boatvideo01', 'How I built a boat')]));
    await waitFor(() => shownThumb(first).includes('COPY'), 2000);
    const later = render(win, 'boatvideo01', 'Hogyan építettem csónakot');
    parse(browse([tile('boatvideo01', 'Hogyan építettem csónakot')]));
    await waitFor(() => shownTitle(later) === 'How I built a boat', 2000);
    t('untranslated: a later translated tile gets the title kept from the first',
      shownTitle(later) === 'How I built a boat' && shownTitle(first) === 'How I built a boat', shownTitle(later));
    t('untranslated: ...with YouTube asked once', fetched.filter((u) => u.indexOf('/oembed?') !== -1).length === 1);
    win.close();
  }
  {
    // The request for the title as uploaded fails (no connection): the video
    // is asked again when it is looked up again (the setting switched off and
    // on), not left at the translation for good.
    const { win, parse, known, uploaded, fetched, toggle, oembedFails } = boot({ dearrowUntranslatedTitles: true, dearrowCrowdTitles: false });
    known.add('flakyvideo1');
    uploaded.set('flakyvideo1', 'How I built a boat');
    oembedFails.add('flakyvideo1');
    const el = render(win, 'flakyvideo1', 'Hogyan építettem csónakot');
    parse(browse([tile('flakyvideo1', 'Hogyan építettem csónakot')]));
    await waitFor(() => shownThumb(el).includes('COPY'), 2000);
    const asked = () => fetched.filter((u) => u.indexOf('/oembed?') !== -1).length;
    t('untranslated, failed request: precondition: asked once, the title as shown',
      asked() === 1 && shownTitle(el) === 'Hogyan építettem csónakot', `${asked()} ${shownTitle(el)}`);
    toggle('Untranslated Titles', false);
    await wait(300);
    toggle('Untranslated Titles', true);
    await waitFor(() => shownTitle(el) === 'How I built a boat', 3000);
    t('untranslated, failed request: looked up again, it is asked again and shown as uploaded',
      asked() === 2 && shownTitle(el) === 'How I built a boat', `${asked()} ${shownTitle(el)}`);
    win.close();
  }
  {
    // A trusted crowdsourced title wins anyway: nothing to wait for.
    const { win, parse, known, uploaded, fetched } = boot({ dearrowUntranslatedTitles: true });
    known.add('crowdwins01');
    uploaded.set('crowdwins01', 'As uploaded');
    const el = render(win, 'crowdwins01', 'Translated');
    parse(browse([tile('crowdwins01', 'Translated')]));
    await waitFor(() => shownTitle(el) === 'Calm crowdwins01' && shownThumb(el).includes('COPY'), 2000);
    t('untranslated, a trusted crowdsourced title: precondition: shown', shownTitle(el) === 'Calm crowdwins01', shownTitle(el));
    t('untranslated, a trusted crowdsourced title: YouTube is not asked', !fetched.some((u) => u.indexOf('/oembed?') !== -1),
      fetched.filter((u) => u.indexOf('/oembed?') !== -1).join());
    win.close();
  }
  {
    // Casual Mode compares its votes with the title as uploaded: that one is still asked for.
    const { win, parse, known, casual, uploaded, fetched } = boot({ dearrowUntranslatedTitles: true, dearrowCasualMode: true });
    known.add('casualasked');
    uploaded.set('casualasked', 'As uploaded');
    casual.set('casualasked', [{ id: 'funny', count: 1, title: 'as uploaded' }]);
    const el = render(win, 'casualasked', 'Translated');
    parse(browse([tile('casualasked', 'Translated')]));
    await waitFor(() => shownTitle(el) === 'As uploaded', 2000);
    t('untranslated, Casual Mode with votes: asked, and the vote for the uploaded title counts',
      shownTitle(el) === 'As uploaded' && fetched.some((u) => u.indexOf('/oembed?') !== -1), shownTitle(el));
    win.close();
  }
});
