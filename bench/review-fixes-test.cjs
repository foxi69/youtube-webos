/**
 * Fixes from a review of the whole source:
 *
 * - video-quality.js attaches to the player when the app starts, on Home too
 *   (where the script runs after the page has loaded). Its attach gives up
 *   after a minute; the first video opened after that got no player, so no
 *   state events at all (Force Max Quality, the queue, the quality toast...).
 * - While it is attached on Home, the player reports the tile previews that
 *   play in it: a preview got the "Playing in ..." toast and the automatic
 *   subtitles, and used up the video's one try for both.
 * - The automatic subtitles' one try was kept for the whole session, so a
 *   video opened a second time got none.
 * - SponsorBlock drew and listed mute segments while "Allow segments that mute
 *   audio" is off, where they are neither muted nor skipped.
 *
 * Usage: node bench/review-fixes-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { UA, setUserAgent, dispatchTrusted } = require('./chrome38-env.cjs');

const bundle = fs.readFileSync(process.argv[2] || 'dist/webOSUserScripts/userScript.js', 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIDEO = 'abcdefghijk';

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };

/**
 * Boots the bundle once the page has loaded (readyState 'complete'), as on a
 * TV, where the userScript comes seconds in. `speed`: the page's timers run
 * that many times faster.
 */
async function boot(cfg, { html, url, speed = 1, fetch, prepare }) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url, virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.fetch = fetch || (() => Promise.reject(new Error('offline')));
  win.XMLHttpRequest = class { open() {} send() { if (this.onerror) this.onerror(); } setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 1);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  if (speed !== 1) {
    const st = win.setTimeout.bind(win);
    const si = win.setInterval.bind(win);
    win.setTimeout = (fn, ms, ...a) => st(fn, (ms || 0) / speed, ...a);
    win.setInterval = (fn, ms, ...a) => si(fn, (ms || 0) / speed, ...a);
  }
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    upgradeThumbnails: false, enableAutoLogin: false
  }, cfg)));
  if (prepare) prepare(win);
  if (win.document.readyState !== 'complete') await new Promise((r) => win.addEventListener('load', r));
  win.eval(bundle);
  return win;
}

/** YouTube's player element, with what the modules ask of it. */
function makePlayer(win, state) {
  const el = win.document.createElement('div');
  el.id = 'ytlr-player__player-container-player';
  el.appendChild(win.document.createElement('video'));
  const p = { el, listeners: [], track: null, setTrack: 0, state, inline: false };
  Object.assign(el, {
    setPlaybackQualityRange() {}, setPlaybackQuality() {},
    getPlaybackQuality: () => 'hd720', getPlaybackQualityLabel: () => '720p',
    getAvailableQualityLevels: () => ['hd720', 'auto'], getVideoData: () => ({ video_id: VIDEO }),
    getPlayerState: () => p.state, pauseVideo() {}, playVideo() {}, isInline: () => p.inline, loadModule() {},
    getOption: (m, name) => (name === 'track' ? p.track : name === 'tracklist' ? [{ languageCode: 'hu' }] : null),
    setOption: (m, name, value) => { if (name === 'track') { p.track = value; p.setTrack++; } },
    addEventListener(type, fn) { if (type === 'onStateChange') p.listeners.push(fn); },
    removeEventListener(type, fn) { p.listeners = p.listeners.filter((f) => f !== fn); }
  });
  p.emit = (next) => { p.state = next; p.listeners.slice().forEach((fn) => { fn(next); }); };
  return p;
}

function openVideo(win) {
  win.location.hash = '#/watch?v=' + VIDEO;
  win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
}

