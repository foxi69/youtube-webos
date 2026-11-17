/**
 * Show Most Replayed Graph Above the Seek Bar (src/most-replayed.js) in the
 * bundle: the heat strip drawn on the player's seek bar. most-replayed-test
 * checks the lookup and the graph's path (src/heatmap-data.js) alone; this
 * one checks what the page gets: the <style> whose ::after on the bar draws
 * the graph above its track, where and how big, the video it is for, and
 * that it goes away with the video, the watch page or the setting.
 *
 *   node bench/most-replayed-bundle-test.cjs <bundle> [legacy|modern]
 *
 * The playing video is what the player element's getVideoData() says, as
 * on the TV; the heatmap comes from a faked /youtubei/v1/next (an
 * XMLHttpRequest the test answers); the bar's and track's boxes are set by
 * the test, as jsdom lays nothing out.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, trustedKey, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();
const LABEL = 'Show Most Replayed Graph Above the Seek Bar';
const GREEN = 404;
const TICK = 300;   // a little over the module's 250 ms
const DURATION = 200;

const A = 'vidAAAAAAAA', B = 'vidBBBBBBBB', C = 'vidCCCCCCCC', D = 'vidDDDDDDDD';
const E = 'vidEEEEEEEE', F = 'vidFFFFFFFF';

const { t, run } = createReporter();

// A `next` answer with the heatmap in its current shape: ten 10 s markers.
const heatmap = (values) => ({ frameworkUpdates: { entityBatchUpdate: { mutations: [
  { payload: { macroMarkersListEntity: { markersList: {
    markerType: 'MARKER_TYPE_HEATMAP',
    markers: values.map((v, i) => ({ startMillis: String(i * 10000), durationMillis: '10000', intensityScoreNormalized: v }))
  } } } }
] } } });
const NONE = { frameworkUpdates: { entityBatchUpdate: { mutations: [] } } };
const VALUES_A = [1, 0.5, 0.2, 0.8, 0.4, 0.6, 0.3, 0.9, 0.1, 0.7];
const VALUES_B = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

const BAR = '<ytlr-multi-markers-player-bar-renderer><div idomkey="progress-bar">' +
  '<div idomkey="time-label"></div><div idomkey="played"></div></div></ytlr-multi-markers-player-bar-renderer>';

/**
 * The bundle on a watch page playing `video`. `answers`: videoId -> the
 * `next` answer, sent a moment after the request; an id missing from it
 * waits for the test (`answer`).
 */
function boot({ on = true, bar = BAR, video = A, answers = {} } = {}) {
  // The heatmap lookups: the `next` requests that ask for the markers.
  const lookups = [];
  const Next = class {
    open(method, url) { this.method = method; this.url = String(url); }
    setRequestHeader() {}
    getResponseHeader() { return null; }
    addEventListener() {}
    abort() {}
    send(body) {
      if (this.url.indexOf('/youtubei/v1/next') === -1 || this.url.indexOf('macroMarkersListEntity') === -1) return;
      let id = null;
      try { id = JSON.parse(body).videoId; } catch { /* not ours */ }
      const x = this;
      x.videoId = id;
      lookups.push(x);
      if (Object.prototype.hasOwnProperty.call(answers, id)) setTimeout(() => answer(x, answers[id]), 5);
    }
  };
  function answer(x, data) {
    x.status = 200;
    x.responseText = JSON.stringify(data);
    x.onload();
  }

  const { win, doc, errors, evaluate } = bootPage({
    code,
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    inner: `<div id="ytlr-player__player-container-player"><video></video></div>${bar}`,
    url: `https://www.youtube.com/tv#/watch?v=${video}`,
    errorStacks: true,
    xhr: Next,
    config: {
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, showMostReplayed: on
    },
    evaluate: false
  });
  const state = { id: video, live: false };
  doc.getElementById('ytlr-player__player-container-player').getVideoData = () =>
    ({ video_id: state.id, isLive: state.live });
  Object.defineProperty(doc.querySelector('video'), 'duration', { configurable: true, get: () => DURATION });

  // The boxes jsdom does not lay out: the bar, and the track inside it.
  const boxes = new Map();
  const box = (el, left, top, width, height) => boxes.set(el, { left, top, width, height,
    right: left + width, bottom: top + height, x: left, y: top });
  const rect = win.Element.prototype.getBoundingClientRect;
  win.Element.prototype.getBoundingClientRect = function () { return boxes.get(this) || rect.call(this); };

  evaluate();
  const rule =() => { const el = doc.getElementById('ytaf-most-replayed'); return el ? el.textContent : ''; };
  return { win, doc, errors, lookups, answer, state, box, rule };
}

