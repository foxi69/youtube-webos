/**
 * Preview countdown (preview-countdown.js): while a tile's preview plays, its
 * time counts down to the video's end, and the tile's own text comes back
 * when the preview stops, the focus moves on or a watch page opens.
 *
 * The bundle in jsdom: a tile shaped as on a webOS 25 TV
 * (ytlr-tile-renderer, its data on __instance.props.data, the time in
 * ytlr-thumbnail-overlay-time-status-renderer > yt-formatted-string), the
 * player element and the shared <video>, whose time is set by hand.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };

function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e && e.message)));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.requestAnimationFrame = () => 0;
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify({ enableSponsorBlock: false, enableReturnYouTubeDislike: false, enableAutoLogin: false }));
  applyChrome38Downgrade(win);
  win.fetch = () => Promise.reject(new Error('offline'));
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, errors };
}

function addTile(win, id, time) {
  const tile = win.document.createElement('ytlr-tile-renderer');
  tile.tabIndex = 0;
  tile.__instance = { props: { data: { contentId: id } } };
  tile.innerHTML = '<ytlr-thumbnail-overlay-time-status-renderer><yt-formatted-string></yt-formatted-string>' +
    '</ytlr-thumbnail-overlay-time-status-renderer><span class="title">A video</span>';
  tile.querySelector('yt-formatted-string').textContent = time;
  win.document.body.appendChild(tile);
  return tile;
}
const badgeOf = (tile) => tile.querySelector('yt-formatted-string').textContent;

function addPlayer(win, state) {
  const p = win.document.createElement('div');
  p.id = 'ytlr-player__player-container-player';
  p.getVideoData = () => ({ video_id: state.id, isLive: !!state.live });
  p.getDuration = () => state.duration;
  win.document.body.appendChild(p);
  return p;
}

function addVideo(win, state) {
  const v = win.document.createElement('video');
  Object.defineProperty(v, 'currentTime', { configurable: true, get: () => state.time, set: (x) => { state.time = x; } });
  Object.defineProperty(v, 'paused', { configurable: true, get: () => !state.playing });
  Object.defineProperty(v, 'duration', { configurable: true, get: () => state.duration });
  win.document.body.appendChild(v);
  return v;
}

(async () => {
  const { win, errors } = boot();
  await wait(50);
  const state = { id: 'aaaaaaaaaa1', duration: 169, time: 12.3, playing: true };
  const tileA = addTile(win, 'aaaaaaaaaa1', '2:49');
  const tileB = addTile(win, 'bbbbbbbbbb1', '10:05');
  addPlayer(win, state);
  const video = addVideo(win, state);
  const tick = (time) => { if (time !== undefined) state.time = time; video.dispatchEvent(new win.Event('timeupdate')); };

  tileA.focus();
  t('precondition: the tile has the focus', win.document.activeElement === tileA);
  tick();
  t('playing preview: the time counts down (169 - 12.3 s -> 2:36)', badgeOf(tileA) === '2:36', badgeOf(tileA));
  tick(100);
  t('...and keeps counting (69 s -> 1:09)', badgeOf(tileA) === '1:09', badgeOf(tileA));
  t('the other tile is untouched', badgeOf(tileB) === '10:05', badgeOf(tileB));

  state.playing = false;
  video.dispatchEvent(new win.Event('pause'));
  t('paused: the tile\'s own time is back', badgeOf(tileA) === '2:49', badgeOf(tileA));
  tick();
  t('a timeupdate while paused leaves it', badgeOf(tileA) === '2:49', badgeOf(tileA));

  state.playing = true;
  tick(20);
  t('playing again: counting again', badgeOf(tileA) === '2:29', badgeOf(tileA));
  tileB.focus();
  t('focus on another tile: the first tile\'s time is back', badgeOf(tileA) === '2:49', badgeOf(tileA));
  tick();
  t('...and the newly focused tile, whose video is not the one playing, is untouched',
    badgeOf(tileB) === '10:05', badgeOf(tileB));

  // Hours.
  state.id = 'bbbbbbbbbb1';
  state.duration = 3725;
  tick(0);
  t('a video over an hour: 1:02:05', badgeOf(tileB) === '1:02:05', badgeOf(tileB));

  // The watch page opens: the tile's own text back, nothing written there.
  win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
  await wait(30);
  t('watch page: the tile\'s own time is back', badgeOf(tileB) === '10:05', badgeOf(tileB));
  tick(5);
  t('...and nothing is counted on the watch page', badgeOf(tileB) === '10:05', badgeOf(tileB));
  win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
  await wait(30);

  // A live badge or any other text stays.
  const live = addTile(win, 'llllllllll1', 'ÉLŐ');
  state.id = 'llllllllll1';
  state.duration = 0;
  live.focus();
  tick(30);
  t('a live badge stays', badgeOf(live) === 'ÉLŐ', badgeOf(live));
  const other = addTile(win, 'oooooooooo1', 'Új');
  state.id = 'oooooooooo1';
  state.duration = 300;
  other.focus();
  tick(30);
  t('a text that is no time stays', badgeOf(other) === 'Új', badgeOf(other));

  // YouTube writes the tile anew while it counts: its text is kept.
  const fresh = addTile(win, 'ffffffffff1', '4:00');
  state.id = 'ffffffffff1';
  state.duration = 240;
  fresh.focus();
  tick(60);
  t('precondition: counting on the new tile', badgeOf(fresh) === '3:00', badgeOf(fresh));
  fresh.querySelector('yt-formatted-string').textContent = '4:01';
  state.playing = false;
  video.dispatchEvent(new win.Event('ended'));
  t('a text YouTube wrote meanwhile is not overwritten on restore', badgeOf(fresh) === '4:01', badgeOf(fresh));

  t('no page errors', errors.length === 0, errors.join(' | '));
  win.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
