/**
 * Uninstalling the playback speed feature (src/playback-speed.js,
 * installSpeedFeature) while a speed reload is still being looked after: its
 * subtitle checks (player-state.js keepCaptions, up to 5 s after the reload
 * plays) and its position check (position-watch.js, 25 s) end with it, so
 * nothing changes the player's subtitles after the feature is gone.
 *
 * The app itself never uninstalls the feature, so the bundle cannot reach
 * this: the module is imported here, in a jsdom window with Web Audio,
 * WebCodecs and MSE faked, its timers counted.
 *
 * Usage: node bench/speed-uninstall-test.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM, VirtualConsole } = require('jsdom');

// mse-hook.js imports '../custom-event-target' (a .ts file) without its extension.
require('./ts-resolve.cjs');

const { createReporter, wait } = require('./harness.cjs');

const MODULE = pathToFileURL(path.resolve(__dirname, '../src/playback-speed.js')).href;

const { t, run } = createReporter();

const EN = { languageCode: 'en', vss_id: '.en', kind: '' };

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e.message));
const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_WATCH"><video></video></body></html>',
  { url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk', virtualConsole: vc, pretendToBeVisual: true });
const win = dom.window;
// The modules the speed feature imports read the page's globals when loaded
// (config.js reads its settings from localStorage).
global.window = win;
global.document = win.document;
global.localStorage = win.localStorage;
for (const name of ['HTMLElement', 'HTMLVideoElement', 'CustomEvent', 'Event', 'KeyboardEvent', 'MutationObserver', 'Node']) {
  global[name] = win[name];
}

const live = new Map();
/** What installSpeedFeature needs (WebCodecs, Web Audio, MSE), and the window's timers counted while due. */
function prepare() {
  win.AudioDecoder = class {};
  win.AudioContext = class {};
  win.MediaSource = class { addSourceBuffer() {} };

  // The window's timers, counted while they are due.
  live.clear();
  const realSetTimeout = win.setTimeout.bind(win);
  const realClearTimeout = win.clearTimeout.bind(win);
  const realSetInterval = win.setInterval.bind(win);
  const realClearInterval = win.clearInterval.bind(win);
  win.setTimeout = (fn, ms) => {
    const id = realSetTimeout(() => { live.delete(id); fn(); }, ms);
    live.set(id, 'timeout ' + ms);
    return id;
  };
  win.clearTimeout = (id) => { live.delete(id); realClearTimeout(id); };
  win.setInterval = (fn, ms) => {
    const id = realSetInterval(fn, ms);
    live.set(id, 'interval ' + ms);
    return id;
  };
  win.clearInterval = (id) => { live.delete(id); realClearInterval(id); };
}

/** YouTube's player: its reload turns the default subtitles on and plays after 300 ms. */
function makePlayer() {
  let state = 1;
  return {
    track: {},
    sets: 0,
    getVideoData: () => ({ video_id: 'abcdefghijk' }),
    getOption(module, name) { return name === 'track' ? this.track : []; },
    setOption(module, name, value) { this.sets++; this.track = value; },
    loadModule() {},
    getCurrentTime: () => 50,
    getPlayerState: () => state,
    getPlaybackQuality: () => 'hd1080',
    getAvailableQualityLevels: () => ['hd1080', 'hd720'],
    setPlaybackQualityRange() {},
    seekTo() {},
    // YouTube's own speed menu bound (enableNativeSpeedMenu): a reload puts it in
    // line 2.5 s later.
    rate: 1,
    rateSets: 0,
    getPlaybackRate() { return this.rate; },
    __ytafOriginalSetPlaybackRate(rate) { this.rateSets++; this.rate = rate; },
    loadVideoById() {
      state = 3;
      this.track = EN;
      setTimeout(() => { state = 1; }, 300);
    }
  };
}

// Loaded before the fakes: the module's own instance (initPlaybackSpeed) does
// not install in a window without Web Audio.
run(async () => {
  const { installSpeedFeature } = await import(MODULE);
  prepare();
  const player = makePlayer();
  const feature = installSpeedFeature(win, {
    notify: () => {},
    configRead: () => undefined,
    getPlayer: () => player
  });
  t('the speed feature installs', !!feature);
  if (!feature) throw new Error('not installed');

  // Subtitles off; 1.5x reloads the video, which turns them on, then plays.
  feature.controller.setSpeed(1.5, { immediate: true });
  await wait(700);
  t('once the reload plays, the subtitles turned off are off again', !player.track.languageCode,
    JSON.stringify(player.track));
  const checks = [...live.values()];
  t('the subtitle and position checks are running before the uninstall',
    checks.includes('timeout 5000') && checks.includes('interval 250') && checks.includes('timeout 2500'), checks.join());

  feature.uninstall();
  const left = [...live.values()];
  t('uninstalled: no subtitle, position or speed menu check is left', left.length === 0, left.join());

  // YouTube's captions module turns them on again a moment later.
  player.track = EN;
  const sets = player.sets;
  const rateSets = player.rateSets;
  await wait(2500);
  t('uninstalled: the player\'s subtitles are left alone', player.track === EN && player.sets === sets,
    `${JSON.stringify(player.track)}, ${player.sets - sets} sets`);
  t('uninstalled: the speed menu is not set afterwards', player.rateSets === rateSets, `${player.rateSets - rateSets} sets`);

  t('no jsdomError', errors.length === 0, errors[0]);
});
