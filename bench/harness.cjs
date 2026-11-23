/**
 * What the bench tests share: the PASS/FAIL reporter, the jsdom page the
 * bundle runs in, fake XMLHttpRequests, a key press and the waits.
 *
 * HOW TO WRITE A NEW TEST
 *
 *   // bench/my-feature-test.cjs
 *   //   node bench/my-feature-test.cjs <bundle> [legacy|modern]
 *   const { createReporter, bootPage, trustedKey, until } = require('./harness.cjs');
 *   const { t, run } = createReporter();
 *
 *   run(async () => {
 *     const { win, doc, errors } = bootPage({
 *       bodyClass: 'WEB_PAGE_TYPE_WATCH',
 *       inner: '<video></video>',                 // inside <ytlr-app>
 *       config: { enableSponsorBlock: false },    // 'ytaf-configuration'
 *       fetch: 'pending'                          // requests never answer
 *     });
 *     trustedKey(win, 404);                       // the green button
 *     t('the panel opens', await until(() => doc.querySelector('.ytaf-ui-container')));
 *     t('no errors', errors.length === 0, errors[0]);
 *   });
 *
 * - t(name, ok, extra) prints `PASS name` or `FAIL name` with `extra` on the
 *   line under it; run() prints "N passed, M failed" at the end and exits 1
 *   on a failure (or when the test itself throws). bench/ci.sh shows a test's
 *   last line, and on a failure its FAIL lines with the line under each: so
 *   keep these formats, and put what was seen instead in `extra`.
 * - bootPage() reads the bundle and the build from the command line
 *   (<bundle> [legacy|modern]) unless `code` and `modern` are given: the
 *   legacy bundle runs with a webOS 3 user agent in the Chrome 38 environment
 *   of chrome38-env.cjs, the modern one with webOS 23 in the Chrome 87 one.
 *   What the page needs before the bundle runs goes in `setup` (before the
 *   environment takes the newer APIs away) or `beforeEval` (after it, e.g. a
 *   fetch of the test's own on the legacy build).
 * - Nothing here is required: a test with a setup of its own can use only
 *   the reporter, or only the pieces (silentXHR, trustedKey, wait, until).
 * - Add the test to bench/ci.sh: `run my-feature-test "$B" legacy`, and its
 *   name to the list run on the modern build.
 *
 * The bundle is read with fs.readFileSync, which the coverage run patches
 * (bench/coverage-preload.cjs), and the page is jsdom's JSDOM as it is when
 * bootPage() is called, which bench/late-injection-preload.cjs replaces.
 */
const fs = require('fs');
const path = require('path');
const jsdom = require('jsdom');
const {
  applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent, dispatchTrusted
} = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BUNDLE = path.join(ROOT, 'dist', 'webOSUserScripts', 'userScript.js');
const DEFAULT_URL = 'https://www.youtube.com/tv';

/* ------------------------------------------------------------------ */
/* Reporter                                                            */
/* ------------------------------------------------------------------ */

/**
 * The PASS/FAIL lines and the summary.
 *
 *   const { t, done, run } = createReporter();
 *   t('name', ok, extra);     // PASS name | FAIL name + "\n     extra"
 *   done();                   // "\nN passed, M failed", exit code 1 on a failure
 *
 * opts.prefix: put before every name ("legacy: name").
 * opts.summary(pass, fail): the last line, for a test whose summary reads
 * otherwise ("all 9 cases passed"); "N passed, M failed" by default.
 * `extra` is printed for a failure unless it is undefined, null, false or ''
 * (so `threw && threw.message` prints nothing when nothing threw, and a
 * count of 0 is printed).
 *
 * run(main) awaits main(), then done(); a throw or rejection is reported as
 * "FAIL harness: <stack>" with exit code 1.
 * counts() gives { pass, fail }.
 */
function createReporter(opts = {}) {
  const prefix = opts.prefix ? opts.prefix + ': ' : '';
  let pass = 0;
  let fail = 0;
  const t = (name, ok, extra) => {
    if (ok) {
      pass++;
      console.log('PASS ' + prefix + name);
    } else {
      fail++;
      const shown = extra !== undefined && extra !== null && extra !== false && extra !== '';
      console.log('FAIL ' + prefix + name + (shown ? '\n     ' + extra : ''));
    }
  };
  const done = () => {
    console.log('\n' + (opts.summary ? opts.summary(pass, fail) : `${pass} passed, ${fail} failed`));
    process.exit(fail ? 1 : 0);
  };
  const crashed = (e) => {
    console.log('FAIL harness: ' + ((e && e.stack) || e));
    process.exit(1);
  };
  const run = (main) => {
    let result;
    try { result = main(); } catch (e) { return crashed(e); }
    return Promise.resolve(result).then(done, crashed);
  };
  return { t, done, run, counts: () => ({ pass, fail }) };
}

