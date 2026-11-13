/**
 * Open Playing Previews Without Reloading: the blockAdoption flag the server
 * puts on a preview's data is cleared in the response, so OK on a playing
 * preview carries that playback on (adblock.js, allowPreviewHandover).
 *
 * Where the flag sits in a real response is not known here: the fixtures put
 * it in several places, which is what the search by name is for.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
const GREEN = 404;
const LABEL = 'Open Playing Previews Without Reloading';

// Everything that needs the JSON.parse hook off, so a case can show the
// switch keeps the hook by itself. With the left menu's entries learnt
// (LEARNT): until then Hide Left Menu Entries keeps the hook too.
const ALL_OFF = {
  enableAdBlock: false, enableTrackingBlock: false, removeGlobalShorts: false,
  removeLiveVideos: false, removeAiVideos: false, markAiVideos: false, removeTopLiveGames: false,
  removeMostRelevant: false, hideGuestSignInPrompts: false, hideEndcards: false,
  enableLegacyEmojiFix: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
  upgradeThumbnails: false, enableAutoLogin: false, loadRowsAhead: false,
  disableAutoCaptions: false, forceOriginalAudio: false, extendLongPressMenu: false,
  enableDeArrow: false, hiddenSidebarEntries: []
};
const LEARNT = { 'ytaf-sidebar-entries': JSON.stringify([{ id: 'FEtopics_music', title: 'Music' }]) };

function boot(cfg, storage = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String(e && e.message)));
  const dom = new JSDOM(
    '<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.requestAnimationFrame = () => 0;
  win.cancelAnimationFrame = () => {};
  win.fetch = () => Promise.reject(new Error('offline'));
  win.localStorage.setItem('ytaf-configuration', win.JSON.stringify(cfg));
  for (const k of Object.keys(storage)) win.localStorage.setItem(k, storage[k]);
  applyChrome38Downgrade(win);
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, errors };
}

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };
const pad = 'z'.repeat(600);

// A tile with preview data, the flag at the depth `wrap` gives it.
const tile = (id, flag, wrap) => {
  let preview = { videoId: id, blockAdoption: flag };
  for (let i = 0; i < wrap; i++) preview = { inner: [preview] };
  return { tileRenderer: { contentId: id, onFocusCommand: { previewCommand: preview } } };
};

// A Home response: two shelves of tiles, and the flag once more outside them.
function browse(flag) {
  return {
    responseContext: { _pad: pad },
    contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: {
      sectionListRenderer: { contents: [
        { shelfRenderer: { content: { horizontalListRenderer: { items: [tile('aaaaaaaaaa1', flag, 0), tile('aaaaaaaaaa2', flag, 3)] } } } },
        { shelfRenderer: { content: { horizontalListRenderer: { items: [tile('aaaaaaaaaa3', flag, 12)] } } } }
      ] } } } } } },
    frameworkUpdates: { previewConfig: { blockAdoption: flag } }
  };
}

// Every blockAdoption value in a parsed response, in the order met.
function flags(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if ('blockAdoption' in node) out.push(node.blockAdoption);
  for (const k of Object.keys(node)) flags(node[k], out);
  return out;
}

// Opens the panel on UI Tweaks and returns the switch's checkbox.
function panelSwitch(win) {
  const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => GREEN, configurable: true });
  dispatchTrusted(win.document.body, e);
  for (const tab of win.document.querySelectorAll('.ytaf-tab-btn')) tab.click();
  return [...win.document.querySelectorAll('label')]
    .filter((l) => l.textContent.indexOf(LABEL) !== -1)
    .map((l) => l.querySelector('input[type=checkbox]'))[0];
}

(async () => {
  {
    const { win, errors } = boot({ continuePreviews: true });
    const out = win.JSON.parse(JSON.stringify(browse(true)));
    const found = flags(out);
    t('on: every blockAdoption of a response is cleared, at any depth', found.length === 4 && found.every((f) => f === false), JSON.stringify(found));
    t('the rest of the response is as it came', out.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content
      .sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items[1].tileRenderer.contentId === 'aaaaaaaaaa2');

    const spaced = win.JSON.parse(JSON.stringify(browse(true), null, 1));
    t('a response written with spaces is cleared too', flags(spaced).every((f) => f === false), JSON.stringify(flags(spaced)));

    const colon = win.JSON.parse(JSON.stringify(browse(true)).split('"blockAdoption":').join('"blockAdoption" : '));
    t('a space before the colon is cleared too', flags(colon).length === 4 && flags(colon).every((f) => f === false), JSON.stringify(flags(colon)));

    // The true flag is what gets the response walked at all: without it the
    // other values would pass untouched whatever the walk did.
    const others = win.JSON.parse(JSON.stringify({
      responseContext: { _pad: pad },
      a: { blockAdoption: false }, b: { blockAdoption: 'true' }, c: { blockAdoption: null }, d: { blockAdoption: 1 },
      e: { blockAdoption: true }
    }));
    t('only a true flag is touched', JSON.stringify(flags(others)) === '[false,"true",null,1,false]', JSON.stringify(flags(others)));

    const cont = win.JSON.parse(JSON.stringify({
      continuationContents: { horizontalListContinuation: { items: [tile('aaaaaaaaaa4', true, 2)] } }, _pad: pad
    }));
    t('a continuation is cleared too', flags(cont)[0] === false, JSON.stringify(flags(cont)));
    t('no page errors', errors.length === 0, errors.join(' | '));
  }
  {
    const { win } = boot({});
    const found = flags(win.JSON.parse(JSON.stringify(browse(true))));
    t('off (the default): the flag stays', found.length === 4 && found.every((f) => f === true), JSON.stringify(found));
  }
  {
    const { win, errors } = boot(Object.assign({}, ALL_OFF, { continuePreviews: true }), LEARNT);
    const found = flags(win.JSON.parse(JSON.stringify(browse(true))));
    t('on with every other use of the hook off: still cleared', found.every((f) => f === false), JSON.stringify(found));
    t('no page errors', errors.length === 0, errors.join(' | '));
  }
  {
    const { win, errors } = boot(ALL_OFF, LEARNT);
    const before = flags(win.JSON.parse(JSON.stringify(browse(true))));
    t('everything off: the flag stays', before.every((f) => f === true), JSON.stringify(before));
    const box = panelSwitch(win);
    t('the switch is in the panel, off', !!box && box.checked === false);
    if (box) {
      box.click();
      const on = flags(win.JSON.parse(JSON.stringify(browse(true))));
      t('switched on in the panel: cleared from the next response', on.every((f) => f === false), JSON.stringify(on));
      // The write to storage is debounced.
      await new Promise((r) => setTimeout(r, 400));
      t('and stored', JSON.parse(win.localStorage.getItem('ytaf-configuration')).continuePreviews === true);
      box.click();
      const off = flags(win.JSON.parse(JSON.stringify(browse(true))));
      t('switched off again: the flag stays', off.every((f) => f === true), JSON.stringify(off));
    }
    t('no page errors', errors.length === 0, errors.join(' | '));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
