/**
 * Force Max Quality and Show Video Quality on Start (src/video-quality.js)
 * against the built bundle, case by case: a video that starts below its best
 * level is paused, upgraded and played on, with a notice once the player
 * moved; one already at its best, or whose levels are not listed yet, is left
 * alone; the quality record it keeps (written, renewed before it expires,
 * dropped when switched off, a viewer's own left alone); a player that sends
 * no state events (polled instead) or mounts late; leaving the watch page;
 * the first video on webOS 25, which can wait unstarted until it is told to
 * play; and the "Playing in" notice when the player has no label.
 *
 * The position fix after the switch is quality-reload-test's, the carried-over
 * preview handover-quality-test's, the relock after a fall review-fixes-test's.
 * YouTube's player is a stand-in that records its calls.
 *
 * Usage: node bench/video-quality-cases-test.cjs <bundle> [legacy|modern]
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { UA, setUserAgent, applyChrome38Downgrade, applyChrome87Downgrade } = require('./chrome38-env.cjs');
const { createReporter, trustedKey, wait } = require('./harness.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const bundle = fs.readFileSync(bundlePath, 'utf8');

const GREEN = 404;
const KEY = 'yt-player-quality';
const YEAR = 365 * 24 * 60 * 60 * 1000;
// webOS 25, which gets the modern build.
const UA25 = UA.webos23.replace('webOS.TV-2023', 'webOS.TV-2025');

const { t, run } = createReporter();
// Every boot's jsdomErrors (a script error on the page), checked at the end.
const allErrors = [];

/**
 * The bundle on the watch page. opts.player: the player is there from the
 * start (true), mounts `ms` later (a number) or never (false). opts.events:
 * whether the player takes state listeners. opts.record: the yt-player-quality
 * record in storage before the app starts.
 */
function boot(cfg, { player = true, events = true, record, ua, quality = 'hd720', state = 1, levels } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { errors.push(e.message); allErrors.push(e.message); });
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_WATCH"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, ua || (modern ? UA.webos23 : UA.webos3));
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  // Chrome 23 has it; the Chrome 38 environment takes it away all the same.
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.launchParams = '{}';
  win.fetch = () => Promise.reject(new Error('offline'));
  win.XMLHttpRequest = class {
    open() {} send() { if (this.onerror) this.onerror(); }
    setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {}
  };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = () => {};
  if (record) win.localStorage.setItem(KEY, JSON.stringify(record));
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    thumbnailQuality: 'off', enableAutoLogin: false, enablePlaybackSpeed: false, forceHighResVideo: true
  }, cfg)));

  const log = { calls: [], listeners: 0 };
  const p = win.document.createElement('div');
  p.id = 'ytlr-player__player-container-player';
  p.innerHTML = '<video></video>';
  const s = { state, quality, levels: levels || ['hd2160', 'hd1080', 'hd720', 'auto'], label: true, videoId: 'abcdefghijk' };
  let onStateChange = null;
  const calls = (name) => (...args) => { log.calls.push(name + (args.length ? ':' + args.join(',') : '')); };
  Object.assign(p, {
    getVideoData: () => ({ video_id: s.videoId }),
    getPlayerState: () => s.state,
    getCurrentTime: () => 10,
    getAvailableQualityLevels: () => s.levels,
    getPlaybackQuality: () => s.quality,
    getUserPlaybackQualityPreference: () => 'auto',
    setPlaybackQualityRange(a) { log.calls.push('range:' + a); if (a === 'highres') s.quality = s.levels[0]; },
    setPlaybackQuality: calls('quality'),
    pauseVideo() { log.calls.push('pause'); },
    playVideo() { log.calls.push('play'); },
    isInline: () => false,
    removeEventListener() { log.calls.push('removeListener'); }
  });
  Object.defineProperty(p, 'getPlaybackQualityLabel', { configurable: true,
    get: () => (s.label ? () => ({ hd2160: '2160p60', hd1080: '1080p', hd720: '720p' })[s.quality] : undefined) });
  p.addEventListener = function (type, cb, ...rest) {
    if (type === 'onStateChange') {
      // A state listener that cannot be added: video-quality.js polls the state instead.
      if (!events) throw new Error('no state events');
      onStateChange = cb;
      log.listeners++;
      return;
    }
    win.HTMLElement.prototype.addEventListener.call(this, type, cb, ...rest);
  };
  const mount = () => win.document.querySelector('ytlr-app').appendChild(p);
  if (player === true) mount();
  win.eval(bundle);
  if (typeof player === 'number') setTimeout(mount, player);

  const toasts = () => Array.from(win.document.querySelectorAll('.ytaf-notification-container .message')).map((m) => m.textContent);
  const emit = (next) => { s.state = next; if (onStateChange) onStateChange(next); };
  const stored = () => { try { const r = JSON.parse(win.localStorage.getItem(KEY)); return r && { ...r, data: JSON.parse(r.data) }; } catch { return null; } };
  const toggle = (label, on) => {
    if (!win.document.querySelector('.ytaf-ui-container')) {
      trustedKey(win, GREEN);
    }
    const input = Array.from(win.document.querySelectorAll('.ytaf-ui-container label'))
      .find((l) => l.querySelector('.label-text')?.textContent === label)?.querySelector('input');
    if (!input) throw new Error(label + ' switch missing');
    input.checked = on;
    input.dispatchEvent(new win.Event('change'));
  };
  return { win, p, s, log, errors, emit, toasts, stored, toggle, video: p.querySelector('video') };
}

