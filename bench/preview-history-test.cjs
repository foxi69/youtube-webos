/**
 * Tile previews stay out of the watch history (preview-history.js): a
 * preview's '/api/stats/playback' and '/api/stats/watchtime' requests are
 * dropped, and nothing else is.
 *
 * The bundle in jsdom. The page's own fetch and XMLHttpRequest record what
 * reaches them; the requests are made as the player makes them (fetch on the
 * TV; XMLHttpRequest where it has no fetch).
 *
 * Usage: node bench/preview-history-test.cjs [dist/webOSUserScripts/userScript.js] [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, until, wait } = require('./harness.cjs');

const { t, run } = createReporter();

const HOST = 'https://www.youtube.com';
const PREVIEW = '?docid=abc&el=leanback&autoplay=1&vis=5&st=0&et=5';
const playback = (q) => HOST + '/api/stats/playback' + q;
const watchtime = (q) => HOST + '/api/stats/watchtime' + q;

function boot(bodyClass, config) {
  const fetched = [];
  const xhrs = [];
  const XHR = class {
    open(method, url) { this.method = method; this.url = String(url); }
    send(body) {
      xhrs.push({ method: this.method, url: this.url, body });
      const done = this.onloadend;
      if (done) Promise.resolve().then(done);
    }
    abort() {}
    setRequestHeader() {}
    getResponseHeader() { return null; }
    addEventListener(type, fn) { if (type === 'loadend') this.onloadend = fn; }
  };
  const { win, doc, errors } = bootPage({
    bodyClass,
    config: Object.assign({ enableAdBlock: false, enableTrackingBlock: false, enableSponsorBlock: false,
      enableReturnYouTubeDislike: false, enableAutoLogin: false }, config),
    xhr: XHR,
    consoleErrors: false,
    // jsdom has no Request; the TV's fetch comes with one.
    beforeEval: (w) => { if (typeof w.Request !== 'function') w.Request = class { constructor(url) { this.url = String(url); } }; },
    fetch: (resource) => { fetched.push(typeof resource === 'string' ? resource : resource.url); return Promise.resolve({ ok: true, status: 204 }); }
  });
  // Whether a request reaches the network, by each way.
  const viaFetch = (url) => { const n = fetched.length; win.fetch(url); return fetched.length > n && fetched[fetched.length - 1] === url; };
  const viaXHR = (url) => {
    const x = new win.XMLHttpRequest();
    x.open('POST', url, true);
    x.send('body');
    const last = xhrs[xhrs.length - 1];
    return last.url === url && last.body === 'body';
  };
  return { win, doc, errors, fetched, xhrs, viaFetch, viaXHR };
}

run(async () => {
  for (const [name, config] of [
    ['Ad Blocking and Tracking Block off', {}],
    ['Ad Blocking and Tracking Block on', { enableAdBlock: true, enableTrackingBlock: true }]
  ]) {
    const home = boot('WEB_PAGE_TYPE_BROWSE', config);
    t(`${name}: a preview's playback ping on Home is dropped (fetch)`, !home.viaFetch(playback(PREVIEW)));
    t(`${name}: a preview's watchtime ping on Home is dropped (fetch)`, !home.viaFetch(watchtime(PREVIEW)));
    t(`${name}: a preview's playback ping on Home is dropped (XMLHttpRequest)`, !home.viaXHR(playback(PREVIEW)));
    t(`${name}: a preview's watchtime ping on Home is dropped (XMLHttpRequest)`, !home.viaXHR(watchtime(PREVIEW)));
    t(`${name}: no errors`, home.errors.length === 0, home.errors[0]);
  }

  const home = boot('WEB_PAGE_TYPE_BROWSE');
  const dropped = await home.win.fetch(playback(PREVIEW));
  t('the dropped fetch is answered like a ping (204)', dropped && dropped.status === 204, dropped && dropped.status);
  t('a watchtime ping of several spans (vis=5,5,5) is dropped',
    !home.viaFetch(watchtime('?docid=abc&autoplay=1&st=1,2,3&et=2,3,4&vis=5,5,5')) &&
    !home.viaFetch(watchtime('?docid=abc&autoplay=1&vis=5%2C5&st=1%2C2')));
  if (typeof home.win.Request === 'function') {
    const before = home.fetched.length;
    home.win.fetch(new home.win.Request(playback(PREVIEW)));
    home.win.fetch(new home.win.Request(playback('?docid=abc')));
    t('given as a Request object: dropped too, and another goes out',
      home.fetched.length === before + 1 && home.fetched[before] === playback('?docid=abc'), home.fetched.slice(before).join(' '));
  }

  // A watched video's last ping goes out when the page is Home again.
  const FINAL = '?docid=abc&el=leanback&state=paused&st=34&et=34&final=1';
  t('on Home without autoplay and vis (the last ping of a watched video): goes out',
    home.viaFetch(watchtime(FINAL)) && home.viaXHR(watchtime(FINAL)));
  // The last ping of a video that autoplay started.
  t('on Home with autoplay=1 only: goes out',
    home.viaFetch(watchtime('?docid=abc&autoplay=1&final=1')) && home.viaXHR(playback('?docid=abc&autoplay=1')));
  t('on Home with vis=5 only: goes out',
    home.viaFetch(watchtime('?docid=abc&vis=5&final=1')) && home.viaXHR(playback('?docid=abc&vis=5')));
  t('on Home with other values (autoplay=10, vis=50, vis=5,3, vis=3): goes out',
    home.viaFetch(playback('?docid=abc&autoplay=10&vis=5')) && home.viaFetch(playback('?docid=abc&autoplay=1&vis=50')) &&
    home.viaFetch(watchtime('?docid=abc&autoplay=1&vis=5,3')) && home.viaFetch(playback('?docid=abc&autoplay=1&vis=3')));
  t('the flags inside another parameter do not count',
    home.viaFetch(playback('?docid=abc&referrer=' + encodeURIComponent('https://x/?autoplay=1&vis=5'))) &&
    home.viaFetch(playback('?docid=abc&xautoplay=1&xvis=5')) && home.viaFetch(playback('?docid=abc#?autoplay=1&vis=5')));
  t('another /api/stats/ request with both flags: unchanged',
    home.viaFetch(HOST + '/api/stats/qoe' + PREVIEW) && home.viaXHR(HOST + '/api/stats/atr' + PREVIEW) &&
    home.viaFetch(HOST + '/api/stats/delayplay' + PREVIEW) && home.viaFetch(HOST + '/api/stats/playbackx' + PREVIEW));
  t('any other request: unchanged',
    home.viaFetch(HOST + '/youtubei/v1/player?autoplay=1&vis=5') && home.viaXHR(HOST + '/youtubei/v1/browse?autoplay=1&vis=5') &&
    home.viaFetch(HOST + '/x?next=/api/stats/playback&autoplay=1&vis=5'));
  t('no errors', home.errors.length === 0, home.errors[0]);

  const watch = boot('WEB_PAGE_TYPE_WATCH');
  t('on the watch page with autoplay=1 and vis=5: goes out',
    watch.viaFetch(playback(PREVIEW)) && watch.viaFetch(watchtime(PREVIEW)) && watch.viaXHR(playback(PREVIEW)) && watch.viaXHR(watchtime(PREVIEW)));
  const shorts = boot('WEB_PAGE_TYPE_SHORTS');
  t('on the Shorts page with autoplay=1 and vis=5: goes out',
    shorts.viaFetch(playback(PREVIEW)) && shorts.viaFetch(watchtime(PREVIEW)) && shorts.viaXHR(playback(PREVIEW)) && shorts.viaXHR(watchtime(PREVIEW)));

  // A preview opened with OK: the page becomes the watch page, and back.
  const page = boot('WEB_PAGE_TYPE_BROWSE');
  page.doc.body.className = 'WEB_PAGE_TYPE_WATCH';
  await until(() => page.viaFetch(playback(PREVIEW)), 1000);
  t('once the page is the watch page the same ping goes out', page.viaFetch(playback(PREVIEW)) && page.viaXHR(watchtime(PREVIEW)));
  page.doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
  await until(() => !page.viaFetch(playback(PREVIEW)), 1000);
  t('and is dropped again back on Home', !page.viaFetch(playback(PREVIEW)) && !page.viaXHR(watchtime(PREVIEW)));
  // The page read when the ping comes, in the same task as YouTube's change.
  const swap = boot('WEB_PAGE_TYPE_WATCH');
  swap.doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
  t('dropped in the same task the page becomes Home', !swap.viaFetch(playback(PREVIEW)) && !swap.viaXHR(watchtime(PREVIEW)));
  swap.doc.body.className = 'WEB_PAGE_TYPE_SHORTS';
  t('and goes out in the same task it becomes the Shorts page', swap.viaFetch(playback(PREVIEW)) && swap.viaXHR(watchtime(PREVIEW)));

  // Tracking Block turned off in the panel puts back the XMLHttpRequest methods it found.
  const tb = boot('WEB_PAGE_TYPE_BROWSE', { enableAdBlock: true, enableTrackingBlock: true });
  t('Tracking Block on: its own requests are blocked', !tb.viaXHR(HOST + '/api/stats/qoe?x=1') && tb.viaXHR(watchtime(FINAL)));
  trustedKey(tb.win, 404);
  await until(() => tb.doc.querySelector('.ytaf-ui-container'));
  const box = [...tb.doc.querySelectorAll('.ytaf-ui-container label')].find((l) => /Reduce Telemetry/.test(l.textContent));
  const input = box && box.querySelector('input');
  if (input) input.click();
  await wait(50);
  t('Tracking Block turned off in the panel: its requests go out again', !!input && tb.viaXHR(HOST + '/api/stats/qoe?x=1'));
  t('and a preview ping is still dropped', !tb.viaXHR(playback(PREVIEW)) && !tb.viaFetch(watchtime(PREVIEW)));
  t('no errors with the panel', tb.errors.length === 0, tb.errors[0]);

  // ===== A preview opened with OK carries on as the same playback (cpn) =====
  // Its start ping, dropped on Home, goes out once just before the first ping
  // of that cpn that goes out; its watchtime pings stay dropped.
  const ping = (path, cpn, q) => HOST + '/api/stats/' + path + '?cpn=' + cpn + '&docid=abc&el=leanback' + q;
  const PV = '&autoplay=1&vis=5&st=0&et=5';
  // The first ping after OK: still autoplay=1, the spans before and after it.
  const OPENED = '&autoplay=1&vis=5,0&st=4,8&et=8,14';
  const start = (cpn) => ping('playback', cpn, PV);
  const toPage = async (env, cls) => {
    env.doc.body.className = cls;
    const watch = cls === 'WEB_PAGE_TYPE_WATCH';
    await until(() => env.viaFetch(playback(PREVIEW)) === watch, 1000);
  };
  // What reaches the network from a ping of the page on, once the chain settled.
  const sentBy = async (env, url) => {
    const n = env.fetched.length;
    env.win.fetch(url);
    await wait(30);
    return env.fetched.slice(n);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  {
    const env = boot('WEB_PAGE_TYPE_BROWSE');
    const dropped = !env.viaFetch(start('c1')) & !env.viaFetch(ping('watchtime', 'c1', PV)) &
      !env.viaFetch(ping('watchtime', 'c1', '&autoplay=1&vis=5&st=5&et=15'));
    t('a preview\'s start and watchtime pings on Home: dropped', !!dropped);
    await toPage(env, 'WEB_PAGE_TYPE_WATCH');
    const first = await sentBy(env, ping('watchtime', 'c1', OPENED));
    t('opened (same cpn on the watch page): the start ping as it came, then the watchtime, each once',
      same(first, [start('c1'), ping('watchtime', 'c1', OPENED)]), first.join(' | '));
    const next = await sentBy(env, ping('watchtime', 'c1', '&autoplay=1&st=14&et=24'));
    t('the next ping of that cpn: the start ping does not go out again',
      same(next, [ping('watchtime', 'c1', '&autoplay=1&st=14&et=24')]), next.join(' | '));
    const previewTime = [ping('watchtime', 'c1', PV), ping('watchtime', 'c1', '&autoplay=1&vis=5&st=5&et=15')];
    t('the preview\'s own watchtime pings never go out', !env.fetched.some((u) => previewTime.includes(u)),
      env.fetched.join(' | '));
    t('no errors (opened)', env.errors.length === 0, env.errors[0]);
  }

  {
    const env = boot('WEB_PAGE_TYPE_BROWSE');
    env.viaFetch(start('c2'));
    await toPage(env, 'WEB_PAGE_TYPE_WATCH');
    const other = await sentBy(env, ping('watchtime', 'c3', '&st=0&et=10'));
    t('a ping of another cpn on the watch page: the kept start ping does not go out',
      same(other, [ping('watchtime', 'c3', '&st=0&et=10')]), other.join(' | '));
    // The last ping of a watched video goes out on Home: by its cpn too.
    await toPage(env, 'WEB_PAGE_TYPE_BROWSE');
    const back = await sentBy(env, ping('watchtime', 'c2', '&autoplay=1&st=8&et=9&final=1'));
    t('on Home, the first ping of that cpn that goes out (no vis): the start ping before it',
      same(back, [start('c2'), ping('watchtime', 'c2', '&autoplay=1&st=8&et=9&final=1')]), back.join(' | '));
  }

  {
    // Not opened: it expires. 80 s after the start ping it is gone.
    const env = boot('WEB_PAGE_TYPE_BROWSE');
    // A fixed clock, moved by hand: the waits in between take no time on it.
    const t0 = env.win.Date.now();
    let offset = 0;
    env.win.Date.now = () => t0 + offset;
    env.viaFetch(start('c4'));
    env.viaFetch(start('c5'));
    await toPage(env, 'WEB_PAGE_TYPE_WATCH');
    offset = 79000;
    const inTime = await sentBy(env, ping('watchtime', 'c5', OPENED));
    t('opened 79 s after the start ping: it goes out', same(inTime, [start('c5'), ping('watchtime', 'c5', OPENED)]), inTime.join(' | '));
    offset = 81000;
    const late = await sentBy(env, ping('watchtime', 'c4', OPENED));
    t('81 s after it (expired): never goes out', same(late, [ping('watchtime', 'c4', OPENED)]), late.join(' | '));
  }

  {
    // Moved along the row: three previews, the third opened.
    const env = boot('WEB_PAGE_TYPE_BROWSE');
    for (const c of ['a', 'b', 'c']) { env.viaFetch(start(c)); env.viaFetch(ping('watchtime', c, PV)); }
    await toPage(env, 'WEB_PAGE_TYPE_WATCH');
    const opened = await sentBy(env, ping('watchtime', 'c', OPENED));
    t('three previews, the third opened: only its start ping goes out',
      same(opened, [start('c'), ping('watchtime', 'c', OPENED)]), opened.join(' | '));
    // Only the last three are kept.
    await toPage(env, 'WEB_PAGE_TYPE_BROWSE');
    for (const c of ['d1', 'd2', 'd3', 'd4']) env.viaFetch(start(c));
    await toPage(env, 'WEB_PAGE_TYPE_WATCH');
    const oldest = await sentBy(env, ping('watchtime', 'd1', OPENED));
    const newest = await sentBy(env, ping('watchtime', 'd2', OPENED));
    t('four previews: the oldest one\'s start ping is no longer kept, the next one\'s is',
      same(oldest, [ping('watchtime', 'd1', OPENED)]) && same(newest, [start('d2'), ping('watchtime', 'd2', OPENED)]),
      oldest.join(' | ') + ' || ' + newest.join(' | '));
  }

  {
    // The same through XMLHttpRequest: the start ping as it came (method, body).
    const env = boot('WEB_PAGE_TYPE_BROWSE');
    env.viaXHR(start('x1'));
    await toPage(env, 'WEB_PAGE_TYPE_WATCH');
    const n = env.xhrs.length;
    const x = new env.win.XMLHttpRequest();
    x.open('POST', ping('watchtime', 'x1', OPENED), true);
    x.send('now');
    await wait(30);
    const sent = env.xhrs.slice(n).map((r) => r.method + ' ' + r.url + ' ' + r.body);
    t('XMLHttpRequest: the start ping first (method and body as they came), then the ping',
      same(sent, ['POST ' + start('x1') + ' body', 'POST ' + ping('watchtime', 'x1', OPENED) + ' now']), sent.join(' | '));
    t('no errors (XMLHttpRequest)', env.errors.length === 0, env.errors[0]);
  }

  {
    // An XMLHttpRequest aborted or opened again while its start ping goes out: the held send is dropped.
    const env = boot('WEB_PAGE_TYPE_BROWSE');
    env.viaXHR(start('y1'));
    env.viaXHR(start('y2'));
    await toPage(env, 'WEB_PAGE_TYPE_WATCH');
    let n = env.xhrs.length;
    const x = new env.win.XMLHttpRequest();
    x.open('POST', ping('watchtime', 'y1', OPENED), true);
    x.send('now');
    x.abort();
    await wait(30);
    const aborted = env.xhrs.slice(n).map((r) => r.url);
    t('aborted while its start ping goes out: the start ping only, not the aborted ping',
      same(aborted, [start('y1')]), aborted.join(' | '));
    n = env.xhrs.length;
    const other = HOST + '/youtubei/v1/next';
    x.open('POST', ping('watchtime', 'y2', OPENED), true);
    x.send('now');
    x.open('POST', other, true);
    x.send('later');
    await wait(30);
    const reopened = env.xhrs.slice(n).map((r) => r.url + ' ' + r.body);
    t('opened again for another request meanwhile: that one once, the held ping not after it',
      same(reopened, [start('y2') + ' body', other + ' later']), reopened.join(' | '));
    t('no errors (aborted)', env.errors.length === 0, env.errors[0]);
  }
});
