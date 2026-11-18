/**
 * src/hooks/fetch.ts in the bundle: FetchRegistry, which takes the place of
 * window.fetch so that listeners see each request and response and may
 * cancel it. Its users are the Tracking Block (adblock.js: telemetry
 * requests cancelled) and, on webOS 25, the cast block. Until this test only
 * the cast block's one URL was checked (webos-version-test); the response
 * listeners, what a request listener is given, the way back to a plain
 * fetch once the listeners are gone, and the debug dumps were not.
 *
 *   node bench/fetch-hook-test.cjs <bundle> [legacy|modern]
 *
 * The registry is no global. The bundle creates it when the Tracking Block
 * is on at start; with the TV's own EventTarget (Chrome 64 and newer) it
 * registers that listener through EventTarget.prototype.addEventListener,
 * where the test picks it up to add listeners of its own.
 *
 * Two TVs: one with a fetch of its own (Chrome 42 and newer, every modern
 * TV), faked here with Node's Request and Response (jsdom has neither) over
 * a fetch that records what reaches it; and, legacy only, webOS 3 as it is:
 * no fetch, so the bundle's polyfill (whatwg-fetch, over XMLHttpRequest)
 * stands in, and no constructible EventTarget, so the registry runs on its
 * stand-in (custom-event-target.ts) and is out of the test's reach; it is
 * checked through the Tracking Block alone.
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');
const { createReporter, flavorFromArgs, readBundle, trustedKey, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();
const ORIGIN = 'https://www.youtube.com';
const TRACKING_LABEL = 'Reduce Telemetry & Tracking';
const GREEN = 404;

const { t, run } = createReporter();
const b64 = (s) => Buffer.from(s).toString('base64');

/**
 * jsdom's FileReader reads only jsdom's own Blob, and Node's Response hands
 * out Node's: a FileReader that reads that one, as Chrome's reads its own.
 */