run(async () => {
  // ---- A video below its best level ----
  {
    // Attached while it plays with its levels not listed yet: nothing to compare with.
    const { log, s, emit, toasts, stored, errors } = boot({}, { levels: ['auto'] });
    await wait(50);
    t('the player is attached and listened to', log.listeners === 1, String(log.listeners));
    t('the 4320p record is written at the start', stored()?.data?.quality === 4320, JSON.stringify(stored()));
    t('levels not listed yet: not paused for nothing', log.calls.length === 0, log.calls.join());
    s.levels = ['hd2160', 'hd1080', 'hd720', 'auto'];
    emit(1);
    t('playing below its best: paused for the switch', log.calls[0] === 'pause', log.calls.join());
    await wait(50);
    t('the range set to the top, then played on', log.calls.join().indexOf('range:highres,quality:highres') !== -1 &&
      log.calls[log.calls.length - 1] === 'play', log.calls.join());
    await wait(600);
    t('once the player moved: "Video quality upgraded to 2160p60"', toasts().includes('Video quality upgraded to 2160p60'),
      toasts().join(' | '));
    log.calls.length = 0;
    emit(3); emit(1);
    t('the same video is not switched again', !log.calls.some((c) => c.startsWith('range')), log.calls.join());
    // The next video starts at its best: nothing to do.
    s.videoId = 'nextvideo01';
    s.quality = 'hd2160';
    emit(-1); emit(1);
    await wait(50);
    t('a video already at its best is left alone', !log.calls.some((c) => c.startsWith('range') || c === 'pause'), log.calls.join());
    // Its levels listed only once it buffers: the range then, without a pause.
    s.videoId = 'thirdvideo1';
    s.quality = 'hd720';
    s.levels = ['auto'];
    emit(1);
    await wait(50);
    s.levels = ['hd1440', 'hd1080', 'hd720', 'auto'];
    emit(3);
    await wait(50);
    t('listed while it buffers: the range is set then, without a pause',
      log.calls.includes('range:highres') && !log.calls.includes('pause'), log.calls.join());
    t('no jsdomError (upgrade)', errors.length === 0, errors[0]);
  }

  // ---- The record ----
  {
    // Ours, a week from expiring: renewed for a year.
    const now = Date.now();
    const ours = { data: JSON.stringify({ quality: 4320, previousQuality: 4320 }), creation: now - YEAR, expiration: now + 7 * 86400000 };
    const { stored } = boot({}, { record: ours });
    await wait(50);
    const r = stored();
    t('a record of ours about to expire is renewed for a year', r && r.expiration > now + YEAR - 60000, JSON.stringify(r));
  }
  {
    // Switched off: ours goes; on again: back.
    const { stored, toggle } = boot({});
    await wait(50);
    toggle('Force Max Quality', false);
    t('switched off: the 4320p record is dropped', stored() === null, JSON.stringify(stored()));
    toggle('Force Max Quality', true);
    t('switched on again: written again at once', stored()?.data?.quality === 4320, JSON.stringify(stored()));
  }
  {
    // A pick of the viewer's in YouTube's menu is not ours to drop.
    const { stored, toggle, win, errors } = boot({});
    await wait(50);
    const now = Date.now();
    win.localStorage.setItem(KEY, JSON.stringify({ data: JSON.stringify({ quality: 720, previousQuality: 1080 }), creation: now, expiration: now + YEAR }));
    toggle('Force Max Quality', false);
    t('switched off: a record the viewer set is left alone', stored()?.data?.quality === 720, JSON.stringify(stored()));
    win.localStorage.setItem(KEY, '{broken');
    toggle('Force Max Quality', true);
    t('switched on over a broken record: ours replaces it', stored()?.data?.quality === 4320, win.localStorage.getItem(KEY));
    win.localStorage.setItem(KEY, '{broken');
    toggle('Force Max Quality', false);
    t('switched off over a broken record: left, no error', win.localStorage.getItem(KEY) === '{broken' && errors.length === 0,
      errors[0]);
  }

  // ---- How the player is found and followed ----
  {
    // No state listener: the state is polled.
    const { log, s } = boot({}, { events: false, levels: ['auto'] });
    await wait(50);
    s.levels = ['hd2160', 'hd1080', 'hd720', 'auto'];
    s.state = 3;
    await wait(400);
    t('a player without state events is polled: buffering below its best gets the range',
      log.calls.includes('range:highres'), log.calls.join());
  }
  {
    // Polled, then the watch page left: the polling stops with the rest.
    const { win, log, s } = boot({}, { events: false, levels: ['auto'] });
    await wait(50);
    win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await wait(50);
    log.calls.length = 0;
    s.levels = ['hd2160', 'hd1080', 'hd720', 'auto'];
    s.state = 3;
    await wait(400);
    t('left the watch page: the state is no longer polled', log.calls.length === 0, log.calls.join());
  }
  {
    // The switch does not take (the player stays where it was): no notice.
    const { log, s, emit, toasts } = boot({}, { levels: ['auto'] });
    await wait(50);
    s.levels = ['hd2160', 'hd1080', 'hd720', 'auto'];
    log.calls.length = 0;
    emit(3);
    s.quality = 'hd720';
    await wait(600);
    t('the range set but the player still at 720p: no "upgraded" notice', log.calls.includes('range:highres') &&
      !toasts().some((x) => /upgraded/.test(x)), `${log.calls.join()} ${toasts().join(' | ')}`);
  }
  {
    // Storage refused: Force Max Quality still sets the range. Switched off
    // first, so its cached record is gone and switching on really writes.
    const { win, log, s, emit, toggle, errors } = boot({}, { levels: ['auto'] });
    await wait(50);
    toggle('Force Max Quality', false);
    let refused = 0;
    win.Storage.prototype.setItem = () => { refused++; throw new Error('quota'); };
    toggle('Force Max Quality', true);
    log.calls.length = 0;
    s.videoId = 'quotavideo1';
    s.levels = ['hd2160', 'hd1080', 'hd720', 'auto'];
    emit(-1);
    await wait(50);
    t('storage refused: a write was tried, and the range is set all the same',
      refused > 0 && log.calls.includes('range:highres') && errors.length === 0, `${refused} writes, ${log.calls.join()} ${errors[0] || ''}`);
  }
  {
    // The player mounts a second after the watch page.
    const { log } = boot({}, { player: 1000, state: 3 });
    await wait(600);
    t('no player yet: nothing', log.listeners === 0);
    await wait(900);
    t('a player that mounts late is attached', log.listeners === 1 && log.calls.includes('range:highres'), log.calls.join());
  }
  {
    // Leaving the watch page detaches; coming back attaches again.
    const { win, log } = boot({});
    await wait(50);
    win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await wait(50);
    t('leaving the watch page detaches from the player', log.calls.includes('removeListener'), log.calls.join());
    win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
    await wait(100);
    t('back on the watch page: attached again', log.listeners === 2, String(log.listeners));
  }

  // ---- webOS 25 (the modern build only): the first video may wait unstarted ----
  if (modern) {
    const { win, log, s, emit } = boot({}, { ua: UA25, state: -1, quality: 'hd2160' });
    const controls = win.document.createElement('yt-focus-container');
    controls.setAttribute('idomkey', 'controls');
    controls.className = 'MFDzfe--focused';
    win.document.body.appendChild(controls);
    const keys = [];
    win.document.addEventListener('keydown', (e) => keys.push(e.keyCode), true);
    emit(-1);
    await wait(1200);
    const plays = log.calls.filter((c) => c === 'play').length;
    t('webOS 25: a first video that does not start is told to play, every half second', plays >= 2, log.calls.join());
    s.state = 1;
    await wait(600);
    const after = log.calls.filter((c) => c === 'play').length;
    await wait(600);
    t('once it plays, no more', log.calls.filter((c) => c === 'play').length === after, log.calls.join());
    t('the controls it brought up are dismissed (Up)', keys.filter((k) => k === 38).length >= 1, keys.join());
    await wait(400);
    t('and the style that hid them meanwhile is gone again',
      !Array.from(win.document.querySelectorAll('style')).some((st) => /^\.GLc3cc \{ opacity: 0/.test(st.textContent)));
  }

  // ---- "Playing in": the label, or the picture's own size ----
  {
    const { s, video, toasts } = boot({ forceHighResVideo: false, showVideoQuality: 'start' });
    s.label = false;
    Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 1080 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 1920 });
    await wait(4300);
    t('no label from the player: the picture\'s height', toasts().includes('Playing in 1080p'), toasts().join(' | '));
  }
  {
    const { s, toasts } = boot({ forceHighResVideo: false, showVideoQuality: 'start' });
    s.label = false;
    s.quality = 'hd1440';
    await wait(4300);
    t('no label and no picture size: the level the player names', toasts().includes('Playing in 1440p'), toasts().join(' | '));
  }
  // Under Title is the tag alone (quality-tag-test); Both is the tag and the notice.
  for (const [mode, notice] of [['title', false], ['both', true]]) {
    const { toasts } = boot({ forceHighResVideo: false, showVideoQuality: mode });
    await wait(4300);
    const playingIn = toasts().filter((x) => /^Playing in/.test(x));
    t(`Show Video Quality ${mode === 'title' ? 'Under Title: no notice' : 'Both: the notice'}`,
      playingIn.length === (notice ? 1 : 0), playingIn.join(' | '));
  }
  {
    // Paused before the notice is due: none; the next time it plays, the notice.
    const { s, emit, toasts } = boot({ forceHighResVideo: false, showVideoQuality: 'start' });
    const playingIn = () => toasts().filter((x) => /^Playing in/.test(x));
    await wait(1000);
    emit(2);
    await wait(3400);
    t('paused before the notice: none', playingIn().length === 0, playingIn().join(' | '));
    emit(1);
    await wait(4200);
    t('playing again: "Playing in 720p"', playingIn().join() === 'Playing in 720p', playingIn().join(' | '));
    await wait(3200);
    // Another video, replaced by a third before its notice: no notice for it.
    s.videoId = 'othervideo1';
    emit(1);
    await wait(1000);
    s.videoId = 'thirdvideo1';
    await wait(3400);
    t('a video replaced before its notice gets none', playingIn().length === 0, playingIn().join(' | '));
  }

  // ---- A player YouTube builds again on the watch page ----
  {
    const { win, p, log } = boot({});
    await wait(50);
    t('replaced player: the first one is attached', log.listeners === 1, String(log.listeners));
    const p2 = win.document.createElement('div');
    p2.id = p.id;
    for (const k of Object.keys(p)) p2[k] = p[k];
    let added = 0;
    p2.addEventListener = (type) => { if (type === 'onStateChange') added++; };
    p2.innerHTML = '<video></video>';
    p.remove();
    win.document.querySelector('ytlr-app').appendChild(p2);
    p2.querySelector('video').dispatchEvent(new win.Event('playing'));
    await wait(50);
    t('replaced player: the old one is let go', log.calls.includes('removeListener'), log.calls.join());
    t('replaced player: the new one is attached', added === 1, String(added));
  }
  // ---- The player replaced while its quality switch waits for a frame ----
  {
    const { win, p, s, log, emit } = boot({}, { levels: ['auto'] });
    await wait(50);
    // Frames from now on wait in a queue the test runs itself.
    const frames = [];
    win.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
    s.levels = ['hd2160', 'hd1080', 'hd720', 'auto'];
    emit(1);
    t('switch pending, then replaced: the old player was paused for the switch', log.calls[0] === 'pause', log.calls.join());
    // Before the switch's frames run: a new player, paused.
    const p2 = win.document.createElement('div');
    p2.id = p.id;
    for (const k of Object.keys(p)) p2[k] = p[k];
    let plays2 = 0;
    let attached2 = 0;
    p2.playVideo = () => { plays2++; };
    p2.getPlayerState = () => 2;
    p2.addEventListener = (type) => { if (type === 'onStateChange') attached2++; };
    p2.innerHTML = '<video></video>';
    p.remove();
    win.document.querySelector('ytlr-app').appendChild(p2);
    p2.querySelector('video').dispatchEvent(new win.Event('playing'));
    await wait(30); // the put-off attach (a timer, not a frame)
    t('...the switch frames still wait, and the new player is attached', frames.length === 1 && attached2 === 1,
      `${frames.length} frames, attached ${attached2}`);
    // Both of the switch's frames, the second queued by the first.
    for (let i = 0; i < 10 && frames.length; i++) frames.shift()();
    t('...the old switch does not play the new, paused player', plays2 === 0 && frames.length === 0, `${plays2} ${frames.length}`);
  }
  // ---- The same, replaced between the switch's two frames ----
  {
    const { win, p, s, log, emit } = boot({}, { levels: ['auto'] });
    await wait(50);
    const frames = [];
    win.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
    s.levels = ['hd2160', 'hd1080', 'hd720', 'auto'];
    emit(1);
    // The first frame runs on the old player: the range set, the second frame queued.
    frames.shift()();
    t('between frames: the first ran on the old player and queued the second',
      log.calls.includes('range:highres') && frames.length === 1, `${log.calls.join()} ${frames.length}`);
    const p2 = win.document.createElement('div');
    p2.id = p.id;
    for (const k of Object.keys(p)) p2[k] = p[k];
    let plays2 = 0;
    let attached2 = 0;
    p2.playVideo = () => { plays2++; };
    p2.getPlayerState = () => 2;
    p2.addEventListener = (type) => { if (type === 'onStateChange') attached2++; };
    p2.innerHTML = '<video></video>';
    p.remove();
    win.document.querySelector('ytlr-app').appendChild(p2);
    p2.querySelector('video').dispatchEvent(new win.Event('playing'));
    await wait(30);
    t('...the new player is attached, the second frame still waits', attached2 === 1 && frames.length === 1,
      `attached ${attached2}, ${frames.length} frames`);
    for (let i = 0; i < 10 && frames.length; i++) frames.shift()();
    t('...the second frame does not play the new, paused player', plays2 === 0, String(plays2));
  }
  // ---- Watch, then Back before the put-off attach ran ----
  {
    const { win, log } = boot({});
    await wait(50);
    win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await wait(50);
    const before = log.listeners;
    const nav = (pageType) => win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType } }));
    nav('watch');
    nav('browse');
    await wait(50);
    t('watch then Back at once: no player attached after Back', log.listeners === before, `${before} -> ${log.listeners}`);
    // Control: the same navigation to the watch page alone attaches.
    nav('watch');
    await wait(50);
    t('...control: watch alone attaches', log.listeners === before + 1, `${before} -> ${log.listeners}`);
  }
  // ---- A setting changed just before the app goes to the background ----
  {
    const { win, toggle } = boot({});
    await wait(50);
    toggle('Force Max Quality', false);
    const before = JSON.parse(win.localStorage.getItem('ytaf-configuration') || '{}');
    t('hidden: the change is still waiting before the app is hidden', before.forceHighResVideo === true, String(before.forceHighResVideo));
    Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => true });
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    const saved = JSON.parse(win.localStorage.getItem('ytaf-configuration') || '{}');
    t('hidden: a change still waiting is written at once', saved.forceHighResVideo === false, String(saved.forceHighResVideo));
  }

  t('no jsdomError in any case', allErrors.length === 0, allErrors[0]);
});
