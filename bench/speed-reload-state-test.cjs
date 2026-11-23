/**
 * A speed change against the built bundle: the controller reloads the video
 * (loadVideoById) on a fake player whose reload turns the video's default
 * subtitles back on, as YouTube does. The subtitles in use before stay
 * (off stays off, on stays on), and the quality the viewer picked in YouTube's
 * menu (the yt-player-quality record) is kept: a pick below 1080p above 1x,
 * and the pick again, not Auto, back at 1x.
 *
 * Usage: node bench/speed-reload-state-test.cjs <bundle> [legacy|modern]
 */
const { createReporter, readBundle, bootPage, failingXHR, dispatchTrusted, trustedKey, until, wait: sleep } = require('./harness.cjs');

// With `modern`, bootPage runs the modern bundle (webOS 22 and newer) in a
// Chrome 87 environment with a webOS 23 user agent, instead of the legacy one
// in a Chrome 38 one.
const bundle = readBundle();

const { t, run } = createReporter();

const EN = { languageCode: 'en', vss_id: '.en', kind: '' };

// What YouTube writes to yt-player-quality on every quality range call (seen on a TV).
const HEIGHTS = { highres: 4320, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480 };
const writeQuality = (win, height, previous) => win.localStorage.setItem('yt-player-quality', JSON.stringify({
  data: JSON.stringify({ quality: height, previousQuality: previous }),
  creation: win.Date.now(), expiration: win.Date.now() + 1e9
}));

// A trusted key press, as the remote sends: the speed keys too.
const pressKey = (win) => dispatchTrusted(win.document.body, new win.KeyboardEvent('keydown', { bubbles: true }));

// force: Force Max Quality on (Max), or the mode itself ('up1080').
// lateRecord: the record follows each range call by 50 ms (true) or that many ms.
// reloadTrack: the subtitles YouTube's reload turns on (else it toggles them).
// oldRecord: a height already recorded a minute before the app started: the
// viewer's pick of an earlier session, or with oldOwn the speed cap that
// session asked for (stored by the controller) half a second, or that many ms,
// before.
function boot(pickHeight, { force = false, manualPlayback = false, lateRecord = false, reloadTrack, oldRecord, oldOwn = false } = {}) {
  const { win, frames, errors } = bootPage({
    code: bundle,
    // The whole page: no doctype and no <ytlr-app>.
    html: '<body class="WEB_PAGE_TYPE_WATCH"><div id="ytlr-player__player-container-player"><video></video></div></body>',
    url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk',
    // Nothing the page logs or throws is collected or checked here.
    consoleErrors: false,
    // Element#remove stays away on the legacy build, as the environment leaves it.
    restoreRemove: false,
    xhr: failingXHR(),
    raf: 'manual',
    frameTime: 0,
    config: {
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      thumbnailQuality: 'off', enableAutoLogin: false, forceQuality: typeof force === 'string' ? force : force ? 'max' : 'off'
    },
    fetch: () => Promise.reject(new Error('offline')),
    beforeEval(win) {
      // What the speed feature needs to install (playback-speed.js).
      win.AudioDecoder = class {};
      win.AudioContext = class {};
      win.MediaSource = class { addSourceBuffer() {} };
      // Written here, not as `storage`: the times are read just before the bundle runs.
      if (oldRecord) {
        win.localStorage.setItem('yt-player-quality', JSON.stringify({
          data: JSON.stringify({ quality: oldRecord, previousQuality: 2160 }),
          creation: Date.now() - 60000, expiration: Date.now() + 1e9
        }));
        if (oldOwn) {
          const at = Date.now() - 60000 - (oldOwn === true ? 500 : oldOwn);
          win.localStorage.setItem('ytaf-speed-own-range', JSON.stringify({ level: 'hd' + oldRecord, from: at, last: at }));
        }
      }
    }
  });
  const pump = frames.pump;
  // The viewer's pick in YouTube's menu, made after the app started (Force Max
  // Quality writes its own record at start).
  if (pickHeight) writeQuality(win, pickHeight, 2160);

  const p = win.document.getElementById('ytlr-player__player-container-player');
  const log = { ranges: [], reloads: 0, sets: [] };
  let state = 1;
  let quality = 'hd720';
  let onStateChange = null;
  const addEventListener = p.addEventListener.bind(p);
  Object.assign(p, {
    track: {},
    reloadTrack,
    videoId: 'abcdefghijk',
    addEventListener(type, callback, ...args) {
      if (type === 'onStateChange') onStateChange = callback;
      else addEventListener(type, callback, ...args);
    },
    getOption(module, name) { return name === 'track' ? this.track : []; },
    setOption(module, name, value) { log.sets.push(value); this.track = value; },
    loadModule() {},
    setPlaybackQualityRange(a) {
      log.ranges.push(a);
      quality = a === 'highres' ? 'hd2160' : a === 'auto' ? 'hd720' : a;
      const write = () => {
        try { if (HEIGHTS[a]) writeQuality(win, HEIGHTS[a], 2160); } catch { /* storage denied */ }
      };
      // On a TV the record follows the call a moment later.
      if (lateRecord) win.setTimeout(write, lateRecord === true ? 50 : lateRecord); else write();
    },
    getPlaybackQuality: () => quality,
    getAvailableQualityLevels: () => ['hd2160', 'hd1080', 'hd720', 'auto'],
    getVideoData: () => ({ video_id: p.videoId }),
    getCurrentTime: () => 50,
    getPlayerState: () => state,
    seekTo() {},
    loadVideoById() {
      log.reloads++;
      // YouTube starts the reloaded video with its own subtitles choice.
      state = 3;
      if (this.reloadTrack !== undefined) this.track = this.reloadTrack;
      else this.track = EN === this.track ? {} : EN;
      if (!manualPlayback) win.setTimeout(() => { state = 1; }, 300);
    }
  });
  return {
    win, p, log, errors, speed: win.ytafSpeed, pump,
    emit(next) { state = next; if (onStateChange) onStateChange(next); },
    // YouTube's own choice, with no record written (no range call).
    setQuality(q) { quality = q; }
  };
}

