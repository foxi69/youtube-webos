/**
 * The AI badge on cards (ai-content-filter.js) as the page changes under it,
 * the cases ai-filter-test leaves out: a card YouTube recycles in place for
 * another video (its attributes or its text change, nothing is added), a
 * playlist row wrapping a tile, or with its data only on the card inside, a
 * card removed from the page, the next sweeps reusing an answer instead of
 * asking again, a failed lookup asked again only once its minute is over, an
 * AI answer asked again after its hour, and the bundle started before the
 * page has a <body>.
 *
 *   node bench/ai-filter-cases-test.cjs <bundle> [legacy|modern]
 *
 * The label service is faked at XMLHttpRequest, as in ai-filter-test: each
 * video id gets the answer the case sets ('ai', 'plain', or an HTTP status).
 * The page's Date.now can be moved forward (jump) for the cases that wait out
 * an answer's lifetime.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const code = fs.readFileSync(bundlePath, 'utf8');
const BADGE = 'data-ytaf-ai-badge';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

const until = async (check, ms) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await wait(20);
  }
  return true;
};

const wrapBody = (contents) => JSON.stringify({ contents: { twoColumnWatchNextResults: { results: { results: { contents } } } } });
const AI_BODY = wrapBody([{ videoPrimaryInfoRenderer: { badges: [{ metadataBadgeRenderer: {
  icon: { iconType: 'INFO' }, label: 'AI', accessibilityData: { label: 'AI: Content was made with AI' } } }] } }]);
const PLAIN_BODY = wrapBody([{ videoPrimaryInfoRenderer: {} }]);

const tileData = (id) => ({ contentType: 'TILE_CONTENT_TYPE_VIDEO', onSelectCommand: { watchEndpoint: { videoId: id } } });
const lockupData = (id) => ({ contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
  rendererContext: { commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: id } } } } } });
const vid = (n) => 'vid' + String(n).padStart(8, '0');

function boot(cfg, opts = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app><div id="root"></div></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = '{}';
  // The page's clock, `offset` ms ahead of the real one.
  let offset = 0;
  const realNow = win.Date.now.bind(win.Date);
  win.Date.now = () => realNow() + offset;
  // answers[id]: 'ai', 'plain' (the default) or an HTTP status; an array is
  // used up one answer per request.
  const answers = opts.answers || {};
  const requests = [];
  const held = [];
  let holding = !!opts.hold;
  win.XMLHttpRequest = class {
    open() {}
    setRequestHeader() {}
    getResponseHeader() { return null; }
    addEventListener() {}
    send(body) {
      const id = JSON.parse(body).videoId;
      requests.push(id);
      let answer = answers[id] || 'plain';
      if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift() : answer[0];
      const finish = () => {
        this.status = typeof answer === 'number' ? answer : 200;
        this.responseText = answer === 'ai' ? AI_BODY : PLAIN_BODY;
        if (this.onload) this.onload();
      };
      // opts.hold: the answers wait in `held` until release(), which also
      // lets the later ones through at once.
      if (holding) held.push(finish);
      else setTimeout(finish, opts.delay || 0);
    }
  };
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: true, enableTrackingBlock: false, removeAiVideos: false, markAiVideos: true,
    enableSponsorBlock: false, enableReturnYouTubeDislike: false, enableDeArrow: false,
    upgradeThumbnails: false, enableAutoLogin: false, checkForUpdates: false, showWhatsNew: false,
    enableLegacyEmojiFix: false
  }, cfg)));
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.fetch = () => new Promise(() => {});
  // Under bench/late-injection-preload.cjs the page has loaded before the
  // bundle runs (readyState 'complete'); jsdom on its own is still loading.
  const late = doc.readyState === 'complete';
  if (opts.noBody) doc.documentElement.removeChild(doc.body);
  win.eval(code);
  const ranWithoutBody = !doc.body;
  if (opts.noBody) {
    // The parser reaching <body>, before DOMContentLoaded as in a browser.
    const body = doc.createElement('body');
    body.className = 'WEB_PAGE_TYPE_BROWSE';
    body.innerHTML = '<ytlr-app><div id="root"></div></ytlr-app>';
    doc.documentElement.appendChild(body);
  }
  const root = () => doc.getElementById('root');
  // A card of `tag` showing `data`, with a title text and a thumbnail.
  const card = (tag, data, parent) => {
    const el = doc.createElement(tag);
    el.__instance = { props: { data } };
    el.setAttribute('idomkey', 'k-' + Math.random().toString(36).slice(2));
    el.innerHTML = '<img src="https://i.ytimg.com/vi/x/hq.jpg"><span class="title">Title</span>';
    (parent || root()).appendChild(el);
    return el;
  };
  // YouTube reusing a card for another video: new data, then the attributes
  // and the text it draws from it.
  const recycle = (el, data) => {
    el.__instance.props.data = data;
    el.setAttribute('idomkey', 'k-' + Math.random().toString(36).slice(2));
  };
  const badged = (el) => el.hasAttribute(BADGE);
  const jump = (ms) => { offset += ms; };
  const count = (id) => requests.filter((r) => r === id).length;
  const release = () => { holding = false; held.splice(0).forEach((finish) => { finish(); }); };
  return { win, doc, errors, requests, count, card, recycle, badged, jump, ranWithoutBody, late, root, held, release };
}

(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- A card recycled in place ----
  {
    const h = boot({}, { answers: { [vid(1)]: 'ai', [vid(2)]: 'plain', [vid(3)]: 'ai' } });
    const c = h.card('ytlr-tile-renderer', tileData(vid(1)));
    t(n('setup: an AI video\'s card is badged'), await until(() => h.badged(c), 3000));
    // Recycled for a plain video: only an attribute changes on the page.
    h.recycle(c, tileData(vid(2)));
    t(n('recycled by an attribute change: the new video is looked up'), await until(() => h.count(vid(2)) === 1, 3000), h.requests.join());
    t(n('...and the badge goes'), await until(() => !h.badged(c), 3000));
    // Recycled again, this time only its text changes (the title node's data).
    c.__instance.props.data = tileData(vid(3));
    c.querySelector('.title').firstChild.nodeValue = 'Another title';
    t(n('recycled by a text change: the new AI video is badged'), await until(() => h.badged(c) && h.count(vid(3)) === 1, 3000),
      h.requests.join());
    // A change inside the card that leaves the video as it was.
    const before = h.requests.length;
    c.querySelector('img').setAttribute('src', 'https://i.ytimg.com/vi/x/maxres.jpg');
    await wait(200);
    t(n('a new thumbnail for the same video: no new lookup, badge kept'), h.requests.length === before && h.badged(c), h.requests.join());
    t(n('recycled: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }

  // ---- Playlist rows (a wrapper around the card) ----
  {
    const h = boot({}, { answers: { [vid(10)]: 'ai', [vid(11)]: 'ai', [vid(12)]: 'plain' } });
    // The wrapper's own data names a tile.
    const w1 = h.card('ytlr-playlist-panel-video-wrapper-renderer', { primaryRenderer: { tileRenderer: tileData(vid(10)) } });
    const inner1 = h.card('ytlr-tile-renderer', tileData(vid(10)), w1);
    // The wrapper has no data of its own: the card inside it decides.
    const w2 = h.card('ytlr-playlist-panel-video-wrapper-renderer', {});
    const inner2 = h.card('yt-lockup-view-model', lockupData(vid(11)), w2);
    t(n('a row wrapping a tile: the row is badged, once, not the tile in it'),
      await until(() => h.badged(w1), 3000) && !h.badged(inner1) && h.count(vid(10)) === 1, h.requests.join());
    t(n('a row with no data of its own: badged from the card inside it'),
      await until(() => h.badged(w2), 3000) && !h.badged(inner2) && h.count(vid(11)) === 1, h.requests.join());
    // The row moves on to a plain video: the change is on the card inside.
    w2.__instance.props.data = {};
    inner2.__instance.props.data = lockupData(vid(12));
    inner2.querySelector('img').setAttribute('src', 'https://i.ytimg.com/vi/y/hq.jpg');
    t(n('a change on the card inside a row: the row follows'), await until(() => !h.badged(w2) && h.count(vid(12)) === 1, 3000),
      h.requests.join());
    // A row whose component cannot be read (torn down mid-sweep).
    const broken = h.doc.createElement('ytlr-playlist-panel-video-wrapper-renderer');
    Object.defineProperty(broken, '__instance', { get() { throw new Error('torn down'); } });
    h.root().appendChild(broken);
    await wait(200);
    t(n('a row whose data cannot be read: skipped, no badge, no page errors'), !h.badged(broken) && h.errors.length === 0,
      h.errors.join(' | '));
  }

  // ---- A card taken off the page ----
  {
    const h = boot({}, { answers: { [vid(20)]: 'ai', [vid(21)]: 'plain' } });
    const c = h.card('ytlr-tile-renderer', tileData(vid(20)));
    t(n('removal: the card is badged first'), await until(() => h.badged(c), 3000), h.requests.join());
    const row = h.doc.createElement('div');
    h.root().appendChild(row);
    row.appendChild(c);
    await wait(150);
    // The row scrolled away: removed with the card in it.
    h.root().removeChild(row);
    t(n('a card removed from the page loses its badge'), await until(() => !h.badged(c), 3000));
    // YouTube puts the element back for a plain video: no badge, not even briefly.
    // Every change of the attribute, by its old value: one with none before
    // is the badge put on, even if it went again in the same task.
    let flashed = false;
    const obs = new h.win.MutationObserver((records) => {
      if (records.some((r) => r.oldValue === null)) flashed = true;
    });
    obs.observe(c, { attributes: true, attributeFilter: [BADGE], attributeOldValue: true });
    h.recycle(c, tileData(vid(21)));
    h.root().appendChild(c);
    t(n('...put back for a plain video, it is looked up'), await until(() => h.count(vid(21)) === 1, 3000), h.requests.join());
    await wait(100);
    obs.disconnect();
    t(n('...and put back for a plain video it shows no badge, not even briefly'), !flashed && !h.badged(c), h.requests.join());
  }

  // ---- Answers reused, failures retried after their minute ----
  {
    const h = boot({}, { hold: true, answers: { [vid(30)]: 'ai', [vid(31)]: [500, 'ai'] } });
    const ai = h.card('ytlr-tile-renderer', tileData(vid(30)));
    t(n('answers: the first lookup goes out and is held'), await until(() => h.held.length === 1, 3000), h.requests.join());
    // Another card while the first lookup is still out: the sweep that
    // follows must not ask again.
    const failing = h.card('ytlr-tile-renderer', tileData(vid(31)));
    t(n('...a second sweep runs while it is out (the new card is asked)'), await until(() => h.count(vid(31)) === 1, 3000),
      h.requests.join());
    t(n('a sweep while a lookup is out does not ask again'), h.count(vid(30)) === 1, h.requests.join());
    // From here on the answers come at once.
    h.release();
    await until(() => h.badged(ai), 3000);
    await wait(100);
    t(n('a failed lookup (HTTP 500): no badge'), !h.badged(failing));
    // More cards: the answers already in are reused.
    h.card('ytlr-tile-renderer', tileData(vid(32)));
    await until(() => h.count(vid(32)) === 1, 3000);
    await wait(400);
    t(n('the next sweep reuses the answers: no new lookups, the badge kept'),
      h.count(vid(30)) === 1 && h.count(vid(31)) === 1 && h.badged(ai), h.requests.join());
    // A minute on, the failure has run out and the next sweep asks again.
    h.jump(61 * 1000);
    h.card('ytlr-tile-renderer', tileData(vid(33)));
    t(n('a minute later the failed video is asked again, and badged'),
      await until(() => h.count(vid(31)) === 2 && h.badged(failing), 3000), h.requests.join());
    t(n('...the AI answer, an hour long, is not asked again'), h.count(vid(30)) === 1 && h.badged(ai), h.requests.join());
  }

  // ---- An AI answer runs out after an hour ----
  {
    const h = boot({}, { answers: { [vid(40)]: ['ai', 'plain'] } });
    const c = h.card('ytlr-tile-renderer', tileData(vid(40)));
    t(n('expiry: the AI video is badged first'), await until(() => h.badged(c), 3000), h.requests.join());
    h.jump(61 * 60 * 1000);
    h.card('ytlr-tile-renderer', tileData(vid(41)));
    t(n('an hour later the AI video is asked again'), await until(() => h.count(vid(40)) === 2, 3000), h.requests.join());
    t(n('...and loses its badge when it is no longer labelled'), await until(() => !h.badged(c), 3000));
    t(n('answers: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }

  // ---- Started before the page has a <body> ----
  {
    const h = boot({}, { noBody: true, answers: { [vid(50)]: 'ai' } });
    if (h.late) {
      // A page that has loaded has its <body>: nothing to wait for.
      console.log('skip no <body> at start: the page has loaded (late injection)');
    } else {
      t(n('the bundle ran before the page had a <body>'), h.ranWithoutBody);
      const c = h.card('ytlr-tile-renderer', tileData(vid(50)));
      t(n('...and badges the cards once the page has loaded'), await until(() => h.badged(c), 3000), h.requests.join());
      t(n('no <body> at start: no page errors'), h.errors.length === 0, h.errors.join(' | '));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
