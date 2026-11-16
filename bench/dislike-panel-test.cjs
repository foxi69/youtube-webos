/**
 * Return YouTube Dislike (src/return-dislike.js) in the description panel,
 * end to end in the bundle: what the factoid shows for each count, both panel
 * layouts, the cache, a failing server, video changes, YouTube re-rendering
 * or replacing the panel, the rows pushed down below a taller header, and the
 * remote's Up/Down/Enter inside the panel. dislike-timing-test covers the
 * slow first request, a rejected fetch, zero and Hungarian; module-behaviour-
 * test covers finding the panel by focus. This covers the rest.
 *
 *   node bench/dislike-panel-test.cjs <bundle> [legacy|modern]
 *
 * The RYD API is faked per video id. jsdom has no IntersectionObserver;
 * Chrome 87 (webOS 22) does, so the modern run gets a stand-in the test
 * drives, and the legacy run (Chrome 38, none) injects without one.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
const modern = process.argv[3] === 'modern';
const code = fs.readFileSync(bundlePath, 'utf8');

const API = 'https://returnyoutubedislikeapi.com/votes?videoId=';
const DASH = '—';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

/**
 * The bundle on a watch page. `answer(id, n)` says what the API does with the
 * n-th request (from 1) for video `id`: a number of dislikes, { status },
 * { body }, or { later: a promise of the response }. Options: hl (YouTube's UI language), noCompact (an
 * Intl without compact notation, as webOS 3-6 have), fastRetry (the 1.2 s
 * retry steps run 10 times faster), visible (what the stand-in
 * IntersectionObserver first reports, modern only).
 */
async function boot(answer, opts = {}) {
  const errors = [];
  const rydErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...a) => errors.push(a.join(' ')));
  vc.on('log', (...a) => { const s = a.map(String).join(' '); if (/^\[RYD:[^\]]*\] \[ERROR\]/.test(s)) rydErrors.push(s); });
  const dom = new JSDOM('<!doctype html><html><head></head><body class="WEB_PAGE_TYPE_WATCH"><ytlr-app>' +
    '<div id="ytlr-player__player-container"><video></video></div></ytlr-app></body></html>',
  { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#' + (opts.hash || '/watch?v=' + (opts.video || 'vidAAAAAAAA')),
    virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableReturnYouTubeDislike: true, enableAdBlock: false, enableSponsorBlock: false,
    enableDeArrow: false, upgradeThumbnails: false, enableAutoLogin: false,
    checkForUpdates: false, showWhatsNew: false, enableLegacyEmojiFix: false
  }, opts.config)));
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  const scrolled = [];
  win.Element.prototype.scrollIntoView = function () { scrolled.push(this); };
  if (opts.hl) win.ytcfg = { get: (k) => (k === 'HL' ? opts.hl : undefined) };
  if (opts.noCompact) {
    const NF = win.Intl.NumberFormat;
    win.Intl.NumberFormat = function (lang, o) {
      const nf = new NF(lang, Object.assign({}, o, { notation: undefined }));
      return { format: (n) => nf.format(n), resolvedOptions: () => ({ locale: lang }) };
    };
  }
  let skew = 0;
  const realNow = win.Date.now;
  win.Date.now = () => realNow.call(win.Date) + skew;
  if (opts.fastRetry) {
    const st = win.setTimeout;
    win.setTimeout = function (fn, ms, ...rest) {
      return st.call(win, fn, ms >= 1200 && ms <= 4800 && ms % 1200 === 0 ? ms / 10 : ms, ...rest);
    };
  }
  // Chrome 87 has IntersectionObserver; this one reports what the test says.
  const ios = [];
  if (modern) {
    win.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; this.targets = []; ios.push(this); }
      observe(el) {
        this.targets.push(el);
        setTimeout(() => { if (this.targets.length) this.cb([{ target: el, isIntersecting: opts.visible !== false }]); }, 0);
      }
      disconnect() { this.targets = []; }
      report(isIntersecting) { this.cb([{ target: this.targets[0], isIntersecting }]); }
    };
  }
  const requests = [];
  const asked = {};
  win.fetch = (resource) => {
    const url = String(resource && resource.url || resource);
    if (url.indexOf(API) !== 0) return new Promise(() => {});
    const id = decodeURIComponent(url.slice(API.length));
    requests.push(id);
    asked[id] = (asked[id] || 0) + 1;
    const a = answer(id, asked[id]);
    if (a && a.later) return a.later;
    const status = typeof a === 'object' && a.status ? a.status : 200;
    const body = typeof a === 'object' ? (a.body || {}) : { id, dislikes: a };
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
  };
  win.eval(code);
  await wait(650);   // handleHashChange runs 500 ms after load
  return {
    win, errors, rydErrors, requests, asked, scrolled, ios,
    setSkew: (ms) => { skew = ms; },
    ryd: () => win.returnYouTubeDislike
  };
}

