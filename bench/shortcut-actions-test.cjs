/**
 * The shortcut actions, end to end in the bundle: a key press of the remote
 * (a number or a colour key bound to an action) and what the action does on
 * the page. Until this test most of handleShortcutAction's switch never ran:
 * comments, description, Save, subtitles, Jump to Live, the sleep timer,
 * audio-only, Refresh Page, the two SponsorBlock actions, the OLED blackout's
 * keep-alive and its switching off, and the scope rules (a player action on
 * the home screen, a held key, a key typed into a text box).
 *
 *   node bench/shortcut-actions-test.cjs <bundle> [legacy|modern]
 *
 * The player's buttons are stand-ins with the shape the TV app gives them
 * (a ytlr-button-renderer whose __instance carries its data); a click on one
 * is counted. The sleep timer's and the keep-alive's long timers are held by
 * the test and run when it says.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, dispatchTrusted, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();

const KEY = { RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, UP: 38, BACK: 461 };
const digit = (n) => 48 + n;
const VIDEO_ID = 'abcdefghijk';

const { t, run } = createReporter();

// Which number key runs which action in these tests.
const BINDINGS = {
  shortcut_key_1: 'toggle_comments',
  shortcut_key_2: 'toggle_description',
  shortcut_key_3: 'save_to_playlist',
  shortcut_key_4: 'toggle_subs',
  shortcut_key_6: 'jump_to_live',
  shortcut_key_7: 'sleep_timer',
  shortcut_key_8: 'audio_only',
  shortcut_key_9: 'refresh_page',
  shortcut_key_0: 'sb_skip_prev',
  shortcut_key_yellow: 'play_pause'
};
const K = { comments: 1, description: 2, save: 3, subs: 4, live: 6, sleep: 7, audio: 8, refresh: 9, sbPrev: 0 };

/**
 * The bundle on a watch page (or `opts.page`), with `opts.html` beside the
 * player. Timers of a minute or more are held in `long` instead of running.
 */
async function boot(cfg = {}, opts = {}) {
  const warnings = [];
  const page = opts.page || 'WEB_PAGE_TYPE_WATCH';
  const { win, errors, evaluate } = bootPage({
    code,
    bodyClass: page,
    inner: `\n    <div id="ytlr-player__player-container-player"><video></video></div>${opts.html || ''}`,
    url: page === 'WEB_PAGE_TYPE_WATCH' ? `https://www.youtube.com/tv#/watch?v=${VIDEO_ID}` : 'https://www.youtube.com/tv#/',
    ignoreNavigation: true,
    console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false
    }, BINDINGS, cfg),
    fetch: 'pending',
    evaluate: false
  });
  // The long timers (the sleep timer, the blackout's keep-alive), held.
  const long = [];
  let nextId = 1e6;
  const realTimeout = win.setTimeout.bind(win), realClearTimeout = win.clearTimeout.bind(win);
  const realInterval = win.setInterval.bind(win), realClearInterval = win.clearInterval.bind(win);
  const holdOr = (real, kind) => (fn, ms, ...args) => {
    if (ms >= 60000) { long.push({ fn, ms, kind, id: ++nextId }); return nextId; }
    return real(fn, ms, ...args);
  };
  const dropOr = (real) => (id) => {
    const i = long.findIndex((h) => h.id === id);
    if (i !== -1) long.splice(i, 1); else real(id);
  };
  win.setTimeout = holdOr(realTimeout, 'timeout');
  win.setInterval = holdOr(realInterval, 'interval');
  win.clearTimeout = dropOr(realClearTimeout);
  win.clearInterval = dropOr(realClearInterval);

  // The <video>: paused or playing, and what was asked of it.
  const video = win.document.querySelector('video');
  const vs = { paused: false, time: 100, duration: 600, plays: 0, pauses: 0, seekable: null };
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => vs.paused },
    currentTime: { configurable: true, get: () => vs.time, set: (v) => { vs.time = v; } },
    duration: { configurable: true, get: () => vs.duration },
    seekable: { configurable: true, get: () => vs.seekable },
    play: { configurable: true, value: () => { vs.paused = false; vs.plays++; return win.Promise.resolve(); } },
    pause: { configurable: true, value: () => { vs.paused = true; vs.pauses++; } }
  });

  // The keys the bundle sends itself (Back to close a panel, Up to keep the TV awake).
  // sentAt: when each was sent (Date.now()).
  const sent = [];
  const sentAt = [];
  win.document.addEventListener('keydown', (e) => { if (e.__ytafSynthetic) { sent.push(e.keyCode); sentAt.push(Date.now()); } });

  evaluate();
  // The Return YouTube Dislike handler is made 0.5 s after the page.
  await wait(opts.settle || 600);

  const container = () => win.document.querySelector('.ytaf-notification-container');
  const toasts = () => (container() || {}).textContent || '';
  // Messages still on screen are reused for the same text: start each press
  // with none, so the text after it is what that press showed.
  const clearToasts = () => { const c = container(); if (c) while (c.firstChild) c.removeChild(c.firstChild); };
  // One press of a remote key: a trusted keydown and keyup on what has the
  // focus. Returns whether the keydown was taken (preventDefault). Then waits
  // past the shortcut's debounce, so the next press of the same key counts.
  // `only`: 'keydown' or 'keyup' for half a press (a key held down).
  const press = async (keyCode, init = {}, only = null) => {
    clearToasts();
    const target = win.document.activeElement || win.document.body;
    let taken = false;
    for (const type of ['keydown', 'keyup']) {
      if (only && only !== type) continue;
      const e = new win.KeyboardEvent(type, Object.assign({ bubbles: true, cancelable: true }, type === 'keydown' ? init : {}));
      Object.defineProperty(e, 'keyCode', { get: () => keyCode, configurable: true });
      const notTaken = dispatchTrusted(target, e);
      if (type === only || type === 'keydown') taken = !notTaken;
    }
    await wait(opts.gap || 120);
    return taken;
  };
  const backs = () => sent.filter((c) => c === KEY.BACK).length;
  // A stand-in for one of the player's buttons: its renderer carries `data`
  // as the TV app's component does; clicks on it are counted.
  const clicks = [];
  const playerButton = (data, name) => {
    let actions = win.document.querySelector('ytlr-player-actions-container');
    if (!actions) {
      actions = win.document.createElement('ytlr-player-actions-container');
      win.document.querySelector('ytlr-app').appendChild(actions);
    }
    const renderer = win.document.createElement('ytlr-button-renderer');
    renderer.__instance = { props: { data } };
    const button = win.document.createElement('yt-button-container');
    button.addEventListener('click', () => clicks.push(name));
    renderer.appendChild(button);
    actions.appendChild(renderer);
    return button;
  };
  const byHtml = (selector, name) => {
    const el = win.document.querySelector(selector);
    el.addEventListener('click', () => clicks.push(name));
    return el;
  };
  return { win, doc: win.document, errors, warnings, clearToasts, video, vs, long, sent, sentAt, backs, toasts, press, clicks, playerButton, byHtml };
}