/* ------------------------------------------------------------------ */
/* Command line and bundle                                             */
/* ------------------------------------------------------------------ */

/**
 * `node bench/x-test.cjs <bundle> [legacy|modern]` as bench/ci.sh runs the
 * tests: { bundlePath, modern, flavor } with flavor 'legacy' or 'modern'.
 * Without a path, the bundle of the last build.
 */
function flavorFromArgs(argv = process.argv) {
  const modern = argv[3] === 'modern';
  return { bundlePath: argv[2] || DEFAULT_BUNDLE, modern, flavor: modern ? 'modern' : 'legacy' };
}

/** The bundle's text (of the command line's path by default). */
function readBundle(bundlePath = flavorFromArgs().bundlePath) {
  return fs.readFileSync(bundlePath, 'utf8');
}

/* ------------------------------------------------------------------ */
/* Fake XMLHttpRequests                                                */
/* ------------------------------------------------------------------ */

/** An XMLHttpRequest that never answers. */
function silentXHR() {
  return class {
    open() {}
    send() {}
    setRequestHeader() {}
    getResponseHeader() { return null; }
    addEventListener() {}
  };
}

/** An XMLHttpRequest that fails at once (onerror), as with no network. */
function failingXHR() {
  return class {
    open() {}
    send() { if (this.onerror) this.onerror(); }
    setRequestHeader() {}
    getResponseHeader() { return null; }
    addEventListener() {}
  };
}

/**
 * An XMLHttpRequest the test answers: answer(request) is called at send()
 * with the request ({ method, url, body, headers }) and returns
 *   undefined / null          never answers
 *   a string                  200 with that responseText
 *   { status, body, headers } that answer (status 200, body '' by default)
 *   { network: true }         onerror
 *   { timeout: true }         ontimeout
 * `delay` ms later (5 by default). Every request sent is pushed to
 * `requests` (an array of the test's, or the class's own `.requests`).
 */
