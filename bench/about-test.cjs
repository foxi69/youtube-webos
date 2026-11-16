/**
 * The update check and the About tab (src/about.js), end to end in the
 * bundle: the release listing read from GitHub, the version compared with the
 * installed one, the "Update available" window (its buttons, keys, release
 * notes and install through the Homebrew Channel), what the About tab says
 * for a newer, the same or no release, and What's New's own notes.
 *
 *   node bench/about-test.cjs <bundle> [legacy|modern]
 *
 * whats-new-test covers when What's New opens; until this test nothing read
 * a listing, opened the Update window with notes in it or installed from it.
 * GitHub (XMLHttpRequest) and the webOS services (PalmServiceBridge) are
 * fakes: the installer answers only when the test makes it. The page's timers
 * run 50 times faster, so the 15 s wait after the start is 0.3 s.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const code = fs.readFileSync(bundlePath, 'utf8');
const INSTALLED = JSON.parse(fs.readFileSync(ROOT + '/package.json', 'utf8')).version;

const RAW = 'https://raw.githubusercontent.com/foxi69/youtube-webos/main/';
const LISTING_URL = RAW + (modern ? 'repo-webos22.json' : 'repo.json');
const CHANGELOG_URL = RAW + 'CHANGELOG.md';
const IPK = 'https://example.com/youtube-webos_99.0.0.ipk';
const SHA = 'ab'.repeat(32);
const RELEASE_PAGE = 'github.com/foxi69/youtube-webos/releases/latest';
const HB_INFO = 'luna://com.webos.applicationManager/getAppInfo';
const INSTALL = 'luna://org.webosbrew.hbchannel.service/install';
const LAUNCH = 'luna://com.webos.applicationManager/launch';
const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, GREEN: 404 };
const SCALE = 50;
const HOUR = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(cond, timeout = 3000) {
  const end = Date.now() + timeout;
  const poll = () => (cond() ? Promise.resolve(true) : Date.now() >= end ? Promise.resolve(false) : sleep(10).then(poll));
  return poll();
}

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

const listing = (version, manifest = {}) => JSON.stringify({
  packages: [{ id: 'youtube.leanback.v4', manifest: Object.assign({ version, ipkUrl: IPK, ipkHash: { sha256: SHA } }, manifest) }]
});

// Newest first, as CHANGELOG.md has them.
const CHANGELOG = [
  '# Changelog', '', '## [Unreleased]', '',
  '## [100.0.0] - 2027-02-01', '', '+ After the listed release.', '',
  '## [99.0.0] - 2027-01-01', '', '### Added', '',
  '+ **Bold** news with `code` and a [link](https://example.com/x).',
  '  carried on the next line', '',
  'A paragraph', 'over two lines.', '',
  '## [1.0.0] - 2026-12-01', '', '- One point zero.', '',
  `## [${INSTALLED}] - 2026-11-01`, '', '+ The installed one.', '',
  '## [0.9.1] - 2026-10-01', '', '+ An old one.', ''
].join('\n');

/**
 * The bundle on a page. opts: cfg, storage, bodyClass, listing (the body, or
 * { status }), changelog (likewise), homebrew ('yes', 'no', 'denied', or
 * 'none' for no service bridge at all), throwOn (services whose call throws),
 * holdHomebrew (the Homebrew Channel's app info is answered only when the
 * test calls answerHomebrew()).
 */