async function go(win, hash) {
  win.location.hash = hash;
  await wait(30);
}

/**
 * A description panel as YouTube builds it: the header row with the stats
 * factoids, then rows of menu items in wrappers, inside a virtual list whose
 * rows carry the height YouTube measured.
 */
function openPanel(win, opts = {}) {
  const d = win.document;
  const el = (tag, cls, attrs) => {
    const e = d.createElement(tag);
    if (cls) e.className = cls;
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    return e;
  };
  const compact = opts.layout === 'compact';
  const C = compact
    ? { container: 'rznqCe', factoid: 'nOJlw', value: 'axf6h', label: 'Ph2lNb' }
    : { container: 'ytLrVideoDescriptionHeaderRendererFactoidContainer', factoid: 'ytLrVideoDescriptionHeaderRendererFactoid',
        value: 'ytLrVideoDescriptionHeaderRendererValue', label: 'ytLrVideoDescriptionHeaderRendererLabel' };
  const panel = el('ytlr-structured-description-content-renderer');
  const list = el('yt-virtual-list');
  const box = el('div');
  const header = el('div');
  header.style.height = opts.rowHeight === undefined ? '100px' : opts.rowHeight;
  const headerInner = el('div');
  const container = el('div', C.container);
  const factoid = (key, value, label, likeLabel) => {
    const f = el('div', C.factoid, Object.assign(key ? { idomkey: key } : {}, likeLabel ? { 'aria-label': likeLabel } : {}));
    const v = el('span', C.value); v.textContent = value;
    const l = el('span', C.label); l.textContent = label;
    f.appendChild(v); f.appendChild(l);
    return f;
  };
  if (opts.likes !== false) {
    container.appendChild(opts.likesByLabel
      ? factoid(null, '52K', 'Likes', '52K likes')
      : factoid('factoid-0', '52K', 'Likes', '52K Likes'));
  }
  container.appendChild(factoid('factoid-1', '1.2M', 'Views'));
  container.appendChild(factoid('factoid-2', '2024', 'Mar 3'));
  headerInner.appendChild(container);
  header.appendChild(headerInner);
  box.appendChild(header);
  // The header's real height once our factoid is in: taller than YouTube measured.
  headerInner.getBoundingClientRect = () => ({ top: 0, left: 0, width: 800, height: opts.realHeight || 160 });

  const items = [];
  const wrappers = [
    ['ytlr-video-owner-renderer', 'ytLrVideoOwnerRenderer'],
    ['ytlr-expandable-video-description-body-renderer', 'ytLrExpandableVideoDescriptionBodyRenderer'],
    ['ytlr-comments-entry-point-renderer', 'ytLrCommentsEntryPointRenderer']
  ];
  for (const [tag, cls] of wrappers) {
    const row = el('div');
    row.style.height = '80px';
    const w = el(tag, cls + ' other');
    const item = el('div', 'item', { role: 'menuitem', tabindex: '0' });
    item.appendChild(el('span', 'inner', { tabindex: '0' }));
    w.appendChild(item); row.appendChild(w); box.appendChild(row);
    items.push(item);
  }
  // Chapters: a dynamic list of chapter items; the outer menuitem holds an
  // inner one and is not an item of its own.
  const row = el('div');
  row.style.height = '80px';
  const dyn = el('yt-dynamic-virtual-list');
  const outer = el('div', 'outer', { role: 'menuitem' });
  for (let i = 0; i < 2; i++) {
    const ch = el('ytlr-chapter-renderer', 'ytLrChapterRenderer');
    const item = el('div', 'item', { role: 'menuitem', tabindex: '0' });
    ch.appendChild(item); outer.appendChild(ch);
    items.push(item);
  }
  dyn.appendChild(outer); row.appendChild(dyn); box.appendChild(row);
  if (opts.markFocused !== undefined) items[opts.markFocused].classList.add('zylon-focus');
  list.appendChild(box);
  panel.appendChild(list);
  d.querySelector('ytlr-app').appendChild(panel);
  return { panel, container, header, box, list, items, dyn, outer, C };
}