function routedXHR(answer, opts = {}) {
  const delay = opts.delay === undefined ? 5 : opts.delay;
  const requests = opts.requests || [];
  const Fake = class {
    constructor() { this.headers = {}; this.readyState = 0; }
    open(method, url) { this.method = method; this.url = String(url); }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader(name) {
      const own = this.responseHeaders || {};
      const key = Object.keys(own).find((k) => k.toLowerCase() === String(name).toLowerCase());
      return key ? own[key] : null;
    }
    getAllResponseHeaders() {
      const own = this.responseHeaders || {};
      return Object.keys(own).map((k) => `${k}: ${own[k]}\r\n`).join('');
    }
    addEventListener(type, fn) { this['on' + type] = fn; }
    abort() { this.aborted = true; }
    send(body) {
      this.body = body;
      requests.push(this);
      const a = answer(this);
      if (a === undefined || a === null) return;
      setTimeout(() => {
        if (this.aborted) return;
        if (a.network) { if (this.onerror) this.onerror(); return; }
        if (a.timeout) { if (this.ontimeout) this.ontimeout(); return; }
        this.status = typeof a === 'string' ? 200 : a.status || 200;
        this.statusText = this.status === 200 ? 'OK' : '';
        this.responseHeaders = (typeof a === 'object' && a.headers) || {};
        this.responseText = typeof a === 'string' ? a : a.body || '';
        this.response = this.responseText;
        this.readyState = 4;
        if (this.onreadystatechange) this.onreadystatechange();
        if (this.onload) this.onload();
        if (this.onloadend) this.onloadend();
      }, delay);
    }
  };
  Fake.requests = requests;
  return Fake;
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

/**
 * Animation frames the test runs itself: install(win) replaces
 * requestAnimationFrame with a queue, pump() runs what is queued (the
 * callbacks queued meanwhile wait for the next pump) and returns how many.
 * `time`: the timestamp every callback gets (the time of the pump by default).
 */
function manualFrames(time) {
  let queue = [];
  return {
    install(win) {
      win.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
      win.cancelAnimationFrame = () => {};
    },
    pump() {
      const q = queue;
      queue = [];
      for (const cb of q) cb(time === undefined ? Date.now() : time);
      return q.length;
    },
    pending: () => queue.length
  };
}

/**
 * The user agent and the environment of a build: webOS 23 in Chrome 87
 * (modern) or webOS 3 in Chrome 38 (legacy), as chrome38-env.cjs makes them.
 * opts.userAgent: another user agent; opts.restoreRemove (true by default):
 * put Element#remove back, which Chrome 23 has and the Chrome 38 environment
 * takes away all the same. Returns the names of what the legacy environment
 * removed.
 */
function applyEnvironment(win, modern, opts = {}) {
  if (opts.userAgent !== false) setUserAgent(win, opts.userAgent || (modern ? UA.webos23 : UA.webos3));
  const removed = modern ? (applyChrome87Downgrade(win), []) : applyChrome38Downgrade(win);
  if (opts.restoreRemove !== false) restoreRemove(win);
  return removed;
}

/** Element#remove, as Chrome 23 and newer have it. */
function restoreRemove(win) {
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
}

/**
 * A jsdom page with the bundle evaluated in it. Every option has a default;
 * the steps run in this order:
 *
 *  1. the page: `html` (a whole document), or one built from `head`,
 *     `bodyClass` ('WEB_PAGE_TYPE_BROWSE') and `inner` (inside <ytlr-app>);
 *     `url` ('https://www.youtube.com/tv'). jsdom options as in every test:
 *     runScripts 'outside-only', pretendToBeVisual.
 *     Errors go to `errors`: page script errors as 'jsdomError: <message>'
 *     (not those matching `ignoreErrors`, a RegExp; `ignoreNavigation: true`
 *     for jsdom's "Not implemented: navigation"), console.error as
 *     'console.error: <text>' (`consoleErrors: false` leaves these out).
 *     `onError(text)` is called for each. `console: { info(...args) {}, .. }`
 *     listens to other console levels.
 *  2. the user agent of the build (`modern`; `userAgent` for another).
 *  3. stubs: `launchParams` ('{}'; null for none), `webOS` (none; true for a
 *     small one), `xhr` (an XMLHttpRequest class, silentXHR() by default,
 *     false to keep jsdom's), `raf` ('keep' jsdom's by default; 'timer': a
 *     0 ms timeout; 'manual': the test runs them with the returned
 *     frames.pump(), each callback getting `frameTime` if given; 'none':
 *     no frame ever runs; a function: the page's requestAnimationFrame).
 *  4. localStorage: `config` as 'ytaf-configuration' (JSON), `storage`
 *     ({ key: string }) as it is.
 *  5. `setup(win)`: anything else before the environment is applied.
 *  6. the environment of the build (applyEnvironment; `restoreRemove`).
 *     On the legacy build this takes fetch, Reflect, Proxy and more away.
 *     `environment: false` leaves jsdom as it is (no API taken away, and
 *     Element#remove untouched), for a test of something the environment
 *     would remove.
 *  7. `fetch`: 'pending' (never answers) or a function, set after the
 *     environment, so it is the TV's own fetch on both builds. Left out,
 *     the legacy bundle uses its polyfill over XMLHttpRequest.
 *  8. `beforeEval(win)`: anything else just before the bundle.
 *  9. the bundle: `code`, or read from `bundlePath`, or from the command
 *     line (flavorFromArgs). `evaluate: false` leaves it to the test
 *     (result.evaluate()). With `catchThrow: true` an exception from the
 *     bundle is returned as `threw` instead of thrown.
 *
 * Returns { win, doc, dom, errors, threw, removed, frames, evaluate }.
 */
function bootPage(opts = {}) {
  const args = flavorFromArgs();
  const modern = opts.modern === undefined ? args.modern : !!opts.modern;

  // 1. the page
  const errors = opts.errors || [];
  const report = (text) => {
    errors.push(text);
    if (opts.onError) opts.onError(text);
  };
  const ignore = opts.ignoreErrors || (opts.ignoreNavigation ? /Not implemented: navigation/ : null);
  const virtualConsole = new jsdom.VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (ignore && ignore.test(e.message)) return;
    report('jsdomError: ' + (opts.errorStacks ? e.stack || e.message : e.message));
  });
  if (opts.consoleErrors !== false) {
    virtualConsole.on('error', (...a) => report('console.error: ' + a.map(String).join(' ')));
  }
  for (const level of Object.keys(opts.console || {})) virtualConsole.on(level, opts.console[level]);

  const html = opts.html !== undefined ? opts.html :
    `<!doctype html><html><head>${opts.head || ''}</head>` +
    `<body class="${opts.bodyClass === undefined ? 'WEB_PAGE_TYPE_BROWSE' : opts.bodyClass}">` +
    `<ytlr-app>${opts.inner || ''}</ytlr-app></body></html>`;
  const dom = new jsdom.JSDOM(html, {
    runScripts: 'outside-only',
    url: opts.url || DEFAULT_URL,
    virtualConsole,
    pretendToBeVisual: true
  });
  const win = dom.window;

  // 2. the user agent
  setUserAgent(win, opts.userAgent || (modern ? UA.webos23 : UA.webos3));

  // 3. stubs
  if (opts.launchParams !== null) win.launchParams = opts.launchParams === undefined ? '{}' : opts.launchParams;
  if (opts.webOS) {
    win.webOS = opts.webOS === true ?
      { deviceInfo: (cb) => cb({ modelName: 'sim' }), platformBack: () => {} } : opts.webOS;
  }
  if (opts.xhr !== false) win.XMLHttpRequest = opts.xhr || silentXHR();
  let frames = null;
  if (opts.raf === 'timer') {
    win.requestAnimationFrame = (cb) => win.setTimeout(() => cb(Date.now()), 0);
    win.cancelAnimationFrame = () => {};
  } else if (opts.raf === 'manual') {
    frames = manualFrames(opts.frameTime);
    frames.install(win);
  } else if (opts.raf === 'none') {
    win.requestAnimationFrame = () => 0;
    win.cancelAnimationFrame = () => {};
  } else if (typeof opts.raf === 'function') {
    win.requestAnimationFrame = opts.raf;
    win.cancelAnimationFrame = () => {};
  }

  // 4. localStorage
  if (opts.config) win.localStorage.setItem('ytaf-configuration', JSON.stringify(opts.config));
  for (const key of Object.keys(opts.storage || {})) win.localStorage.setItem(key, opts.storage[key]);

  // 5. the test's own setup
  if (opts.setup) opts.setup(win);

  // 6. the environment
  const removed = opts.environment === false ? [] :
    applyEnvironment(win, modern, { userAgent: false, restoreRemove: opts.restoreRemove });

  // 7. fetch
  if (opts.fetch === 'pending') win.fetch = () => new Promise(() => {});
  else if (opts.fetch) win.fetch = opts.fetch;

  // 8. just before the bundle
  if (opts.beforeEval) opts.beforeEval(win);

  // 9. the bundle
  const page = { win, doc: win.document, dom, errors, threw: null, removed, frames };
  page.evaluate = () => {
    const code = opts.code !== undefined ? opts.code : readBundle(opts.bundlePath || args.bundlePath);
    if (!opts.catchThrow) { win.eval(code); return page; }
    try { win.eval(code); } catch (e) { page.threw = e; }
    return page;
  };
  if (opts.evaluate !== false) page.evaluate();
  return page;
}

