/**
 * Launch parameters in the userscript (src/launch.js): where a relaunch with
 * a target sends the app (a video, a same-origin address, a voice search, the
 * kids theme), and how the launch parameters the app started with are read
 * (Start Page leaves a launch with a target alone, and a broken parameter
 * string counts as none).
 *
 *   node bench/launch-params-test.cjs <bundle> [legacy|modern]
 *
 * launch-test runs dist/index.js (the launcher page); in the userscript only
 * smoke's two relaunches reached handleLaunch. The address each relaunch
 * navigates to is read from jsdom's Location, whose navigation the test
 * replaces with a recorder (jsdom itself does not navigate).
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// jsdom's wrapper -> implementation map (its path moved in jsdom 30), and the
// URL serializer of the whatwg-url copy jsdom uses.
function jsdomUtils() {
  for (const p of ['jsdom/lib/generated/idl/utils.js', 'jsdom/lib/jsdom/living/generated/utils.js']) {
    try { return require(p); } catch { /* the next layout */ }
  }
  throw new Error('jsdom internals not found');
}
const { serializeURL } = require(require.resolve('whatwg-url', { paths: [path.dirname(require.resolve('jsdom/package.json'))] }));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

const ENV = ['env_forceFullAnimation', 'env_enableWebSpeech', 'env_enableVoice'];

/** The bundle started with `launchParams` (a string, or undefined for none). */
function boot(launchParams, cfg = {}) {
  const errors = [];
  const logs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  for (const level of ['info', 'log', 'warn']) vc.on(level, (...a) => logs.push(level + ' ' + a.map(String).join(' ')));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  if (launchParams !== undefined) win.launchParams = launchParams;
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.fetch = () => new Promise(() => {});
  win.requestAnimationFrame = (cb) => win.setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false, enableDeArrow: false,
    upgradeThumbnails: false, enableAutoLogin: false, checkForUpdates: false, showWhatsNew: false
  }, cfg)));
  const navigations = [];
  jsdomUtils().implForWrapper(win.location)._locationObjectSetterNavigate = (url) => { navigations.push(serializeURL(url)); };
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.eval(code);

  // A relaunch: the address it navigated to, or null for none.
  const relaunch = (detail) => {
    const before = navigations.length;
    win.document.dispatchEvent(new win.CustomEvent('webOSRelaunch', { detail }));
    return navigations.length > before ? new URL(navigations[navigations.length - 1]) : null;
  };
  return { win, errors, logs, navigations, relaunch };
}

// The parameters of a URL as "k=v" in order.
const params = (url) => (url ? [...url.searchParams].map(([k, v]) => `${k}=${v}`) : []);
const yt = (url) => !!url && url.origin === 'https://www.youtube.com' && url.pathname === '/tv' && url.hash === '#/';
const envFlags = () => ENV.map((k) => `${k}=1`);

