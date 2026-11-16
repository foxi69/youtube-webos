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
    open(method, url) { this.url = String(url); }
    send(body) { xhrs.push({ url: this.url, body }); }
    setRequestHeader() {}
    getResponseHeader() { return null; }
    addEventListener() {}
  };
  const { win, doc, errors } = bootPage({
    bodyClass,
    config: Object.assign({ enableAdBlock: false, enableTrackingBlock: false, enableSponsorBlock: false,
      enableReturnYouTubeDislike: false, enableAutoLogin: false }, config),
    xhr: XHR,
    consoleErrors: false,
    // jsdom has no Request; the TV's fetch comes with one.
    beforeEval: (w) => { if (typeof w.Request !== 'function') w.Request = class { constructor(url) { this.url = String(url); } }; },
    fetch: (resource) => { fetched.push(typeof resource === 'string' ? resource : resource.url); return new Promise(() => {}); }
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
  return { win, doc, errors, fetched, viaFetch, viaXHR };
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
});