/* ------------------------------------------------------------------ */
/* Keys and waits                                                      */
/* ------------------------------------------------------------------ */

/**
 * A key of the remote, as a trusted event (the app ignores untrusted ones):
 * `code` is the keyCode (404 green, 461 back, 13 OK, 37-40 the arrows).
 * target: document.body by default; type: 'keydown' by default; init: more
 * for the KeyboardEvent ({ repeat: true, key: 'a', ctrlKey: true }),
 * init.props, own properties set on the event before it is sent
 * ({ __ytafSynthetic: true } for a key the app made itself), and
 * init.isTrusted, another value for the flag (undefined: a press on Chrome 38,
 * which has none). Returns the event: its defaultPrevented says whether the
 * app took the press.
 */
function trustedKey(win, code, target, type = 'keydown', init) {
  const options = Object.assign({ bubbles: true, cancelable: true }, init);
  const props = options.props;
  delete options.props;
  const hasTrusted = 'isTrusted' in options;
  const trusted = options.isTrusted;
  delete options.isTrusted;
  const event = new win.KeyboardEvent(type, options);
  Object.defineProperty(event, 'keyCode', { get: () => code, configurable: true });
  if (props) {
    for (const name of Object.keys(props)) Object.defineProperty(event, name, { value: props[name], configurable: true });
  }
  // No target given: the page's body. A target that was looked for and is
  // missing (null) throws, so a test does not carry on with a press nothing took.
  const where = target === undefined ? win.document.body : target;
  if (hasTrusted) dispatchTrusted(where, event, trusted);
  else dispatchTrusted(where, event);
  return event;
}

/** Resolves after `ms` (node's timer, not the page's). */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls cond() every `step` ms: resolves true as soon as it is truthy, false
 * after `timeout` ms.
 */
function until(cond, timeout = 3000, step = 10) {
  const end = Date.now() + timeout;
  const poll = () => (cond() ? Promise.resolve(true) :
    Date.now() >= end ? Promise.resolve(false) : wait(step).then(poll));
  return poll();
}

module.exports = {
  ROOT,
  DEFAULT_BUNDLE,
  createReporter,
  flavorFromArgs,
  readBundle,
  silentXHR,
  failingXHR,
  routedXHR,
  manualFrames,
  applyEnvironment,
  restoreRemove,
  bootPage,
  trustedKey,
  wait,
  until,
  // chrome38-env.cjs, for a test that sets its page up itself.
  UA,
  setUserAgent,
  dispatchTrusted
};