// Holds the page's timeouts of exactly `ms` (the one under test), so the test
// decides when they run: `count()` of those waiting, `run()` runs them.
function holdTimeouts(env, ms) {
  const held = new Map();
  let next = 5e6;
  const realSet = env.win.setTimeout, realClear = env.win.clearTimeout;
  env.win.setTimeout = (fn, delay, ...args) => {
    if (delay !== ms) return realSet(fn, delay, ...args);
    held.set(++next, () => fn(...args));
    return next;
  };
  env.win.clearTimeout = (id) => { if (!held.delete(id)) realClear(id); };
  return { count: () => held.size, run: () => { const jobs = [...held.values()]; held.clear(); jobs.forEach((f) => { f(); }); } };
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;
  const D = digit;

  // ---- Toggle Comments ----
  {
    const env = await boot();
    const button = env.playerButton({ icon: { iconType: 'COMMENT' } }, 'comments');
    // The TV's component handles the press too: its onSelect is called as well.
    let selected = 0;
    button.__instance = { onSelect: (e) => { if (e.target === button) selected++; } };
    const taken = await env.press(D(K.comments));
    t(n('comments: the key is taken'), taken === true);
    t(n('comments: the player\'s comments button (found by its icon) is pressed'),
      env.clicks.join() === 'comments' && selected === 1, env.clicks.join() + ' onSelect ' + selected);
    t(n('...and no Back is sent'), env.backs() === 0, env.sent.join());
    button.setAttribute('aria-pressed', 'true');
    await env.press(D(K.comments));
    t(n('comments open: the key sends Back to close them'), env.backs() === 1 && env.clicks.length === 1,
      `backs ${env.backs()} clicks ${env.clicks.join()}`);
    t(n('comments: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }
  {
    // Found by the panel it opens (a button with a new icon, as on webOS 25 in Hungarian).
    const env = await boot();
    env.playerButton({ icon: { iconType: 'LIKE' } }, 'like');
    env.playerButton({ command: { changeEngagementPanelVisibilityAction: { targetId: 'comment-item-section' } } }, 'comments');
    await env.press(D(K.comments));
    t(n('comments: found by the panel it opens, not the button before it'), env.clicks.join() === 'comments', env.clicks.join());
  }
  {
    // An old layout: the button by its label.
    const env = await boot({}, { html: '<yt-button-container aria-label="Comments"></yt-button-container>' });
    env.byHtml('yt-button-container[aria-label="Comments"]', 'comments');
    await env.press(D(K.comments));
    t(n('comments: an old layout\'s button found by its label'), env.clicks.join() === 'comments', env.clicks.join());
  }
  {
    const env = await boot({}, { html: '<ytlr-engagement-panel-section-list-renderer></ytlr-engagement-panel-section-list-renderer>' });
    env.playerButton({ icon: { iconType: 'COMMENT' } }, 'comments');
    await env.press(D(K.comments));
    t(n('comments: with a side panel open the key closes it (Back)'), env.backs() === 1 && env.clicks.length === 0,
      `backs ${env.backs()} clicks ${env.clicks.join()}`);
  }
  {
    const env = await boot({}, { html: '<ytlr-live-chat-toggle-button><yt-button-container></yt-button-container></ytlr-live-chat-toggle-button>' });
    const chat = env.byHtml('ytlr-live-chat-toggle-button yt-button-container', 'chat');
    chat.addEventListener('click', () => chat.setAttribute('aria-pressed', chat.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'));
    await env.press(D(K.comments));
    await wait(200);
    t(n('a live stream: the live chat button is pressed instead'), env.clicks.join() === 'chat', env.clicks.join());
    t(n('...and a toast says it is on'), /Live Chat: ON/.test(env.toasts()), env.toasts());
    await env.press(D(K.comments));
    await wait(200);
    t(n('...pressed again: off, with no Back'), /Live Chat: OFF/.test(env.toasts()) && env.backs() === 0 &&
      env.clicks.length === 2, env.toasts());
  }
  {
    const env = await boot();
    await env.press(D(K.comments));
    t(n('no comments button: "Comments Unavailable"'), /Comments Unavailable/.test(env.toasts()) && env.backs() === 0, env.toasts());
  }

  // ---- Toggle Description ----
  {
    const env = await boot();
    env.playerButton({ icon: { iconType: 'COMMENT' } }, 'comments');
    env.playerButton({ command: { changeEngagementPanelVisibilityAction: { targetId: 'video-description-ep-identifier' } } }, 'description');
    let rydChecks = 0;
    env.win.returnYouTubeDislike = { observeBodyForPanel: () => { rydChecks++; }, destroy() {} };
    await env.press(D(K.description));
    t(n('description: the player\'s description button is pressed'), env.clicks.join() === 'description', env.clicks.join());
    await wait(350);
    t(n('...and Return YouTube Dislike looks for the panel it opens'), rydChecks === 1, String(rydChecks));
    env.doc.querySelectorAll('yt-button-container')[1].setAttribute('aria-selected', 'true');
    await env.press(D(K.description));
    t(n('description open: the key closes it (Back)'), env.backs() === 1 && env.clicks.length === 1, `backs ${env.backs()}`);
    t(n('description: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }
  {
    // The English label of an older layout.
    const env = await boot({}, { html: '<ytlr-button-renderer><yt-button-container><yt-formatted-string class="XGffTd OqGroe">Description</yt-formatted-string></yt-button-container></ytlr-button-renderer>' });
    env.byHtml('yt-button-container', 'description');
    await env.press(D(K.description));
    t(n('description: an old layout\'s button found by its label'), env.clicks.join() === 'description', env.clicks.join());
  }
  {
    // The label in another language: the first text button, remembered.
    const env = await boot({}, { html: '<ytlr-button-renderer><yt-button-container><yt-formatted-string class="XGffTd OqGroe">Leírás</yt-formatted-string></yt-button-container></ytlr-button-renderer>' });
    const button = env.byHtml('yt-button-container', 'description');
    await env.press(D(K.description));
    t(n('description: a label in another language, the text button is pressed'), env.clicks.join() === 'description', env.clicks.join());
    button.setAttribute('aria-pressed', 'true');
    await env.press(D(K.description));
    t(n('...and found again the next time, now open: Back'), env.backs() === 1 && env.clicks.length === 1, `backs ${env.backs()}`);
  }
  {
    const env = await boot();
    await env.press(D(K.description));
    t(n('no description button: "Description Unavailable"'), /Description Unavailable/.test(env.toasts()), env.toasts());
  }

  // ---- Save / Watch Later ----
  {
    const env = await boot();
    env.playerButton({ icon: { iconType: 'BOOKMARK_BORDER' } }, 'save');
    await env.press(D(K.save));
    t(n('save: the player\'s Save button (bookmark icon) is pressed'), env.clicks.join() === 'save', env.clicks.join());
    const panel = env.doc.createElement('div');
    panel.className = 'AmQJbe';
    env.doc.body.appendChild(panel);
    await env.press(D(K.save));
    t(n('save: with the playlist picker open the key closes it (Back)'), env.backs() === 1 && env.clicks.length === 1,
      `backs ${env.backs()} clicks ${env.clicks.join()}`);
  }
  {
    const env = await boot({}, { html: '<yt-button-container class="save"><yt-icon class="p9sZp"></yt-icon></yt-button-container>' });
    // The button itself is pressed, not the icon in it (whose click the TV's
    // component does not take).
    const button = env.doc.querySelector('yt-button-container.save');
    button.addEventListener('click', (e) => env.clicks.push(e.target === button ? 'save' : 'icon'));
    await env.press(D(K.save));
    t(n('save: an old layout\'s icon, its button is pressed'), env.clicks.join() === 'save', env.clicks.join());
  }
  {
    const env = await boot();
    await env.press(D(K.save));
    t(n('no Save button: "Save Button Unavailable"'), /Save Button Unavailable/.test(env.toasts()), env.toasts());
  }

  // ---- Toggle Subtitles ----
  {
    const env = await boot();
    const player = env.doc.getElementById('ytlr-player__player-container-player');
    let track = {};
    const set = [];
    const loaded = [];
    player.loadModule = (m) => loaded.push(m);
    player.getOption = (m, k) => (k === 'track' ? track : [{ languageCode: 'hu', languageName: 'Hungarian' }]);
    player.setOption = (m, k, v) => { set.push(v); track = v; };
    await env.press(D(K.subs));
    t(n('subtitles: on, with the first track the player lists'), set.length === 1 && set[0].languageCode === 'hu' &&
      loaded.indexOf('captions') !== -1, JSON.stringify(set));
    t(n('...and a toast naming it'), /Subtitles: ON \(Hungarian\)/.test(env.toasts()), env.toasts());
    await env.press(D(K.subs));
    t(n('subtitles: on again, off (an empty track)'), set.length === 2 && Object.keys(set[1]).length === 0 &&
      /Subtitles: OFF/.test(env.toasts()), env.toasts());
  }
  {
    // No track list: the video's caption tracks.
    const env = await boot();
    const player = env.doc.getElementById('ytlr-player__player-container-player');
    const set = [];
    player.getOption = (m, k) => (k === 'track' ? null : []);
    player.setOption = (m, k, v) => set.push(v);
    player.getVideoData = () => ({ captionTracks: [{ languageCode: 'de', name: 'Deutsch' }] });
    await env.press(D(K.subs));
    t(n('subtitles: without a track list, the video\'s first caption track'),
      set.length === 1 && set[0].languageCode === 'de' && /Subtitles: ON \(Deutsch\)/.test(env.toasts()), env.toasts());
  }
  {
    // No player API: the captions button, and its state after the press.
    const env = await boot({}, { html: '<ytlr-captions-button><yt-button-container></yt-button-container></ytlr-captions-button>' });
    const button = env.byHtml('ytlr-captions-button yt-button-container', 'captions');
    button.addEventListener('click', () => button.setAttribute('aria-pressed', 'true'));
    await env.press(D(K.subs));
    await wait(200);
    t(n('subtitles without the player API: the captions button is pressed'), env.clicks.join() === 'captions', env.clicks.join());
    t(n('...and the toast says what it shows now'), /Subtitles: ON/.test(env.toasts()), env.toasts());
  }
  {
    // The API throws: the button is the way left; with no button either, a toast.
    const env = await boot();
    const player = env.doc.getElementById('ytlr-player__player-container-player');
    player.getOption = () => { throw new Error('no captions module'); };
    player.setOption = () => {};
    await env.press(D(K.subs));
    t(n('subtitles: the API failing and no button: "Subtitles unavailable"'), /Subtitles unavailable/.test(env.toasts()), env.toasts());
  }

  // ---- Jump to Live ----
  {
    const env = await boot();
    await env.press(D(K.live));
    t(n('jump to live on an ordinary video: "Not a live stream", nothing moves'),
      /Not a live stream/.test(env.toasts()) && env.vs.time === 100, env.toasts());
  }
  {
    const env = await boot();
    const player = env.doc.getElementById('ytlr-player__player-container-player');
    let heads = 0;
    player.getVideoData = () => ({ isLive: true });
    player.seekToLiveHead = () => { heads++; };
    env.vs.paused = true;
    await env.press(D(K.live));
    t(n('jump to live: the player\'s own seek to the live head'), heads === 1, String(heads));
    t(n('...a paused stream plays again'), env.vs.plays === 1 && env.vs.paused === false);
    t(n('...and a toast'), /Jumped to Live/.test(env.toasts()), env.toasts());
  }
  {
    // No player API: the end of the seekable range, less a second.
    const env = await boot();
    env.vs.duration = Infinity;
    env.vs.seekable = { length: 2, start: () => 0, end: (i) => (i === 1 ? 5000 : 10) };
    await env.press(D(K.live));
    t(n('jump to live without the player API: to the end of what can be seeked'),
      env.vs.time === 4999 && env.vs.plays === 0 && /Jumped to Live/.test(env.toasts()), `${env.vs.time} ${env.toasts()}`);
    env.vs.seekable = { length: 0 };
    env.vs.time = 100;
    await env.press(D(K.live));
    t(n('...nothing seekable: "Live edge not available"'), env.vs.time === 100 &&
      /Live edge not available/.test(env.toasts()), env.toasts());
  }
  {
    const env = await boot();
    const player = env.doc.getElementById('ytlr-player__player-container-player');
    player.getVideoData = () => ({ isLive: true });
    player.seekToLiveHead = () => { throw new Error('not ready'); };
    await env.press(D(K.live));
    t(n('jump to live: the player refusing is "Live edge not available"'), /Live edge not available/.test(env.toasts()) &&
      !/Jumped/.test(env.toasts()), env.toasts());
  }

  // ---- Sleep timer ----
  {
    const env = await boot();
    const SLEEP = [15, 30, 60, 90, 120].map((m) => m * 60000);
    const sleeping = () => env.long.filter((h) => h.kind === 'timeout' && SLEEP.indexOf(h.ms) !== -1);
    await env.press(D(K.sleep));
    t(n('sleep timer: the first press sets 15 minutes'), sleeping().length === 1 && sleeping()[0].ms === SLEEP[0] &&
      /Sleep timer: 15 min/.test(env.toasts()), env.toasts());
    await env.press(D(K.sleep));
    t(n('...the next 30, the 15 gone'), sleeping().length === 1 && sleeping()[0].ms === SLEEP[1] &&
      /Sleep timer: 30 min/.test(env.toasts()), env.toasts());
    for (const [i, min] of [[2, 60], [3, 90], [4, 120]]) {
      await env.press(D(K.sleep));
      t(n(`...then ${min}`), sleeping().length === 1 && sleeping()[0].ms === SLEEP[i] &&
        new RegExp(`Sleep timer: ${min} min`).test(env.toasts()), env.toasts());
    }
    await env.press(D(K.sleep));
    t(n('...and past 120 it is off'), sleeping().length === 0 && /Sleep timer off/.test(env.toasts()), env.toasts());
    await env.press(D(K.sleep));
    const timer = sleeping()[0];
    env.long.splice(env.long.indexOf(timer), 1);
    env.clearToasts();
    timer.fn();
    t(n('sleep timer running out pauses the video'), env.vs.pauses === 1 && env.vs.paused === true);
    t(n('...with a toast'), /Sleep timer: playback paused/.test(env.toasts()), env.toasts());
    await env.press(D(K.sleep));
    t(n('...and the next press starts again at 15'), /Sleep timer: 15 min/.test(env.toasts()), env.toasts());
  }

  // ---- Audio-only ----
  {
    const env = await boot();
    const html = env.doc.documentElement;
    await env.press(D(K.audio));
    t(n('audio-only: on (a class on <html>), with a toast'), html.classList.contains('ytaf-audio-only') &&
      /Audio-Only Mode Enabled/.test(env.toasts()), env.toasts());
    await env.press(D(K.audio));
    t(n('...pressed again: off'), !html.classList.contains('ytaf-audio-only') &&
      /Audio-Only Mode Disabled/.test(env.toasts()), env.toasts());
    await env.press(D(K.audio));
    env.doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await wait(30);
    t(n('...and it ends with the watch page'), !html.classList.contains('ytaf-audio-only'));
    const taken = await env.press(D(K.audio));
    t(n('a player action on the home screen does nothing, the key goes on to YouTube'),
      taken === false && !html.classList.contains('ytaf-audio-only') && env.toasts() === '', env.toasts());
  }

  // ---- Refresh Page ----
  {
    const env = await boot({}, { page: 'WEB_PAGE_TYPE_BROWSE' });
    const commands = [];
    env.doc.addEventListener('innertube-command', (e) => commands.push(e));
    const taken = await env.press(D(K.refresh));
    const signal = commands[0] && commands[0].detail.signalServiceEndpoint.actions[0].signalAction.signal;
    t(n('refresh on the home screen: a soft reload command to the app'), taken === true && commands.length === 1 &&
      signal === 'SOFT_RELOAD_PAGE' && commands[0].target === env.doc.querySelector('ytlr-app'), String(signal));
  }
  {
    const env = await boot();
    const commands = [];
    env.doc.addEventListener('innertube-command', (e) => commands.push(e));
    await env.press(D(K.refresh));
    t(n('refresh on the watch page: refused, with a toast'), commands.length === 0 &&
      /Cannot refresh on player pages/.test(env.toasts()), env.toasts());
  }

  // ---- The SponsorBlock actions ----
  {
    const env = await boot();
    await env.press(D(K.sbPrev));
    t(n('skip to last segment without SponsorBlock: "SponsorBlock not loaded"'), /SponsorBlock not loaded/.test(env.toasts()), env.toasts());
    let back = false;
    env.win.sponsorblock = { skipToPreviousSegment: () => back };
    await env.press(D(K.sbPrev));
    t(n('...no segment behind: "No previous segment found"'), /No previous segment found/.test(env.toasts()), env.toasts());
    back = true;
    await env.press(D(K.sbPrev));
    t(n('...a segment behind: no toast from the shortcut'), env.toasts() === '', env.toasts());

    env.win.sponsorblock = null;
    await env.press(KEY.BLUE);
    t(n('blue (manual skip) without SponsorBlock: "SponsorBlock not loaded"'), /SponsorBlock not loaded/.test(env.toasts()), env.toasts());
    let handled = false;
    env.win.sponsorblock = { handleBlueButton: () => handled };
    await env.press(KEY.BLUE);
    t(n('...nothing to skip: "No action available"'), /No action available/.test(env.toasts()), env.toasts());
    handled = true;
    await env.press(KEY.BLUE);
    t(n('...a segment skipped: no toast from the shortcut'), env.toasts() === '', env.toasts());
    env.win.sponsorblock = { handleBlueButton: () => { throw new Error('segment gone'); } };
    await env.press(KEY.BLUE);
    t(n('...the handler failing: its error in a toast'), /Error: segment gone/.test(env.toasts()), env.toasts());
    t(n('SponsorBlock actions: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- The OLED blackout's keep-alive and switching it off ----
  {
    const env = await boot({}, { page: 'WEB_PAGE_TYPE_BROWSE' });
    await env.press(KEY.RED);
    const overlay = env.doc.getElementById('oled-black-overlay');
    const keepAlive = env.long.filter((h) => h.kind === 'interval' && h.ms === 30 * 60000);
    t(n('red: the blackout covers the screen, with a toast'), !!overlay && overlay.style.zIndex === '1100' &&
      env.doc.documentElement.classList.contains('ytaf-oled-blackout') && /OLED Black Overlay On/.test(env.toasts()), env.toasts());
    t(n('...and keeps the TV awake every 30 minutes'), keepAlive.length === 1);
    env.sent.length = 0;
    env.sentAt.length = 0;
    keepAlive[0].fn();
    await wait(300);
    const gap = env.sentAt.length === 2 ? env.sentAt[1] - env.sentAt[0] : -1;
    t(n('...with two presses of Up, a quarter second apart'), env.sent.join() === `${KEY.UP},${KEY.UP}` &&
      gap >= 240, `${env.sent.join()} gap=${gap}`);
    await env.press(KEY.RED);
    t(n('red again: the blackout ends, with a toast'), !env.doc.getElementById('oled-black-overlay') &&
      !env.doc.documentElement.classList.contains('ytaf-oled-blackout') && /OLED Black Overlay Off/.test(env.toasts()), env.toasts());
    t(n('...and the keep-alive stops'), env.long.filter((h) => h.kind === 'interval').length === 0);
  }

  // ---- Play / Pause: the controls YouTube shows on a pause ----
  {
    const env = await boot({}, { html: '<yt-focus-container idomkey="controls"></yt-focus-container><div class="webOs-watch"></div>', gap: 20 });
    const controls = env.doc.querySelector('yt-focus-container[idomkey="controls"]');
    const clock = env.doc.querySelector('.webOs-watch');
    await env.press(KEY.YELLOW);
    t(n('play/pause: pauses a playing video'), env.vs.pauses === 1 && /Paused/.test(env.toasts()), env.toasts());
    t(n('...hiding the controls and the clock for a moment'), env.doc.body.classList.contains('ytaf-hide-controls') &&
      clock.style.opacity === '0');
    // YouTube shows its controls on the pause: the shortcut closes them with Back.
    controls.classList.add('zylon-focus');
    await wait(300);
    t(n('...the controls YouTube opened are closed with Back'), env.backs() === 1, env.sent.join());
    await wait(600);
    t(n('...and the controls and clock come back after'), !env.doc.body.classList.contains('ytaf-hide-controls') &&
      clock.style.opacity === '');
    await wait(600);   // the pause's longer debounce
    await env.press(KEY.YELLOW);
    t(n('play/pause again: plays'), env.vs.plays === 1 && env.vs.paused === false && /Playing/.test(env.toasts()), env.toasts());
    await wait(150);
    // The controls on screen when pausing: left as they are.
    await env.press(KEY.YELLOW);
    await wait(300);
    t(n('pausing with the controls on screen leaves them (no hiding, no Back)'), env.vs.pauses === 2 &&
      !env.doc.body.classList.contains('ytaf-hide-controls') && env.backs() === 1, env.sent.join());
  }

  // ---- Chapters ----
  // Missing renderer chapter data must use the visible bar, rather than
  // coercing null into a spurious chapter at 0. Test through the remote key.
  for (const [label, chapters] of [
    ['empty data (control)', []],
    ['null entry', [null]],
    ['null start', [{ start: null }]]
  ]) {
    const bar = '<ytlr-multi-markers-player-bar-renderer><div idomkey="progress-bar">' +
      '<div idomkey="chapter-0" style="width: 50%"></div>' +
      '<div idomkey="chapter-1" style="width: 50%"></div>' +
      '<div idomkey="playhead"></div></div></ytlr-multi-markers-player-bar-renderer>';
    const env = await boot({ shortcut_key_0: 'chapter_skip_prev' }, { html: bar });
    env.doc.querySelector('ytlr-multi-markers-player-bar-renderer').__instance = {
      props: { data: { chapters } }
    };
    env.vs.time = 100;
    await env.press(D(5));
    t(n(`chapter fallback (${label}): next key seeks to 300 seconds`),
      env.vs.time === 300 && /Next Chapter/.test(env.toasts()), `${env.vs.time} ${env.toasts()}`);
    env.vs.time = 320;
    await env.press(D(0));
    t(n(`chapter fallback (${label}): previous key seeks to 300 seconds`),
      env.vs.time === 300, String(env.vs.time));
    t(n(`chapter fallback (${label}): no page errors`), env.errors.length === 0, env.errors.join(' | '));
  }
  {
    // Four chapters of a quarter each: 0:00, 2:30, 5:00, 7:30 of a 10-minute video.
    const bar = '<ytlr-multi-markers-player-bar-renderer><div idomkey="progress-bar">' +
      [0, 1, 2, 3].map((i) => `<div idomkey="chapter-${i}" style="width: 25%"></div>`).join('') +
      '<div idomkey="playhead"></div></div></ytlr-multi-markers-player-bar-renderer>';
    const env = await boot({ shortcut_key_0: 'chapter_skip_prev' }, { html: bar });
    env.vs.time = 100;
    await env.press(D(5));
    t(n('next chapter: to the start of the next one'), env.vs.time === 150 && /Next Chapter/.test(env.toasts()), `${env.vs.time} ${env.toasts()}`);
    env.vs.time = 200;
    await env.press(D(0));
    t(n('previous chapter, well into one: back to its start'), env.vs.time === 150 &&
      /Previous Chapter/.test(env.toasts()), `${env.vs.time} ${env.toasts()}`);
    env.vs.time = 151;
    await env.press(D(0));
    t(n('previous chapter, just after a start: to the chapter before'), env.vs.time === 0, String(env.vs.time));
    env.vs.time = 500;
    await env.press(D(5));
    t(n('next chapter in the last one: "No next chapter", nothing moves'), env.vs.time === 500 &&
      /No next chapter/.test(env.toasts()), env.toasts());
  }
  {
    // The renderer's data has the chapters' own starts. The bar's widths are whole pixels and, on a
    // long video, cover only some chapters: here two halves (0:00, 5:00) for four chapters.
    const bar = '<ytlr-multi-markers-player-bar-renderer><div idomkey="progress-bar">' +
      '<div idomkey="chapter-0" style="width: 50%"></div><div idomkey="chapter-1" style="width: 50%"></div>' +
      '<div idomkey="playhead"></div></div></ytlr-multi-markers-player-bar-renderer>';
    const env = await boot({ shortcut_key_0: 'chapter_skip_prev' }, { html: bar });
    env.doc.querySelector('ytlr-multi-markers-player-bar-renderer').__instance =
      { props: { data: { chapters: [0, 70, 333, 480].map((start) => ({ start, title: { simpleText: 'c' } })) } } };
    env.vs.time = 100;
    await env.press(D(5));
    t(n('next chapter: the start the data gives (5:33), not the bar\'s 5:00'), env.vs.time === 333, String(env.vs.time));
    env.vs.time = 400;
    await env.press(D(0));
    t(n('previous chapter: back to the data\'s start too'), env.vs.time === 333, String(env.vs.time));
  }
  {
    // A bar with no chapter markers on it.
    const env = await boot({}, { html: '<ytlr-multi-markers-player-bar-renderer><div idomkey="progress-bar"><div idomkey="playhead"></div></div></ytlr-multi-markers-player-bar-renderer>' });
    await env.press(D(5));
    t(n('a progress bar without chapters: "No chapters found"'), /No chapters found/.test(env.toasts()) && env.vs.time === 100, env.toasts());
  }
  {
    // No progress bar: OK opens the controls to load it, then Back closes them.
    const env = await boot();
    const ENTER = 13;
    await env.press(D(5));
    t(n('no progress bar: OK is sent to bring up the controls, with a toast'), env.sent.indexOf(ENTER) !== -1 &&
      /Loading chapters/.test(env.toasts()), `${env.sent.join()} ${env.toasts()}`);
    await wait(900);
    t(n('...still none: "No chapters found" and Back to close the controls'), /No chapters found/.test(env.toasts()) &&
      env.backs() === 1, `${env.sent.join()} ${env.toasts()}`);
  }

  // A delayed chapter lookup must belong to the video that requested it. Its
  // 500 ms wait and the closing Back's 250 ms are held and run by the test, so
  // timing cannot pass or fail it; 'none' (no change) shows that the held
  // timers are the lookup's: there it seeks and closes the controls.
  for (const change of ['none', 'left watch', 'reused video']) {
    const env = await boot({}, { gap: 10 });
    const lookup = holdTimeouts(env, 500);
    const back = holdTimeouts(env, 250);
    const player = env.doc.getElementById('ytlr-player__player-container-player');
    let id = VIDEO_ID;
    player.getVideoData = () => ({ video_id: id });
    await env.press(D(5));
    t(n(`pending chapters, ${change}: the lookup is waiting`), /Loading chapters/.test(env.toasts()) && env.vs.time === 100, env.toasts());
    if (change === 'left watch') env.doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
    else if (change === 'reused video') id = 'newvideo123'; // YouTube can reuse the element before updating the route.
    player.insertAdjacentHTML('afterend', '<ytlr-multi-markers-player-bar-renderer><div idomkey="progress-bar"><div idomkey="chapter-0" style="width:50%"></div><div idomkey="chapter-1" style="width:50%"></div></div></ytlr-multi-markers-player-bar-renderer>');
    await wait(30);
    lookup.run();
    await wait(30);
    back.run();
    await wait(30);
    if (change === 'none') {
      t(n('pending chapters, no change: it seeks to the next chapter and closes the controls'),
        env.vs.time === 300 && env.backs() === 1, `${env.vs.time} ${env.sent.join()}`);
    } else {
      t(n(`pending chapters, ${change}: no stale seek`), env.vs.time === 100, String(env.vs.time));
      t(n(`pending chapters, ${change}: no stale Back`), env.backs() === 0, env.sent.join());
    }
    env.win.close();
  }
  for (const navigate of [false, true]) {
    // No chapters: the lookup queues its closing Back. Held, it runs after
    // the navigation (or, as a control, with none: then Back is sent).
    const env = await boot({}, { gap: 10 });
    const lookup = holdTimeouts(env, 500);
    const back = holdTimeouts(env, 250);
    await env.press(D(5));
    await wait(30);
    lookup.run();
    await wait(30);
    t(n(`chapter controls${navigate ? '' : ' (control)'}: the lookup found nothing`), /No chapters found/.test(env.toasts()) &&
      env.backs() === 0, `${env.sent.join()} ${env.toasts()}`);
    if (navigate) {
      env.win.location.hash = '#/';
      env.doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
    }
    await wait(30);
    back.run();
    t(n(navigate ? '...navigation before it runs: the queued Back is cancelled' : '...with no navigation its queued Back is sent'),
      env.backs() === (navigate ? 0 : 1), env.sent.join());
    env.win.close();
  }
  {
    // A lookup discarded by A -> B -> A during its (held) wait: the next press
    // sends the Enter that loads the chapter bar again.
    const env = await boot({}, { gap: 10 });
    const lookup = holdTimeouts(env, 500);
    const ENTER = 13;
    await env.press(D(5));
    env.win.location.hash = '#/watch?v=newvideo123';
    await wait(10);
    env.win.location.hash = '#/watch?v=' + VIDEO_ID;
    await wait(30);
    lookup.run();
    await wait(520); // past the shortcut's 500 ms debounce
    await env.press(D(5));
    t(n('chapter lookup discarded by A -> B -> A: the next press loads the bar again'),
      env.sent.filter((c) => c === ENTER).length === 2 && /Loading chapters/.test(env.toasts()), `${env.sent.join()} ${env.toasts()}`);
    env.win.close();
  }

  // ---- Fast forward and rewind ----
  {
    const env = await boot({ shortcut_key_1: 'seek_15_fwd', shortcut_key_2: 'seek_15_back' });
    await env.press(D(1));
    await env.press(D(1));
    t(n('fast forward twice in quick succession: one toast with the total'), /Skipped \+10s/.test(env.toasts()), env.toasts());
    t(n('...the video not moved yet'), env.vs.time === 100, String(env.vs.time));
    await wait(150);
    t(n('...then moved once by the total'), env.vs.time === 110, String(env.vs.time));
    await env.press(D(2));
    t(n('rewind after it: the toast counts from the turn'), /Skipped -5s/.test(env.toasts()), env.toasts());
    await wait(150);
    t(n('...and the video goes back by 5'), env.vs.time === 105, String(env.vs.time));
  }

  for (const change of ['route', 'video', 'element']) {
    const env = await boot({ shortcut_key_1: 'seek_15_fwd' }, { gap: 10 });
    const player = env.doc.getElementById('ytlr-player__player-container-player');
    let id = VIDEO_ID;
    player.getVideoData = () => ({ video_id: id });
    await env.press(D(1));
    if (change === 'route') env.win.location.hash = '#/watch?v=newvideo123';
    else if (change === 'video') id = 'newvideo123';
    else env.video.remove();
    await wait(260);
    t(n(`pending burst seek, changed ${change}: old position untouched`), env.vs.time === 100, String(env.vs.time));
    if (change !== 'element') {
      await env.press(D(1));
      await wait(250);
      t(n(`pending burst seek, changed ${change}: next press has no old offset`), env.vs.time === 105, String(env.vs.time));
    }
    env.win.close();
  }

  {
    // The seek timer held: the first press (+5) is still waiting when the
    // video changes; the second is a rewind, so the one write shows which
    // press was applied.
    const env = await boot({ shortcut_key_1: 'seek_15_fwd', shortcut_key_2: 'seek_15_back' }, { gap: 10 });
    const player = env.doc.getElementById('ytlr-player__player-container-player');
    let id = VIDEO_ID;
    player.getVideoData = () => ({ video_id: id });
    const writes = [];
    Object.defineProperty(env.video, 'currentTime', { configurable: true, get: () => env.vs.time,
      set: (v) => { writes.push(v); env.vs.time = v; } });
    const seekTimer = holdTimeouts(env, 200);
    await env.press(D(1));
    await wait(300);
    t(n('new video before queued seek: the first seek (+5) is queued and held past its 200 ms'),
      /Skipped \+5s/.test(env.toasts()) && writes.length === 0, `${env.toasts()} ${writes.join()}`);
    id = 'newvideo123';
    await wait(510); // past the shortcut debounce
    await env.press(D(2));
    seekTimer.run();
    t(n('...only the new press is applied: one write, to 95'), writes.length === 1 && writes[0] === 95, writes.join());
    env.win.close();
  }
  {
    // The seek timer is held until the route is back on A and its hashchange
    // has been delivered: only that listener can cancel the seek.
    const env = await boot({ shortcut_key_1: 'seek_15_fwd' }, { gap: 10 });
    const seekTimer = holdTimeouts(env, 200);
    await env.press(D(1));
    await wait(300);
    t(n('A to B to A: the seek (+5) is queued and held past its 200 ms'),
      /Skipped \+5s/.test(env.toasts()) && env.vs.time === 100, `${env.toasts()} ${env.vs.time}`);
    env.win.location.hash = '#/watch?v=newvideo123';
    await wait(10);
    env.win.location.hash = '#/watch?v=' + VIDEO_ID;
    await wait(30);
    seekTimer.run();
    t(n('...A to B to A navigation cancels the old queued seek'), env.vs.time === 100, String(env.vs.time));
    env.win.close();
  }

  // ---- The key that closes the settings panel ----
  {
    const env = await boot({}, { page: 'WEB_PAGE_TYPE_BROWSE' });
    const reached = [];
    // On window, in the capture phase, as YouTube's own key handler listens.
    env.win.addEventListener('keydown', (e) => { if (!e.__ytafSynthetic && e.keyCode === KEY.BACK) reached.push(e.repeat); }, true);
    await env.press(KEY.GREEN);
    await wait(500);   // the panel ignores toggles in its first half second
    await env.press(KEY.BACK, {}, 'keydown');
    const panel = env.doc.querySelector('.ytaf-ui-container');
    t(n('Back closes the settings panel'), !!panel && panel.style.display === 'none');
    reached.length = 0;
    const repeat = await env.press(KEY.BACK, { repeat: true }, 'keydown');
    t(n('...Back still held: its repeats are swallowed, YouTube does not go back'), repeat === true && reached.length === 0,
      JSON.stringify(reached));
    await env.press(KEY.BACK, {}, 'keyup');
    await env.press(KEY.BACK);
    t(n('...released: the next Back reaches YouTube again'), reached.length === 1, JSON.stringify(reached));
  }

  // ---- Keys the shortcuts leave alone ----
  {
    const env = await boot({ shortcut_key_3: 'none' }, { html: '<input type="text" id="box">' });
    const html = env.doc.documentElement;
    env.doc.getElementById('box').focus();
    const typed = await env.press(D(K.audio));
    t(n('a number typed into a text box stays a number'), typed === false && !html.classList.contains('ytaf-audio-only'));
    env.doc.getElementById('box').blur();
    const held = await env.press(D(K.audio), { repeat: true });
    t(n('a held bound key\'s repeat is taken but runs nothing'), held === true && !html.classList.contains('ytaf-audio-only'));
    const unbound = await env.press(D(3));
    t(n('a number key bound to nothing goes on to YouTube'), unbound === false);
  }
  {
    // A binding the settings no longer offer (an older version's action).
    const env = await boot({ shortcut_key_5: 'retired_action' });
    const taken = await env.press(D(5));
    t(n('a key bound to an unknown action is taken, and only logged'), taken === true &&
      env.warnings.some((w) => /Unknown action: retired_action/.test(w)) && env.errors.length === 0,
    env.warnings.join(' | '));
  }
});
