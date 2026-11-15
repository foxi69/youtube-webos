/**
 * Fix Black Tile Previews (preview-fix.js, #67), end to end in the bundle. On
 * webOS 3-6 a tile preview is YouTube's one player scaled onto the tile under
 * the browse page, and the video is a hole punched down to a hardware plane:
 * whatever paints over the middle of it (on an OLED C9 the browse page's
 * black ytlr-surface-page) hides the picture while the sound plays. Until
 * this test nothing ran the decision itself (which elements paint, which are
 * stacked over the video), nor the undo.
 *
 *   node bench/preview-fix-test.cjs <bundle> [legacy|modern]
 *
 * legacy: the legacy bundle as webOS 3 (no elementsFromPoint: only the
 * surface pages over the video count) and as webOS 6 (elementsFromPoint: the
 * whole stack). modern: the modern bundle as webOS 23, where the fix is off.
 *
 * jsdom has no layout: getBoundingClientRect gives each element the rectangle
 * the case sets, and on webOS 6 document.elementsFromPoint returns, topmost
 * first, the elements of a stacking order the case sets whose rectangle holds
 * the point. Colours, images and shadows are inline styles, so jsdom's own
 * getComputedStyle (which applies the bundle's !important rules over them)
 * says what paints.
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

const UA_WEBOS6 = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/79.0.3945.79 Safari/537.36 WebAppManager webOS.TV-2021';
const GREEN = 404;
const CLEARED = 'ytaf-pfix-cleared';
const ON = 'ytaf-pfix-clear';
const TICK = 1150;   // one of the module's 1 s re-checks, and a little more
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

const BLACK = 'background-color: rgb(0, 0, 0)';
// The browse page: two tiles in a row; the player, mounted once, under it.
const PAGE = `<!doctype html><html><head></head><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app id="app" style="${BLACK}">
  <div id="ytlr-player__player-container"><div id="ytlr-player__player-container-player"><video></video></div></div>
  <div id="backdrop" style="${BLACK}"></div>
  <ytlr-surface-page id="browse" style="${BLACK}">
    <div id="tile1" style="background-image: url(tile.png)">
      <img id="thumb1"><div id="shade1" style="box-shadow: 0 0 8px rgb(0, 0, 0)"></div>
      <div id="glass1" style="background-color: rgba(0, 0, 0, 0)"></div>
      <div id="tint1" style="background-color: rgba(0, 0, 0, 0.5)"></div><div id="label1"></div>
    </div>
    <div id="tile2" style="background-image: url(tile.png)"><img id="thumb2"><div id="label2"></div></div>
  </ytlr-surface-page>
  <ytlr-surface-page id="clearpage"></ytlr-surface-page>
  <ytlr-surface-page id="side" style="${BLACK}"></ytlr-surface-page>
</ytlr-app></body></html>`;

const box = (left, top, width, height) => ({ left, top, width, height });
const FULL = box(0, 0, 1920, 1080);
const TILE1 = box(80, 180, 520, 300);
const TILE2 = box(640, 180, 520, 300);
const RECTS = {
  app: FULL, 'ytlr-player__player-container': FULL, backdrop: FULL, browse: FULL, clearpage: FULL,
  side: box(1600, 0, 320, 1080),
  tile1: TILE1, thumb1: TILE1, shade1: TILE1, glass1: TILE1, tint1: TILE1, label1: TILE1,
  tile2: TILE2, thumb2: TILE2, label2: TILE2, icon2: TILE2
};
// Topmost first, as the TV would stack them: the tile's own layers, the
// browse page, then the player and what lies under it.
const ORDER = ['label1', 'tint1', 'glass1', 'shade1', 'thumb1', 'tile1', 'label2', 'thumb2', 'tile2',
  'browse', 'clearpage', 'side', 'VIDEO', 'backdrop', 'ytlr-player__player-container-player',
  'ytlr-player__player-container', 'app'];

/** The bundle on the browse page as `webos` (3, 6 or 23), with `cfg` stored. */
function boot(webos, cfg = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e && e.message)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  setUserAgent(win, webos === 23 ? UA.webos23 : webos === 6 ? UA_WEBOS6 : UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    enableDeArrow: false, upgradeThumbnails: false, enableAutoLogin: false,
    checkForUpdates: false, showWhatsNew: false
  }, cfg)));
  if (webos === 23) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  // Chrome 23 has it; the Chrome 38 environment takes it away all the same
  // (as in upstream-fixes-test).
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.fetch = () => new Promise(() => {});

  const video = doc.querySelector('video');
  const state = { playing: false, ended: false, rect: TILE1, order: ORDER.slice(), fromPoint: [] };
  Object.defineProperty(video, 'paused', { configurable: true, get: () => !state.playing });
  Object.defineProperty(video, 'ended', { configurable: true, get: () => state.ended });
  const keyOf = (el) => (el.tagName === 'VIDEO' ? 'VIDEO' : el.id);
  const rectOf = (el) => (keyOf(el) === 'VIDEO' ? state.rect : RECTS[keyOf(el)]) || box(0, 0, 0, 0);
  win.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const r = rectOf(this);
    return { left: r.left, top: r.top, width: r.width, height: r.height, x: r.left, y: r.top,
      right: r.left + r.width, bottom: r.top + r.height };
  };
  if (webos !== 3) {
    // Chrome 43 and newer. What it was called with, and whether the
    // stylesheet that makes pointer-events: none elements count was in.
    doc.elementsFromPoint = (x, y) => {
      const sheets = Array.prototype.map.call(doc.querySelectorAll('style'), (s) => s.textContent);
      state.fromPoint.push({ x, y, all: sheets.indexOf('*{pointer-events:auto!important}') !== -1 });
      const out = [];
      for (const key of state.order) {
        const el = key === 'VIDEO' ? video : doc.getElementById(key);
        if (!el || !el.isConnected) continue;
        const r = rectOf(el);
        if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) out.push(el);
      }
      return out.concat([doc.body, doc.documentElement]);
    };
  }
  win.eval(code);

  const fire = (type) => video.dispatchEvent(new win.Event(type));
  const env = {
    win, doc, errors, video, state,
    el: (id) => doc.getElementById(id),
    // A preview starting on the tile at `rect`, as YouTube plays it.
    play(rect) { if (rect) state.rect = rect; state.playing = true; state.ended = false; fire('play'); fire('playing'); },
    pause() { state.playing = false; fire('pause'); },
    // At its end, with paused left false: the module takes ended by itself
    // as the preview over, without counting on paused.
    end() { state.ended = true; fire('ended'); },
    // The ids of the elements the fix has cleared, in page order.
    cleared: () => Array.prototype.map.call(doc.querySelectorAll('.' + CLEARED), keyOf).join(','),
    on: () => doc.documentElement.classList.contains(ON),
    style: (id) => win.getComputedStyle(doc.getElementById(id)),
    async page(type) { doc.body.className = 'WEB_PAGE_TYPE_' + type; await wait(30); },
    openPanel() {
      const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
      dispatchTrusted(doc.body, e);
      const tab = Array.prototype.find.call(doc.querySelectorAll('.ytaf-tab-btn'), (b) => b.textContent.trim() === 'UI Tweaks');
      if (tab) tab.click();
    },
    // The panel's Fix Black Tile Previews checkbox (null when not offered).
    checkbox() {
      const label = Array.prototype.find.call(doc.querySelectorAll('.ytaf-ui-container label'),
        (l) => l.textContent.trim() === 'Fix Black Tile Previews');
      return label ? label.querySelector('input[type=checkbox]') : null;
    },
    setBox(on) {
      const b = env.checkbox();
      if (!b) return false;
      b.checked = on;
      b.dispatchEvent(new win.Event('change', { bubbles: true }));
      return true;
    }
  };
  return env;
}

