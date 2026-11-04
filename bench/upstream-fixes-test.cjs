/**
 * Fixes taken from mirijanristic's fork: the SponsorBlock switch and same-video
 * hash changes, the OLED blackout under the panel, the Auto Login window, test
 * thumbnails, chapter skipping without markers, the clock after standby and
 * the no-ad flag with Ad Blocking off.
 *
 * Usage: node bench/upstream-fixes-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const RED = 403;
const GREEN = 404;
const FIVE = 53; // Skip to Next Chapter, by default.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = 'z'.repeat(600);

function boot(cfg, opts = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(`<!doctype html><html><body class="${opts.bodyClass || 'WEB_PAGE_TYPE_BROWSE'}"><ytlr-app>${opts.html || ''}</ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: opts.url || 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  win.cancelAnimationFrame = () => {};
  // A clock that can jump, for the time windows and the standby.
  const clock = { offset: 0 };
  const RealDate = win.Date;
  win.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() + clock.offset);
    }
    static now() { return RealDate.now() + clock.offset; }
  };
  const NS = win.JSON.stringify;
  win.localStorage.setItem('ytaf-configuration', NS(Object.assign({
    enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false,
    checkForUpdates: false, showWhatsNew: false
  }, cfg)));
  applyChrome38Downgrade(win);
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  // Requests that never answer: a handler stays as it is.
  win.fetch = () => new Promise(() => {});
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  const key = (code) => {
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => code, configurable: true });
    dispatchTrusted(win.document.body, e);
  };
  const toasts = () => (win.document.querySelector('.ytaf-notification-container') || {}).textContent || '';
  return { win, errors, clock, key, toasts, parse: (o) => win.JSON.parse(NS(o)) };
}

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};

setTimeout(async () => {
  // ---- No-ad flag ----
  {
    const request = { context: { client: {} }, playbackContext: { contentPlaybackContext: {} } };
    t('the no-ad flag goes out with Ad Blocking on',
      /isInlinePlaybackNoAd/.test(boot({ enableAdBlock: true }).win.JSON.stringify(request)));
    t('the no-ad flag stays out with Ad Blocking off',
      !/isInlinePlaybackNoAd/.test(boot({ enableAdBlock: false }).win.JSON.stringify(request)));
  }

  // ---- Thumbnail test variants ----
  {
    const { parse } = boot({ upgradeThumbnails: true, thumbnailQualityMode: 'sd' });
    const tile = (id, name) => ({ tileRenderer: { style: 'TILE_STYLE_YTLR_DEFAULT', contentId: id, onSelectCommand: { watchEndpoint: { videoId: id } },
      header: { tileHeaderRenderer: { thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/${name}.jpg?sqp=signed&rs=signed`, width: 320, height: 180 }] } } } } });
    const r = parse({ responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: {
      sectionListRenderer: { contents: [{ shelfRenderer: { content: { horizontalListRenderer: { items: [tile('testvariant', 'hqdefault_custom_1'), tile('shortscrop1', 'oar2')] } } } }] } } } } } } });
    const items = r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items;
    const url = (i) => items[i].tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url;
    t('a thumbnail test variant gets the video\'s own thumbnail', /\/testvariant\/sddefault\.(jpg|webp)/.test(url(0)), url(0));
    t('a name the ladder does not know stays as sent', /\/oar2\.jpg/.test(url(1)), url(1));
  }

  // ---- OLED blackout and the panel ----
  {
    const { win, key, errors } = boot({});
    await wait(20);
    key(RED);
    t('Red turns the blackout on', !!win.document.getElementById('oled-black-overlay'));
    key(GREEN);
    await wait(20);
    const panel = win.document.querySelector('.ytaf-ui-container');
    t('the panel opens', panel && panel.style.display === 'block');
    t('and the blackout does not stay over it', !win.document.getElementById('oled-black-overlay') &&
      !win.document.documentElement.classList.contains('ytaf-oled-blackout'));
    t('blackout: no page errors', errors.length === 0, errors.join(' | '));
  }

  // ---- SponsorBlock: the switch, and hash changes within a video ----
  {
    const { win, key } = boot({ enableSponsorBlock: true },
      { url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk', bodyClass: 'WEB_PAGE_TYPE_WATCH' });
    await wait(600);
    const first = win.sponsorblock;
    t('a handler runs for the video', first && first.videoID === 'abcdefghijk');
    win.location.hash = '#/watch?v=abcdefghijk&t=5';
    await wait(50);
    t('a hash change within the same video keeps it', win.sponsorblock === first && !first.isDestroyed);
    win.location.hash = '#/watch?v=otherother1';
    await wait(50);
    t('another video gets its own', win.sponsorblock && win.sponsorblock.videoID === 'otherother1' && first.isDestroyed);

    key(GREEN);
    await wait(20);
    win.document.querySelectorAll('.ytaf-tab-btn')[3].click();
    await wait(20);
    const box = win.document.querySelector('#ytaf-page-sponsor input[type=checkbox]');
    box.click();
    await wait(50);
    t('turning the switch off stops it at once', !win.sponsorblock);
    box.click();
    await wait(50);
    t('turning it on starts it for this video', win.sponsorblock && win.sponsorblock.videoID === 'otherother1');
  }

  // ---- Auto Login: the time window ----
  {
    const { win, clock } = boot({ enableAutoLogin: true, autoSelectAccount: true });
    const body = win.document.body;
    const selector = async () => {
      body.className = 'WEB_PAGE_TYPE_ACCOUNT_SELECTOR';
      win.dispatchEvent(new win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
      await wait(10);
      const bypassed = body.classList.contains('ytaf-bypassing-login');
      body.className = 'WEB_PAGE_TYPE_BROWSE';
      await wait(10);
      return bypassed;
    };
    const relaunch = () => win.document.dispatchEvent(new win.CustomEvent('webOSRelaunch', { detail: {} }));
    clock.offset += 16000;
    t('after the start-up window the selector is left alone', !(await selector()));
    relaunch();
    await wait(10);
    t('a relaunch opens the window again', await selector());
    t('and it bypasses once', !(await selector()));
    relaunch();
    await wait(10);
    clock.offset += 16000;
    t('the window closes again: opening the picker later presses nothing', !(await selector()));
  }

  // ---- Chapter skip ----
  {
    const video = '<video></video>';
    const bar = '<ytlr-multi-markers-player-bar-renderer><div idomkey="progress-bar"><div idomkey="played"></div></div></ytlr-multi-markers-player-bar-renderer>';
    const watch = { url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk', bodyClass: 'WEB_PAGE_TYPE_WATCH' };
    const ready = async (win) => {
      Object.defineProperty(win.document.querySelector('video'), 'duration', { value: 600 });
      // The app learns the page from the changes it watches.
      win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
      await wait(20);
      win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
      win.dispatchEvent(new win.Event('hashchange'));
      await wait(50);
    };
    {
      const { win, key, toasts } = boot({}, Object.assign({ html: video + bar }, watch));
      await ready(win);
      key(FIVE);
      await wait(50);
      t('a bar without chapter markers says so', /No chapters found/.test(toasts()), toasts());
    }
    {
      const { win, key, toasts } = boot({}, Object.assign({ html: video }, watch));
      await ready(win);
      key(FIVE);
      await wait(150);
      key(FIVE);
      await wait(100);
      t('a second press while chapters load says nothing yet', /Loading chapters/.test(toasts()) && !/No chapters found/.test(toasts()), toasts());
    }
  }

  // ---- The clock after standby ----
  {
    const { win, clock } = boot({ clockMode: 'time' });
    await wait(20);
    const text = () => win.document.querySelector('.webOs-watch').textContent;
    const before = text();
    clock.offset += 3 * 3600000 + 1800000;
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    t('the clock is right on coming back', text() !== before && text() !== '', `${before} -> ${text()}`);
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 0);
