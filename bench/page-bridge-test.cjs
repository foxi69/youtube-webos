/**
 * The bundle's ties to the page and to the TV app, end to end: the page-state
 * event (utils.js), which the player features wait on; the guest check; the
 * keys the bundle sends itself on a TV without a KeyboardEvent constructor;
 * the launch parameters (launch.js) and a relaunch; and the bridge to the TV
 * app's command resolver (app_api/index.ts), which the long-press menu, the
 * queue and the language fix go through. Until this test the page-state
 * event's own rules, the resolver found only after a wait (or never), its
 * debug log and a broken launchParams were not run.
 *
 *   node bench/page-bridge-test.cjs <bundle> [legacy|modern]
 *
 * The TV app's resolver is a stand-in in window._yttv, with the shape
 * app_api looks for: a function with an `instance` whose resolveCommand takes
 * each command.
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

const GREEN = 404;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

// The TV app's command resolver: what reaches it is recorded.
function fakeResolver() {
  const seen = [];
  function Resolver() {}
  Resolver.instance = { resolveCommand(command, extra) { seen.push({ command, extra, self: this }); return 'resolved'; } };
  return { Resolver, seen, original: Resolver.instance.resolveCommand };
}

/**
 * The bundle on a page with body class `opts.page` (the home screen by
 * default). `opts.before(win)` runs just before the bundle.
 */