(async () => {
  if (modern) {
    // ---- webOS 23: not a legacy TV, the fix stays off ----
    const env = boot(23);
    await wait(50);
    t('webOS 23: <html> does not get the fix\'s class', !env.on(), env.doc.documentElement.className);
    env.play();
    t('webOS 23: a playing preview clears nothing', env.cleared() === '', env.cleared());
    t('webOS 23: the browse page keeps its black background',
      env.style('browse').backgroundColor === 'rgb(0, 0, 0)', env.style('browse').backgroundColor);
    await wait(TICK);
    t('webOS 23: nothing cleared a second later either, and no stack is looked up',
      env.cleared() === '' && env.state.fromPoint.length === 0, env.cleared() + ' / ' + env.state.fromPoint.length);
    env.openPanel();
    t('webOS 23: the panel does not offer Fix Black Tile Previews',
      !!env.doc.querySelector('.ytaf-ui-container') && env.checkbox() === null);
    t('webOS 23: no page errors', env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  } else {
    // ---- webOS 3: the surface pages over the video ----
    {
      const env = boot(3);
      await wait(50);
      t('webOS 3: <html> gets the fix\'s class (on by default)', env.on(), env.doc.documentElement.className);
      t('webOS 3: nothing is cleared before a preview plays', env.cleared() === '', env.cleared());
      t('webOS 3: the bundle\'s stylesheet has the rule that clears',
        Array.prototype.some.call(env.doc.querySelectorAll('style'),
          (s) => s.textContent.indexOf('html.' + ON + ' .' + CLEARED) !== -1));

      env.play();
      t('webOS 3: a preview playing: the black surface page over it is cleared at once',
        env.cleared() === 'browse', env.cleared());
      t('webOS 3: ...its background is now transparent, so the video shows',
        env.style('browse').backgroundColor === 'rgba(0, 0, 0, 0)', env.style('browse').backgroundColor);
      t('webOS 3: a transparent surface page over it, and one beside it, are left alone',
        !env.el('clearpage').classList.contains(CLEARED) && !env.el('side').classList.contains(CLEARED) &&
        env.style('side').backgroundColor === 'rgb(0, 0, 0)');
      t('webOS 3: no elementsFromPoint: the tile\'s own image is not touched',
        !env.el('thumb1').classList.contains(CLEARED) && env.style('thumb1').opacity !== '0');

      await wait(TICK);
      t('webOS 3: still cleared after the next re-check (no flicker)', env.cleared() === 'browse', env.cleared());

      // YouTube renders the browse page anew while the preview plays.
      const old = env.el('browse');
      const fresh = old.cloneNode(true);
      old.parentNode.replaceChild(fresh, old);
      fresh.classList.remove(CLEARED);
      t('webOS 3: precondition: a new surface page, not cleared yet', env.cleared() === '', env.cleared());
      await wait(TICK);
      t('webOS 3: a re-rendered surface page is cleared at the next re-check', env.cleared() === 'browse' &&
        fresh.classList.contains(CLEARED), env.cleared());
      t('webOS 3: ...and the one it replaced gets its background back', !old.classList.contains(CLEARED));

      // The focus moves on: YouTube stops the preview. The page gets its
      // look back then, not at the next re-check a second later.
      env.pause();
      await wait(30);
      t('webOS 3: the preview stopped (the focus moved on): the surface page gets its black background back at once',
        env.cleared() === '' && env.style('browse').backgroundColor === 'rgb(0, 0, 0)',
        env.cleared() + ' / ' + env.style('browse').backgroundColor);
      t('webOS 3: <html> keeps the fix\'s class (the setting is on)', env.on());
      await wait(TICK);
      t('webOS 3: ...and it stays so', env.cleared() === '', env.cleared());

      env.play();
      env.end();
      await wait(30);
      t('webOS 3: a preview that ended: the background comes back at once too', env.cleared() === '', env.cleared());
      await wait(TICK);

      // The preview opened: the watch page plays in the same <video>.
      env.play();
      t('webOS 3: precondition: cleared again for a new preview', env.cleared() === 'browse', env.cleared());
      await env.page('WATCH');
      t('webOS 3: the watch page opens: the background comes back at once', env.cleared() === '', env.cleared());
      env.play();
      await wait(TICK);
      t('webOS 3: on the watch page a playing video clears nothing', env.cleared() === '', env.cleared());
      await env.page('BROWSE');
      t('webOS 3: back on the browse page, nothing cleared until a preview plays', env.cleared() === '', env.cleared());
      env.play();
      t('webOS 3: ...and a preview there is cleared again', env.cleared() === 'browse', env.cleared());
      await env.page('SHORTS');
      t('webOS 3: Shorts opens: the background comes back', env.cleared() === '', env.cleared());
      await env.page('BROWSE');

      // A preview whose video has no size on the screen covers nothing.
      env.play(box(0, 0, 0, 0));
      t('webOS 3: a playing video with no size: nothing cleared', env.cleared() === '', env.cleared());
      env.pause();
      await wait(TICK);

      // The setting, switched in the panel while a preview plays.
      env.play(TILE1);
      env.openPanel();
      t('webOS 3: the panel offers Fix Black Tile Previews, checked', !!env.checkbox() && env.checkbox().checked);
      t('webOS 3: turned off in the panel', env.setBox(false));
      t('webOS 3: ...<html> loses the fix\'s class', !env.on(), env.doc.documentElement.className);
      t('webOS 3: ...and the playing preview\'s page gets its background back at once',
        env.cleared() === '' && env.style('browse').backgroundColor === 'rgb(0, 0, 0)', env.cleared());
      env.play();
      await wait(TICK);
      t('webOS 3: off: a preview playing clears nothing', env.cleared() === '', env.cleared());
      env.setBox(true);
      t('webOS 3: turned on again: <html> gets the class back', env.on());
      env.play();
      t('webOS 3: ...and the next preview is cleared', env.cleared() === 'browse', env.cleared());
      t('webOS 3: no page errors', env.errors.length === 0, env.errors.join(' | '));
      env.win.close();
    }

    // ---- The setting off from the start ----
    {
      const env = boot(3, { fixBlackPreviews: false });
      await wait(50);
      t('setting off: <html> does not get the fix\'s class', !env.on(), env.doc.documentElement.className);
      env.play();
      await wait(TICK);
      t('setting off: a playing preview clears nothing', env.cleared() === '' &&
        env.style('browse').backgroundColor === 'rgb(0, 0, 0)', env.cleared());
      t('setting off: no page errors', env.errors.length === 0, env.errors.join(' | '));
      env.win.close();
    }

    // ---- webOS 6: the whole stack over the middle of the video ----
    {
      const env = boot(6);
      await wait(50);
      env.play(TILE1);
      const call = env.state.fromPoint[0] || {};
      t('webOS 6: the stack is looked up at the middle of the video (340, 330)',
        call.x === 340 && call.y === 330, JSON.stringify(call));
      t('webOS 6: ...with pointer-events: none elements counted during the lookup', call.all === true);
      t('webOS 6: ...and that stylesheet gone again afterwards', !Array.prototype.some.call(
        env.doc.querySelectorAll('style'), (s) => s.textContent.indexOf('pointer-events:auto') !== -1));
      // Over the video, page order: the browse page; on the tile, its
      // background image, the image, the shadow and the half-black tint.
      t('webOS 6: what paints over the video is cleared: the page, the tile\'s image, shadow, tint, picture',
        env.cleared() === 'browse,tile1,thumb1,shade1,tint1', env.cleared());
      t('webOS 6: what draws nothing is left alone (a label, a fully transparent layer, a transparent page)',
        !env.el('label1').classList.contains(CLEARED) && !env.el('glass1').classList.contains(CLEARED) &&
        !env.el('clearpage').classList.contains(CLEARED));
      t('webOS 6: under the video nothing is touched (a backdrop, the player, the app)',
        !env.el('backdrop').classList.contains(CLEARED) && !env.el('app').classList.contains(CLEARED) &&
        !env.doc.body.classList.contains(CLEARED));
      t('webOS 6: a tile not over the video is left alone', !env.el('tile2').classList.contains(CLEARED) &&
        !env.el('thumb2').classList.contains(CLEARED));
      t('webOS 6: the cleared image is hidden, the shadow and background image gone',
        env.style('thumb1').opacity === '0' && env.style('shade1').boxShadow === 'none' &&
        env.style('tile1').backgroundImage === 'none',
        [env.style('thumb1').opacity, env.style('shade1').boxShadow, env.style('tile1').backgroundImage].join(' / '));

      await wait(TICK);
      t('webOS 6: still the same after the next re-check', env.cleared() === 'browse,tile1,thumb1,shade1,tint1',
        env.cleared());

      // The focus moves to the next tile and YouTube plays its preview there.
      env.play(TILE2);
      t('webOS 6: the focus moves on, the preview plays on the next tile: that tile is cleared',
        env.cleared() === 'browse,tile2,thumb2', env.cleared());
      t('webOS 6: ...and the first tile gets its image, shadow and tint back',
        env.style('thumb1').opacity !== '0' && env.style('shade1').boxShadow !== 'none' &&
        env.style('tint1').backgroundColor === 'rgba(0, 0, 0, 0.5)');

      // An SVG drawn over the video (an icon on the tile) paints too: it is
      // hidden like the image.
      const icon = env.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.id = 'icon2';
      env.el('tile2').appendChild(icon);
      env.state.order = ['icon2'].concat(ORDER);
      await wait(TICK);
      t('webOS 6: an SVG over the video is cleared, and hidden', icon.classList.contains(CLEARED) &&
        env.style('icon2').opacity === '0', env.cleared() + ' / opacity ' + env.style('icon2').opacity);
      env.state.order = ORDER.slice();
      await wait(TICK);
      t('webOS 6: ...and shown again once it no longer covers it', !icon.classList.contains(CLEARED) &&
        env.style('icon2').opacity !== '0', env.style('icon2').opacity);

      // A pointer-events quirk: an element holding the video comes first.
      env.state.order = ['ytlr-player__player-container'].concat(ORDER);
      await wait(TICK);
      t('webOS 6: nothing under an element that holds the video is cleared', env.cleared() === '', env.cleared());
      env.state.order = ORDER.slice();

      env.play(TILE1);
      await env.page('WATCH');
      t('webOS 6: the watch page opens: everything gets its look back', env.cleared() === '' &&
        env.style('browse').backgroundColor === 'rgb(0, 0, 0)' && env.style('thumb1').opacity !== '0', env.cleared());
      t('webOS 6: no page errors', env.errors.length === 0, env.errors.join(' | '));
      env.win.close();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
