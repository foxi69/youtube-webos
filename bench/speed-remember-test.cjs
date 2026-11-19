/**
 * Remember Playback Speed and Toggle Speed (1x / Last), playback-speed.js:
 * the speed set is stored; with Remember Playback Speed on, the next start
 * opens videos at it (a live stream still at 1x), off it starts at 1x. Toggle
 * Speed goes from 1x to the last other speed (1.5x before any) and back.
 *
 * Usage: node bench/speed-remember-test.cjs <bundle> [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, wait } = require('./harness.cjs');

const { t, run } = createReporter();

function boot(config, { live = false } = {}) {
  const page = bootPage({
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    url: 'https://www.youtube.com/tv#/watch?v=aaaaaaaaaaa',
    consoleErrors: false,
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      thumbnailQuality: 'off', enableAutoLogin: false, checkForUpdates: false, showWhatsNew: false
    }, config),
    fetch: 'pending',
    beforeEval(win) {
      win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
      win.cancelAnimationFrame = () => {};
      win.AudioDecoder = class { configure() {} decode() {} flush() { return Promise.resolve(); } close() {} };
      win.AudioDecoder.isConfigSupported = () => Promise.resolve({ supported: true });
      win.AudioContext = class {
        constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; this.sampleRate = 48000; }
        createGain() { return { gain: { value: 1 }, connect() {} }; }
        close() { this.state = 'closed'; }
      };
      win.MediaSource = class {
        constructor() { this.readyState = 'open'; }
        addSourceBuffer() { return { updating: false, appendBuffer() {}, remove() {}, abort() {}, buffered: { length: 0 } }; }
        get sourceBuffers() { return { length: 0, item: () => undefined }; }
      };
      win.MediaSource.isTypeSupported = () => true;
      win.URL.createObjectURL = () => 'blob:fake';
      win.URL.revokeObjectURL = () => {};
      const el = win.document.createElement('div');
      el.id = 'ytlr-player__player-container-player';
      el.getVideoData = () => ({ video_id: 'aaaaaaaaaaa', isLive: live });
      el.getCurrentTime = () => 12;
      el.getPlayerState = () => 1;
      el.getPlaybackQuality = () => 'hd1080';
      el.getAvailableQualityLevels = () => ['hd1080', 'auto'];
      el.loadVideoById = () => {};
      el.setPlaybackQualityRange = () => {};
      el.appendChild(win.document.createElement('video'));
      win.document.body.appendChild(el);
    }
  });
  return page;
}

const stored = (win) => JSON.parse(win.localStorage.getItem('ytaf-configuration') || '{}');

run(async () => {
  // ---- A speed set is stored ----
  {
    const { win, errors } = boot({});
    const speed = win.ytafSpeed;
    t('the speed feature is installed', !!speed);
    if (!speed) return;
    speed.setSpeed(1.75, { immediate: true });
    await wait(300);
    t('a speed set is stored, and as the toggle speed', stored(win).savedPlaybackSpeed === 1.75 && stored(win).toggleSpeed === 1.75,
      JSON.stringify([stored(win).savedPlaybackSpeed, stored(win).toggleSpeed]));
    speed.setSpeed(1, { immediate: true });
    await wait(300);
    t('1x is stored too, the toggle speed stays', stored(win).savedPlaybackSpeed === 1 && stored(win).toggleSpeed === 1.75);
    t('no page error', errors.length === 0, errors[0]);
  }

  // ---- Remember Playback Speed ----
  {
    const { win } = boot({ rememberPlaybackSpeed: true, savedPlaybackSpeed: 1.5 });
    t('on: the next start plays at the stored speed', win.ytafSpeed.getSpeed() === 1.5, win.ytafSpeed.getSpeed());
  }
  {
    const { win } = boot({ rememberPlaybackSpeed: false, savedPlaybackSpeed: 1.5 });
    t('off: the next start plays at 1x', win.ytafSpeed.getSpeed() === 1, win.ytafSpeed.getSpeed());
  }
  {
    const { win } = boot({ rememberPlaybackSpeed: true, savedPlaybackSpeed: 1.5 }, { live: true });
    t('on: a live stream still plays at 1x', win.ytafSpeed.getSpeed() === 1, win.ytafSpeed.getSpeed());
  }
  {
    const { win } = boot({ rememberPlaybackSpeed: true, savedPlaybackSpeed: 1.5, enablePlaybackSpeed: false });
    t('on, with Playback Speed Control off: 1x', win.ytafSpeed.getSpeed() === 1, win.ytafSpeed.getSpeed());
  }
  {
    const { win } = boot({ rememberPlaybackSpeed: true, savedPlaybackSpeed: 7 });
    t('on: a stored speed the app does not offer is not used', win.ytafSpeed.getSpeed() === 1, win.ytafSpeed.getSpeed());
  }

  // ---- Toggle Speed (1x / Last), on a key ----
  {
    const { win } = boot({ shortcut_key_7: 'speed_toggle' });
    const press = () => { trustedKey(win, 55, win.document.body, 'keydown'); trustedKey(win, 55, win.document.body, 'keyup'); };
    press();
    await wait(200);
    t('toggle from 1x with no speed set yet: 1.5x', win.ytafSpeed.getSpeed() === 1.5, win.ytafSpeed.getSpeed());
    press();
    await wait(200);
    t('toggle again: 1x', win.ytafSpeed.getSpeed() === 1, win.ytafSpeed.getSpeed());
    win.ytafSpeed.setSpeed(2, { immediate: true });
    win.ytafSpeed.setSpeed(1, { immediate: true });
    await wait(300);
    press();
    await wait(200);
    t('toggle from 1x goes to the last other speed (2x)', win.ytafSpeed.getSpeed() === 2, win.ytafSpeed.getSpeed());
  }
});
