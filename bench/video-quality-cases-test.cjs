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
const { createReporter, flavorFromArgs, readBundle, bootPage, failingXHR, dispatchTrusted, trustedKey, wait, until, UA } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const bundle = readBundle();

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
function boot(cfg, { player = true, events = true, record, ua, quality = 'hd720', state = 1, levels, holdApply = false, qualityThrows = false, rafHook } = {}) {
  const { win, errors, evaluate } = bootPage({
    code: bundle,
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk',
    userAgent: ua || (modern ? UA.webos23 : UA.webos3),
    launchParams: '{}',
    xhr: failingXHR(),
    raf: 'timer',
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      thumbnailQuality: 'off', enableAutoLogin: false, enablePlaybackSpeed: false, forceQuality: 'max'
    }, cfg),
    storage: record ? { [KEY]: JSON.stringify(record) } : {},
    consoleErrors: false,
    onError: (text) => allErrors.push(text),
    fetch: () => Promise.reject(new Error('offline')),
    evaluate: false
  });
  // holdApply: the page's 600 ms timers (the panel change applied to the video
  // playing) are held, to be run by hand; cleared ones are noted.
  const applyTimers = [];
  if (holdApply) {
    const realSet = win.setTimeout.bind(win);
    const realClear = win.clearTimeout.bind(win);
    win.setTimeout = (fn, ms, ...args) => {
      if (ms !== 600) return realSet(fn, ms, ...args);
      const held = { id: -100 - applyTimers.length, fn, cleared: false };
      applyTimers.push(held);
      return held.id;
    };
    win.clearTimeout = (id) => {
      const held = applyTimers.find((h) => h.id === id);
      if (held) held.cleared = true;
      else realClear(id);
    };
  }
  // rafHook(s): run before each animation frame callback, with the player's state (set before the bundle runs).
  let rafState = null;
  if (rafHook) {
    const raf = win.requestAnimationFrame.bind(win);
    win.requestAnimationFrame = (cb) => raf((ts) => { if (rafState) rafHook(rafState); cb(ts); });
  }

  const log = { calls: [], listeners: 0 };
  const p = win.document.createElement('div');
  p.id = 'ytlr-player__player-container-player';
  p.innerHTML = '<video></video>';
  const s = { state, quality, levels: levels || ['hd2160', 'hd1080', 'hd720', 'auto'], label: true, videoId: 'abcdefghijk' };
  rafState = s;
  let onStateChange = null;
  const calls = (name) => (...args) => { log.calls.push(name + (args.length ? ':' + args.join(',') : '')); };
  Object.assign(p, {
    getVideoData: () => ({ video_id: s.videoId }),
    getPlayerState: () => s.state,
    getCurrentTime: () => 10,
    getAvailableQualityLevels: () => s.levels,
    getPlaybackQuality: () => s.quality,
    getUserPlaybackQualityPreference: () => 'auto',
    setPlaybackQualityRange(a) { log.calls.push('range:' + a); if (a === 'highres') s.quality = s.levels[0]; else if (s.levels.indexOf(a) !== -1) s.quality = a; },
    // qualityThrows: the call after the range fails (the player busy), the range already set.
    setPlaybackQuality: qualityThrows ? () => { log.calls.push('quality-threw'); throw new Error('player busy'); } : calls('quality'),
    pauseVideo() { log.calls.push('pause'); },
    loadVideoById(id, at) { log.calls.push('load:' + id + ',' + at); },
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
  evaluate();
  if (typeof player === 'number') setTimeout(mount, player);

  const toasts = () => Array.from(win.document.querySelectorAll('.ytaf-notification-container .message')).map((m) => m.textContent);
  const emit = (next) => { s.state = next; if (onStateChange) onStateChange(next); };
  const stored = () => { try { const r = JSON.parse(win.localStorage.getItem(KEY)); return r && { ...r, data: JSON.parse(r.data) }; } catch { return null; } };
  const toggle = (label, on) => {
    if (!win.document.querySelector('.ytaf-ui-container')) {
      trustedKey(win, GREEN);
    }
    // Force Max Quality is a choice row (Off, Max, Up to ...): Right from Off
    // is Max, Left from Max is Off, one step with no limit between.
    const row = Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
      .find((r) => r.querySelector('.shortcut-label')?.textContent.trim() === label);
    if (row) {
      const want = on ? 'Max' : 'Off';
      for (let i = 0; i < 8 && row.querySelector('.current-value').textContent !== want; i++) {
        row.focus();
        trustedKey(win, on ? 39 : 37, row);
      }
      if (row.querySelector('.current-value').textContent !== want) throw new Error(label + ' did not reach ' + want);
      return;
    }
    const input = Array.from(win.document.querySelectorAll('.ytaf-ui-container label'))
      .find((l) => l.querySelector('.label-text')?.textContent === label)?.querySelector('input');
    if (!input) throw new Error(label + ' switch missing');
    input.checked = on;
    input.dispatchEvent(new win.Event('change'));
  };
  return { win, p, s, log, errors, emit, toasts, stored, toggle, applyTimers, video: p.querySelector('video') };
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
  for (const [name, data, kept] of [['ours (left by an older build)', { quality: 4320, previousQuality: 4320 }, false],
    ['the viewer’s', { quality: 720, previousQuality: 1080 }, true]]) {
    // A start with Force Max Quality off: a 4320p record of ours left from
    // before (the old on/off switch) goes, or YouTube keeps forcing with the
    // panel at Off; one of the viewer's stays.
    const now = Date.now();
    const record = { data: JSON.stringify(data), creation: now - 86400000, expiration: now + 200 * 86400000 };
    const { stored } = boot({ forceQuality: 'off' }, { record });
    await wait(50);
    t(`start with Force off: ${name} record ${kept ? 'stays' : 'goes'}`, kept ? !!stored() && stored().data.quality === data.quality : stored() === null,
      JSON.stringify(stored()));
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
    // Changed in the panel while a video plays: the video playing gets the
    // new level at once, once the row stops (Off steps through Max on the way
    // to an Up to). Its formats were read with the option off, so it lists
    // them all: Up to picks the best level up to its size.
    // The 600 ms settle timer is held: each step of the row starts it again,
    // and only the one after the last step applies the level.
    const { win, log, s, emit, toggle, applyTimers } = boot({ forceQuality: 'off' }, { holdApply: true });
    await wait(50);
    emit(1);
    t('changed mid-video: precondition: off, nothing set', !log.calls.some((c) => c.startsWith('range')), log.calls.join());
    const live = () => applyTimers.filter((h) => !h.cleared && !h.ran);
    const runLive = () => { for (const h of live()) { h.ran = true; h.fn(); } };
    toggle('Force Max Quality', true);
    t('changed mid-video: precondition: the change set a 600 ms settle timer', live().length === 1, String(live().length));
    t('changed mid-video: nothing applied before it runs', !log.calls.some((c) => c.startsWith('range')), log.calls.join());
    runLive();
    t('changed mid-video: Max, once it runs the video playing goes to its best', log.calls.some((c) => c === 'range:highres'), log.calls.join());
    log.calls.length = 0;
    const row = Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
      .find((r) => r.querySelector('.shortcut-label')?.textContent.trim() === 'Force Max Quality');
    const before = applyTimers.length;
    let steps = 0;
    for (let i = 0; i < 12 && row.querySelector('.current-value').textContent !== 'Up to 1080p'; i++) {
      row.focus();
      trustedKey(win, 39, row);
      steps++;
    }
    t('changed mid-video: precondition: Up to 1080p chosen, more than one step', steps > 1 &&
      row.querySelector('.current-value').textContent === 'Up to 1080p', steps + ' ' + row.querySelector('.current-value').textContent);
    const stepped = applyTimers.slice(before);
    t('changed mid-video: each step starts the timer again, the earlier ones cleared', stepped.length === steps &&
      stepped.slice(0, -1).every((h) => h.cleared) && live().length === 1, stepped.map((h) => h.cleared).join());
    t('changed mid-video: nothing applied while the row moves', !log.calls.some((c) => c.startsWith('range')), log.calls.join());
    runLive();
    // One range, 1080p, and the player ends there.
    const ranges = log.calls.filter((c) => c.startsWith('range:'));
    t('changed mid-video: Up to 1080p, once the last timer runs the video playing goes to 1080p',
      ranges.join() === 'range:hd1080' && s.quality === 'hd1080', log.calls.join() + ' ' + s.quality);
  }
  {
    // Up to 480p when the video was read: its bigger formats were left out.
    // Raised to Max in the panel while it plays, it has nothing bigger to go
    // to, so it is loaded again where it is (no speed feature here: the plain
    // load). Not when it is paused, nor for a video whose formats were whole.
    const formats = () => [
      { itag: 401, mimeType: 'video/webm; codecs="vp9"', width: 3840, height: 2160, qualityLabel: '2160p' },
      { itag: 399, mimeType: 'video/webm; codecs="vp9"', width: 1920, height: 1080, qualityLabel: '1080p' },
      { itag: 397, mimeType: 'video/webm; codecs="vp9"', width: 854, height: 480, qualityLabel: '480p' },
      { itag: 251, mimeType: 'audio/webm; codecs="opus"' }
    ];
    const read = (win, videoId) => win.JSON.parse(win.JSON.stringify({ responseContext: { _pad: 'z'.repeat(600) },
      videoDetails: { videoId }, streamingData: { adaptiveFormats: formats() } }));
    for (const variant of ['cut', 'paused', 'whole']) {
      const { win, log, emit, applyTimers, video } = boot({ forceQuality: variant === 'whole' ? 'off' : 'up480' },
        { holdApply: true, quality: 'large', levels: ['large', 'medium', 'auto'] });
      const r = read(win, 'abcdefghijk');
      if (variant !== 'whole') {
        t('raise (' + variant + '): precondition: the read left the bigger formats out',
          r.streamingData.adaptiveFormats.map((x) => x.itag).join() === '397,251', r.streamingData.adaptiveFormats.map((x) => x.itag).join());
      }
      let paused = variant === 'paused';
      Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
      await wait(50);
      emit(1);
      log.calls.length = 0;
      const row = () => Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
        .find((x) => x.querySelector('.shortcut-label')?.textContent.trim() === 'Force Max Quality');
      if (!row()) trustedKey(win, GREEN);
      for (let i = 0; i < 8 && row().querySelector('.current-value').textContent !== 'Max'; i++) {
        row().focus();
        trustedKey(win, variant === 'whole' ? 39 : 37, row());
      }
      t('raise (' + variant + '): precondition: Max chosen', row().querySelector('.current-value').textContent === 'Max',
        row().querySelector('.current-value').textContent);
      for (const h of applyTimers.filter((x) => !x.cleared && !x.ran)) { h.ran = true; h.fn(); }
      const loads = log.calls.filter((c) => c.startsWith('load:'));
      if (variant === 'cut') {
        t('raise (cut): loaded again where it plays, at Max', loads.join() === 'load:abcdefghijk,10' &&
          log.calls.indexOf('range:highres') !== -1 && log.calls.indexOf('range:highres') < log.calls.indexOf('load:abcdefghijk,10'),
          log.calls.join());
      } else {
        t('raise (' + variant + '): not loaded again', loads.length === 0, log.calls.join());
      }
      if (variant !== 'whole') {
        // Played on: the paused one is loaded again then, once; the one
        // already loaded again is not loaded a second time.
        paused = false;
        log.calls.length = 0;
        video.dispatchEvent(new win.Event('playing'));
        video.dispatchEvent(new win.Event('playing'));
        const again = log.calls.filter((c) => c.startsWith('load:'));
        t('raise (' + variant + '): playing on: ' + (variant === 'paused' ? 'loaded again where it is, once' : 'not loaded again'),
          variant === 'paused' ? again.join() === 'load:abcdefghijk,10' : again.length === 0, log.calls.join());
      }
    }
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
  // Up to 720p makes YouTube record 720p. Switched off, that record goes with
  // Force Max Quality; a viewer's own, told apart by its time or size, stays.
  for (const [name, offset, quality, kept] of [
    ['its own 720p record, as the range was set', 0, 720, false],
    ['its own 720p record, at the end of the window', 5000, 720, false],
    ['a 720p pick just after the window', 5001, 720, true],
    ['a 720p record from just before the range', -1, 720, true],
    ['a 1080p pick inside the window', 100, 1080, true]
  ]) {
    const { win, log, stored, toggle } = boot({ forceQuality: 'up720' }, { quality: 'hd1080', state: 3 });
    await wait(50);
    const own = JSON.parse(win.localStorage.getItem('ytaf-force-record') || 'null');
    t(`Up to 720p, ${name}: precondition: the range was set and noted`,
      log.calls.includes('range:hd720') && own?.level === 'hd720' && typeof own?.at === 'number',
      `${log.calls.join()} ${JSON.stringify(own)}`);
    if (!own) continue;
    win.localStorage.setItem(KEY, JSON.stringify({
      data: JSON.stringify({ quality, previousQuality: 1080 }), creation: own.at + offset, expiration: own.at + YEAR
    }));
    // Switched off after the window, so the press that does it is no key inside it.
    win.Date.now = () => own.at + 6000;
    toggle('Force Max Quality', false);
    t(`Up to 720p, ${name}: ${kept ? 'kept' : 'removed'} when switched off`,
      kept ? stored()?.data?.quality === quality : win.localStorage.getItem(KEY) === null, win.localStorage.getItem(KEY));
    t(`Up to 720p, ${name}: the note goes too`, win.localStorage.getItem('ytaf-force-record') === null,
      win.localStorage.getItem('ytaf-force-record'));
  }
  // A 720p record 100 ms after the range: a key press before it (480p, then
  // 720p picked in the menu) makes it the viewer's; one after it, or a key the
  // app sent itself, does not.
  for (const [name, keyAt, trusted, kept] of [
    ['no key', null, true, false],
    ['a key just after the record', 101, true, false],
    ['a key in the same ms as the record', 100, true, true],
    ['a key before the record', 50, true, true],
    ['a key of the app’s own before the record', 50, false, false],
    ['a pointer press before the record', 50, 'pointer', true]
  ]) {
    const { win, log, stored, toggle } = boot({ forceQuality: 'up720' }, { quality: 'hd1080', state: 3 });
    await wait(50);
    const own = JSON.parse(win.localStorage.getItem('ytaf-force-record') || 'null');
    t(`Same level, ${name}: precondition: the range was set and noted`,
      log.calls.includes('range:hd720') && own?.level === 'hd720', `${log.calls.join()} ${JSON.stringify(own)}`);
    if (!own) continue;
    let now = own.at;
    win.Date.now = () => now;
    // In the order they happen: a key after the record is pressed once it is
    // written, one before (or in the same ms) first.
    const writeRecord = () => win.localStorage.setItem(KEY, JSON.stringify({
      data: JSON.stringify({ quality: 720, previousQuality: 480 }), creation: own.at + 100, expiration: own.at + YEAR
    }));
    const press = () => {
      now = own.at + keyAt;
      if (trusted === 'pointer') dispatchTrusted(win.document.body, new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      else if (trusted) trustedKey(win, 65);
      else win.document.body.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, keyCode: 65 }));
    };
    if (keyAt !== null && keyAt > 100) { now = own.at + 100; writeRecord(); press(); }
    else if (keyAt !== null) { press(); writeRecord(); }
    else writeRecord();
    now = own.at + 6000;
    toggle('Force Max Quality', false);
    t(`Same level, ${name}: ${kept ? 'kept' : 'removed'} when switched off`,
      kept ? stored()?.data?.quality === 720 : win.localStorage.getItem(KEY) === null, win.localStorage.getItem(KEY));
  }
  // Paused to raise the quality, and the levels gone by the frame that sets
  // the range (a list being rebuilt): no range then, which a player could
  // ignore for a level it does not list, leaving the video taken as done;
  // playback resumes, and once listed again the limit's level is set.
  {
    let emptied = false;
    const { log, s, emit } = boot({ forceQuality: 'up1080' }, { quality: 'hd720', state: 1, levels: ['hd2160', 'hd1080', 'hd720', 'auto'],
      rafHook: (st) => { if (!emptied && log.calls.includes('pause')) { emptied = true; st.levels = ['auto']; } } });
    await wait(100);
    t('levels gone in the frame: precondition: paused to raise it, then the list emptied', emptied && log.calls.includes('pause'), log.calls.join());
    t('levels gone in the frame: no range then, and playback goes on', !log.calls.some((c) => c.startsWith('range')) && log.calls.includes('play'),
      log.calls.join());
    s.levels = ['hd2160', 'hd1080', 'hd720', 'auto'];
    log.calls.length = 0;
    emit(1);
    await wait(100);
    t('levels gone in the frame: listed again, the next play sets the limit’s level', log.calls.includes('range:hd1080'), log.calls.join());
  }
  // A mode this build does not know (stored by a later one, say) is Off: no
  // range at all, where Max would set highres; Max itself is the control.
  for (const [mode, forced] of [['futureMode', false], ['max', true]]) {
    const { log } = boot({ forceQuality: mode }, { quality: 'hd720', state: 3 });
    await wait(50);
    const ranged = log.calls.some((c) => c.startsWith('range'));
    t(`unknown mode: ${mode} ${forced ? 'forces (the control)' : 'forces nothing, as Off'}`, ranged === forced, log.calls.join());
  }
  // The range set, then the player's next call failing: the video counts as
  // done, so the next state change does not set the range (and reload) again.
  {
    const { log, s, emit } = boot({ forceQuality: 'max' }, { quality: 'hd720', state: 3, qualityThrows: true });
    await wait(50);
    t('range set, then a failure: precondition: the range went through, the next call threw',
      log.calls.includes('range:highres') && log.calls.includes('quality-threw'), log.calls.join());
    // Still reloading: the player reports the old level for a while.
    s.quality = 'hd720';
    log.calls.length = 0;
    emit(3);
    emit(3);
    await wait(50);
    t('range set, then a failure: the next buffering sets no range again', !log.calls.some((c) => c.startsWith('range')),
      log.calls.join());
  }
  // The same while playing: the video is paused, the range set, the next call
  // fails; the next playing state does not pause and set it again.
  {
    const { log, s, emit } = boot({ forceQuality: 'max' }, { quality: 'hd720', state: 1, qualityThrows: true });
    await wait(80);
    t('playing, range set, then a failure: precondition: paused, the range went through, the next call threw',
      log.calls.includes('pause') && log.calls.includes('range:highres') && log.calls.includes('quality-threw'), log.calls.join());
    t('playing, range set, then a failure: playback goes on after the failed call',
      log.calls.lastIndexOf('play') > log.calls.indexOf('quality-threw'), log.calls.join());
    s.quality = 'hd720';
    log.calls.length = 0;
    emit(1);
    await wait(50);
    emit(1);
    await wait(50);
    t('playing, range set, then a failure: the next playing state sets no range again', !log.calls.some((c) => c.startsWith('range')),
      log.calls.join());
  }
  // A limit moved while a video plays, at 1x with no speed reload: a level the
  // viewer picked on this video stays; Force's own record does not hold it back.
  {
    const stepRow = (win, to) => {
      if (!win.document.querySelector('.ytaf-ui-container')) trustedKey(win, GREEN);
      const row = Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
        .find((r) => r.querySelector('.shortcut-label')?.textContent.trim() === 'Force Max Quality');
      for (let i = 0; i < 8 && row.querySelector('.current-value').textContent !== to; i++) {
        row.focus();
        trustedKey(win, 37, row);
      }
      return row.querySelector('.current-value').textContent;
    };
    const writeRecord = (win, quality, previousQuality, creation) => win.localStorage.setItem(KEY, JSON.stringify({
      data: JSON.stringify({ quality, previousQuality }), creation, expiration: creation + YEAR
    }));
    const live = (timers) => timers.filter((h) => !h.cleared && !h.ran);
    const runLive = (timers) => { for (const h of live(timers)) { h.ran = true; h.fn(); } };

    // The viewer's 480p, picked with a key after Force's 720p.
    {
      const { win, log, s, emit, applyTimers } = boot({ forceQuality: 'up720' }, { quality: 'hd1080', state: 3, holdApply: true });
      await wait(50);
      t('pick at 1x: precondition: Force set 720p', log.calls.includes('range:hd720'), log.calls.join());
      await wait(5);
      trustedKey(win, 65);
      await wait(5);
      writeRecord(win, 480, 720, Date.now());
      s.quality = 'large';
      log.calls.length = 0;
      t('pick at 1x: precondition: Up to 1080p chosen', stepRow(win, 'Up to 1080p') === 'Up to 1080p');
      t('pick at 1x: the change sets no timer to apply it', live(applyTimers).length === 0, String(live(applyTimers).length));
      runLive(applyTimers);
      emit(3); emit(1);
      await wait(50);
      t('pick at 1x: the 480p pick stays, also through the next state events',
        !log.calls.some((c) => c.startsWith('range')) && s.quality === 'large', log.calls.join());
    }
    // The viewer's 480p, picked while the change waits its 600 ms: the pick stays.
    {
      const { win, log, s, applyTimers } = boot({ forceQuality: 'up720' }, { quality: 'hd1080', state: 3, holdApply: true });
      await wait(50);
      t('pick in the wait: precondition: Force set 720p', log.calls.includes('range:hd720'), log.calls.join());
      log.calls.length = 0;
      t('pick in the wait: precondition: Up to 1080p chosen', stepRow(win, 'Up to 1080p') === 'Up to 1080p');
      t('pick in the wait: precondition: the change waits on its timer', live(applyTimers).length === 1, String(live(applyTimers).length));
      await wait(5);
      trustedKey(win, 65);
      await wait(5);
      writeRecord(win, 480, 720, Date.now());
      s.quality = 'large';
      runLive(applyTimers);
      t('pick in the wait: the 480p picked meanwhile stays', !log.calls.some((c) => c.startsWith('range')) && s.quality === 'large',
        log.calls.join());
    }
    // Control: the record is Force's own: the new limit applies.
    {
      const { win, log, applyTimers } = boot({ forceQuality: 'up720' }, { quality: 'hd1080', state: 3, holdApply: true });
      await wait(50);
      const own = JSON.parse(win.localStorage.getItem('ytaf-force-record') || 'null');
      t('Force’s record at 1x: precondition: noted', own?.level === 'hd720', JSON.stringify(own));
      writeRecord(win, 720, 1080, own.at);
      log.calls.length = 0;
      t('Force’s record at 1x: precondition: Up to 1080p chosen', stepRow(win, 'Up to 1080p') === 'Up to 1080p');
      runLive(applyTimers);
      t('Force’s record at 1x: the new limit applies', log.calls.includes('range:hd1080'), log.calls.join());
    }
    // A pick on the video before: this one takes the new limit.
    {
      const { win, log, s, emit, applyTimers } = boot({ forceQuality: 'up720' }, { quality: 'hd1080', state: 3, holdApply: true });
      await wait(50);
      await wait(5);
      trustedKey(win, 65);
      await wait(5);
      writeRecord(win, 480, 720, Date.now());
      await wait(5);
      // The next video starts at its limit already, so no range replaces the record.
      s.videoId = 'nextvideo02';
      s.quality = 'hd720';
      emit(-1); emit(1);
      await wait(20);
      log.calls.length = 0;
      t('pick on the video before: precondition: Up to 1080p chosen', stepRow(win, 'Up to 1080p') === 'Up to 1080p');
      runLive(applyTimers);
      t('pick on the video before: this video takes the new limit', log.calls.includes('range:hd1080'), log.calls.join());
    }
    // Off and on again releases a pick, also when its record could not be replaced.
    {
      const { win, log, s, toggle, applyTimers } = boot({ forceQuality: 'up720' }, { quality: 'hd1080', state: 3, holdApply: true });
      await wait(50);
      await wait(5);
      trustedKey(win, 65);
      await wait(5);
      writeRecord(win, 480, 720, Date.now());
      s.quality = 'large';
      const setItem = win.Storage.prototype.setItem;
      win.Storage.prototype.setItem = function refused(k, v) {
        if (k === KEY) throw new Error('QuotaExceededError');
        return setItem.call(this, k, v);
      };
      await wait(5);
      toggle('Force Max Quality', false);
      t('off and on: precondition: the pick’s record is still there', JSON.parse(win.localStorage.getItem(KEY)).creation > 0 &&
        JSON.parse(JSON.parse(win.localStorage.getItem(KEY)).data).quality === 480, win.localStorage.getItem(KEY));
      await wait(5);
      log.calls.length = 0;
      toggle('Force Max Quality', true);
      t('off and on: it applies again, the pick released', live(applyTimers).length === 1, String(live(applyTimers).length));
      runLive(applyTimers);
      t('off and on: the video goes to Max', log.calls.includes('range:highres'), log.calls.join());
    }
  }
  // Max on a 2160p video: YouTube records 4320 with the level it came from
  // (measured on webOS 25), which is not the 4320/4320 record this module writes.
  for (const [quality, kept] of [[4320, false], [2160, true], [1080, true]]) {
    const { win, log, stored, toggle } = boot({}, { quality: 'hd720', state: 3 });
    await wait(50);
    const own = JSON.parse(win.localStorage.getItem('ytaf-force-record') || 'null');
    t(`Max, a ${quality}p record: precondition: the range was set and noted`,
      log.calls.includes('range:highres') && own?.level === 'highres', `${log.calls.join()} ${JSON.stringify(own)}`);
    if (!own) continue;
    win.localStorage.setItem(KEY, JSON.stringify({
      data: JSON.stringify({ quality, previousQuality: 720 }), creation: own.at, expiration: own.at + YEAR
    }));
    toggle('Force Max Quality', false);
    t(`Max, a ${quality}p record: ${kept ? 'kept' : 'removed'} when switched off`,
      kept ? stored()?.data?.quality === quality : win.localStorage.getItem(KEY) === null, win.localStorage.getItem(KEY));
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
    // The panel's settle timer is held and run before the video's events: a
    // state event while the row may still move forces nothing.
    const { win, log, s, emit, toggle, errors, applyTimers } = boot({}, { levels: ['auto'], holdApply: true });
    await wait(50);
    toggle('Force Max Quality', false);
    let refused = 0;
    win.Storage.prototype.setItem = () => { refused++; throw new Error('quota'); };
    toggle('Force Max Quality', true);
    for (const h of applyTimers.filter((x) => !x.cleared && !x.ran)) { h.ran = true; h.fn(); }
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
  // ---- webOS 25: the player replaced while its first video is told to play ----
  if (modern) {
    const { win, p, log, toggle } = boot({}, { ua: UA25, state: -1, quality: 'hd2160' });
    // The enforcer, started at attach, tells the player to play and then sets
    // its wait for the next attempt in the same step. That wait, the first
    // after one of the old player's attempts, is held here until the new
    // player is attached; every other timer runs as usual.
    const held = [];
    let holdNext = false;
    const realSetTimeout = win.setTimeout;
    win.setTimeout = function (cb, ms, ...rest) {
      if (holdNext) { holdNext = false; held.push(cb); return 0; }
      return realSetTimeout.call(win, cb, ms, ...rest);
    };
    const playA = p.playVideo;
    p.playVideo = function () { holdNext = true; return playA.apply(this, arguments); };
    const attempt = await until(() => held.length === 1, 2000);
    t('webOS 25, replaced: the first player is told to play, and its next attempt waits',
      attempt && log.calls.includes('play'), `${log.calls.join()} ${held.length} held`);
    // Force Max Quality off: the new player starts no enforcer of its own.
    toggle('Force Max Quality', false);
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
    await wait(50);
    t('...the new, paused player is attached, the old attempt still waits', attached2 === 1 && held.length === 1,
      `attached ${attached2}, ${held.length} held`);
    // The old player's next attempt runs now, with the new player attached.
    win.setTimeout = realSetTimeout;
    for (const cb of held.splice(0)) cb();
    await wait(50);
    t('...the old player\'s attempt does not play the new one', plays2 === 0, String(plays2));
  }

  // ---- "Playing in": the label, or the picture's own size ----
  {
    const { s, video, toasts } = boot({ forceQuality: 'off', showVideoQuality: 'start' });
    s.label = false;
    Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 1080 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 1920 });
    await wait(4300);
    t('no label from the player: the picture\'s height', toasts().includes('Playing in 1080p'), toasts().join(' | '));
  }
  {
    const { s, toasts } = boot({ forceQuality: 'off', showVideoQuality: 'start' });
    s.label = false;
    s.quality = 'hd1440';
    await wait(4300);
    t('no label and no picture size: the level the player names', toasts().includes('Playing in 1440p'), toasts().join(' | '));
  }
  // Under Title is the tag alone (quality-tag-test); Both is the tag and the notice.
  for (const [mode, notice] of [['title', false], ['both', true]]) {
    const { toasts } = boot({ forceQuality: 'off', showVideoQuality: mode });
    await wait(4300);
    const playingIn = toasts().filter((x) => /^Playing in/.test(x));
    t(`Show Video Quality ${mode === 'title' ? 'Under Title: no notice' : 'Both: the notice'}`,
      playingIn.length === (notice ? 1 : 0), playingIn.join(' | '));
  }
  {
    // Paused before the notice is due: none; the next time it plays, the notice.
    const { s, emit, toasts } = boot({ forceQuality: 'off', showVideoQuality: 'start' });
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
    let quality2 = 0;
    p2.playVideo = () => { plays2++; };
    p2.setPlaybackQualityRange = () => { quality2++; };
    p2.setPlaybackQuality = () => { quality2++; };
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
    t('...nor sets the new player\'s quality', quality2 === 0, String(quality2));
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
    t('hidden: the change is still waiting before the app is hidden', before.forceQuality === 'max', String(before.forceQuality));
    Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => true });
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    const saved = JSON.parse(win.localStorage.getItem('ytaf-configuration') || '{}');
    t('hidden: a change still waiting is written at once', saved.forceQuality === 'off', String(saved.forceQuality));
  }

  t('no jsdomError in any case', allErrors.length === 0, allErrors[0]);
});