function boot(opts = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(`<!doctype html><html><body class="${opts.bodyClass || 'WEB_PAGE_TYPE_BROWSE'}"><ytlr-app></ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = '{}';
  const routes = { [LISTING_URL]: 'listing' in opts ? opts.listing : listing('99.0.0'), [CHANGELOG_URL]: opts.changelog || CHANGELOG };
  const requests = [];
  win.XMLHttpRequest = class {
    open(method, url) { this.url = String(url); }
    send() {
      requests.push(this.url);
      if (!(this.url in routes)) return;   // anything else: never answers
      const route = routes[this.url];
      setTimeout(() => {
        if (route && route.network) { if (this.onerror) this.onerror(); return; }
        if (route && route.timeout) { if (this.ontimeout) this.ontimeout(); return; }
        this.status = route && route.status ? route.status : 200;
        this.responseText = typeof route === 'string' ? route : '';
        if (this.onload) this.onload();
      }, 5);
    }
    setRequestHeader() {} getResponseHeader() { return null; } getAllResponseHeaders() { return ''; }
    addEventListener() {} abort() {}
  };
  win.fetch = () => new Promise(() => {});
  const realTimeout = win.setTimeout.bind(win);
  win.setTimeout = (fn, ms, ...args) => realTimeout(fn, (ms || 0) / SCALE, ...args);
  win.requestAnimationFrame = (cb) => realTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    enableDeArrow: false, upgradeThumbnails: false, enableAutoLogin: false, showWhatsNew: false
  }, opts.cfg)));
  win.localStorage.setItem('ytaf-seen-version', INSTALLED);
  for (const [k, v] of Object.entries(opts.storage || {})) win.localStorage.setItem(k, v);

  // The webOS services: every call is kept; the Homebrew Channel's app info
  // is answered at once, the others when the test calls answer().
  const calls = [];
  const homebrew = opts.homebrew || 'yes';
  const homebrewAnswer = (kind) => (kind === 'yes' ? { returnValue: true, appInfo: { id: 'org.webosbrew.hbchannel' } }
    : kind === 'denied' ? { returnValue: false, errorText: 'Permission denied' }
      : { returnValue: false, errorText: 'Cannot find application info' });
  // The held app info calls answered now, as the Homebrew Channel `kind` would.
  const answerHomebrew = (kind) => {
    for (const c of calls) if (c.uri === HB_INFO && !c.answered) { c.answered = true; c.answer(homebrewAnswer(kind)); }
  };
  if (homebrew !== 'none') {
    win.PalmServiceBridge = function PalmServiceBridge() {
      this.call = (uri, payload) => {
        if ((opts.throwOn || []).indexOf(uri) !== -1) throw new Error('refused: ' + uri);
        const call = { uri, params: JSON.parse(payload), answer: (res) => this.onservicecallback(JSON.stringify(res)) };
        calls.push(call);
        if (uri !== HB_INFO || opts.holdHomebrew) return;
        call.answered = true;
        realTimeout(() => call.answer(homebrewAnswer(homebrew)), 5);
      };
    };
  }
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };

  // Keys the page itself (YouTube) would get.
  const pageKeys = [];
  win.document.addEventListener('keydown', (e) => pageKeys.push('down ' + e.keyCode));
  win.document.addEventListener('keyup', (e) => pageKeys.push('up ' + e.keyCode));
  win.eval(code);

  const doc = win.document;
  const press = (code, type = 'keydown') => {
    const e = new win.KeyboardEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => code, configurable: true });
    dispatchTrusted(doc.body, e);
  };
  const tap = (code) => { press(code, 'keydown'); press(code, 'keyup'); };
  const dialogs = () => [...doc.querySelectorAll('.ytaf-dialog')];
  const text = (sel, root = doc) => { const n = root.querySelector(sel); return n ? n.textContent : null; };
  const buttons = () => [...doc.querySelectorAll('.ytaf-dialog-btn')].map((b) => b.textContent);
  const focused = () => text('.ytaf-dialog-focused');
  const versions = () => [...doc.querySelectorAll('.ytaf-dialog-reader .ytaf-cl-version')].map((v) => v.firstChild.textContent);
  const reader = () => doc.querySelector('.ytaf-dialog-reader');
  const note = () => doc.querySelector('.ytaf-dialog-note');
  const status = () => doc.querySelector('.ytaf-dialog-status');
  const listings = () => requests.filter((u) => /repo(?:-webos22)?\.json$/.test(u));
  const changelogs = () => requests.filter((u) => u === CHANGELOG_URL);
  const toasts = () => text('.ytaf-notification-container') || '';
  const stored = () => JSON.parse(win.localStorage.getItem('ytaf-update-check'));
  // The About tab, opened from the panel (the green key, then its last tab).
  // The tab asks the TV about the Homebrew Channel as it opens: async, so the
  // answer is in before the tab is read.
  const about = async () => {
    if (!doc.querySelector('#ytaf-page-about .ytaf-about-version')) {
      // A window left open would take the green key.
      if (dialogs().length) press(KEY.BACK);
      press(KEY.GREEN);
      const tabs = doc.querySelectorAll('.ytaf-tab-btn');
      tabs[tabs.length - 1].click();
      await sleep(50);
    }
    const page = doc.querySelector('#ytaf-page-about');
    const v = page.querySelector('.ytaf-about-version');
    const status = v.nextElementSibling.nextElementSibling;
    const install = status.nextElementSibling;
    const installStatus = install.nextElementSibling;
    const computer = installStatus.nextElementSibling;
    const btn = (label) => [...page.querySelectorAll('button')].find((b) => b.textContent === label);
    const box = (label) => [...page.querySelectorAll('label')].find((l) => l.textContent.trim() === label).querySelector('input');
    const shown = (n) => n.style.display !== 'none';
    return { page, v, status, install, installStatus, computer, btn, box, shown };
  };
  return {
    win, doc, errors, requests, calls, routes, pageKeys, press, tap, dialogs, text, buttons, focused, versions,
    reader, note, status, listings, changelogs, toasts, stored, about, answerHomebrew
  };
}

// Waits for the launch check (0.3 s) and the window it may open.
const settle = async (env, cond) => { if (cond) await waitFor(cond); else await sleep(500); };
const callsTo = (env, uri) => env.calls.filter((c) => c.uri === uri);
const visible = (n) => !!n && n.style.display !== 'none';

(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- A newer release, the Homebrew Channel installed ----
  {
    const env = boot();
    await sleep(100);
    t(n('nothing is asked right after the start'), env.listings().length === 0, env.requests.join(' '));
    await settle(env, () => env.dialogs().length === 1 && env.versions().length > 0);
    t(n('the listing of this build is read'), env.listings().length === 1 && env.listings()[0] === LISTING_URL,
      env.listings().join(' '));
    const s = env.stored() || {};
    t(n('the check is stored with the package'), s.latest === '99.0.0' && Date.now() - s.at < 5000 &&
      s.ipk && s.ipk.url === IPK && s.ipk.sha256 === SHA, JSON.stringify(s));
    t(n('an Update available window opens'), env.text('.ytaf-dialog-title') === 'Update available' &&
      env.text('.ytaf-dialog-subtitle') === `Version 99.0.0  ·  Current ${INSTALLED}`, env.text('.ytaf-dialog-subtitle'));
    t(n('...with Update and Skip, Update focused'), env.buttons().join() === 'Update,Skip' && env.focused() === 'Update',
      env.buttons().join() + ' / ' + env.focused());
    t(n('...and no install-from-a-computer note'), !visible(env.note()));
    t(n('the notes are those since the installed version, up to the listed one'),
      env.versions().join() === '99.0.0,1.0.0', env.versions().join());
    const tags = [...env.doc.querySelectorAll('.ytaf-dialog-reader .ytaf-cl-tag')].map((x) => x.textContent);
    t(n('...each tagged newer'), tags.join() === 'newer,newer', tags.join());
    const entry = env.doc.querySelector('.ytaf-dialog-reader .ytaf-cl-entry');
    const item = entry.querySelector('.ytaf-cl-item');
    t(n('...a heading, a point and a paragraph'), env.text('.ytaf-cl-heading', entry) === 'Added' &&
      env.text('.ytaf-cl-text', entry) === 'A paragraph over two lines.', entry.textContent);
    t(n('...bold, code and a link as its text'), !!item && env.text('b', item) === 'Bold' && env.text('code', item) === 'code' &&
      item.textContent === 'Bold news with code and a link. carried on the next line', item && item.innerHTML);
    t(n('...with the date'), env.text('.ytaf-cl-date', entry) === '  2027-01-01');

    env.pageKeys.length = 0;
    env.press(KEY.RIGHT);
    const afterRight = env.focused();
    env.press(KEY.RIGHT);
    const wrapped = env.focused();
    env.press(KEY.LEFT);
    t(n('Left and Right move between the buttons'), afterRight === 'Skip' && wrapped === 'Update' && env.focused() === 'Skip',
      [afterRight, wrapped, env.focused()].join());
    env.press(KEY.RIGHT);
    env.press(KEY.DOWN);
    env.press(KEY.DOWN);
    const down = env.reader().scrollTop;
    env.press(KEY.UP);
    t(n('Down and Up scroll the notes'), down === 80 && env.reader().scrollTop === 40, `${down} ${env.reader().scrollTop}`);
    t(n('the keys do not reach the page'), env.pageKeys.length === 0, env.pageKeys.join());

    env.tap(KEY.ENTER);
    const install = callsTo(env, INSTALL);
    t(n('OK on Update hands the package to the installer'), install.length === 1 &&
      JSON.stringify(install[0].params) === JSON.stringify({ ipkUrl: IPK, subscribe: true, ipkHash: SHA }),
      JSON.stringify(install.map((c) => c.params)));
    t(n('...and the window stays open'), env.dialogs().length === 1 && /Starting the download/.test(env.status().textContent));
    t(n('...its OK not reaching the page, down or up'), env.pageKeys.length === 0, env.pageKeys.join());
    install[0].answer({ returnValue: true, statusText: 'Downloading', progress: 42.4 });
    t(n('...with the progress shown'), env.status().textContent === 'Downloading 42%', env.status().textContent);
    env.press(KEY.ENTER);
    t(n('...Update again while it installs starts nothing'), callsTo(env, INSTALL).length === 1);
    install[0].answer({ returnValue: true, finished: true });
    t(n('...then that it is installed'), /^Installed\. The app closes now/.test(env.status().textContent), env.status().textContent);

    env.pageKeys.length = 0;
    env.tap(KEY.BACK);
    t(n('Back closes the window'), env.dialogs().length === 0);
    t(n('...and its key up does not reach the page'), env.pageKeys.length === 0, env.pageKeys.join());
    t(n('the offer is remembered for this version'), env.stored().notified === '99.0.0', JSON.stringify(env.stored()));

    const a = await env.about();
    t(n('About: the newer version is named'), a.status.textContent === 'Version 99.0.0 is available.', a.status.textContent);
    t(n('About: an install button for it'), a.shown(a.install) && a.install.textContent === 'Download and Install 99.0.0',
      a.install.textContent);
    t(n('About: no install-from-a-computer note'), !a.shown(a.computer));
    t(n('About: the version of this build'), a.v.textContent === 'YouTube Foxtended ' + INSTALLED, a.v.textContent);
    t(n('newer release: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- Once a day, and once a day per version ----
  {
    const recent = { at: Date.now() - HOUR, latest: '99.0.0', ipk: { url: IPK }, notified: '99.0.0', notifiedAt: Date.now() - HOUR };
    const env = boot({ storage: { 'ytaf-update-check': JSON.stringify(recent) } });
    await settle(env);
    t(n('a check an hour old: the listing is not read again'), env.listings().length === 0, env.listings().join());
    t(n('...and the version already offered today is not offered again'), env.dialogs().length === 0);
    t(n('...while About still names it'), (await env.about()).status.textContent === 'Version 99.0.0 is available.',
      (await env.about()).status.textContent);
  }
  {
    const old = { at: Date.now() - 21 * HOUR, latest: '99.0.0', notified: '99.0.0', notifiedAt: Date.now() - 21 * HOUR };
    const env = boot({ storage: { 'ytaf-update-check': JSON.stringify(old) } });
    await settle(env, () => env.dialogs().length === 1);
    t(n('a check 21 hours old: the listing is read again'), env.listings().length === 1);
    t(n('...and the version is offered again'), env.dialogs().length === 1);
  }

  // ---- The same release, or none to be had ----
  {
    const env = boot({ listing: listing(INSTALLED) });
    await settle(env);
    t(n('the installed version listed: no window'), env.listings().length === 1 && env.dialogs().length === 0);
    const a = await env.about();
    t(n('About: up to date'), a.status.textContent === `Up to date (latest release: ${INSTALLED}).`, a.status.textContent);
    t(n('About: no install button, no note'), !a.shown(a.install) && !a.shown(a.computer));

    // Check for Updates Now, with other listings.
    const check = async (body) => {
      env.routes[LISTING_URL] = body;
      a.btn('Check for Updates Now').click();
      const during = a.status.textContent;
      await waitFor(() => a.status.textContent !== during);
      return [during, a.status.textContent];
    };
    const [during, newer] = await check(listing('0.9.10'));
    t(n('Check for Updates Now: "Checking" while it reads'), during === 'Checking for updates...', during);
    t(n('0.9.10 is newer than 0.9.2 (numbers, not text)'), newer === 'Version 0.9.10 is available.', newer);
    t(n('...and About offers to install it'), a.shown(a.install) && a.install.textContent === 'Download and Install 0.9.10');
    t(n('0.9.2.0 is the same version'), (await check(listing(INSTALLED + '.0')))[1] === `Up to date (latest release: ${INSTALLED}.0).`,
      a.status.textContent);
    t(n('an older release is not offered'), (await check(listing('0.9.1')))[1] === 'Up to date (latest release: 0.9.1).',
      a.status.textContent);
    const ERR = 'Could not check for updates (no connection to GitHub).';
    t(n('a server error: could not check'), (await check({ status: 500 }))[1] === ERR, a.status.textContent);
    t(n('...and the button hidden'), !a.shown(a.install));
    t(n('no connection: could not check'), (await check({ network: true }))[1] === ERR, a.status.textContent);
    t(n('no answer in time: could not check'), (await check({ timeout: true }))[1] === ERR, a.status.textContent);
    t(n('a version that is not numbers: could not check'), (await check(listing('1.0-beta')))[1] === ERR, a.status.textContent);
    t(n('a listing that is not JSON: could not check'), (await check('<html>portal</html>'))[1] === ERR, a.status.textContent);
    t(n('a listing without packages: could not check'), (await check('{}'))[1] === ERR, a.status.textContent);
    t(n('the last good check stays stored'), env.stored().latest === '0.9.1', JSON.stringify(env.stored()));
    t(n('Check Now opens no window'), env.dialogs().length === 0);
  }

  // ---- The update check switched off ----
  {
    const env = boot({ cfg: { checkForUpdates: false } });
    await settle(env);
    const a = await env.about();
    t(n('check off: the listing is not read'), env.listings().length === 0);
    t(n('About: the check is off'), a.status.textContent === 'Update check is off.', a.status.textContent);
    const box = a.box('Check for Updates');
    box.checked = true;
    box.dispatchEvent(new env.win.Event('change', { bubbles: true }));
    await waitFor(() => /available/.test(a.status.textContent));
    t(n('switched on: checked at once'), env.listings().length === 1 && a.status.textContent === 'Version 99.0.0 is available.',
      a.status.textContent);
    box.checked = false;
    box.dispatchEvent(new env.win.Event('change', { bubbles: true }));
    t(n('switched off again: off'), a.status.textContent === 'Update check is off.', a.status.textContent);
  }

  // ---- Not over a video ----
  {
    const env = boot({ bodyClass: 'WEB_PAGE_TYPE_WATCH' });
    await settle(env, () => env.listings().length === 1);
    await sleep(300);
    t(n('on a video the window waits'), env.dialogs().length === 0);
    env.doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
    t(n('...and opens on the browse page'), await waitFor(() => env.dialogs().length === 1));
  }

  // ---- Without the Homebrew Channel ----
  {
    const env = boot({ homebrew: 'no' });
    await settle(env, () => env.dialogs().length === 1);
    t(n('no Homebrew Channel: OK alone'), env.buttons().join() === 'OK', env.buttons().join());
    const txt = env.note() ? env.note().textContent : '';
    t(n('...and a note to install from a computer'), visible(env.note()) &&
      txt.indexOf('The Homebrew Channel is not installed on this TV, so the app cannot install 99.0.0 itself') === 0 &&
      txt.indexOf(RELEASE_PAGE) !== -1, txt);
    env.press(KEY.ENTER);
    t(n('...OK closes it'), env.dialogs().length === 0 && callsTo(env, INSTALL).length === 0);
    const a = await env.about();
    t(n('About: no install button, the note instead'), !a.shown(a.install) && a.shown(a.computer) &&
      a.computer.textContent === txt, a.computer.textContent);
  }
  {
    const env = boot({ homebrew: 'denied' });
    await settle(env, () => env.dialogs().length === 1);
    t(n('the TV will not say: Update offered, with the note'), env.buttons().join() === 'Update,Skip' &&
      visible(env.note()) && /^Without the Homebrew Channel, install 99\.0\.0 from a computer/.test(env.note().textContent),
      env.buttons().join() + ' / ' + (env.note() && env.note().textContent));
    env.press(KEY.RIGHT);
    env.press(KEY.ENTER);
    t(n('...Skip closes it'), env.dialogs().length === 0 && callsTo(env, INSTALL).length === 0);
  }
  {
    const env = boot({ homebrew: 'none' });
    await settle(env, () => env.dialogs().length === 1);
    t(n('no service bridge: OK alone, and why'), env.buttons().join() === 'OK' &&
      /^This TV does not let the app install updates/.test(env.note().textContent), env.note() && env.note().textContent);
    env.press(KEY.ENTER);
    const a = await env.about();
    t(n('About without a bridge: no Open in Browser'), !a.btn('Open in Browser') &&
      !/TV's browser/.test(a.page.textContent));
    t(n('no bridge: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- The About tab before the TV says whether the Homebrew Channel is there ----
  // A newer release already known (checked and offered earlier today), so the
  // tab has the release at once; the app info call is held until the test
  // answers it. Until then the tab must not tell a TV that has the Homebrew
  // Channel to install the update without it.
  for (const kind of ['yes', 'no']) {
    const now = Date.now();
    const env = boot({
      holdHomebrew: true,
      storage: { 'ytaf-update-check': JSON.stringify({ at: now, latest: '99.0.0', ipk: { url: IPK, sha256: SHA }, notified: '99.0.0', notifiedAt: now }) }
    });
    await sleep(500);
    const a = await env.about();
    const asked = callsTo(env, HB_INFO).length > 0;
    t(n(`About, the Homebrew Channel not answered yet (${kind}): the release is shown`), asked &&
      a.status.textContent === 'Version 99.0.0 is available.', a.status.textContent);
    t(n(`...and no install-from-a-computer note yet (${kind})`), !a.shown(a.computer) &&
      !/Without the Homebrew Channel/.test(a.page.textContent),
      (a.shown(a.computer) ? 'shown: ' : 'hidden: ') + a.computer.textContent);
    env.answerHomebrew(kind);
    await sleep(20);
    if (kind === 'yes') {
      t(n('...answered yes: the install button, no note'), a.shown(a.install) && !a.shown(a.computer),
        `install ${a.shown(a.install)}, note ${a.shown(a.computer)}`);
    } else {
      t(n('...answered no: the note that it is not installed, no install button'), !a.shown(a.install) && a.shown(a.computer) &&
        a.computer.textContent.indexOf('The Homebrew Channel is not installed on this TV') === 0, a.computer.textContent);
    }
    t(n(`...no page errors (${kind})`), env.errors.length === 0, env.errors.join(' | '));
  }

  {
    // The install fails before the TV answers: the note the error points to
    // ("below") is there, the general one until the answer.
    const now = Date.now();
    const env = boot({
      holdHomebrew: true,
      storage: { 'ytaf-update-check': JSON.stringify({ at: now, latest: '99.0.0', ipk: { url: IPK, sha256: SHA }, notified: '99.0.0', notifiedAt: now }) }
    });
    await sleep(500);
    const a = await env.about();
    t(n('About, not answered yet: the install button is offered'), a.shown(a.install) && !a.shown(a.computer));
    a.install.click();
    const call = callsTo(env, INSTALL)[0];
    if (call) call.answer({ returnValue: false, errorText: 'Bad hash' });
    t(n('...the install fails: the note it points to is shown'), !!call && /\(below\)/.test(a.installStatus.textContent) &&
      a.shown(a.computer) && a.computer.textContent.indexOf('Without the Homebrew Channel, install 99.0.0') === 0,
      `${a.installStatus.textContent} | ${a.shown(a.computer)} ${a.computer.textContent}`);
    env.answerHomebrew('no');
    await sleep(20);
    t(n('...answered no afterwards: the note that it is not installed'),
      a.computer.textContent.indexOf('The Homebrew Channel is not installed on this TV') === 0, a.computer.textContent);
  }

  // ---- A package that is not https ----
  {
    const env = boot({ listing: listing('99.0.0', { ipkUrl: 'http://example.com/a.ipk' }) });
    await settle(env, () => env.dialogs().length === 1);
    t(n('a package not on https is not installed: OK alone'), env.buttons().join() === 'OK' && env.stored().ipk === null,
      env.buttons().join() + ' ' + JSON.stringify(env.stored()));
    t(n('...with the note shown'), visible(env.note()));
  }

  // ---- The installer refusing, and installing from the About tab ----
  {
    const env = boot();
    await settle(env, () => env.dialogs().length === 1);
    env.press(KEY.ENTER);
    callsTo(env, INSTALL)[0].answer({ returnValue: false, errorText: 'Bad hash' });
    t(n('a refused install says why'), env.status().textContent ===
      'Could not install: Bad hash. Install it from a computer instead (below).', env.status().textContent);
    t(n('...and shows the note'), visible(env.note()));
    env.press(KEY.ENTER);
    t(n('...Update can be pressed again'), callsTo(env, INSTALL).length === 2);
    env.press(KEY.BACK);

    const a = await env.about();
    a.install.click();
    a.install.click();
    const call = callsTo(env, INSTALL)[2];
    t(n('About: pressed twice, installed once'), callsTo(env, INSTALL).length === 3);
    t(n('About: the install button hands over the package'), !!call && call.params.ipkUrl === IPK);
    call.answer({ returnValue: true, progress: 10 });
    t(n('About: its progress'), a.shown(a.installStatus) && a.installStatus.textContent === 'Installing 10%', a.installStatus.textContent);
    call.answer({ returnValue: false });
    t(n('About: a refusal, and the note'), /^Could not install: the Homebrew Channel refused the request/.test(a.installStatus.textContent) &&
      a.shown(a.computer), a.installStatus.textContent);
    a.install.click();
    t(n('About: it can be tried again'), callsTo(env, INSTALL).length === 4);
  }

  // ---- Open in Browser ----
  {
    const env = boot({ listing: listing(INSTALLED) });
    await settle(env);
    const a = await env.about();
    const open = [...a.page.querySelectorAll('button')].filter((b) => b.textContent === 'Open in Browser');
    t(n('About: both codes can be opened in the browser'), open.length === 2 &&
      /or open it in the TV's browser/.test(a.page.textContent));
    open[0].click();
    const launch = callsTo(env, LAUNCH);
    t(n('Open in Browser starts the browser at the Ko-fi page'), launch.length === 1 &&
      JSON.stringify(launch[0].params) === JSON.stringify({ id: 'com.webos.app.browser', params: { target: 'https://ko-fi.com/foxi69' } }),
      JSON.stringify(launch.map((c) => c.params)));
    launch[0].answer({ returnValue: false });
    t(n('...and says so when it cannot'), /Could not open the browser on this TV/.test(env.toasts()), env.toasts());
    open[1].click();
    t(n('the project page too'), callsTo(env, LAUNCH)[1].params.params.target === 'https://github.com/foxi69/youtube-webos');
  }

  // ---- A firmware that refuses the service calls ----
  {
    const env = boot({ throwOn: [INSTALL, LAUNCH] });
    await settle(env, () => env.dialogs().length === 1);
    env.press(KEY.ENTER);
    t(n('the installer call refused: install from a computer'), /^This TV does not let the app reach the Homebrew Channel installer/
      .test(env.status().textContent) && visible(env.note()), env.status().textContent);
    env.press(KEY.RIGHT);
    env.press(KEY.ENTER);
    const a = await env.about();
    [...a.page.querySelectorAll('button')].find((b) => b.textContent === 'Open in Browser').click();
    t(n('the browser call refused: a toast'), /Could not open the browser on this TV/.test(env.toasts()), env.toasts());
    t(n('refused calls: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- Release notes that cannot be had, then can ----
  {
    const env = boot({
      cfg: { showWhatsNew: true }, changelog: { status: 500 },
      storage: { 'ytaf-seen-version': '0.9.1' }
    });
    await settle(env, () => env.dialogs().length === 1 && !/Loading/.test(env.reader().textContent));
    t(n('What\'s New first, its notes failing'), /^What's new in /.test(env.text('.ytaf-dialog-title')) &&
      env.reader().textContent === 'The release notes could not be loaded (no connection to GitHub).', env.reader().textContent);
    // The update offer comes while What's New is open: it waits.
    await waitFor(() => env.listings().length === 1);
    await sleep(150);
    t(n('...the Update window waiting for it to close'), env.dialogs().length === 1 &&
      /^What's new in /.test(env.text('.ytaf-dialog-title')));
    env.routes[CHANGELOG_URL] = CHANGELOG;
    env.press(KEY.ENTER);
    await waitFor(() => env.dialogs().length === 1 && env.versions().length > 0);
    t(n('the Update window after it reads the notes again'), env.text('.ytaf-dialog-title') === 'Update available' &&
      env.changelogs().length === 2 && env.versions().join() === '99.0.0,1.0.0', env.changelogs().length + ' ' + env.versions().join());
  }
  {
    const env = boot({ changelog: '<html>a captive portal</html>' });
    await settle(env, () => env.dialogs().length === 1 && !/Loading/.test(env.reader().textContent));
    t(n('notes that are not a changelog: could not be loaded'),
      env.reader().textContent === 'The release notes could not be loaded (no connection to GitHub).', env.reader().textContent);
  }
  {
    const env = boot({ changelog: `## [${INSTALLED}]\n\n+ Only this.\n` });
    await settle(env, () => env.dialogs().length === 1 && !/Loading/.test(env.reader().textContent));
    t(n('no notes for the new version yet'), env.reader().textContent === 'No release notes for 99.0.0 yet.', env.reader().textContent);
  }

  // ---- What's New: the installed version's notes ----
  {
    const env = boot({ cfg: { showWhatsNew: true }, listing: listing(INSTALLED), storage: { 'ytaf-seen-version': '0.9.1' } });
    await settle(env, () => env.dialogs().length === 1 && env.versions().length > 0);
    t(n('What\'s New: title and the version updated from'), env.text('.ytaf-dialog-title') === `What's new in ${INSTALLED}` &&
      env.text('.ytaf-dialog-subtitle') === 'Updated from 0.9.1', env.text('.ytaf-dialog-subtitle'));
    t(n('What\'s New: the installed version\'s notes only, tagged installed'), env.versions().join() === INSTALLED &&
      !!env.doc.querySelector('.ytaf-dialog-reader .ytaf-cl-entry.ytaf-cl-installed') &&
      env.text('.ytaf-dialog-reader .ytaf-cl-tag') === 'installed', env.versions().join());
    t(n('What\'s New: OK alone'), env.buttons().join() === 'OK');
    env.pageKeys.length = 0;
    env.tap(KEY.ENTER);
    t(n('What\'s New: OK closes it, its key up kept from the page'), env.dialogs().length === 0 && env.pageKeys.length === 0,
      env.pageKeys.join());
  }
  {
    // Settings of its own but no seen version: an update from before 0.9.
    const env = boot({ cfg: { showWhatsNew: true }, listing: listing(INSTALLED), changelog: '## [0.0.1]\n\n+ x\n',
      storage: { 'ytaf-seen-version': '' } });
    await settle(env, () => env.dialogs().length === 1 && !/Loading/.test(env.reader().textContent));
    t(n('What\'s New: no version updated from'), env.dialogs().length === 1 && !env.doc.querySelector('.ytaf-dialog-subtitle'));
    t(n('What\'s New: no notes for this version'), env.reader().textContent === `No release notes for ${INSTALLED}.`,
      env.reader().textContent);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
