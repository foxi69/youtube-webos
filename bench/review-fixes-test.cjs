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
  // How often the page looks for the player: the attach poll's heartbeat.
  win.playerLookups = 0;
  const byId = win.document.getElementById.bind(win.document);
  win.document.getElementById = (id) => {
    if (id === 'ytlr-player__player-container-player') win.playerLookups++;
    return byId(id);
  };
  // Every "Playing in ..." toast put on the page, with the page it came on.
  win.qualityToasts = [];
  new win.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (/Playing in/.test(node.textContent || '')) win.qualityToasts.push(win.document.body.className);
      }
    }
  }).observe(win.document.documentElement, { childList: true, subtree: true });
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

/** Waits until `check()` holds, at most `ms`; resolves with whether it did. */
async function until(check, ms) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

function openVideo(win) {
  win.location.hash = '#/watch?v=' + VIDEO;
  win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
}

(async () => {
  // ---- The first video after more than a minute on Home with no player ----
  {
    const win = await boot({}, { html: '<body class="WEB_PAGE_TYPE_BROWSE"></body>', url: 'https://www.youtube.com/tv#/', speed: 400 });
    // The attach at the start has given up: it looked for the player its
    // hundred-odd times and then no more, however slowly its timers ran.
    let seen = -1;
    const gaveUp = await until(() => {
      const quiet = win.playerLookups > 100 && win.playerLookups === seen;
      seen = win.playerLookups;
      return quiet;
    }, 20000);
    await sleep(200);
    t('the attach at the start gives up with no player', gaveUp && win.playerLookups === seen, `lookups=${win.playerLookups}`);
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
    await sleep(670); // 13 s of page time: past the toast's 4 s and the subtitles' retry
    t('a preview on Home: no "Playing in" toast', win.qualityToasts.length === 0, win.qualityToasts.join(','));
    t('a preview on Home: no subtitles turned on', player.setTrack === 0, `setTrack=${player.setTrack}`);
    // Opened: the same player plays on, with no new state.
    const before = player.setTrack;
    player.inline = false;
    openVideo(win);
    await sleep(400);
    t('the video opened from its preview: subtitles turned on', player.setTrack === before + 1 && !!player.track && player.track.languageCode === 'hu',
      `setTrack=${player.setTrack} before=${before}`);
    const toasted = await until(() => win.qualityToasts.length > 0, 5000);
    t('the video opened from its preview: the "Playing in" toast, on the watch page',
      toasted && win.qualityToasts.length === 1 && win.qualityToasts[0] === 'WEB_PAGE_TYPE_WATCH', win.qualityToasts.join(','));

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
    const win = await boot({ enableSponsorBlock: true, enableMutedSegments: muting, sbPeriodicRefresh: false }, {
      html: '<body class="WEB_PAGE_TYPE_WATCH"><video></video><ytlr-progress-bar><div idomkey="slider"></div></ytlr-progress-bar></body>',
      url: 'https://www.youtube.com/tv#/watch?v=' + VIDEO,
      fetch,
      // The bar is drawn against the video's length.
      prepare: (w) => Object.defineProperty(w.document.querySelector('video'), 'duration', { get: () => 100, configurable: true })
    });
    await sleep(900);
    // Which ones, not how many: the skip segment is 10 to 20 of 100 s, the mute one 30 to 40.
    const bars = Array.prototype.map.call(win.document.querySelectorAll('#previewbar .previewbar'), (b) => `${b.style.left} ${b.style.width}`);
    const rows = Array.prototype.map.call(win.document.querySelectorAll('.sb-segment-row .sb-segment-time'), (r) => r.textContent);
    const wantBars = muting ? ['10% 10%', '30% 10%'] : ['10% 10%'];
    const wantRows = muting ? ['00:10 to 00:20', '00:30 to 00:40'] : ['00:10 to 00:20'];
    t(`SponsorBlock, muting ${muting ? 'on: the skip and the mute segment' : 'off: the skip segment alone'} on the seek bar and in the list`,
      bars.join('|') === wantBars.join('|') && rows.join('|') === wantRows.join('|'), `bars=${bars.join('|')} rows=${rows.join('|')}`);
    // Switched during the video, in the panel: the bar and the list follow at once.
    const e = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 404, configurable: true }); // green: the panel
    dispatchTrusted(win.document.body, e);
    // The SponsorBlock page is built a frame after the panel opens.
    await until(() => Array.from(win.document.querySelectorAll('label .label-text')).some((l) => l.textContent === 'Allow segments that mute audio'), 2000);
    const label = Array.from(win.document.querySelectorAll('label'))
      .find((l) => (l.querySelector('.label-text') || {}).textContent === 'Allow segments that mute audio');
    const input = label && label.querySelector('input');
    t('SponsorBlock: the muting switch is in the panel', !!input);
    if (input) {
      input.checked = !muting;
      input.dispatchEvent(new win.Event('change'));
    }
    await sleep(300);
    const barsAfter = Array.prototype.map.call(win.document.querySelectorAll('#previewbar .previewbar'), (b) => `${b.style.left} ${b.style.width}`);
    const rowsAfter = Array.prototype.map.call(win.document.querySelectorAll('.sb-segment-row .sb-segment-time'), (r) => r.textContent);
    const flipBars = muting ? ['10% 10%'] : ['10% 10%', '30% 10%'];
    const flipRows = muting ? ['00:10 to 00:20'] : ['00:10 to 00:20', '00:30 to 00:40'];
    t(`SponsorBlock, muting switched ${muting ? 'off' : 'on'} during the video: the seek bar and the list follow`,
      barsAfter.join('|') === flipBars.join('|') && rowsAfter.join('|') === flipRows.join('|'), `bars=${barsAfter.join('|')} rows=${rowsAfter.join('|')}`);
    win.close();
  }

  // ---- Force Max Quality: a stream that falls on its own is put back up ----
  // A video that starts at its best level gets no range (it would reload),
  // and after a seek the stream fell to 1080p by itself (seen on webOS 25).
  for (const variant of ['falls', 'byHand', 'throws']) {
    const win = await boot({ forceHighResVideo: true },
      { html: '<body class="WEB_PAGE_TYPE_WATCH"></body>', url: 'https://www.youtube.com/tv#/watch?v=' + VIDEO, speed: 20 });
    const player = makePlayer(win, -1);
    let quality = 'hd1440';
    // Every setPlaybackQualityRange call; with 'throws', the first one fails.
    const ranges = [];
    Object.assign(player.el, {
      getAvailableQualityLevels: () => ['hd1440', 'hd1080', 'hd720', 'auto'],
      getPlaybackQuality: () => quality,
      getPlaybackQualityLabel: () => quality,
      // What YouTube's menu leaves when a level is picked there.
      getUserPlaybackQualityPreference: () => (variant === 'byHand' ? 'hd720' : 'auto'),
      setPlaybackQualityRange: (min) => {
        ranges.push(min);
        if (variant === 'throws' && ranges.length === 1) throw new Error('player busy');
        quality = 'hd1440';
      }
    });
    win.document.body.appendChild(player.el);
    // Without the player attached, no case below would test anything.
    const attached = await until(() => player.listeners.length === 1, 3000);
    t(`Force Max Quality (${variant}): the player is attached`, attached, `listeners=${player.listeners.length}`);
    if (!attached) { win.close(); continue; }
    player.emit(1);
    await sleep(100);
    const video = player.el.querySelector('video');
    const fall = async (to) => { quality = to; video.dispatchEvent(new win.Event('resize')); await sleep(50); };
    if (variant === 'falls') {
      t('Force Max Quality: a video that starts at its best level gets no range', ranges.length === 0, ranges.join());
      await fall('hd1080');
      t('Force Max Quality: fallen to 1080p on its own, the range is set again', ranges.join() === 'highres', ranges.join());
      await fall('hd1080');
      t('Force Max Quality: put back up once per video, not again', ranges.length === 1, ranges.join());
    } else if (variant === 'byHand') {
      await fall('hd720');
      t('Force Max Quality: a level picked by hand in the menu is left as it is', ranges.length === 0, ranges.join());
    } else {
      await fall('hd1080');
      await fall('hd1080');
      t('Force Max Quality: a call that failed gets one more try', ranges.length === 2 && quality === 'hd1440', ranges.join());
      await fall('hd1080');
      await fall('hd1080');
      t('Force Max Quality: and no more after that', ranges.length === 2, ranges.join());
    }
    win.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