function nodeBlobFileReader(win) {
  return class FileReader {
    constructor() { this.result = null; this.listeners = []; }
    addEventListener(type, fn) { if (type === 'load') this.listeners.push(fn); }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,` + Buffer.from(buf).toString('base64');
        for (const fn of this.listeners) fn.call(this, new win.Event('load'));
      });
    }
  };
}

/**
 * The bundle on the home screen with Ad Blocking and the Tracking Block on.
 * `polyfill`: webOS 3 as it is (no fetch, EventTarget not constructible);
 * otherwise a TV with its own fetch, whose calls land in `fetched`.
 */
function boot({ polyfill }) {
  const errors = [];
  const debug = [];
  const info = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));
  vc.on('debug', (...a) => debug.push(a));
  vc.on('info', (...a) => info.push(a.map(String).join(' ')));
  const dom = new JSDOM('<!doctype html><html><head></head><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: ORIGIN + '/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = '{}';
  win.localStorage.setItem('ytaf-configuration', JSON.stringify({
    enableAdBlock: true, enableTrackingBlock: true, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, enableDeArrow: false, thumbnailQuality: 'off',
    enableAutoLogin: false, checkForUpdates: false, showWhatsNew: false
  }));
  if (!win.requestAnimationFrame) win.requestAnimationFrame = (cb) => win.setTimeout(() => cb(Date.now()), 16);
  if (!win.cancelAnimationFrame) win.cancelAnimationFrame = (id) => win.clearTimeout(id);
  const reflect = win.Reflect;
  const eventTarget = win.EventTarget;
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  // Chrome 23 has it; the Chrome 38 environment takes it away all the same.
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };

  // Every XMLHttpRequest: the polyfill's fetch goes through it; it answers
  // `{"path":...}` for any URL. Other modules' requests are recorded too.
  const xhrs = [];
  win.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = String(url); }
    setRequestHeader() {}
    getResponseHeader() { return null; }
    getAllResponseHeaders() { return 'content-type: application/json\r\n'; }
    addEventListener() {}
    abort() {}
    send(body) {
      this.body = body;
      xhrs.push(this);
      setTimeout(() => {
        this.status = 200;
        this.statusText = 'OK';
        this.readyState = 4;
        this.responseText = JSON.stringify({ path: this.url.replace(ORIGIN, '').split('?')[0] });
        if (this.onload) this.onload();
      }, 1);
    }
  };

  const fetched = [];
  let registry = null;
  if (polyfill) {
    const Native = win.EventTarget;
    win.EventTarget = function EventTarget() { throw new win.TypeError('Illegal constructor'); };
    win.EventTarget.prototype = Native.prototype;
  } else {
    // A fetch of the TV's own (Chrome 42 and newer). On the legacy build that
    // is webOS 5 and 6 (Chrome 68 and 79), which also have Reflect: Babel's
    // `class extends EventTarget` constructs the real one through it, and
    // without it fails ("Class constructor EventTarget cannot be invoked
    // without 'new'"), which no TV does.
    if (!modern) {
      win.Reflect = reflect;
      // ...and a constructible EventTarget (Chrome 64 and newer), which the
      // Chrome 38 environment takes away.
      win.EventTarget = eventTarget;
    }
    win.Request = Request;
    win.Response = Response;
    win.Headers = Headers;
    win.FileReader = nodeBlobFileReader(win);
    win.fetch = function fetch(resource, init) {
      const url = resource instanceof Request ? resource.url : String(resource);
      const call = { url, resource, init, self: this };
      fetched.push(call);
      const p = url.replace(ORIGIN, '').split('?')[0];
      if (p === '/empty') return Promise.resolve(new Response(null, { status: 204 }));
      if (p === '/error') return Promise.resolve(new Response('{}', { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify({ path: p }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    // The registry, as the Tracking Block registers its request listener.
    const add = win.EventTarget.prototype.addEventListener;
    win.EventTarget.prototype.addEventListener = function (type) {
      if (type === 'request' && !(this instanceof win.Node) && this !== win) registry = this;
      return add.apply(this, arguments);
    };
  }
  let threw = null;
  try { win.eval(code); } catch (e) { threw = e; }
  return { win, errors, debug, info, xhrs, fetched, registry: () => registry, threw };
}

// What a call to window.fetch came to: { res, body } or { error }.
async function call(win, resource, init) {
  try {
    const res = await win.fetch(resource, init);
    let body = null;
    try { body = await res.text(); } catch (e) { body = 'unreadable: ' + e.message; }
    return { res, body };
  } catch (error) {
    return { error };
  }
}
const isFailedToFetch = (win, r) => !!r.error && r.error instanceof win.TypeError && r.error.message === 'Failed to fetch';
const describe = (r) => r.error ? 'rejected: ' + r.error : `resolved ${r.res && r.res.status}: ${r.body}`;

function toggleTrackingBlock(win) {
  const doc = win.document;
  if (!doc.querySelector('.ytaf-ui-container')) {
    trustedKey(win, GREEN);
  }
  const panel = doc.querySelector('.ytaf-ui-container');
  if (!panel) throw new Error('the settings panel did not open');
  for (let i = 0; i < 20; i++) panel.ensurePage(i);
  const labels = panel.querySelectorAll('label');
  let row = null;
  for (let i = 0; i < labels.length; i++) if (labels[i].textContent.trim() === TRACKING_LABEL) row = labels[i];
  if (!row) throw new Error('no "' + TRACKING_LABEL + '" switch in the panel');
  const input = row.querySelector('input');
  input.checked = !input.checked;
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  return input.checked;
}

// The number the registry gave its last logged request ("Request 3:").
function lastRequestNo(debug) {
  for (let i = debug.length - 1; i >= 0; i--) {
    const m = /^Request (\d+):$/.exec(String(debug[i][0]));
    if (m) return +m[1];
  }
  return -1;
}
const debugLine = (debug, prefix) => debug.find((a) => String(a[0]).indexOf(prefix) === 0);

async function nativeFetchTv() {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}, own fetch: ${s}`;
  const env = boot({ polyfill: false });
  const { win, fetched } = env;
  await wait(300);
  t(n('the bundle loads'), !env.threw, env.threw && String(env.threw.stack || env.threw));
  const reg = env.registry();
  t(n('window.fetch is the registry\'s, not the TV\'s'), win.fetch.name !== 'fetch');
  t(n('the Tracking Block registers a request listener'), !!reg);
  if (!reg) return;

  // ---- The Tracking Block's request listener ----
  let before = fetched.length;
  let r = await call(win, '/youtubei/v1/log_event?alt=json', { method: 'POST', body: '{}' });
  t(n('a telemetry request is cancelled: TypeError "Failed to fetch"'), isFailedToFetch(win, r), describe(r));
  t(n('...and never reaches the TV\'s fetch'), fetched.length === before, fetched.slice(before).map((c) => c.url).join(' '));
  t(n('...and the cancel is logged'), env.info.some((l) => /Fetch request \d+ was cancelled by listener/.test(l)));
  before = fetched.length;
  r = await call(win, new Request(ORIGIN + '/api/stats/qoe?docid=x', { method: 'POST', body: 'q' }));
  t(n('a telemetry Request object is cancelled too'), isFailedToFetch(win, r) && fetched.length === before, describe(r));
  before = fetched.length;
  r = await call(win, '/youtubei/v1/browse?key=1', { method: 'POST' });
  t(n('any other request reaches the TV\'s fetch, called on the window'),
    fetched.length === before + 1 && fetched[before].url === '/youtubei/v1/browse?key=1' && fetched[before].self === win,
    fetched.slice(before).map((c) => c.url).join(' '));
  t(n('...and the caller reads its answer'), !r.error && r.res.status === 200 && r.body === '{"path":"/youtubei/v1/browse"}', describe(r));
  r = await call(win, '/signin?next=%2Fptracking');
  t(n('a telemetry path in the query only: let through'), !r.error, describe(r));

  // ---- What a request listener is given ----
  const seen = [];
  const onRequest = (evt) => seen.push(evt.detail);
  reg.addEventListener('request', onRequest);
  const init = { method: 'POST', body: 'b' };
  await call(win, '/youtubei/v1/next?v=1', init);
  let d = seen[seen.length - 1] || {};
  t(n('request listener, a string: the URL resolved against the page'),
    d.url instanceof win.URL && d.url.href === ORIGIN + '/youtubei/v1/next?v=1', d.url && d.url.href);
  t(n('...the resource and init as the caller passed them'), d.resource === '/youtubei/v1/next?v=1' && d.init === init);
  const req = new Request('https://example.com/a/b?c=d', { method: 'PUT', body: 'x' });
  await call(win, req);
  d = seen[seen.length - 1] || {};
  t(n('request listener, a Request: its URL, the Request itself, no init'),
    d.url && d.url.href === 'https://example.com/a/b?c=d' && d.resource === req && d.init === undefined,
    d.url && d.url.href);
  const asUrl = new win.URL('/x?y=1', ORIGIN);
  await call(win, asUrl);
  d = seen[seen.length - 1] || {};
  t(n('request listener, a URL object: read by its toString'), d.url && d.url.href === ORIGIN + '/x?y=1' && d.resource === asUrl);

  // A listener of its own cancelling a request.
  const cancelNext = (evt) => { if (evt.detail.url.pathname === '/youtubei/v1/next') evt.preventDefault(); };
  reg.addEventListener('request', cancelNext);
  before = fetched.length;
  r = await call(win, '/youtubei/v1/next?v=2');
  t(n('a request listener\'s preventDefault cancels it: TypeError "Failed to fetch"'), isFailedToFetch(win, r), describe(r));
  t(n('...and the TV\'s fetch is not called'), fetched.length === before);
  reg.removeEventListener('request', cancelNext);
  r = await call(win, '/youtubei/v1/next?v=3');
  t(n('that listener removed: the request goes through'), !r.error && r.res.status === 200, describe(r));

  // ---- Response listeners ----
  const responses = [];
  const onResponse = (evt) => responses.push(evt.detail);
  reg.addEventListener('response', onResponse);
  r = await call(win, '/youtubei/v1/player');
  t(n('a response listener sees the response the TV\'s fetch returned'),
    responses.length === 1 && responses[0] instanceof Response && responses[0].status === 200 && responses[0] === r.res,
    `${responses.length} seen`);
  t(n('...and the caller still reads its body'), r.body === '{"path":"/youtubei/v1/player"}', describe(r));
  const cancel500 = (evt) => { if (evt.detail.status >= 500) evt.preventDefault(); };
  reg.addEventListener('response', cancel500);
  before = fetched.length;
  r = await call(win, '/error');
  t(n('a response listener\'s preventDefault cancels it: TypeError "Failed to fetch"'), isFailedToFetch(win, r), describe(r));
  t(n('...after the request was made'), fetched.length === before + 1);
  t(n('...and the cancel is logged'), env.info.some((l) => /Fetch response \d+ was cancelled by listener/.test(l)));
  r = await call(win, '/youtubei/v1/player');
  t(n('a response it lets be: the caller gets it'), !r.error && r.res.status === 200, describe(r));
  reg.removeEventListener('response', cancel500);
  r = await call(win, '/error');
  t(n('that listener removed: the 500 reaches the caller'), !r.error && r.res.status === 500, describe(r));

  // ---- Removed listeners are no longer called ----
  reg.removeEventListener('request', onRequest);
  reg.removeEventListener('response', onResponse);
  const seenBefore = seen.length, responsesBefore = responses.length;
  await call(win, '/youtubei/v1/guide');
  t(n('removed request and response listeners are not called'), seen.length === seenBefore && responses.length === responsesBefore);

  // ---- No listeners: straight to the TV's fetch ----
  t(n('the Tracking Block switched off in the panel'), toggleTrackingBlock(win) === false);
  before = fetched.length;
  r = await call(win, '/youtubei/v1/log_event?alt=json', { method: 'POST' });
  t(n('...telemetry then reaches the TV\'s fetch'), !r.error && fetched.length === before + 1, describe(r));
  // The registry numbers the requests it handled itself; one that went
  // straight through is not counted. Its number shows in the debug log.
  win.__ytaf_debug__ = true;
  await call(win, '/probe1');
  win.__ytaf_debug__ = false;
  const no1 = lastRequestNo(env.debug);
  before = fetched.length;
  const opts = { method: 'POST', body: 'p' };
  for (let i = 0; i < 3; i++) await call(win, '/youtubei/v1/browse', opts);
  t(n('no listeners: each request reaches the TV\'s fetch as passed'),
    fetched.length === before + 3 && fetched.slice(before).every((c) => c.resource === '/youtubei/v1/browse' && c.init === opts));
  win.__ytaf_debug__ = true;
  await call(win, '/probe2');
  win.__ytaf_debug__ = false;
  const no2 = lastRequestNo(env.debug);
  t(n('...without passing through the registry (its count does not move)'), no1 >= 0 && no2 === no1 + 1,
    `request numbers ${no1} then ${no2}`);
  // A response listener alone takes the registry's path again.
  const late = [];
  const onLate = (evt) => late.push(evt.detail);
  reg.addEventListener('response', onLate);
  await call(win, '/youtubei/v1/browse');
  t(n('a response listener alone is still called'), late.length === 1);
  reg.removeEventListener('response', onLate);
  // Added in both capture modes, removed in one: the browser keeps the other,
  // and the registry must still dispatch to it.
  const kept = [];
  const onKept = (evt) => kept.push(evt.detail);
  reg.addEventListener('request', onKept);
  reg.addEventListener('request', onKept, { capture: true });
  reg.removeEventListener('request', onKept);
  await call(win, '/youtubei/v1/browse');
  t(n('a request listener left in its capture registration is still called'), kept.length === 1, kept.length);
  reg.removeEventListener('request', onKept, true);
  win.__ytaf_debug__ = true;
  await call(win, '/probe3');
  win.__ytaf_debug__ = false;
  const kept3 = lastRequestNo(env.debug);
  before = fetched.length;
  r = await call(win, '/youtubei/v1/browse');
  t(n('...the request then still reaches the TV\'s fetch'), !r.error && fetched.length === before + 1,
    r.error || fetched.length - before);
  t(n('...and not once that one is removed too'), kept.length === 1, kept.length);
  win.__ytaf_debug__ = true;
  await call(win, '/probe4');
  win.__ytaf_debug__ = false;
  const kept4 = lastRequestNo(env.debug);
  t(n('...and with no listener left, requests go straight through again (the count does not move)'),
    kept3 >= 0 && kept4 === kept3 + 1, `request numbers ${kept3} then ${kept4}`);
  // Options inherited from a prototype count too: a `once` given so runs once.
  const inherited = [];
  const onInherited = (evt) => inherited.push(evt.detail);
  reg.addEventListener('request', onInherited, Object.create({ once: true }));
  await call(win, '/youtubei/v1/browse');
  await call(win, '/youtubei/v1/browse');
  t(n('a request listener added with an inherited once runs once'), inherited.length === 1, inherited.length);
  reg.removeEventListener('request', onInherited);

  // ---- window.__ytaf_debug__: the bodies in the log ----
  win.__ytaf_debug__ = true;
  env.debug.length = 0;
  let readByFetch = null;
  const posted = new Request(ORIGIN + '/youtubei/v1/log', { method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' } });
  before = fetched.length;
  r = await call(win, posted);
  const reached = fetched[before];
  if (reached && reached.resource instanceof Request) {
    try { readByFetch = await reached.resource.text(); } catch (e) { readByFetch = 'unreadable: ' + e.message; }
  }
  const no = lastRequestNo(env.debug);
  const reqLine = debugLine(env.debug, `Request ${no}:`);
  t(n('debug: the request is logged'), !!reqLine && reqLine[1] === posted);
  const reqBody = debugLine(env.debug, `Request Body ${no}:`);
  t(n('debug: the request body is logged, as a data: URL'),
    !!reqBody && reqBody[1] === 'data:text/plain;base64,' + b64('hello'), reqBody && reqBody[1]);
  t(n('...and the body still reaches the TV\'s fetch'), readByFetch === 'hello', String(readByFetch));
  const resLine = debugLine(env.debug, `Response ${no}:`);
  t(n('debug: the response is logged'), !!resLine && resLine[1] === r.res);
  const resBody = debugLine(env.debug, `Response Body ${no}:`);
  t(n('debug: the response body is logged, as a data: URL'),
    !!resBody && resBody[1] === 'data:application/json;base64,' + b64('{"path":"/youtubei/v1/log"}'), resBody && resBody[1]);
  t(n('...and the caller still reads it'), r.body === '{"path":"/youtubei/v1/log"}', describe(r));

  env.debug.length = 0;
  const strInit = { method: 'POST', body: 's' };
  r = await call(win, '/empty', strInit);
  const no3 = lastRequestNo(env.debug);
  const optsLine = debugLine(env.debug, `Options  ${no3}:`);
  t(n('debug, a string and init: both logged'), !!debugLine(env.debug, `Request ${no3}:`) && !!optsLine && optsLine[1] === strInit);
  t(n('debug, an empty body: no body line'), !r.error && r.res.status === 204 &&
    !debugLine(env.debug, 'Request Body') && !debugLine(env.debug, 'Response Body'),
    env.debug.map((a) => a[0]).join(' | '));
  // A body that cannot be read for the dump: the request goes out all the same.
  const unreadable = new Request(ORIGIN + '/youtubei/v1/unreadable', { method: 'POST', body: 'x' });
  unreadable.clone = () => { throw new Error('no clone'); };
  before = fetched.length;
  r = await call(win, unreadable);
  t(n('debug: a body that cannot be dumped does not stop the request'), !r.error && fetched.length === before + 1 &&
    fetched[before].resource === unreadable, describe(r));
  // Dumping a body is diagnostic only: FileReader failures cannot block fetch.
  const GoodReader = win.FileReader;
  for (const failure of ['error', 'abort', 'throw']) {
    win.FileReader = class extends win.EventTarget {
      readAsDataURL() {
        if (failure === 'throw') throw new Error('unreadable blob');
        // In a microtask, with no timer a busy runner could hold back.
        Promise.resolve().then(() => this.dispatchEvent(new win.Event(failure)));
      }
    };
    const brokenDump = new Request(ORIGIN + '/reader-failure', { method: 'POST', body: 'keep this body' });
    before = fetched.length;
    env.debug.length = 0;
    const result = await Promise.race([
      call(win, brokenDump),
      // Only for a request that never ends: everything above settles in microtasks.
      wait(5000).then(() => ({ error: new Error('debug dump stalled fetch') }))
    ]);
    t(n(`debug, FileReader ${failure}: request and response still delivered`),
      !result.error && fetched.length === before + 1 && result.body === '{"path":"/reader-failure"}', describe(result));
    t(n('...and no body line is logged for a read that failed'),
      !debugLine(env.debug, 'Request Body') && !debugLine(env.debug, 'Response Body'), env.debug.map((a) => a[0]).join(' | '));
  }
  win.FileReader = GoodReader;
  win.__ytaf_debug__ = false;

  // ---- The Tracking Block back on ----
  t(n('the Tracking Block switched on again'), toggleTrackingBlock(win) === true);
  before = fetched.length;
  r = await call(win, '/youtubei/v1/log_event?alt=json', { method: 'POST' });
  t(n('...telemetry is cancelled again'), isFailedToFetch(win, r) && fetched.length === before, describe(r));

  t(n('no console.error / jsdomError'), env.errors.length === 0, env.errors.slice(0, 3).join(' || '));
  win.close();
}

async function webos3() {
  const n = (s) => `legacy, webOS 3 (polyfill): ${s}`;
  const env = boot({ polyfill: true });
  const { win, xhrs } = env;
  await wait(300);
  t(n('the bundle loads'), !env.threw, env.threw && String(env.threw.stack || env.threw));
  t(n('the polyfill\'s fetch, Request and Response are in'), typeof win.fetch === 'function' &&
    typeof win.Request === 'function' && typeof win.Response === 'function');
  t(n('the Tracking Block\'s fetch hook went in'), !env.info.concat(env.errors).some((l) => /Fetch hook failed/.test(l)));

  const sent = (p) => xhrs.filter((x) => x.url.indexOf(p) !== -1).length;
  let r = await call(win, '/youtubei/v1/log_event?alt=json', { method: 'POST', body: '{}' });
  t(n('a telemetry request is cancelled: TypeError "Failed to fetch"'), isFailedToFetch(win, r), describe(r));
  t(n('...and no XMLHttpRequest is sent for it'), sent('log_event') === 0);
  r = await call(win, new win.Request(ORIGIN + '/ptracking?x=1'));
  t(n('a telemetry Request object is cancelled too'), isFailedToFetch(win, r) && sent('ptracking') === 0, describe(r));
  // The polyfill's Request keeps a relative URL as it was given: read against
  // the page, as the TV's own fetch would.
  r = await call(win, new win.Request('/api/stats/qoe?docid=y'));
  t(n('a telemetry Request with a relative URL is cancelled too'), isFailedToFetch(win, r) && sent('qoe') === 0, describe(r));
  r = await call(win, new win.Request('/youtubei/v1/guide', { method: 'POST', body: 'g' }));
  t(n('any other Request with a relative URL is sent'), !r.error && r.res.status === 200 &&
    r.body === '{"path":"/youtubei/v1/guide"}' && sent('/youtubei/v1/guide') === 1, describe(r));
  r = await call(win, '/youtubei/v1/browse', { method: 'POST', body: 'b' });
  const x = xhrs.find((q) => q.url.indexOf('/youtubei/v1/browse') !== -1);
  t(n('any other request is sent, method and body intact'), !!x && x.method === 'POST' && x.body === 'b');
  t(n('...and the caller reads its answer'), !r.error && r.res.status === 200 && r.body === '{"path":"/youtubei/v1/browse"}', describe(r));

  win.__ytaf_debug__ = true;
  env.debug.length = 0;
  r = await call(win, '/youtubei/v1/next');
  t(n('debug: request and response logged'), lastRequestNo(env.debug) >= 0 &&
    env.debug.some((a) => /^Response \d+:$/.test(String(a[0]))), env.debug.map((a) => a[0]).join(' | '));
  t(n('debug: the caller still reads the body'), r.body === '{"path":"/youtubei/v1/next"}', describe(r));
  // The bodies too, with the polyfill's Request and Response (their names
  // are minified away in the legacy bundle).
  env.debug.length = 0;
  r = await call(win, new win.Request(ORIGIN + '/youtubei/v1/log', { method: 'POST', body: 'hello' }));
  const no = lastRequestNo(env.debug);
  const reqBody = debugLine(env.debug, `Request Body ${no}:`);
  t(n('debug: the polyfill\'s request body is logged, as a data: URL'),
    !!reqBody && /^data:[^,]*;base64,/.test(reqBody[1]) && reqBody[1].split(',')[1] === b64('hello'), reqBody && reqBody[1]);
  const resBody = debugLine(env.debug, `Response Body ${no}:`);
  t(n('debug: the polyfill\'s response body is logged, as a data: URL'),
    !!resBody && /^data:[^,]*;base64,/.test(resBody[1]) && resBody[1].split(',')[1] === b64('{"path":"/youtubei/v1/log"}'),
    resBody && resBody[1]);
  t(n('...and the caller still reads it'), r.body === '{"path":"/youtubei/v1/log"}', describe(r));
  win.__ytaf_debug__ = false;

  t(n('the Tracking Block switched off in the panel'), toggleTrackingBlock(win) === false);
  r = await call(win, '/youtubei/v1/log_event?alt=json', { method: 'POST' });
  t(n('...telemetry is then sent'), !r.error && sent('log_event') === 1, describe(r));
  t(n('the Tracking Block switched on again'), toggleTrackingBlock(win) === true);
  r = await call(win, '/youtubei/v1/log_event?alt=json', { method: 'POST' });
  t(n('...telemetry is cancelled again'), isFailedToFetch(win, r) && sent('log_event') === 1, describe(r));

  t(n('no console.error / jsdomError'), env.errors.length === 0, env.errors.slice(0, 3).join(' || '));
  win.close();
}

run(async () => {
  await nativeFetchTv();
  if (!modern) await webos3();
});