// The graph's SVG path from the rule's data: URI.
function graphPath(rule) {
  const m = /url\("data:image\/svg\+xml,([^"]*)"\)/.exec(rule);
  if (!m) return '';
  const svg = decodeURIComponent(m[1]);
  const d = /<path d="([^"]*)"/.exec(svg);
  return d ? d[1] : '';
}

function toggleSetting(win) {
  const doc = win.document;
  if (!doc.querySelector('.ytaf-ui-container')) {
    trustedKey(win, GREEN);
  }
  const panel = doc.querySelector('.ytaf-ui-container');
  if (!panel) throw new Error('the settings panel did not open');
  for (let i = 0; i < 20; i++) panel.ensurePage(i);
  const labels = panel.querySelectorAll('label');
  let row = null;
  for (let i = 0; i < labels.length; i++) if (labels[i].textContent.trim() === LABEL) row = labels[i];
  if (!row) throw new Error('no "' + LABEL + '" switch in the panel');
  const input = row.querySelector('input');
  input.checked = !input.checked;
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  return input.checked;
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;
  const HOST = 'ytlr-multi-markers-player-bar-renderer';

  // ---- The graph for the playing video ----
  {
    const env = boot({ answers: { [A]: heatmap(VALUES_A), [B]: heatmap(VALUES_B), [E]: heatmap(VALUES_B), [F]: NONE } });
    const { doc, win, lookups, state, box, rule } = env;
    const host = doc.querySelector(HOST);
    const track = host.querySelector('[idomkey="progress-bar"]');
    // The bar across the bottom of the screen; its track 60 px in, 50 px down.
    box(host, 100, 900, 1720, 80);
    box(track, 160, 950, 1600, 6);
    await wait(TICK * 2);

    t(n('the heatmap is asked for the playing video'), lookups.length === 1 && lookups[0].videoId === A &&
      lookups[0].method === 'POST', lookups.map((x) => x.videoId).join(' '));
    const r1 = rule();
    const el = doc.getElementById('ytaf-most-replayed');
    t(n('a <style> in the head draws it'), !!el && el.parentNode === doc.head && r1.length > 0);
    // 27 px high: 3.5 % of jsdom's 768 px window; 4 px above the track.
    t(n('...as an ::after on the bar, right above its track'),
      r1.indexOf(`${HOST}::after{content:'';position:absolute;left:60px;top:19px;width:1600px;height:27px;` +
        'background:url("data:image/svg+xml,') !== -1, r1);
    t(n('...the bar made a positioned block, as it is static and inline'),
      r1.indexOf(`${HOST}{position:relative!important;display:block!important;}`) === 0, r1.slice(0, 120));
    t(n('...the bar\'s time labels moved up out of its way'),
      r1.indexOf('[idomkey="progress-bar"]>[idomkey="time-label"]{transform:translateY(-17px);}') !== -1, r1);
    const d = graphPath(r1);
    // Marker i is drawn at the middle of its 10 s, along the video's 200 s:
    // the first at x 25, the last at 475 (of 1000); its height the value.
    t(n('the graph: the markers along the video\'s length, one curve through all ten'),
      d.indexOf('M0,100L0,0L25,0Q') === 0 && /L475,30L1000,30L1000,100Z$/.test(d) && d.split('Q').length === 10, d);

    // Writes to the stylesheet while nothing changes.
    let writes = 0;
    new win.MutationObserver((m) => { writes += m.length; }).observe(el, { childList: true, characterData: true, subtree: true });
    await wait(TICK * 3);
    t(n('nothing changed: the stylesheet is not rewritten'), writes === 0 && rule() === r1, `${writes} writes`);

    // The bar focused: its track moves and grows.
    box(track, 120, 940, 1680, 10);
    await wait(TICK);
    t(n('the track moves: the graph follows it'),
      rule().indexOf('left:20px;top:9px;width:1680px;height:27px;') !== -1, rule());
    // The bar's own style, not the rule's: it stays a positioned block on
    // every redraw (it is still static and inline without the rule).
    t(n('...and the bar is still made a positioned block'),
      rule().indexOf(`${HOST}{position:relative!important;display:block!important;}`) === 0, rule().slice(0, 120));
    box(track, 140, 945, 1640, 8);
    await wait(TICK);
    t(n('...and so on the next redraw too'), rule().indexOf('left:40px;top:14px;width:1640px;') !== -1 &&
      rule().indexOf(`${HOST}{position:relative!important;display:block!important;}`) === 0, rule().slice(0, 120));
    box(track, 120, 940, 1680, 10);
    await wait(TICK);

    // The controls hidden: the rule stays, it hides with the bar.
    const shown = rule();
    host.classList.add('zylon-hidden');
    box(track, 300, 950, 1000, 6);
    await wait(TICK);
    t(n('controls hidden: the graph is left as it was'), rule() === shown);
    host.classList.remove('zylon-hidden');
    await wait(TICK);
    t(n('controls back: it is measured again'), rule().indexOf('left:200px;top:19px;width:1000px;') !== -1, rule());
    box(track, 160, 950, 1600, 6);
    await wait(TICK);

    // The next video, its answer held back: the old graph goes at once.
    const before = lookups.length;
    state.id = C;
    await wait(TICK);
    t(n('another video: the graph of the last one goes'), rule() === '', rule());
    t(n('...and that video\'s heatmap is asked for'), lookups.length === before + 1 && lookups[before].videoId === C);
    // The viewer moves on before C's answer: it is not drawn for D.
    state.id = D;
    await wait(TICK);
    // D's own answer is held back too, so that it cannot clear a stale C graph.
    env.answer(lookups[before], heatmap(VALUES_A));
    await wait(TICK);
    t(n('an answer that comes after the video changed is not drawn'), rule() === '', rule());
    const forD = lookups[lookups.length - 1];
    env.answer(forD, NONE);
    await wait(TICK);
    t(n('a video without a heatmap: nothing drawn'), forD.videoId === D && rule() === '', rule());

    state.id = B;
    await wait(TICK * 2);
    const rB = rule();
    t(n('a video with one: its own graph'), graphPath(rB).indexOf('M0,100L0,90L25,90Q') === 0 &&
      rB.indexOf('left:60px;top:19px;width:1600px;') !== -1, graphPath(rB));

    const asked = lookups.length;
    state.id = A;
    await wait(TICK * 2);
    t(n('back to the first video: its graph again, without asking again'), rule() === r1 && lookups.length === asked);

    state.live = true;
    state.id = 'liveLLLLLLL';
    await wait(TICK * 2);
    t(n('a live stream: nothing drawn, nothing asked'), rule() === '' && lookups.length === asked);
    state.live = false;
    state.id = A;
    await wait(TICK * 2);

    // Off the watch page.
    doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await wait(TICK);
    t(n('off the watch page: the graph goes'), rule() === '', rule());
    state.id = F;
    await wait(TICK * 2);
    t(n('...and nothing is asked there'), lookups.length === asked);
    state.id = A;
    doc.body.className = 'WEB_PAGE_TYPE_WATCH';
    await wait(TICK * 2);
    t(n('back on the watch page: drawn again'), rule() === r1, rule());

    // The setting.
    t(n('the setting switched off in the panel'), toggleSetting(win) === false);
    await wait(50);
    t(n('...the graph goes'), rule() === '', rule());
    state.id = E;
    await wait(TICK * 2);
    t(n('...and stays away for the next video'), rule() === '' && lookups.length === asked);
    t(n('the setting switched on again'), toggleSetting(win) === true);
    await wait(TICK * 2);
    t(n('...that video\'s heatmap is asked for and drawn'), lookups.length === asked + 1 &&
      lookups[asked].videoId === E && rule() === rB, rule());

    t(n('no console.error / jsdomError'), env.errors.length === 0, env.errors.slice(0, 3).join(' || '));
    win.close();
  }

  // Same geometry, different host: do not keep the old static host's
  // position:relative rule when YouTube replaces it with a positioned one.
  {
    const env = boot({ answers: { [A]: heatmap(VALUES_A) } });
    const host = env.doc.querySelector(HOST);
    env.box(host, 100, 900, 1720, 80);
    env.box(host.querySelector('[idomkey="progress-bar"]'), 160, 950, 1600, 6);
    await wait(TICK * 2);
    t(n('host replacement: initial static bar needs relative positioning'),
      env.rule().includes('position:relative!important;'), env.rule());
    const replacement = host.cloneNode(true);
    replacement.style.position = 'absolute';
    replacement.style.display = 'block';
    host.replaceWith(replacement);
    env.box(replacement, 100, 900, 1720, 80);
    env.box(replacement.querySelector('[idomkey="progress-bar"]'), 160, 950, 1600, 6);
    await wait(TICK * 2);
    t(n('host replacement: same-sized positioned bar keeps its position'),
      env.rule().includes(`${HOST}::after{`) && !env.rule().includes('position:relative!important;'), env.rule());
    t(n('host replacement: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  // ---- The setting off from the start ----
  {
    const env = boot({ on: false, answers: { [A]: heatmap(VALUES_A) } });
    const host = env.doc.querySelector(HOST);
    env.box(host, 100, 900, 1720, 80);
    env.box(host.querySelector('[idomkey="progress-bar"]'), 160, 950, 1600, 6);
    await wait(TICK * 2);
    t(n('setting off: no lookup and no stylesheet'), env.lookups.length === 0 && !env.doc.getElementById('ytaf-most-replayed'));
    t(n('setting off: no console.error / jsdomError'), env.errors.length === 0, env.errors.slice(0, 3).join(' || '));
    env.win.close();
  }

  // ---- The other bar: ytlr-progress-bar, already positioned ----
  {
    const env = boot({ answers: { [A]: heatmap(VALUES_A) },
      bar: '<ytlr-progress-bar style="position:absolute;display:block"><div idomkey="slider"></div></ytlr-progress-bar>' });
    const host = env.doc.querySelector('ytlr-progress-bar');
    env.box(host, 0, 1000, 1920, 40);
    env.box(host.querySelector('[idomkey="slider"]'), 40, 1010, 1840, 4);
    await wait(TICK * 2);
    const r = env.rule();
    t(n('ytlr-progress-bar: the graph above its slider'),
      r.indexOf('ytlr-progress-bar::after{content:\'\';position:absolute;left:40px;top:-21px;width:1840px;height:27px;') === 0, r);
    t(n('...and the bar, already positioned, left as it is'), r.indexOf('ytlr-progress-bar{') === -1, r);
    t(n('ytlr-progress-bar: no console.error / jsdomError'), env.errors.length === 0, env.errors.slice(0, 3).join(' || '));
    env.win.close();
  }

  // ---- No bar on screen yet: nothing until it comes ----
  {
    const env = boot({ bar: '', answers: { [A]: heatmap(VALUES_A) } });
    await wait(TICK * 2);
    t(n('no seek bar yet: nothing drawn'), env.lookups.length === 1 && env.rule() === '', env.rule());
    env.doc.querySelector('ytlr-app').insertAdjacentHTML('beforeend', BAR);
    const host = env.doc.querySelector(HOST);
    env.box(host, 100, 900, 1720, 80);
    env.box(host.querySelector('[idomkey="progress-bar"]'), 160, 950, 1600, 6);
    await wait(TICK);
    t(n('...the bar comes up: drawn on it'), env.rule().indexOf(`${HOST}::after{`) !== -1, env.rule());
    t(n('no bar yet: no console.error / jsdomError'), env.errors.length === 0, env.errors.slice(0, 3).join(' || '));
    env.win.close();
  }
});