(async () => {
  // ---- The first video after more than a minute on Home with no player ----
  {
    const win = await boot({}, { html: '<body class="WEB_PAGE_TYPE_BROWSE"></body>', url: 'https://www.youtube.com/tv#/', speed: 400 });
    await sleep(600); // four minutes of page time: the attach has given up
    const player = makePlayer(win, 1);
    win.document.body.appendChild(player.el);
    let events = 0;
    win.addEventListener('yt-player-state-change', () => { events++; });
    openVideo(win);
    await sleep(300);
    t('the first video after a minute on Home: the player is attached', player.listeners.length === 1 && events > 0,
      `listeners=${player.listeners.length} events=${events}`);
    win.close();
  }

  // ---- A tile preview on Home, then the video opened ----
  {
    const win = await boot({ subtitleTranslateLang: 'hu', subtitleAutoEnable: true, showQualityOnStart: true },
      { html: '<body class="WEB_PAGE_TYPE_BROWSE"></body>', url: 'https://www.youtube.com/tv#/', speed: 20 });
    const player = makePlayer(win, -1);
    player.inline = true;
    win.document.body.appendChild(player.el);
    await sleep(100);
    t('the player is attached on Home at the start', player.listeners.length === 1);
    player.emit(1); // the preview plays
    await sleep(270); // 5.4 s of page time: the toast comes 4 s in and stays 3 s
    t('a preview on Home: no "Playing in" toast', !/Playing in/.test(win.document.body.textContent));
    await sleep(400); // 8 s more: past the toast and the subtitles' retry
    t('a preview on Home: no subtitles turned on', player.setTrack === 0, `setTrack=${player.setTrack}`);
    // Opened: the same player plays on, with no new state.
    const before = player.setTrack;
    player.inline = false;
    openVideo(win);
    await sleep(400);
    t('the video opened from its preview: subtitles turned on', player.setTrack === before + 1 && !!player.track && player.track.languageCode === 'hu',
      `setTrack=${player.setTrack} before=${before}`);
    t('the video opened from its preview: the "Playing in" toast', /Playing in 720p/.test(win.document.body.textContent));

    // Subtitles turned off by hand stay off while the video is watched...
    // By hand means a key press, which also ends the watch for a reset by the player.
    await sleep(20);
    dispatchTrusted(win.document.body, new win.KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
    const applied = player.setTrack;
    player.track = null;
    player.emit(2);
    player.emit(1);
    await sleep(350);
    t('subtitles turned off by hand stay off for this viewing', player.setTrack === applied, `setTrack=${player.setTrack} applied=${applied}`);
    // ...and come on again when the video is opened another time.
    win.location.hash = '#/';
    win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await sleep(100);
    const fresh = makePlayer(win, 1); // the watch page binds the player anew
    win.document.body.replaceChild(fresh.el, player.el);
    openVideo(win);
    await sleep(400);
    t('the same video opened again: subtitles turned on again', fresh.setTrack === 1, `setTrack=${fresh.setTrack}`);
    win.close();
  }

  // ---- SponsorBlock: mute segments while muting is off ----
  for (const muting of [false, true]) {
    const answer = [{ videoID: VIDEO, segments: [
      { category: 'sponsor', actionType: 'skip', segment: [10, 20], UUID: 'a' },
      { category: 'sponsor', actionType: 'mute', segment: [30, 40], UUID: 'b' }
    ] }];
    const fetch = (url) => (String(url).indexOf('/skipSegments/') !== -1
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(answer))) })
      : Promise.reject(new Error('offline')));
    // eslint-disable-next-line no-await-in-loop
    const win = await boot({ enableSponsorBlock: true, enableMutedSegments: muting, sbPeriodicRefresh: false }, {
      html: '<body class="WEB_PAGE_TYPE_WATCH"><video></video><ytlr-progress-bar><div idomkey="slider"></div></ytlr-progress-bar></body>',
      url: 'https://www.youtube.com/tv#/watch?v=' + VIDEO,
      fetch,
      // The bar is drawn against the video's length.
      prepare: (w) => Object.defineProperty(w.document.querySelector('video'), 'duration', { get: () => 100, configurable: true })
    });
    // eslint-disable-next-line no-await-in-loop
    await sleep(900);
    const bars = win.document.querySelectorAll('#previewbar .previewbar').length;
    const rows = win.document.querySelectorAll('.sb-segment-row').length;
    const want = muting ? 2 : 1;
    t(`SponsorBlock, muting ${muting ? 'on' : 'off'}: ${want} mark(s) on the seek bar and row(s) in the list`,
      bars === want && rows === want, `bars=${bars} rows=${rows}`);
    win.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