(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  const env = boot('{}');
  await sleep(200);
  const go = env.relaunch;

  {
    const url = go({ contentTarget: 'v=dQw4w9WgXcQ' });
    t(n('a video: YouTube TV with the video, after the app\'s own flags'), yt(url) &&
      params(url).join('&') === envFlags().concat('v=dQw4w9WgXcQ').join('&'), url && url.href);
  }
  {
    const url = go({ contentTarget: 'v=v=dQw4w9WgXcQ' });
    t(n('"v=v=" from some launchers: one v'), yt(url) && url.searchParams.getAll('v').join() === 'dQw4w9WgXcQ', url && url.href);
  }
  {
    const url = go({ contentTarget: 'v=abc&list=PL1&t=30' });
    t(n('a video in a playlist at a time: all three kept'), yt(url) &&
      params(url).slice(3).join('&') === 'v=abc&list=PL1&t=30', url && url.href);
  }
  {
    const url = go({ target: 'v=fromTarget' });
    t(n('target alone counts as the content target'), yt(url) && url.searchParams.get('v') === 'fromTarget', url && url.href);
  }
  {
    const url = go({ target: 'v=a', contentTarget: 'v=b' });
    t(n('contentTarget wins over target'), yt(url) && url.searchParams.getAll('v').join() === 'b', url && url.href);
  }
  {
    const url = go({ contentTarget: 'https://www.youtube.com/tv?v=abc&t=5#/watch' });
    t(n('a YouTube address: opened as it is'), !!url && url.href === 'https://www.youtube.com/tv?v=abc&t=5#/watch', url && url.href);
  }
  {
    const url = go({ contentTarget: 'https://evil.example/tv?v=abc' });
    t(n('an address elsewhere: not followed, YouTube TV opens'), yt(url) && url.hostname === 'www.youtube.com' &&
      ENV.every((k) => url.searchParams.get(k) === '1'), url && url.href);
  }
  {
    const url = go({ contentTarget: { intent: 'PlayContent', intentParam: 'lofi beats' } });
    t(n('a voice "play": inApp, vs, va=play, launch=voice and the query'), yt(url) &&
      params(url).slice(3).join('&') === 'inApp=true&vs=9&va=play&launch=voice&vq=lofi beats', url && url.href);
  }
  {
    const url = go({ contentTarget: { intent: 'SearchContent', intentParam: 'cats' } });
    t(n('a voice search: launch=voice and launch=search'), yt(url) && url.searchParams.get('va') === 'search' &&
      url.searchParams.getAll('launch').join() === 'voice,search' && url.searchParams.get('vq') === 'cats', url && url.href);
  }
  {
    const url = go({ contentTarget: { intent: 'PlayContent' } });
    t(n('a voice launch without a query: no vq'), yt(url) && !url.searchParams.has('vq') &&
      url.searchParams.get('va') === 'play', url && url.href);
  }
  {
    const url = go({ contentTarget: { intent: 'Play', intentParam: 'x' } });
    t(n('an intent not ending in Content: no va'), yt(url) && !url.searchParams.has('va') &&
      url.searchParams.getAll('launch').join() === 'voice' && url.searchParams.get('vq') === 'x', url && url.href);
  }
  {
    const url = go({ contentTarget: { intent: 42, intentParam: 'y' } });
    t(n('an intent that is not text: no va, the launch still voice'), yt(url) && !url.searchParams.has('va') &&
      url.searchParams.get('launch') === 'voice', url && url.href);
  }
  {
    const url = go({ contentTarget: 'theme=k&v=kid' });
    t(n('the kids theme: without the app\'s flags'), yt(url) && params(url).join('&') === 'theme=k&v=kid', url && url.href);
  }
  {
    const url = go({ contentTarget: 'theme=dark&v=x' });
    t(n('another theme keeps the flags'), yt(url) && ENV.every((k) => url.searchParams.get(k) === '1'), url && url.href);
  }
  t(n('a plain relaunch does not navigate'), go({ displayAffinity: 0 }) === null);
  t(n('a relaunch without detail does not navigate'), go(null) === null && go('v=abc') === null);
  t(n('an empty content target does not navigate'), go({ contentTarget: '' }) === null);

  {
    env.logs.length = 0;
    go({ contentTarget: { intent: 'SearchContent', intentParam: 'my secret search' } });
    const logged = env.logs.join('\n');
    t(n('the log names the parameters, not their values'), /handleLaunch/.test(logged) && /contentTarget/.test(logged) &&
      !/secret/.test(logged), logged);
  }
  t(n('relaunches: no page errors'), env.errors.length === 0, env.errors.join(' | '));

  // ---- The launch parameters the app started with (Start Page reads them) ----
  const startPage = { startPage: 'subscriptions' };
  const opened = (e) => e.navigations.some((u) => /#\/browse\?c=FEsubscriptions$/.test(u));
  {
    const e = boot(undefined, startPage);
    await sleep(200);
    t(n('no launch parameters: Start Page opens Subscriptions'), opened(e), e.navigations.join(' '));
  }
  {
    const e = boot('{}', startPage);
    await sleep(200);
    t(n('empty launch parameters: Start Page opens Subscriptions'), opened(e), e.navigations.join(' '));
  }
  {
    const e = boot(JSON.stringify({ contentTarget: 'v=abc' }), startPage);
    await sleep(200);
    t(n('launched into a video: Start Page leaves it'), !opened(e), e.navigations.join(' '));
  }
  {
    const e = boot(JSON.stringify({ target: 'v=abc' }), startPage);
    await sleep(200);
    t(n('launched with a target: Start Page leaves it'), !opened(e), e.navigations.join(' '));
  }
  {
    const e = boot('{"contentTarget": "v=abc"', startPage);
    await sleep(200);
    t(n('broken launch parameters: a warning'), e.logs.some((l) => /^warn Failed to parse launchParams/.test(l)),
      e.logs.filter((l) => /^warn/.test(l)).join(' | '));
    t(n('...read as none: Start Page opens'), opened(e), e.navigations.join(' '));
    t(n('...and no errors'), e.errors.length === 0, e.errors.join(' | '));
    const warnings = e.logs.filter((l) => /Failed to parse launchParams/.test(l)).length;
    t(n('...warned once, not on every read'), warnings === 1, String(warnings));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