const factoidEl = (win) => win.document.getElementById('ryd-dislike-factoid');
const shown = (win, cls) => {
  const f = factoidEl(win);
  const v = f && f.querySelector('.' + (cls || 'ytLrVideoDescriptionHeaderRendererValue'));
  return v ? v.textContent : null;
};
const shiftCss = (win) => (win.document.getElementById('ryd-shift-style') || {}).textContent;

function key(win, target, name, code) {
  const e = new win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => code, configurable: true });
  return dispatchTrusted(target, e);   // false: the press was taken
}

(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;
  const counts = { vidAAAAAAAA: 4321 };

  // ---- Standard layout: the factoid sits after Likes, with the right text ----
  {
    const b = await boot((id) => counts[id] || 0);
    const { win } = b;
    const p = openPanel(win);
    await wait(700);   // the panel poll runs every 500 ms
    const fe = factoidEl(win);
    t(n('factoid goes right after the Likes factoid'),
      fe && fe.previousElementSibling && fe.previousElementSibling.getAttribute('idomkey') === 'factoid-0',
      fe && fe.previousElementSibling && fe.previousElementSibling.outerHTML);
    t(n('factoid shows the count and the Dislikes label'),
      shown(win) === '4.3k' && fe.querySelector('.ytLrVideoDescriptionHeaderRendererLabel').textContent === 'Dislikes'
      && fe.getAttribute('aria-label') === '4.3k Dislikes' && fe.getAttribute('idomkey') === 'factoid-ryd',
      fe && fe.outerHTML);
    t(n('stats row gets the ryd-ready layout and the stylesheet is in'),
      p.container.classList.contains('ryd-ready') && !!win.document.getElementById('ryd-persistent-styles'));
    t(n('the one request asks for this video'), b.requests.join() === 'vidAAAAAAAA', b.requests.join());

    // The header grew from 100 px to 160 px: every other row moves down 60 px.
    t(n('rows below a taller header are pushed down by the difference'),
      /margin-top: 60px/.test(shiftCss(win)) && p.list.hasAttribute('data-ryd-shift')
      && p.header.hasAttribute('data-ryd-header')
      && [...p.box.children].filter((r) => r.hasAttribute('data-ryd-header')).length === 1,
      shiftCss(win));

    // YouTube re-renders the stats row, dropping our factoid: it comes back.
    p.container.removeChild(factoidEl(win));
    await wait(350);   // 200 ms debounce after the mutation
    t(n('factoid comes back after YouTube re-renders the row'),
      win.document.querySelectorAll('#ryd-dislike-factoid').length === 1 && shown(win) === '4.3k', String(shown(win)));

    // ---- Remote navigation inside the panel ----
    const it = p.items;
    it[1].querySelector('.inner').focus();   // focus lands on a child of the second item
    await wait(10);
    const owner = it[0].parentNode, body = it[1].parentNode;
    t(n('focused item and its wrapper get the focus classes'),
      it[1].classList.contains('zylon-focus') && it[1].classList.contains('bNqvrc')
      && body.classList.contains('ytLrExpandableVideoDescriptionBodyRenderer--focused')
      && body.classList.contains('zylon-ve'), body.className);

    it[1].focus();
    await wait(10);
    t(n('Down is taken and moves focus to the next item'),
      key(win, it[1], 'ArrowDown', 40) === false && win.document.activeElement === it[2]
      && it[2].classList.contains('zylon-focus') && !it[1].classList.contains('zylon-focus')
      && !body.classList.contains('ytLrExpandableVideoDescriptionBodyRenderer--focused'),
      win.document.activeElement && win.document.activeElement.className);
    t(n('the new item is scrolled into view'), b.scrolled[b.scrolled.length - 1] === it[2]);

    key(win, it[2], 'ArrowDown', 40);
    t(n('nested menu items: the outer chapter list is skipped'),
      win.document.activeElement === it[3] && !p.outer.classList.contains('zylon-focus'),
      win.document.activeElement && win.document.activeElement.className);
    t(n('a chapter item marks the dynamic list focused'), p.dyn.classList.contains('zylon-focus'));

    key(win, it[3], 'ArrowDown', 40);
    key(win, it[4], 'ArrowDown', 40);
    t(n('Down on the last item wraps to the first'), win.document.activeElement === it[0]
      && owner.classList.contains('ytLrVideoOwnerRenderer--focused'));
    key(win, it[0], 'ArrowUp', 38);
    t(n('Up on the first item wraps to the last'), win.document.activeElement === it[4]);
    const other = key(win, it[4], 'ArrowLeft', 37);
    t(n('Left is left to YouTube'), other === true && win.document.activeElement === it[4]);

    // Enter on an item: the item gets Enter itself (YouTube acts on it there).
    const got = [];
    it[4].addEventListener('keydown', (e) => got.push('down:' + e.keyCode + ':' + e.key));
    it[4].addEventListener('keyup', (e) => got.push('up:' + e.keyCode));
    const enter = key(win, it[4], 'Enter', 13);
    t(n('Enter on an item is taken and replayed on the item as keydown and keyup'),
      enter === false && got.join() === 'down:13:Enter,up:13', got.join());
    await wait(150);
    t(n('after Enter the highlight is cleared'),
      !it[4].classList.contains('zylon-focus') && !p.dyn.classList.contains('zylon-focus'));

    // Enter with focus on a focusable child goes to YouTube untouched.
    it[1].querySelector('.inner').focus();
    await wait(10);
    t(n('Enter on a child of an item is not taken'), key(win, it[1].querySelector('.inner'), 'Enter', 13) === true);

    // Focus leaves the panel: highlights go after the focus settles.
    const outside = win.document.createElement('div');
    outside.setAttribute('tabindex', '0');
    win.document.querySelector('ytlr-app').appendChild(outside);
    it[2].focus();
    await wait(10);
    outside.focus();
    await wait(80);
    t(n('focus leaving the panel clears the highlight'),
      !it[2].classList.contains('zylon-focus') && b.ryd().isPanelFocused === false);
    t(n('keys outside the panel are left alone'), key(win, outside, 'ArrowDown', 40) === true);

    // ---- The panel closed and opened again: a new element ----
    p.panel.parentNode.removeChild(p.panel);
    const p2 = openPanel(win);
    p2.items[0].focus();
    await wait(30);
    t(n('a reopened panel is found again and gets its own factoid'),
      b.ryd().panelElement === p2.panel && p2.container.contains(factoidEl(win)) && shown(win) === '4.3k',
      String(shown(win)));
    t(n('no RYD errors, no console errors'), !b.errors.length && !b.rydErrors.length,
      b.errors.concat(b.rydErrors).join(' | '));

    // The description shortcut (ui.js) asks for a re-check of an open panel.
    b.ryd().observeBodyForPanel();
    await wait(10);
    t(n('a re-check of the open panel keeps one factoid'),
      win.document.querySelectorAll('#ryd-dislike-factoid').length === 1 && shown(win) === '4.3k');

    // ---- Leaving the watch page ----
    await go(win, '#/browse');
    t(n('leaving the watch page removes the factoid, the styles and the shift'),
      !factoidEl(win) && !win.document.getElementById('ryd-persistent-styles')
      && !shiftCss(win) && !p2.list.hasAttribute('data-ryd-shift') && b.ryd() === null,
      String(shiftCss(win)));
    t(n('after leaving, the panel\'s keys are left alone'), key(win, p2.items[0], 'ArrowDown', 40) === true);
    await go(win, '#/watch?v=vidAAAAAAAA');
    t(n('back on a watch page: the factoid is back'), shown(win) === '4.3k', String(shown(win)));
    await go(win, '#');
    t(n('an empty hash counts as leaving'), b.ryd() === null && !factoidEl(win));
  }

  // ---- What the factoid says for each count (English) ----
  {
    const table = [[0, '0'], [999, '999'], [1000, '1k'], [1049, '1k'], [1050, '1.1k'], [999949, '999.9k'],
      [999950, '1m'], [1234567, '1.2m'], [25000000, '25m']];
    const byId = {};
    table.forEach(([c], i) => { byId['fmt' + String(i).padStart(8, '0')] = c; });
    const b = await boot((id) => (id in byId ? byId[id] : 7), { video: 'fmt00000000' });
    const { win } = b;
    openPanel(win);
    await wait(700);
    const got = [];
    for (let i = 0; i < table.length; i++) {
      if (i) await go(win, '#/watch?v=fmt' + String(i).padStart(8, '0'));
      await wait(20);
      got.push(shown(win));
    }
    const want = table.map((r) => r[1]);
    t(n('counts read 0, 999, 1k, 1k, 1.1k, 999.9k, 1m, 1.2m, 25m'), got.join() === want.join(),
      got.join() + ' / want ' + want.join());
    t(n('a new video gets a new request and one factoid'),
      b.requests.length === table.length && win.document.querySelectorAll('#ryd-dislike-factoid').length === 1,
      b.requests.join());
  }

  // ---- The cache ----
  {
    const b = await boot((id, k) => (id === 'vidAAAAAAAA' ? 100 * k : 5));
    const { win } = b;
    openPanel(win);
    await wait(700);
    await go(win, '#/watch?v=vidBBBBBBBB');
    await wait(20);
    await go(win, '#/watch?v=vidAAAAAAAA');
    t(n('back to a video seen a moment ago: no new request, its count at once'),
      b.asked.vidAAAAAAAA === 1 && shown(win) === '100', b.asked.vidAAAAAAAA + ' / ' + shown(win));
    b.setSkew(301000);   // five minutes later
    await go(win, '#/watch?v=vidBBBBBBBB');
    await go(win, '#/watch?v=vidAAAAAAAA');
    await wait(20);
    t(n('after five minutes the count is asked for again'),
      b.asked.vidAAAAAAAA === 2 && shown(win) === '200', b.asked.vidAAAAAAAA + ' / ' + shown(win));

    // Fifty videos are kept: the 51st pushes out the oldest.
    for (let i = 0; i < 50; i++) await go(win, '#/watch?v=many' + String(i).padStart(7, '0'));
    await go(win, '#/watch?v=many0000049');
    const before = b.asked.vidBBBBBBBB;
    await go(win, '#/watch?v=vidBBBBBBBB');
    await wait(20);
    t(n('the cache keeps fifty videos: older ones are asked for again'),
      b.asked.vidBBBBBBBB === before + 1, `B ${before} -> ${b.asked.vidBBBBBBBB}`);
    // B pushed out the oldest of the fifty: the second oldest is still kept, the oldest is asked for again.
    await go(win, '#/watch?v=many0000001');
    await wait(20);
    await go(win, '#/watch?v=many0000000');
    await wait(20);
    t(n('...exactly fifty: the second oldest kept, the oldest gone'),
      b.asked.many0000001 === 1 && b.asked.many0000000 === 2, `many1 ${b.asked.many0000001}, many0 ${b.asked.many0000000}`);
  }

  // ---- Answers that are not a count ----
  {
    const b = await boot((id, k) => (id === 'vidAAAAAAAA' ? (k === 1 ? { status: 503 } : 77)
      : id === 'vidNOFIELDS' ? { body: { likes: 3 } } : { status: 500 }), { fastRetry: true, hash: '/browse' });
    const { win } = b;
    openPanel(win);
    await go(win, '#/watch?v=vidAAAAAAAA');
    t(n('server error: the dash, not 0'), shown(win) === DASH && b.asked.vidAAAAAAAA === 1, String(shown(win)));
    await wait(300);   // the retry after 1.2 s, here 120 ms
    t(n('server error: retried, then the count'), shown(win) === '77' && b.asked.vidAAAAAAAA === 2,
      shown(win) + ' after ' + b.asked.vidAAAAAAAA);

    await go(win, '#/watch?v=vidNOFIELDS');
    await wait(20);
    t(n('an answer without dislikes reads 0'), shown(win) === '0', String(shown(win)));

    await go(win, '#/watch?v=vidFAILFAIL');
    // Retries after 120, 240 and 360 ms; a fourth would come 480 ms later.
    await wait(1600);
    t(n('a server that keeps failing is asked four times in all, then left'),
      b.asked.vidFAILFAIL === 4 && shown(win) === DASH, b.asked.vidFAILFAIL + ' / ' + shown(win));
    t(n('each failure is logged'), b.rydErrors.length === 5, b.rydErrors.length + ' errors');
  }

  // ---- Video change while a request runs ----
  {
    let late;
    const b = await boot((id, k) => {
      if (id === 'vidAAAAAAAA' && k === 1) {
        return { later: new Promise((r) => { late = () => r({ ok: true, status: 200, json: () => Promise.resolve({ dislikes: 111 }) }); }) };
      }
      return id === 'vidBBBBBBBB' ? 222 : { status: 500 };
    });
    const { win } = b;
    openPanel(win);
    await wait(700);
    await go(win, '#/watch?v=vidBBBBBBBB');
    await wait(20);
    late();
    await wait(30);
    t(n('a late answer for the previous video does not replace the new count'),
      shown(win) === '222' && b.ryd().videoID === 'vidBBBBBBBB', String(shown(win)));
    await go(win, '#/watch?v=vidAAAAAAAA');
    await wait(20);
    // webOS 3/4 have no AbortController: the old request runs on, and its
    // answer is cached. The modern build cancels it, so it is asked again.
    if (modern) {
      t(n('back to the first video: its cancelled request is made again'),
        b.asked.vidAAAAAAAA === 2, JSON.stringify(b.asked));
    } else {
      t(n('back to the first video: the late answer was cached'),
        b.asked.vidAAAAAAAA === 1 && shown(win) === '111', JSON.stringify(b.asked) + ' ' + shown(win));
    }
  }
  {
    // A failure, then a video change before the retry: no more requests for it.
    const b = await boot((id) => (id === 'vidAAAAAAAA' ? { status: 500 } : 9));
    const { win } = b;
    await go(win, '#/watch?v=vidBBBBBBBB');
    await wait(1400);
    t(n('leaving a video stops its retries'), b.asked.vidAAAAAAAA === 1, String(b.asked.vidAAAAAAAA));
  }

  // ---- Compact layout, Likes found by its label, no Likes ----
  {
    const b = await boot(() => 1234567);
    const { win } = b;
    const p = openPanel(win, { layout: 'compact', rowHeight: '6.25rem', realHeight: 101 });
    await wait(700);
    const fe = factoidEl(win);
    t(n('compact layout: the factoid uses its classes'),
      fe && fe.classList.contains('nOJlw') && shown(win, 'axf6h') === '1.2m'
      && fe.querySelector('.Ph2lNb').textContent === 'Dislikes' && p.container.classList.contains('ryd-ready'),
      fe && fe.outerHTML);
    t(n('a header 1 px taller than measured (in rem) moves nothing'), shiftCss(win) === '', JSON.stringify(shiftCss(win)));
  }
  {
    const b = await boot(() => 12);
    const { win } = b;
    const p = openPanel(win, { likesByLabel: true, rowHeight: '0px' });
    await wait(700);
    const fe = factoidEl(win);
    t(n('Likes found by its aria-label when it has no idomkey'),
      fe && fe.previousElementSibling && fe.previousElementSibling.getAttribute('aria-label') === '52K likes' && shown(win) === '12');
    t(n('a header row YouTube never measured is not shifted'),
      !shiftCss(win) && !p.list.hasAttribute('data-ryd-shift'), JSON.stringify(shiftCss(win)));
  }
  {
    const b = await boot(() => 12);
    const { win } = b;
    const p = openPanel(win, { likes: false });
    await wait(700);
    t(n('no Likes factoid: nothing injected, nothing broken'),
      !factoidEl(win) && !p.container.classList.contains('ryd-ready') && !b.errors.length && !b.rydErrors.length,
      b.errors.concat(b.rydErrors).join(' | '));
  }

  {
    const b = await boot(() => 12);
    const { win } = b;
    const p = openPanel(win);
    p.container.parentNode.removeChild(p.container);
    await wait(700);
    t(n('a panel without the stats row: nothing injected'), !factoidEl(win) && !b.rydErrors.length);
  }

  // ---- A panel found by focus, then replaced while the poll still runs ----
  {
    const b = await boot(() => 31);
    const { win } = b;
    const p = openPanel(win);
    p.items[0].focus();   // before the poll's first look
    await wait(20);
    t(n('a panel focused at once is found by the focus'), b.ryd().panelElement === p.panel && shown(win) === '31');
    await wait(600);
    t(n('the poll leaves a found panel alone'), b.ryd().panelElement === p.panel
      && win.document.querySelectorAll('#ryd-dislike-factoid').length === 1);
    p.panel.parentNode.removeChild(p.panel);
    const p2 = openPanel(win);
    await wait(600);
    t(n('a panel replaced without a focus change is picked up by the poll'),
      b.ryd().panelElement === p2.panel && p2.container.contains(factoidEl(win)) && shown(win) === '31');
  }

  // ---- Languages ----
  {
    const b = await boot(() => 4321, { hl: 'fr-FR' });
    openPanel(b.win);
    await wait(700);
    const fe = factoidEl(b.win);
    const want = new Intl.NumberFormat('fr-fr', { notation: 'compact', maximumFractionDigits: 1 }).format(4321);
    t(n('fr-FR: the French label and French compact number'),
      fe && fe.querySelector('.ytLrVideoDescriptionHeaderRendererLabel').textContent === 'Je n’aime pas'
      && shown(b.win) === want, fe && fe.textContent);
  }
  {
    const b = await boot(() => 4321, { hl: 'fr', noCompact: true });
    openPanel(b.win);
    await wait(700);
    t(n('no compact number format (webOS 3-6): 4.3k in French too'), shown(b.win) === '4.3k', String(shown(b.win)));
  }
  {
    const b = await boot(() => 4321, { hl: 'ja' });
    openPanel(b.win);
    await wait(700);
    const fe = factoidEl(b.win);
    t(n('a language without a label keeps Dislikes'),
      fe && fe.querySelector('.ytLrVideoDescriptionHeaderRendererLabel').textContent === 'Dislikes', fe && fe.textContent);
  }

  // ---- Off screen (IntersectionObserver, modern only) ----
  if (modern) {
    const b = await boot(() => 50, { visible: false });
    const { win } = b;
    const p = openPanel(win, { markFocused: 2 });
    await wait(700);
    t(n('a panel off screen gets no factoid yet'), !factoidEl(win));
    const io = b.ios[b.ios.length - 1];
    p.items[2].focus();
    await wait(10);
    io.report(true);
    t(n('in view: the factoid is injected and the focused item highlighted'),
      shown(win) === '50' && p.items[2].classList.contains('bNqvrc'), String(shown(win)));
    io.report(false);
    t(n('out of view: the highlight is cleared'),
      !p.items[2].classList.contains('bNqvrc') && b.ryd().isPanelFocused === false);
  } else {
    // ---- YouTube's own focus mark decides where Down starts ----
    const b = await boot(() => 50);
    const { win } = b;
    const p = openPanel(win, { markFocused: 2 });
    await wait(700);
    p.items[2].focus();
    b.ryd().lastFocusedElement = null;   // as after YouTube re-rendered the list
    b.ryd().menuItemsCache = [];
    key(win, p.items[2], 'ArrowDown', 40);
    t(n('Down starts from the item YouTube marked focused'), win.document.activeElement === p.items[3],
      win.document.activeElement && win.document.activeElement.className);
  }

  // ---- Focus in the panel on no item, none marked: Down to the first ----
  {
    const b = await boot(() => 50);
    const { win } = b;
    const p = openPanel(win);
    await wait(700);
    p.header.setAttribute('tabindex', '0');
    p.header.focus();   // the header: in the panel, not a menu item
    await wait(10);
    t(n('precondition: the panel has the focus, no item marked'), b.ryd().isPanelFocused === true &&
      !p.panel.querySelector('[role="menuitem"].zylon-focus'));
    key(win, p.header, 'ArrowDown', 40);
    t(n('focus on no item: Down goes to the first item'), win.document.activeElement === p.items[0],
      win.document.activeElement && (win.document.activeElement === p.items[1] ? 'the second item' : win.document.activeElement.className));
    p.header.focus();
    await wait(10);
    b.ryd().lastFocusedElement = null;   // as after YouTube re-rendered the list
    b.ryd().menuItemsCache = [];
    p.items[0].classList.remove('zylon-focus');
    key(win, p.header, 'ArrowUp', 38);
    t(n('focus on no item: Up goes to the last item'), win.document.activeElement === p.items[4],
      win.document.activeElement && win.document.activeElement.className);
  }

  // ---- Return YouTube Dislike switched off ----
  {
    const b = await boot(() => 5, { config: { enableReturnYouTubeDislike: false } });
    const { win } = b;
    const p = openPanel(win);
    await wait(700);
    p.items[0].focus();
    await wait(10);
    key(win, p.items[0], 'ArrowDown', 40);
    t(n('switched off: no request and no factoid'), !b.requests.length && !factoidEl(win), b.requests.join());
    t(n('switched off: Down in the panel still moves the focus'), win.document.activeElement === p.items[1]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
