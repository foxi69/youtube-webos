/**
 * Remember Playback Speed and Toggle Speed (1x / Last), playback-speed.js:
 * the speed set is stored; with Remember Playback Speed on, the next start
 * opens videos at it (a live stream still at 1x), off it starts at 1x. Toggle
 * Speed goes from 1x to the last other speed (1.5x before any) and back.
 *
 * Usage: node bench/speed-remember-test.cjs <bundle> [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, wait, until } = require('./harness.cjs');
const { hashString } = require('./fake-indexeddb.cjs');

const { t, run } = createReporter();

function boot(config, opts = {}) {
  // opts.live, opts.id: whether the video playing is live, and its id; read on each call, so a test can change them.
  if (opts.live === undefined) opts.live = false;
  if (opts.id === undefined) opts.id = 'aaaaaaaaaaa';
  const page = bootPage({
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    url: 'https://www.youtube.com/tv#/watch?v=aaaaaaaaaaa',
    consoleErrors: false,
    storage: opts.storage,
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
      el.getVideoData = () => ({ video_id: opts.id, isLive: opts.live });
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
    // Stored once the write (debounced) has run.
    await until(() => stored(win).savedPlaybackSpeed === 1.75 && stored(win).toggleSpeed === 1.75, 3000);
    t('a speed set is stored, and as the toggle speed', stored(win).savedPlaybackSpeed === 1.75 && stored(win).toggleSpeed === 1.75,
      JSON.stringify([stored(win).savedPlaybackSpeed, stored(win).toggleSpeed]));
    speed.setSpeed(1, { immediate: true });
    await until(() => stored(win).savedPlaybackSpeed === 1, 3000);
    t('1x is stored too, the toggle speed stays', stored(win).savedPlaybackSpeed === 1 && stored(win).toggleSpeed === 1.75);
    t('no page error', errors.length === 0, errors[0]);
  }

  // ---- Separate settings for each account: each account's own remembered speed ----
  {
    const KEY = 'ytaf-configuration';
    const identity = (id) => JSON.stringify({ data: { accountId: id } });
    const storage = {
      'yt.leanback.default::last-identity-used': identity('abc'),
      [KEY + '::' + hashString('accountId=abc')]: JSON.stringify({ rememberPlaybackSpeed: true, savedPlaybackSpeed: 2 }),
      [KEY + '::' + hashString('accountId=xyz')]: JSON.stringify({ rememberPlaybackSpeed: false, savedPlaybackSpeed: 1.5 })
    };
    const { win } = boot({ perAccountSettings: true }, { storage });
    t('per account: precondition: the account at the start plays at its remembered 2x', win.ytafSpeed.getSpeed() === 2,
      win.ytafSpeed.getSpeed());
    // Who's watching: another account picked, then back on a watch page.
    const pick = async (id) => {
      win.document.body.className = 'WEB_PAGE_TYPE_ACCOUNT_SELECTOR';
      win.dispatchEvent(new win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
      win.localStorage.setItem('yt.leanback.default::last-identity-used', identity(id));
      win.dispatchEvent(new win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
      await wait(200);
      win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
    };
    await pick('xyz');
    t('per account: an account with Remember off plays at 1x, not the speed of the first', win.ytafSpeed.getSpeed() === 1,
      win.ytafSpeed.getSpeed());
    await pick('abc');
    t('per account: back to the first account, its remembered speed again', win.ytafSpeed.getSpeed() === 2, win.ytafSpeed.getSpeed());
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
  // ---- The panel: Remember Playback Speed follows Playback Speed Control ----
  {
    const { win, errors } = boot({ rememberPlaybackSpeed: true, savedPlaybackSpeed: 1.5, enablePlaybackSpeed: false });
    const box = (start) => {
      const label = [...win.document.querySelectorAll('.ytaf-ui-container label')]
        .find((l) => l.textContent.trim().startsWith(start));
      return label && label.querySelector('input[type=checkbox]');
    };
    trustedKey(win, 404);
    await until(() => box('Remember Playback Speed'));
    const remember = box('Remember Playback Speed');
    const control = box('Playback Speed Control');
    t('the panel has Playback Speed Control and Remember Playback Speed', !!remember && !!control);
    if (!remember || !control) return;
    t('Playback Speed Control off: Remember Playback Speed is greyed out',
      remember.disabled === true && remember.closest('label').style.opacity === '0.5',
      remember.disabled + ' ' + remember.closest('label').style.opacity);
    control.checked = true;
    control.dispatchEvent(new win.Event('change', { bubbles: true }));
    t('...turned on in the panel: Remember Playback Speed is usable',
      remember.disabled === false && remember.closest('label').style.opacity === '1',
      remember.disabled + ' ' + remember.closest('label').style.opacity);
    // The start ran with it off: the stored speed was not set then, so it is
    // not taken up now either.
    t('...the video still plays at 1x, not the speed stored for the start', win.ytafSpeed.getSpeed() === 1, win.ytafSpeed.getSpeed());
    win.ytafSpeed.setSpeed(2, { immediate: true });
    t('...while a speed set now applies', win.ytafSpeed.getSpeed() === 2, win.ytafSpeed.getSpeed());
    t('...with no page error', errors.length === 0, errors[0]);
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
  // ---- Toggle Speed on a live stream ----
  {
    const opts = { live: true };
    const { win } = boot({ shortcut_key_7: 'speed_toggle', rememberPlaybackSpeed: true, savedPlaybackSpeed: 1.5 }, opts);
    await wait(300);
    const before = stored(win).savedPlaybackSpeed;
    trustedKey(win, 55, win.document.body, 'keydown');
    trustedKey(win, 55, win.document.body, 'keyup');
    await wait(400);
    t('toggle on a live stream: the speed kept for the next video stays', stored(win).savedPlaybackSpeed === before && before === 1.5,
      JSON.stringify([before, stored(win).savedPlaybackSpeed]));
    t('...and it still plays at 1x', win.ytafSpeed.getSpeed() === 1);
    t('...with the notice that there is no speed on a live stream',
      (win.document.querySelector('.ytaf-notification-container') || {}).textContent.indexOf('live stream') !== -1);
    // The next video, another one and not live: it plays at the speed kept.
    opts.live = false;
    opts.id = 'bbbbbbbbbbb';
    t('...and the next video that is not live plays at it', win.ytafSpeed.getSpeed() === 1.5, win.ytafSpeed.getSpeed());
  }
});