run(async () => {
  {
    // Subtitles off, a 720p pick; to 1.5x.
    const { win, p, log, speed } = boot(720);
    t('the speed controller is installed', !!speed);
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('the video was reloaded', log.reloads === 1, log.reloads);
      t('subtitles turned off stay off after the reload', !p.track.languageCode, JSON.stringify(p.track));
      t('above 1x a 720p pick stays 720p, not 1080p', log.ranges.length > 0 && log.ranges.every((r) => r === 'hd720'),
        log.ranges.join());
      // Subtitles on by hand, then back to 1x: the reload drops them.
      p.track = EN;
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t('returning to 1x reloads the video before checking restored subtitles', log.reloads === 2, log.reloads);
      t('subtitles turned on stay on after the reload', p.track === EN, JSON.stringify(p.track));
      t('back at 1x the pick returns, not Auto', log.ranges.join() === 'hd720', log.ranges.join());
    }
    win.close();
  }
  {
    // No pick: the 1080p cap and Auto as before.
    const { win, log, speed } = boot(0);
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('without a pick, above 1x is capped at 1080p', log.ranges.length > 0 && log.ranges.every((r) => r === 'hd1080'),
        log.ranges.join());
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t('without a pick, back at 1x is Auto', log.ranges.join() === 'auto', log.ranges.join());
    }
    win.close();
  }
  {
    // Force Max Quality on, 480p picked in the menu: the pick wins back at 1x (seen on a TV going to 2160p).
    const { win, log, speed } = boot(480, { force: true });
    if (speed) {
      speed.setSpeed(1.25, { immediate: true });
      await sleep(900);
      t('Force Max Quality on, a 480p pick stays 480p above 1x', log.ranges.length > 0 && log.ranges.every((r) => r === 'large'),
        log.ranges.join());
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t('Force Max Quality on, back at 1x the 480p pick wins over Max', log.ranges.join() === 'large', log.ranges.join());
    }
    win.close();
  }
  {
    // Force Max Quality on, no pick: Max back at 1x, even after the 1080p cap was recorded.
    const { win, log, speed } = boot(0, { force: true });
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t('Force Max Quality on, no pick: back at 1x is Max, not the recorded 1080p cap', log.ranges.join() === 'highres',
        log.ranges.join());
    }
    win.close();
  }
  {
    // Force Max Quality Up to 1080p, no pick: back at 1x the reset asks for
    // the best level up to 1080p (as video-quality.js does), not Max.
    const { win, log, speed } = boot(0, { force: 'up1080' });
    // The fixture gives the speed feature what it needs: none is a failure, not a skip.
    t('Up to 1080p reset: precondition: the speed feature is installed', !!speed);
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('Up to 1080p: precondition: capped at 1080p above 1x', log.ranges.length > 0 && log.ranges.every((r) => r === 'hd1080'),
        log.ranges.join());
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t('Up to 1080p, no pick: back at 1x is the best up to 1080p, not Max', log.ranges.join() === 'hd1080', log.ranges.join());
    }
    win.close();
  }
  {
    // Up to 480p: its limit holds above 1x too, below the speed's 1080p cap.
    const { win, log, speed } = boot(0, { force: 'up480' });
    // The fixture gives the speed feature what it needs: none is a failure, not a skip.
    t('Up to 480p cap: precondition: the speed feature is installed', !!speed);
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('Up to 480p: above 1x the cap is 480p, not 1080p', log.ranges.length > 0 && log.ranges.every((r) => r === 'large'),
        log.ranges.join());
    }
    win.close();
  }
  {
    // Up to 720p puts the video at 720p at 1x, and YouTube records 720p for
    // it: that record is Force Max Quality's, not a pick of the viewer's. So
    // after 1.5x and back, Up to 1080p chosen at 1x still applies (on a TV the
    // video stayed at 480p: the record read as a pick held Force back).
    const { win, p, log, speed, emit, setQuality, pump } = boot(0, { force: 'up720' });
    // The fixture gives the speed feature what it needs: none is a failure, not a skip.
    t('Force’s own record: precondition: the speed feature is installed', !!speed);
    if (speed) {
      // A new video, starting at 2160p as YouTube picks: Up to 720p takes it down.
      win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
      await sleep(300);
      p.videoId = 'upto720vid1';
      setQuality('hd2160');
      emit(-1); emit(3); emit(1); pump(); pump();
      const forced = await until(() => log.ranges.includes('hd720'), 3000);
      t('Force’s own record: precondition: Up to 720p set 720p at 1x', forced, log.ranges.join());
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('Force’s own record: at 1.5x it is no viewer’s pick', speed.keepsQuality(win.document.getElementById('ytlr-player__player-container-player')) === false);
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      log.ranges.length = 0;
      trustedKey(win, 404);
      await until(() => win.document.querySelector('.ytaf-ui-container .shortcut-control-row'), 2000);
      const row = Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
        .find((r) => r.querySelector('.shortcut-label') && r.querySelector('.shortcut-label').textContent.trim() === 'Force Max Quality');
      for (let i = 0; i < 10; i++) {
        if (!row || row.querySelector('.current-value').textContent === 'Up to 1080p') break;
        row.focus();
        trustedKey(win, 37, row);
      }
      t('Force’s own record: precondition: Up to 1080p chosen at 1x', !!row && row.querySelector('.current-value').textContent === 'Up to 1080p',
        row ? row.querySelector('.current-value').textContent : 'no row');
      const raised = await until(() => log.ranges.includes('hd1080'), 3000);
      t('Force’s own record: Up to 1080p applies to the video playing', raised, log.ranges.join());
    }
    win.close();
  }
  for (const how of ['key', 'pointer']) {
    // Force Max Quality sets 720p, and the viewer picks 480p in YouTube's menu
    // right after (a key, then the record, well within a second): that record
    // is the viewer's pick, kept at 1.5x. A Magic Remote pointer press sends
    // no key: it counts the same.
    const n = (name) => how === 'key' ? name : name.replace('pick right after Force', 'pointer pick right after Force');
    const press = how === 'key' ? pressKey : (w) => dispatchTrusted(w.document.body, new w.MouseEvent('mousedown', { bubbles: true }));
    const { win, p, log, speed, emit, setQuality, pump } = boot(0, { force: 'up720' });
    t(n('pick right after Force: precondition: the speed feature is installed'), !!speed);
    if (speed) {
      win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
      await sleep(300);
      p.videoId = 'pickafter01';
      setQuality('hd2160');
      emit(-1); emit(3); emit(1); pump(); pump();
      t(n('pick right after Force: precondition: Force set 720p'), await until(() => log.ranges.includes('hd720'), 3000), log.ranges.join());
      // A few ms apart, so the key comes after Force's range and before the
      // record (the times are whole ms): the order is what is tested.
      await sleep(20);
      press(win);
      await sleep(20);
      writeQuality(win, 480, 720);
      setQuality('large');
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t(n('pick right after Force: the 480p pick is the viewer\u2019s, kept above 1x'),
        speed.keepsQuality(p) === true && log.ranges[log.ranges.length - 1] === 'large', log.ranges.join());
    }
    win.close();
  }
  // Force Max Quality's panel row, moved to `to` (Left is towards a higher limit).
  const moveForceRow = async (win, to, key) => {
    trustedKey(win, 404);
    await until(() => win.document.querySelector('.ytaf-ui-container .shortcut-control-row'), 2000);
    const row = Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
      .find((r) => r.querySelector('.shortcut-label') && r.querySelector('.shortcut-label').textContent.trim() === 'Force Max Quality');
    if (!row) return 'no row';
    const shown = () => row.querySelector('.current-value').textContent;
    for (let i = 0; i < 10; i++) {
      if (shown() === to) break;
      row.focus();
      trustedKey(win, key, row);
    }
    return shown();
  };
  {
    // A 480p pick at 1x, with no speed reload: Up to 1080p chosen leaves it.
    const { win, p, log, speed, emit, setQuality, pump } = boot(0, { force: 'up720' });
    t('pick at 1x, limit moved: precondition: the speed feature is installed', !!speed);
    if (speed) {
      win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
      await sleep(300);
      p.videoId = 'pickat1x001';
      setQuality('hd2160');
      emit(-1); emit(3); emit(1); pump(); pump();
      t('pick at 1x, limit moved: precondition: Force set 720p', await until(() => log.ranges.includes('hd720'), 3000), log.ranges.join());
      await sleep(20);
      pressKey(win);
      await sleep(20);
      writeQuality(win, 480, 720);
      setQuality('large');
      log.ranges.length = 0;
      t('pick at 1x, limit moved: precondition: Up to 1080p chosen', await moveForceRow(win, 'Up to 1080p', 37) === 'Up to 1080p');
      // Past the 600 ms after which a change is applied.
      await sleep(900);
      emit(3); emit(1); pump(); pump();
      await sleep(100);
      t('pick at 1x, limit moved: the 480p pick stays', log.ranges.length === 0, log.ranges.join());
    }
    win.close();
  }
  {
    // Its control: the same steps with no pick of the viewer's: the new limit applies.
    const { win, p, log, speed, emit, setQuality, pump } = boot(0, { force: 'up720' });
    if (speed) {
      win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
      await sleep(300);
      p.videoId = 'nopick00001';
      setQuality('hd2160');
      emit(-1); emit(3); emit(1); pump(); pump();
      t('no pick, limit moved: precondition: Force set 720p', await until(() => log.ranges.includes('hd720'), 3000), log.ranges.join());
      log.ranges.length = 0;
      t('no pick, limit moved: precondition: Up to 1080p chosen', await moveForceRow(win, 'Up to 1080p', 37) === 'Up to 1080p');
      await sleep(900);
      emit(3); emit(1); pump(); pump();
      await sleep(100);
      t('no pick, limit moved: the new limit applies', log.ranges.includes('hd1080'), log.ranges.join());
    }
    win.close();
  }
  {
    // The speed reload's own record is no pick: with it the newest record, past
    // Force's window, a new limit still applies.
    const { win, p, log, speed, emit, setQuality, pump } = boot(0, { force: 'up1080' });
    t('speed’s record, limit moved: precondition: the speed feature is installed', !!speed);
    if (speed) {
      win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
      await sleep(300);
      p.videoId = 'speedrec001';
      setQuality('hd2160');
      emit(-1); emit(3); emit(1); pump(); pump();
      t('speed’s record, limit moved: precondition: Force set 1080p', await until(() => log.ranges.includes('hd1080'), 3000), log.ranges.join());
      // The page's clock past Force's 5 s, so the reloads' records are outside its window.
      const realNow = win.Date.now.bind(win.Date);
      const forcedBy = realNow();
      win.Date.now = () => realNow() + 6000;
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      const recordAt = JSON.parse(win.localStorage.getItem('yt-player-quality')).creation;
      t('speed’s record, limit moved: precondition: the record is past Force’s 5 s', recordAt > forcedBy + 5000,
        String(recordAt - forcedBy));
      log.ranges.length = 0;
      t('speed’s record, limit moved: precondition: Up to 720p chosen', await moveForceRow(win, 'Up to 720p', 39) === 'Up to 720p');
      t('speed’s record, limit moved: the new limit applies', await until(() => log.ranges.includes('hd720'), 3000), log.ranges.join());
    }
    win.close();
  }
  {
    // A 480p pick on one video, then Force's record on the next: the pick is
    // not the next video's, and its speed reload keeps Force's limit.
    const { win, p, log, speed, emit, setQuality, pump } = boot(0, { force: 'up720' });
    t('pick, then Force on the next video: precondition: the speed feature is installed', !!speed);
    if (speed) {
      win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
      await sleep(300);
      p.videoId = 'pickvideoa1';
      setQuality('hd2160');
      emit(-1); emit(3); emit(1); pump(); pump();
      t('pick, then Force on the next video: precondition: Force set 720p on the first',
        await until(() => log.ranges.includes('hd720'), 3000), log.ranges.join());
      await sleep(20);
      pressKey(win);
      await sleep(20);
      writeQuality(win, 480, 720);
      setQuality('large');
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('pick, then Force on the next video: precondition: the first video’s reload kept the pick',
        log.ranges[log.ranges.length - 1] === 'large', log.ranges.join());
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      log.ranges.length = 0;
      p.videoId = 'pickvideob2';
      setQuality('hd2160');
      emit(-1); emit(3); emit(1); pump(); pump();
      t('pick, then Force on the next video: precondition: Force set 720p on the second',
        await until(() => log.ranges.includes('hd720'), 3000), log.ranges.join());
      log.ranges.length = 0;
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('pick, then Force on the next video: its reload is at Force’s limit, not the old pick',
        log.ranges.length > 0 && !log.ranges.includes('large') && log.ranges[log.ranges.length - 1] === 'hd720', log.ranges.join());
    }
    win.close();
  }
  // The reset from 1.5x with a player that fails on the quality: the reload is
  // still made (the audio sink is gone by then), at the limit's own level.
  for (const [name, breakIt, range] of [
    ['the level list throws', (p) => { p.getAvailableQualityLevels = () => { throw new Error('no levels'); }; }, 'hd720'],
    ['no level list', (p) => { p.getAvailableQualityLevels = undefined; }, 'hd720'],
    ['the level list is empty', (p) => { p.getAvailableQualityLevels = () => []; }, 'hd720'],
    ['the range setter throws', (p) => { p.setPlaybackQualityRange = () => { throw new Error('no range'); }; }, null]
  ]) {
    const { win, p, log, speed } = boot(0, { force: 'up720' });
    t(`reset, ${name}: precondition: the speed feature is installed`, !!speed);
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t(`reset, ${name}: precondition: reloaded at 1.5x`, log.reloads === 1, String(log.reloads));
      breakIt(p);
      log.ranges.length = 0;
      speed.setSpeed(1, { immediate: true });
      await sleep(900);
      t(`reset, ${name}: the video is still reloaded`, log.reloads === 2, String(log.reloads));
      if (range) t(`reset, ${name}: at the limit’s level`, log.ranges.join() === range, log.ranges.join());
    }
    win.close();
  }
  {
    // A replacement player with no setPlaybackQualityRange: Up to 480p chosen
    // at 1.5x does nothing to it and throws nothing (a page error would show).
    const { win, p, log, errors, speed } = boot(0, { force: true });
    t('no range setter: precondition: the speed feature is installed', !!speed);
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      const errorsBefore = errors.length;
      // A range never set must not be remembered as the controller's own.
      const ownBefore = win.localStorage.getItem('ytaf-speed-own-range');
      t('no range setter: precondition: the 1080p cap is noted as its own',
        !!ownBefore && JSON.parse(ownBefore).level === 'hd1080', String(ownBefore));
      p.setPlaybackQualityRange = undefined;
      log.ranges.length = 0;
      trustedKey(win, 404);
      await until(() => win.document.querySelector('.ytaf-ui-container .shortcut-control-row'), 2000);
      const row = Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
        .find((r) => r.querySelector('.shortcut-label') && r.querySelector('.shortcut-label').textContent.trim() === 'Force Max Quality');
      for (let i = 0; i < 10; i++) {
        if (!row || row.querySelector('.current-value').textContent === 'Up to 480p') break;
        row.focus();
        trustedKey(win, 39, row);
      }
      t('no range setter: precondition: Up to 480p chosen at 1.5x', !!row && row.querySelector('.current-value').textContent === 'Up to 480p',
        row ? row.querySelector('.current-value').textContent : 'no row');
      // Past the 600 ms settle timer.
      await sleep(900);
      t('no range setter: no page error, no range', errors.length === errorsBefore && log.ranges.length === 0,
        errors.slice(errorsBefore).join(' | ') + ' ' + log.ranges.join());
      t('no range setter: its own range note is unchanged', win.localStorage.getItem('ytaf-speed-own-range') === ownBefore,
        String(win.localStorage.getItem('ytaf-speed-own-range')));
    }
    win.close();
  }
  {
    // Max at 1.5x (capped at 1080p), then Up to 480p chosen in the panel: the
    // video playing goes down to 480p once the row stops.
    const { win, log, speed } = boot(0, { force: true });
    // The fixture gives the speed feature what it needs: none is a failure, not a skip.
    t('Max to Up to 480p: precondition: the speed feature is installed', !!speed);
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      t('Max to Up to 480p at 1.5x: precondition: capped at 1080p', log.ranges.length > 0 && log.ranges.every((r) => r === 'hd1080'),
        log.ranges.join());
      log.ranges.length = 0;
      trustedKey(win, 404);
      await until(() => win.document.querySelector('.ytaf-ui-container .shortcut-control-row'), 2000);
      // The page's 600 ms timers (the limit's settle timer) are held from here
      // and run by hand: no timing decides what was applied when.
      const held = [];
      const realSet = win.setTimeout;
      const realClear = win.clearTimeout;
      win.setTimeout = (fn, ms, ...args) => {
        if (ms !== 600) return realSet.call(win, fn, ms, ...args);
        const h = { id: -500 - held.length, fn, cleared: false };
        held.push(h);
        return h.id;
      };
      win.clearTimeout = (id) => {
        const h = held.find((x) => x.id === id);
        if (h) h.cleared = true; else realClear.call(win, id);
      };
      const row = Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
        .find((r) => r.querySelector('.shortcut-label') && r.querySelector('.shortcut-label').textContent.trim() === 'Force Max Quality');
      for (let i = 0; i < 10; i++) {
        if (!row || row.querySelector('.current-value').textContent === 'Up to 480p') break;
        row.focus();
        trustedKey(win, 39, row);
      }
      t('Max to Up to 480p at 1.5x: precondition: Up to 480p chosen', !!row && row.querySelector('.current-value').textContent === 'Up to 480p',
        row ? row.querySelector('.current-value').textContent : 'no row');
      const live = held.filter((h) => !h.cleared);
      // Two listeners wait on the row: this one and video-quality.js.
      t('Max to Up to 480p at 1.5x: precondition: each step set the settle timers again, one left for each listener',
        held.length > 2 && live.length === 2, held.length + ' set, ' + live.length + ' left');
      await sleep(50);
      t('Max to Up to 480p at 1.5x: nothing before the settle timer runs', log.ranges.length === 0, log.ranges.join());
      for (const h of live) h.fn();
      win.setTimeout = realSet;
      win.clearTimeout = realClear;
      const lowered = await until(() => log.ranges.includes('large'), 2000);
      t('Max to Up to 480p at 1.5x: once it runs, the video playing goes to 480p', lowered && log.ranges.join() === 'large',
        log.ranges.join());
    }
    win.close();
  }
  {
    // The same, with the player between two videos when the limit is applied
    // (its range call throws): the next play applies it, once.
    const { win, p, log, speed, emit } = boot(0, { force: true });
    if (speed) {
      speed.setSpeed(1.5, { immediate: true });
      await sleep(900);
      log.ranges.length = 0;
      trustedKey(win, 404);
      await until(() => win.document.querySelector('.ytaf-ui-container .shortcut-control-row'), 2000);
      const held = [];
      const realSet = win.setTimeout;
      const realClear = win.clearTimeout;
      win.setTimeout = (fn, ms, ...args) => {
        if (ms !== 600) return realSet.call(win, fn, ms, ...args);
        const h = { id: -600 - held.length, fn, cleared: false };
        held.push(h);
        return h.id;
      };
      win.clearTimeout = (id) => {
        const h = held.find((x) => x.id === id);
        if (h) h.cleared = true; else realClear.call(win, id);
      };
      const row = Array.from(win.document.querySelectorAll('.ytaf-ui-container .shortcut-control-row'))
        .find((r) => r.querySelector('.shortcut-label') && r.querySelector('.shortcut-label').textContent.trim() === 'Force Max Quality');
      for (let i = 0; i < 10; i++) {
        if (!row || row.querySelector('.current-value').textContent === 'Up to 480p') break;
        row.focus();
        trustedKey(win, 39, row);
      }
      const setRange = p.setPlaybackQualityRange;
      let threw = 0;
      p.setPlaybackQualityRange = function () { threw++; throw new Error('between two videos'); };
      for (const h of held.filter((x) => !x.cleared)) h.fn();
      p.setPlaybackQualityRange = setRange;
      win.setTimeout = realSet;
      win.clearTimeout = realClear;
      t('missed limit at 1.5x: precondition: the limit’s range call threw', threw > 0 && log.ranges.length === 0,
        `${threw} ${log.ranges.join()}`);
      emit(1);
      const lowered = await until(() => log.ranges.includes('large'), 2000);
      t('missed limit at 1.5x: the next play applies it', lowered, log.ranges.join());
    }
    win.close();
  }
  {
    const { win, p, speed, emit } = boot(720, { manualPlayback: true });
    speed.setSpeed(1.5, { immediate: true });
    // A real key during buffering changes the viewer's choice before PLAYING.
    dispatchTrusted(win.document.body, new win.KeyboardEvent('keydown', { bubbles: true }));
    p.track = EN;
    emit(1);
    await sleep(600);
    t('the reload controller preserves a subtitle choice made during buffering', p.track === EN);
    win.close();
  }
  {
    const { win, speed, log } = boot(720);
    speed.setSpeed(1.5, { immediate: true });
    Object.defineProperty(win, 'localStorage', { configurable: true, get() { throw new Error('storage denied'); } });
    let error = null;
    try { speed.setSpeed(1, { immediate: true }); } catch (err) { error = err; }
    t('denied storage does not prevent a second reload using the remembered quality',
      !error && log.reloads === 2 && log.ranges[log.ranges.length - 1] === 'hd720', String(error));
    win.close();
  }
  {
    const { win, speed, log } = boot(720);
    speed.setSpeed(1.5, { immediate: true });
    win.Storage.prototype.getItem = () => { throw new Error('storage method denied'); };
    speed.setSpeed(1, { immediate: true });
    t('a denied storage method retains the last known quality on return to 1x',
      log.reloads === 2 && log.ranges[log.ranges.length - 1] === 'hd720', log.ranges.join());
    win.close();
  }
  {
    // The player between two videos: the live check reads its metadata, and the
    // reload's own read then throws.
    const { win, p, speed, log } = boot(720);
    let reads = 0;
    p.getVideoData = () => {
      if (++reads > 1) throw new Error('no video data');
      return { video_id: p.videoId };
    };
    let error = null;
    try { speed.setSpeed(1.5, { immediate: true }); } catch (err) { error = err; }
    t('a throwing getVideoData skips the reload instead of breaking the speed change',
      !error && reads >= 2 && log.ranges.join() === 'hd720' && log.reloads === 0,
      `${error} reads=${reads} ranges=${log.ranges.join()} reloads=${log.reloads}`);
    win.close();
  }
  {
    const { win, p, speed, log, emit } = boot(720, { manualPlayback: true });
    speed.setSpeed(1.5, { immediate: true });
    // YouTube writes the new manual choice within the old heuristic's 1s window.
    p.setPlaybackQualityRange('large');
    log.ranges.length = 0;
    emit(1);
    await sleep(650);
    t('a new 480p choice during buffering is not overwritten by the old 720p cap',
      p.getPlaybackQuality() === 'large' && log.ranges.includes('large') && !log.ranges.includes('hd720'),
      log.ranges.join());
    speed.setSpeed(1, { immediate: true });
    t('the newer buffering-time choice is also restored at 1x',
      log.ranges[log.ranges.length - 1] === 'large', log.ranges.join());
    win.close();
  }
  {
    // A 2160p pick; YouTube writes each range call's record a moment after it.
    // The cap set again when the reload plays is then still unrecorded: the
    // first cap's record is the controller's too, not a 1080p pick.
    const { win, speed, log } = boot(2160, { lateRecord: true });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    t('the cap is set again once the reload plays', log.ranges.join() === 'hd1080,hd1080', log.ranges.join());
    log.ranges.length = 0;
    speed.setSpeed(1, { immediate: true });
    t('back at 1x a 2160p pick returns, not the cap recorded late', log.ranges.join() === 'hd2160', log.ranges.join());
    win.close();
  }
  {
    const { win, p, speed, log, emit, pump } = boot(480, { force: true });
    speed.setSpeed(1.5, { immediate: true });
    // Attach Force Max Quality while speed still suppresses it.
    win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
    await sleep(300);
    speed.setSpeed(1, { immediate: true });
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    p.querySelector('video').dispatchEvent(new win.Event('resize', { bubbles: true }));
    t('Force Max Quality state and resize handlers leave the restored manual choice alone',
      p.getPlaybackQuality() === 'large' && log.ranges.length === 0, log.ranges.join());
    p.videoId = 'nextvideo01';
    emit(-1); emit(3); emit(1); pump(); pump();
    t('the next video is not held back by the previous video quality override',
      log.ranges.includes('highres'), log.ranges.join());
    const open = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(open, 'keyCode', { get: () => 404 });
    dispatchTrusted(win.document.body, open);
    for (let i = 0; i < 20; i++) pump();
    // A choice row: Left from Max goes to Off, Right from Off back to Max.
    const row = Array.from(win.document.querySelectorAll('.shortcut-control-row'))
      .find((r) => r.querySelector('.shortcut-label')?.textContent.trim() === 'Force Max Quality');
    if (!row) throw new Error('Force Max Quality control missing');
    const flip = (on) => {
      const press = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(press, 'keyCode', { get: () => (on ? 39 : 37) });
      row.focus();
      dispatchTrusted(row, press);
    };
    // Capture a fresh retained choice on this video, then explicitly override it.
    writeQuality(win, 480, 2160);
    speed.setSpeed(1.5, { immediate: true });
    speed.setSpeed(1, { immediate: true });
    log.ranges.length = 0;
    flip(false); flip(true);
    emit(3); pump(); pump();
    // A state event while the row's settle timer is pending forces nothing;
    // the timer then applies Max to the video playing.
    t('...precondition: nothing forced while the row may still move', !log.ranges.includes('highres'), log.ranges.join());
    t('explicitly enabling Force Max Quality releases the retained manual choice',
      await until(() => log.ranges.includes('highres'), 2000), log.ranges.join());
    win.close();
  }
  {
    // Subtitles off; YouTube's reload turns its default ones on. A second
    // speed key while the first reload still buffers: once the video plays,
    // the subtitles from before the first reload are put back.
    const { win, p, speed, emit } = boot(0, { manualPlayback: true, reloadTrack: EN });
    pressKey(win);
    speed.setSpeed(1.5, { immediate: true });
    pressKey(win);
    speed.setSpeed(2, { immediate: true });
    emit(1);
    await sleep(600);
    t('a second speed change while the first reload buffers still keeps the subtitles off',
      !p.track.languageCode, JSON.stringify(p.track));
    win.close();
  }
  {
    // A reload that never played: another video was opened while it buffered.
    // Back on the first video the viewer turns subtitles on, and the next speed
    // change keeps them on, not the off state from before that reload.
    const { win, p, speed, emit } = boot(0, { manualPlayback: true, reloadTrack: EN });
    pressKey(win);
    speed.setSpeed(1.5, { immediate: true });
    p.videoId = 'othervideo1';
    await sleep(400);
    p.videoId = 'abcdefghijk';
    emit(1);
    pressKey(win);
    p.track = EN;
    // This time YouTube's reload drops them.
    p.reloadTrack = {};
    pressKey(win);
    speed.setSpeed(2, { immediate: true });
    emit(1);
    await sleep(600);
    t('a reload that never played does not hand its subtitles to a later speed change',
      p.track === EN, JSON.stringify(p.track));
    win.close();
  }
  {
    // The same, but the next video starts below the cap: capNext replaces the
    // reload's watch at once, which ends it without its onEnd.
    const { win, p, speed, emit, pump, setQuality } = boot(0, { manualPlayback: true, reloadTrack: EN });
    pressKey(win);
    speed.setSpeed(1.5, { immediate: true });
    p.videoId = 'othervideo1';
    setQuality('large');
    emit(-1); emit(3); emit(1); pump(); pump();
    // Called here too, not left to the play event alone: the reload's own
    // watch notices the other video on its next tick (250 ms) and would drop
    // the subtitles itself, so the replacement has to happen before that.
    speed.capNext(p);
    await sleep(400);
    p.videoId = 'abcdefghijk';
    emit(1);
    pressKey(win);
    p.track = EN;
    p.reloadTrack = {};
    pressKey(win);
    speed.setSpeed(2, { immediate: true });
    emit(1);
    await sleep(600);
    t('a reload replaced by the next video\'s cap check does not hand its subtitles on either',
      p.track === EN, JSON.stringify(p.track));
    win.close();
  }
  {
    // The last session ended at 1.5x: its 1080p cap is still recorded when the
    // app starts. No pick of the viewer's: back at 1x is Auto.
    const { win, log, speed } = boot(0, { oldRecord: 1080, oldOwn: true });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    log.ranges.length = 0;
    speed.setSpeed(1, { immediate: true });
    t('the own cap of the last session is no pick: back at 1x is Auto', log.ranges.join() === 'auto',
      log.ranges.join());
    win.close();
  }
  {
    // 720p picked in an earlier session: YouTube still plays it at 1x after a
    // restart (webOS 25), so it is the viewer's pick.
    const { win, log, speed } = boot(0, { oldRecord: 720 });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    t('720p picked in an earlier session: the cap above 1x is 720p', log.ranges.join() === 'hd720,hd720',
      log.ranges.join());
    t('the kept 720p is not stored as the speed\'s own cap for the next run',
      !/hd720/.test(win.localStorage.getItem('ytaf-speed-own-range') || ''), win.localStorage.getItem('ytaf-speed-own-range'));
    log.ranges.length = 0;
    speed.setSpeed(1, { immediate: true });
    t('and back at 1x it is kept', log.ranges.join() === 'hd720', log.ranges.join());
    win.close();
  }
  {
    // 1080p picked in an earlier session, not the speed's own record.
    const { win, log, speed } = boot(0, { oldRecord: 1080 });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    log.ranges.length = 0;
    speed.setSpeed(1, { immediate: true });
    t('1080p picked in an earlier session is kept back at 1x', log.ranges.join() === 'hd1080', log.ranges.join());
    win.close();
  }
  {
    // That session capped at 1080p, and two minutes later the viewer picked 1080p.
    const { win, log, speed } = boot(0, { oldRecord: 1080, oldOwn: 120000 });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    log.ranges.length = 0;
    speed.setSpeed(1, { immediate: true });
    t('a record long after the cap of the last session is a pick: kept back at 1x', log.ranges.join() === 'hd1080',
      log.ranges.join());
    win.close();
  }
  {
    // YouTube records the cap more than a second after the call.
    const { win, log, speed } = boot(0, { lateRecord: 1200 });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(2200);
    log.ranges.length = 0;
    pressKey(win);
    speed.setSpeed(1, { immediate: true });
    t('the cap recorded over a second late is no pick: back at 1x is Auto', log.ranges.join() === 'auto',
      log.ranges.join());
    win.close();
  }
  {
    // Force Max Quality on, the cap recorded late: Max back at 1x, and the
    // next playing state is not held back for this video.
    const { win, log, speed } = boot(0, { lateRecord: 1200, force: true });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(2200);
    log.ranges.length = 0;
    pressKey(win);
    speed.setSpeed(1, { immediate: true });
    t('Force Max Quality on, the cap recorded late: back at 1x is Max', log.ranges.join() === 'highres',
      log.ranges.join());
    win.close();
  }
  {
    // The viewer picks 1080p in the menu (keys pressed) after the cap: that is a pick.
    const { win, log, speed } = boot(0, { lateRecord: 1200 });
    speed.setSpeed(1.5, { immediate: true });
    await sleep(2200);
    pressKey(win);
    writeQuality(win, 1080, 2160);
    await sleep(10);
    log.ranges.length = 0;
    speed.setSpeed(1, { immediate: true });
    t('1080p picked by the viewer after the cap is kept back at 1x', log.ranges.join() === 'hd1080',
      log.ranges.join());
    win.close();
  }
  {
    // The position check runs every 250 ms for 25 s after a reload: while the
    // picture is at the cap, the stored record is not read on every tick.
    const { win, p, log, speed } = boot(0);
    let reads = 0;
    const getItem = win.Storage.prototype.getItem;
    win.Storage.prototype.getItem = function (key) {
      if (key === 'yt-player-quality') reads++;
      return getItem.call(this, key);
    };
    speed.setSpeed(1.5, { immediate: true });
    await sleep(800);
    reads = 0;
    await sleep(1500);
    t('at the cap, the position check does not read the quality record', reads === 0, `${reads} reads`);
    // YouTube falls to 720p: the cap is set again (after 2 s of it).
    log.ranges.length = 0;
    p.getPlaybackQuality = () => 'hd720';
    await sleep(2600);
    t('fallen below the cap, the cap is set again', log.ranges.join() === 'hd1080', log.ranges.join());
    win.close();
  }
  {
    // A 480p pick kept by a speed change holds Force Max Quality off for that
    // video while it plays. Left for Home and opened again later, the video is
    // forced as any other.
    const { win, log, speed, emit, pump } = boot(480, { force: true });
    speed.setSpeed(1.5, { immediate: true });
    speed.setSpeed(1, { immediate: true });
    await sleep(900);
    win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await sleep(50);
    win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
    await sleep(50);
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    t('the same video opened again after leaving it gets Force Max Quality', log.ranges.includes('highres'),
      log.ranges.join());
    win.close();
  }
  {
    // A 720p pick at 1.5x; on a TV the next video then started at 480p, though YouTube holds 720p at 1x.
    const { win, p, speed, log, emit, pump, setQuality } = boot(720);
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    p.videoId = 'nextvideo01';
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    // Raised as it started, the <video> stayed at 0 on a TV: only once it has played.
    t('a next video below the pick is not raised as it starts', log.ranges.length === 0, log.ranges.join());
    // The watch raises it after 2 s of play (8 ticks of 250 ms), not sooner.
    await sleep(1500);
    t('nor after 1.5 s of play', log.ranges.length === 0, log.ranges.join());
    await sleep(1100);
    t('a next video that plays below the 720p pick above 1x gets the pick',
      log.ranges.join() === 'hd720' && p.getPlaybackQuality() === 'hd720', log.ranges.join());
    // The viewer picks 480p on that video: it is theirs.
    await sleep(1100);
    writeQuality(win, 480, 2160);
    setQuality('large');
    log.ranges.length = 0;
    emit(2); emit(1); pump(); pump();
    await sleep(2600);
    t('a 480p pick made on the next video is left alone', log.ranges.length === 0, log.ranges.join());
    win.close();
  }
  {
    // A next video raised once; when its watch is over (25 s) it falls again
    // (a slow line) and a pause and play follow: left alone, not raised and
    // so loaded again at every play.
    const { p, speed, log, emit, pump, setQuality } = boot(0);
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    p.videoId = 'nextvideo02';
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    for (let i = 0; i < 80 && !log.ranges.length; i++) await sleep(50);
    t('a next video below the cap is raised once it has played', log.ranges.join() === 'hd1080', log.ranges.join());
    await sleep(25500);
    setQuality('large');
    log.ranges.length = 0;
    emit(2); emit(1); pump(); pump();
    await sleep(2800);
    t('fallen again after its watch, a later play does not raise it once more', log.ranges.length === 0, log.ranges.join());
    // Another video gets its own turn.
    p.videoId = 'nextvideo03';
    setQuality('large');
    emit(-1); emit(3); emit(1); pump(); pump();
    for (let i = 0; i < 80 && !log.ranges.length; i++) await sleep(50);
    t('the video after it is raised in its turn', log.ranges.join() === 'hd1080', log.ranges.join());
    // Once a playback, not once an id: opened again after another video, the
    // first one gets its turn again.
    p.videoId = 'nextvideo02';
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    for (let i = 0; i < 80 && !log.ranges.length; i++) await sleep(50);
    t('a video opened again after another one is raised again', log.ranges.join() === 'hd1080', log.ranges.join());
    // Also when the one in between started above the cap (never below it).
    p.videoId = 'nextvideo04';
    setQuality('hd1440');
    emit(-1); emit(3); emit(1); pump(); pump();
    await sleep(300);
    p.videoId = 'nextvideo02';
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    for (let i = 0; i < 80 && !log.ranges.length; i++) await sleep(50);
    t('a video opened again after one above the cap is raised again', log.ranges.join() === 'hd1080', log.ranges.join());
  }
  // The raise's reload starts the video over (webOS 25: raised at 3.0 s, on
  // from 0.0). viewer(p, win) runs as the cap is set: the viewer's own doing.
  const raiseRun = async (at, viewer, { shorts = false } = {}) => {
    const { win, p, speed, log, emit, pump, setQuality } = boot(0);
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    let time = at;
    const seeks = [];
    p.getCurrentTime = () => time;
    p.seekTo = (to) => { seeks.push(to); time = to; };
    const setRange = p.setPlaybackQualityRange;
    p.setPlaybackQualityRange = function (a) {
      setRange.call(this, a);
      if (viewer) time = viewer(win);
      // The reload: back to 0, buffering, then playing.
      win.setTimeout(() => { if (!viewer) time = 0; emit(3); }, 50);
      win.setTimeout(() => { emit(1); }, 700);
    };
    if (shorts) win.document.body.className = 'WEB_PAGE_TYPE_SHORTS';
    p.videoId = 'raisevideo1';
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    for (let i = 0; i < 80 && !log.ranges.length; i++) await sleep(50);
    await sleep(1500);
    win.close();
    return { ranges: log.ranges.join(), seeks: seeks.join() };
  };
  {
    const r = await raiseRun(3);
    t('a raise whose reload starts the video over: raised once', r.ranges === 'hd1080', r.ranges);
    t('and put back where it was raised (3 s), not left at 0', r.seeks === '3', r.seeks);
  }
  {
    const r = await raiseRun(1.5);
    t('raised 1.5 s in: back to 1.5 s, no repeat from 0', r.seeks === '1.5', r.seeks);
  }
  {
    // The viewer skips 30 s ahead (a key) as the cap is set; the reload then
    // reports 0 for a moment: their seek stands.
    const r = await raiseRun(3, (win) => { pressKey(win); return 0; });
    t('a key of the viewer\'s during the raise: not moved back', r.seeks === '', r.seeks);
  }
  {
    // Without a key, a seek of theirs elsewhere (33 s) is not a start over.
    const r = await raiseRun(3, () => 33);
    t('a seek of the viewer\'s ahead during the raise stays', r.seeks === '', r.seeks);
  }
  {
    // On Shorts (they loop by themselves) a start over is never moved on.
    const r = await raiseRun(3, null, { shorts: true });
    t('on Shorts the raise still comes', r.ranges === 'hd1080', r.ranges);
    t('on Shorts a start over after the raise is not moved on', r.seeks === '', r.seeks);
  }
  {
    // A 720p pick; the reloaded video plays, then falls to 480p while its watch runs.
    const { win, speed, log, setQuality } = boot(720);
    speed.setSpeed(1.5, { immediate: true });
    // The reload's own caps first (at the reload, then as it plays), so the
    // hd720 after the fall can only come from the watch.
    for (let i = 0; i < 40 && log.ranges.length < 2; i++) await sleep(50);
    t('the reload is capped at the 720p pick as it plays', log.ranges.join() === 'hd720,hd720', log.ranges.join());
    log.ranges.length = 0;
    setQuality('large');
    await sleep(2600);
    t('a reload fallen below the 720p pick gets the pick again', log.ranges.join() === 'hd720', log.ranges.join());
    win.close();
    // A level list that is not a list: no throw while it plays, the cap falls back to the pick.
    const b = boot(720);
    b.p.getAvailableQualityLevels = () => ({});
    const errors = [];
    b.win.addEventListener('error', (e) => errors.push(e.message));
    b.speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    t('a level list that is not an array: capped at the pick, nothing thrown', b.log.ranges.join() === 'hd720,hd720' && !errors.length,
      `${b.log.ranges.join()} ${errors.join()}`);
    b.win.close();
  }
  {
    // No pick: a 60 fps video started at 1.5x came at 480p30 on a TV, where 1080p60 played 1.5x at 60 fps.
    const { win, p, speed, log, emit, pump, setQuality } = boot(0);
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    p.videoId = 'nextvideo01';
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    await sleep(2600);
    t('without a pick a next video at 480p above 1x gets the 1080p cap',
      log.ranges.join() === 'hd1080' && p.getPlaybackQuality() === 'hd1080', log.ranges.join());
    // Raised, the check runs on for the rest of its 25 s: the stored record is not read on every tick.
    let reads = 0;
    const getItem = win.Storage.prototype.getItem;
    win.Storage.prototype.getItem = function (key) {
      if (key === 'yt-player-quality') reads++;
      return getItem.call(this, key);
    };
    await sleep(1500);
    win.Storage.prototype.getItem = getItem;
    t('at the cap, the next video\'s check does not read the quality record', reads === 0, `${reads} reads`);
    // A video whose top is 720p gets that, not a 1080p it does not have.
    p.videoId = 'nextvideo02';
    p.getAvailableQualityLevels = () => ['hd720', 'large', 'auto'];
    setQuality('large');
    log.ranges.length = 0;
    emit(-1); emit(3); emit(1); pump(); pump();
    await sleep(2600);
    t('a next video with 720p at most gets 720p', log.ranges.join() === 'hd720', log.ranges.join());
    win.close();
  }
  {
    // A raise can still leave the <video> at 0 while the player buffers at its position.
    const { win, p, speed, emit, pump, setQuality } = boot(0);
    speed.setSpeed(1.5, { immediate: true });
    await sleep(900);
    const seeks = [];
    p.seekTo = (s) => { seeks.push(s); };
    p.videoId = 'nextvideo01';
    setQuality('large');
    emit(-1); emit(3); emit(1); pump(); pump();
    await sleep(2600);
    emit(3);
    await sleep(3600);
    t('a next video left at 0 after the raise is moved to just before the player position', seeks.join() === '49.5', seeks.join());
    win.close();
  }
  {
    // The speed reload's own first play below the cap: its watch (subtitles back) is not cut short.
    const { p, win, speed, emit, pump, setQuality } = boot(0);
    p.track = EN;
    speed.setSpeed(1.5, { immediate: true });
    setQuality('large');
    emit(1); pump(); pump();
    await sleep(900);
    t('a raise on the reloaded video keeps the reload restoring the subtitles', p.track === EN, JSON.stringify(p.track));
    win.close();
  }
});