function boot(cfg = {}, opts = {}) {
  const errors = [];
  const warnings = [];
  const logs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...args) => errors.push('console.error: ' + args.map(String).join(' ')));
  vc.on('warn', (...args) => warnings.push(args.map(String).join(' ')));
  for (const level of ['group', 'debug']) vc.on(level, (...args) => logs.push({ level, args }));
  const dom = new JSDOM(`<!doctype html><html><body class="${opts.page || 'WEB_PAGE_TYPE_BROWSE'}"><ytlr-app></ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = opts.launchParams || '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    enableDeArrow: false, upgradeThumbnails: false, enableAutoLogin: false,
    checkForUpdates: false, showWhatsNew: false
  }, cfg)));
  for (const k of Object.keys(opts.storage || {})) win.localStorage.setItem(k, opts.storage[k]);
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  // Chrome 23 has it; the Chrome 38 environment takes it away all the same
  // (as in upstream-fixes-test).
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.fetch = () => new Promise(() => {});
  const pageEvents = [];
  win.addEventListener('ytaf-page-update', (e) => pageEvents.push(e.detail));
  if (opts.before) opts.before(win);
  win.eval(code);
  const toasts = () => (win.document.querySelector('.ytaf-notification-container') || {}).textContent || '';
  return { win, doc: win.document, errors, warnings, logs, pageEvents, toasts };
}

// A trusted key press (keydown and keyup) of the remote on the focused element.
function press(win, keyCode, make) {
  const target = win.document.activeElement || win.document.body;
  for (const type of ['keydown', 'keyup']) {
    const e = make ? make(type) : new win.KeyboardEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => keyCode, configurable: true });
    dispatchTrusted(target, e);
  }
}

const flags = (d) => d && `${+d.isWatch}${+d.isShorts}${+d.isAccountSelector}${+d.isSearch}`;

(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- The page-state event ----
  {
    const env = boot();
    await wait(30);
    t(n('the home screen at start: no page-state event (nothing changed)'), env.pageEvents.length === 0,
      JSON.stringify(env.pageEvents));
    const body = env.doc.body;
    const setClass = async (c) => { body.className = c; await wait(20); };
    await setClass('WEB_PAGE_TYPE_WATCH');
    t(n('the watch page: one event, isWatch only'), env.pageEvents.length === 1 && flags(env.pageEvents[0]) === '1000',
      JSON.stringify(env.pageEvents));
    await setClass('WEB_PAGE_TYPE_WATCH zylon-focus');
    await setClass('WEB_PAGE_TYPE_WATCH');
    t(n('a class that is not a page type changing: no event'), env.pageEvents.length === 1, JSON.stringify(env.pageEvents));
    await setClass('WEB_PAGE_TYPE_WATCH ytaf-extra');
    t(n('the page type class written again with the same page: no event'), env.pageEvents.length === 1);
    await setClass('WEB_PAGE_TYPE_SHORTS');
    await setClass('WEB_PAGE_TYPE_SEARCH');
    await setClass('WEB_PAGE_TYPE_ACCOUNT_SELECTOR');
    await setClass('WEB_PAGE_TYPE_BROWSE');
    t(n('Shorts, search, the account selector, home: one event each, with its flag'),
      env.pageEvents.slice(1).map(flags).join() === '0100,0001,0010,0000', env.pageEvents.map(flags).join());
    t(n('page state: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }
  {
    const env = boot({}, { page: 'WEB_PAGE_TYPE_WATCH' });
    t(n('opened on the watch page: the event at once, as the bundle loads'), env.pageEvents.length === 1 &&
      flags(env.pageEvents[0]) === '1000', JSON.stringify(env.pageEvents));
  }

  // ---- Guest or signed in (the panel's guest-only row) ----
  const guestPanel = async (storage) => {
    const env = boot({}, { storage });
    await wait(30);
    press(env.win, GREEN);
    await wait(30);
    const panel = env.doc.querySelector('.ytaf-ui-container');
    return { env, guest: !!panel && panel.classList.contains('guest-mode') };
  };
  {
    const identity = (type) => JSON.stringify({ data: { identityType: type } });
    const guest = await guestPanel({ 'yt.leanback.default::last-identity-used': identity('UNAUTHENTICATED_IDENTITY_TYPE_GUEST') });
    t(n('the last identity a guest: the panel is the guest one'), guest.guest === true);
    const signedIn = await guestPanel({
      'yt.leanback.default::last-identity-used': identity('IDENTITY_TYPE_SIGNED_IN'),
      'yt.leanback.default::AUTONAV_FOR_LIVING_ROOM': JSON.stringify({ data: { guest: true } })
    });
    t(n('the last identity signed in: not a guest, whatever autoplay says'), signedIn.guest === false);
    const autonav = await guestPanel({ 'yt.leanback.default::AUTONAV_FOR_LIVING_ROOM': JSON.stringify({ data: { guest: true } }) });
    t(n('no identity, autoplay saved for a guest: a guest'), autonav.guest === true);
    const autonavUser = await guestPanel({ 'yt.leanback.default::AUTONAV_FOR_LIVING_ROOM': JSON.stringify({ data: { guest: false } }) });
    t(n('no identity, autoplay saved for an account: not a guest'), autonavUser.guest === false);
    const broken = await guestPanel({ 'yt.leanback.default::last-identity-used': '{not json' });
    t(n('a broken identity record: not a guest, and no error'), broken.guest === false && broken.env.errors.length === 0,
      broken.env.errors.join(' | '));
  }

  // ---- Keys the bundle sends, without a KeyboardEvent constructor ----
  // As on webOS 3's oldest builds: `new KeyboardEvent` throws, so the event is
  // made with document.createEvent. Comments are bound to 1; with a side panel
  // open the key sends Back to close it.
  for (const withInit of [true, false]) {
    const env = boot({ shortcut_key_1: 'toggle_comments' }, {
      page: 'WEB_PAGE_TYPE_WATCH',
      before: (win) => {
        win.KeyboardEvent = function KeyboardEvent() { throw new win.TypeError('Illegal constructor'); };
        if (!withInit) {
          const real = win.document.createEvent.bind(win.document);
          win.document.createEvent = (type) => {
            const e = real(type);
            if (type === 'KeyboardEvent') Object.defineProperty(e, 'initKeyboardEvent', { value: undefined });
            return e;
          };
        }
      }
    });
    env.doc.querySelector('ytlr-app').innerHTML = '<video></video><ytlr-engagement-panel-section-list-renderer></ytlr-engagement-panel-section-list-renderer>';
    const sent = [];
    env.doc.addEventListener('keydown', (e) => { if (e.__ytafSynthetic) sent.push({ code: e.keyCode, which: e.which, bubbles: e.bubbles }); });
    await wait(30);
    press(env.win, 49, (type) => { const e = env.doc.createEvent('Event'); e.initEvent(type, true, true); return e; });
    await wait(30);
    const label = withInit ? 'with initKeyboardEvent' : 'with only initEvent';
    t(n(`no KeyboardEvent constructor, ${label}: Back is still sent, keyCode and which set`),
      sent.length === 1 && sent[0].code === 461 && sent[0].which === 461 && sent[0].bubbles === true, JSON.stringify(sent));
    t(n(`...${label}: no page errors`), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- Launch parameters ----
  {
    const env = boot({}, { launchParams: '{not json' });
    await wait(30);
    t(n('broken launchParams: a warning, and the bundle runs on'), env.warnings.some((w) => /Failed to parse launchParams/.test(w)) &&
      !!env.win.ytaf_showOptionsPanel && env.errors.length === 0, env.warnings.join(' | ') + ' ' + env.errors.join(' | '));
  }
  {
    // A relaunch with a target goes to it; a plain one (the app icon) stays.
    const env = boot();
    const went = [];
    const errorsBefore = env.errors.length;
    const relaunch = (detail) => env.doc.dispatchEvent(new env.win.CustomEvent('webOSRelaunch', { detail }));
    const realInfo = env.win.console.info;
    env.win.console.info = (...args) => { if (args[0] === 'handleLaunch') went.push(args[1]); return realInfo.apply(env.win.console, args); };
    relaunch({ displayAffinity: 0 });
    t(n('a plain relaunch: no navigation'), went.length === 0, JSON.stringify(went));
    relaunch({ contentTarget: 'v=abcdefghijk' });
    t(n('a relaunch with a video: handled as a launch'), went.length === 1 && went[0].indexOf('contentTarget') !== -1,
      JSON.stringify(went));
    t(n('relaunch: no page errors'), env.errors.length === errorsBefore, env.errors.join(' | '));
  }

  // ---- The TV app's command resolver ----
  {
    // Found at once.
    const r = fakeResolver();
    const env = boot({}, { before: (win) => { win._yttv = { notAFunction: { instance: {} }, noInstance() {}, resolver: r.Resolver }; } });
    await wait(30);
    const resolve = r.Resolver.instance.resolveCommand;
    t(n('the resolver in window._yttv is taken over'), resolve !== r.original);
    const out = resolve({ browseEndpoint: { browseId: 'FEwhat_to_watch' } }, { extra: 1 });
    t(n('a command no hook wants reaches the app, with its extra'), out === 'resolved' && r.seen.length === 1 &&
      r.seen[0].command.browseEndpoint.browseId === 'FEwhat_to_watch' && r.seen[0].extra.extra === 1);
    t(n('...called on the app\'s own instance'), r.seen[0].self === r.Resolver.instance);
    // A hook (the language fix): the language goes into the PREF cookie and
    // the page reloads.
    r.seen.length = 0;
    resolve({ setClientSettingEndpoint: { settingDatas: [null, { clientSettingEnum: { item: 'I18N_LANGUAGE' }, stringValue: 'hu' }] } });
    t(n('a hooked command goes to its hook (the language fix sets the cookie)'), /PREF=hl=hu/.test(env.doc.cookie), env.doc.cookie);
    resolve({ setClientSettingEndpoint: { settingDatas: [{ clientSettingEnum: { item: 'OTHER' } }] } });
    t(n('...and the hook hands a command it does not want back to the app'), r.seen.some((s) => /"item":"OTHER"/.test(JSON.stringify(s.command))), JSON.stringify(r.seen.map((s) => Object.keys(s.command))));

    env.logs.length = 0;
    env.win.__ytaf_debug__ = true;
    resolve({ pingCommand: {} }, 'x');
    env.win.__ytaf_debug__ = false;
    const commandLogged = env.logs.some((l) => l.level === 'debug' && l.args[0] && l.args[0].pingCommand);
    t(n('debug on: each command is logged, in a group'), env.logs.some((l) => l.level === 'group' && /Resolving/.test(String(l.args[0]))) &&
      commandLogged, JSON.stringify(env.logs.map((l) => l.level + ':' + String(l.args[0]))));
    env.logs.length = 0;
    resolve({ pingCommand: {} });
    t(n('debug off: nothing logged'), env.logs.length === 0);
    t(n('resolver: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }
  {
    // The app's resolver appears a while after the bundle (the app still loading).
    const r = fakeResolver();
    const env = boot({ shortcut_key_1: 'queue_next' });
    await wait(60);
    t(n('no resolver yet: nothing taken over'), r.Resolver.instance.resolveCommand === r.original);
    env.win._yttv = { resolver: r.Resolver };
    await wait(600);
    t(n('the resolver appearing later is found and taken over'), r.Resolver.instance.resolveCommand !== r.original);
    t(n('...with no warnings'), !env.warnings.some((w) => /hook unavailable|not installed/.test(w)), env.warnings.join(' | '));
  }
  {
    // It never appears: after 30 s the bridge gives up, with a warning, and
    // what needs it says so.
    const env = boot({}, {
      before: (win) => {
        const RealDate = win.Date;
        let offset = 0;
        win.Date = class extends RealDate {
          constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset); }
          static now() { return RealDate.now() + offset; }
        };
        win.__jump = (ms) => { offset += ms; };
      }
    });
    await wait(30);
    env.win.__jump(31000);
    await wait(1200);
    t(n('no resolver after 30 s: the bridge gives up with a warning'),
      env.warnings.some((w) => /\[app_api\] resolveCommand hook unavailable/.test(w)), env.warnings.join(' | '));
    t(n('...and the language fix says it is not installed'), env.warnings.some((w) => /\[lang-settings-fix\] hook not installed/.test(w)),
      env.warnings.join(' | '));
    t(n('...no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
