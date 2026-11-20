/**
 * screensaver-fix.js beyond the frozen-picture nudge (bench/screensaver-test):
 * the screensaver request it registers with the TV's power service, the
 * full-screen size it keeps on the watch page's <video>, and the Shorts
 * keep-alive. Until this test nothing answered a screensaver the TV was about
 * to start (isVideoPlaying), and nothing resized the player (isPlayerHidden).
 *
 *   node bench/screensaver-cases-test.cjs <bundle> [legacy|modern]
 *
 * PalmServiceBridge (the webOS service bridge) is a stand-in that records
 * each luna call; the test answers the subscription as the TV would, with a
 * timestamp for each screensaver it is about to start, and reads the ack the
 * bundle sends back (ack: false holds the screensaver off). The 30 s Shorts
 * keep-alive runs every 0.3 s here.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, trustedKey, wait, until } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();

const TVPOWER = 'luna://com.webos.service.tvpower/power/';
const YELLOW = 405;
const YELLOW_ALT = 170;

const { t, run } = createReporter();

/**
 * The bundle on the browse page, the player mounted. `bridge: false` leaves
 * PalmServiceBridge out, as on a firmware without it.
 */
function boot(opts = {}) {
  const { win, doc, errors, evaluate } = bootPage({
    code,
    inner: '\n    <div id="ytlr-player__player-container"><div id="ytlr-player__player-container-player"></div></div>\n    ',
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false
    }, opts.config),
    fetch: 'pending',
    evaluate: false
  });

  // Every luna call the page makes: its uri, its params, whether it was cancelled.
  const calls = [];
  if (opts.bridge !== false) {
    win.PalmServiceBridge = function PalmServiceBridge() {
      const call = { bridge: this, uri: null, params: null, cancelled: false };
      this.call = (uri, payload) => { call.uri = uri; call.params = JSON.parse(payload); calls.push(call); };
      this.cancel = () => { call.cancelled = true; };
      call.answer = (res) => this.onservicecallback(JSON.stringify(res));
    };
  }
  // The Shorts keep-alive's 30 s, as 0.3 s.
  const realInterval = win.setInterval;
  win.setInterval = function (fn, ms, ...rest) { return realInterval.call(win, fn, ms === 30000 ? 300 : ms, ...rest); };

  const player = doc.getElementById('ytlr-player__player-container-player');
  const state = { playerState: 1 };
  player.getPlayerState = () => state.playerState;
  // The synthetic key presses the page receives.
  const keys = [];
  doc.addEventListener('keydown', (e) => { if (e.__ytafSynthetic) keys.push(e.keyCode); }, true);

  evaluate();

  const env = {
    win, doc, errors, calls, state, keys, player,
    // A <video> in the player whose play state the test sets.
    addVideo(parent = player) {
      const v = doc.createElement('video');
      const vs = { paused: false, ended: false };
      Object.defineProperty(v, 'paused', { configurable: true, get: () => vs.paused });
      Object.defineProperty(v, 'ended', { configurable: true, get: () => vs.ended });
      v.vs = vs;
      parent.appendChild(v);
      return v;
    },
    async page(type) { doc.body.className = 'WEB_PAGE_TYPE_' + type; await wait(30); },
    register: () => calls.find((c) => c.uri === TVPOWER + 'registerScreenSaverRequest'),
    responses: () => calls.filter((c) => c.uri === TVPOWER + 'responseScreenSaverRequest'),
    // The TV about to start a screensaver: the ack the page answers it with
    // (undefined when it does not answer).
    screensaver(stamp) {
      const before = env.responses().length;
      env.register().answer({ returnValue: true, timestamp: stamp });
      const res = env.responses().slice(before);
      if (res.length !== 1) return res.length ? 'answered ' + res.length + ' times' : undefined;
      const p = res[0].params;
      return p.timestamp === stamp && p.clientName === 'youtube-webos' ? p.ack : 'wrong answer ' + JSON.stringify(p);
    },
    // YouTube writing the player's size and place, as it does when it shrinks it.
    async writeStyle(v, css) { Object.assign(v.style, css); await wait(60); },
    size: (v) => [v.style.width, v.style.height, v.style.left, v.style.top].join(' ')
  };
  return env;
}

const FULL = '1024px 768px 0px 0px';   // jsdom's window: 1024 x 768
const SMALL = { width: '640px', height: '360px', left: '100px', top: '50px' };

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- The screensaver request ----
  {
    const env = boot();
    await wait(50);
    const reg = env.register();
    t(n('at start the page registers with the TV\'s power service for its screensavers'), !!reg &&
      reg.params.subscribe === true && reg.params.clientName === 'youtube-webos', JSON.stringify(reg && reg.params));
    reg.answer({ returnValue: true, subscribed: true });
    t(n('the first answer only confirms the subscription: nothing sent back'), env.responses().length === 0);

    const video = env.addVideo();
    t(n('browse page, a preview playing: the screensaver is allowed'), env.screensaver('s1') === true);
    await env.page('WATCH');
    const ack = env.screensaver('s2');
    t(n('watch page, the video playing: the screensaver is held off (ack false)'), ack === false, String(ack));
    video.vs.paused = true;
    t(n('watch page, the video paused: allowed'), env.screensaver('s3') === true);
    video.vs.paused = false;
    // At its end, with paused left false: ended alone counts.
    video.vs.ended = true;
    t(n('watch page, the video ended: allowed'), env.screensaver('s4') === true);
    video.vs.ended = false;
    t(n('watch page, playing again: held off again'), env.screensaver('s5') === false);
    await env.page('SHORTS');
    t(n('Shorts, playing: held off'), env.screensaver('s6') === false);
    video.vs.paused = true;
    t(n('Shorts, paused: allowed'), env.screensaver('s7') === true);
    video.vs.paused = false;
    await env.page('WATCH');
    video.remove();
    t(n('watch page with no video: allowed'), env.screensaver('s8') === true);
    t(n('the subscription is kept: every screensaver got its one answer'),
      env.responses().length === 8 && !reg.cancelled, env.responses().length);
    t(n('...each a single call, not a subscription'), env.responses().every((c) => !c.params.subscribe));

    env.win.dispatchEvent(new env.win.Event('beforeunload'));
    t(n('the page unloading cancels the subscription'), reg.cancelled === true);
    t(n('screensaver request: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }
  {
    // The TV refuses the subscription: the call is over, nothing is left to cancel.
    const env = boot();
    await wait(50);
    const reg = env.register();
    reg.answer({ returnValue: false, errorText: 'denied' });
    env.win.dispatchEvent(new env.win.Event('beforeunload'));
    t(n('a refused subscription is not held: nothing cancelled at unload'), reg.cancelled === false);
    env.win.close();
  }
  {
    const env = boot();
    await wait(50);
    env.addVideo();
    await env.page('WATCH');
    env.register().answer({ returnValue: false, errorText: 'Unknown method', timestamp: 'x' });
    t(n('the TV refusing the request: nothing is sent back'), env.responses().length === 0);
    t(n('refused: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }
  {
    const env = boot({ bridge: false });
    await wait(50);
    const video = env.addVideo();
    await env.page('WATCH');
    await env.writeStyle(video, SMALL);
    t(n('no service bridge: no luna call, and the rest still works'), env.calls.length === 0 &&
      env.size(video) === FULL, env.size(video));
    t(n('no service bridge: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  // ---- The watch page's player kept full screen ----
  {
    const env = boot();
    await wait(50);
    const video = env.addVideo();
    await env.writeStyle(video, SMALL);
    t(n('browse page: a preview\'s size is left alone'), env.size(video) === '640px 360px 100px 50px', env.size(video));
    await env.page('WATCH');
    await env.writeStyle(video, { width: '480px', height: '270px' });
    t(n('watch page: the player YouTube shrinks is put back full screen'), env.size(video) === FULL, env.size(video));
    await env.writeStyle(video, { display: 'none', width: '640px', left: '100px' });
    t(n('a hidden player (display: none) is left alone'), env.size(video) === '640px 768px 100px 0px', env.size(video));
    await env.writeStyle(video, { display: '', top: '-1080px', width: '320px' });
    t(n('a player moved off the screen (negative top) is left alone'), env.size(video) === '320px 768px 100px -1080px',
      env.size(video));
    await env.writeStyle(video, { top: '20px' });
    t(n('shown again: full screen again'), env.size(video) === FULL, env.size(video));

    // A video-to-video navigation with a new <video>.
    video.remove();
    const next = env.addVideo();
    env.win.dispatchEvent(new env.win.HashChangeEvent('hashchange'));
    await wait(30);
    await env.writeStyle(next, SMALL);
    t(n('a new <video> on the next watch page is kept full screen too'), env.size(next) === FULL, env.size(next));

    await env.page('BROWSE');
    await env.writeStyle(next, SMALL);
    t(n('back on the browse page: left alone again'), env.size(next) === '640px 360px 100px 50px', env.size(next));

    // The watch page opening before its <video> is mounted.
    next.remove();
    await env.page('WATCH');
    const late = env.addVideo();
    await wait(30);
    await env.writeStyle(late, SMALL);
    t(n('a <video> mounted after the watch page opened: kept full screen'), env.size(late) === FULL, env.size(late));
    t(n('player size: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  // ---- The Shorts keep-alive ----
  {
    const env = boot();
    await wait(50);
    env.addVideo();
    await wait(700);
    t(n('browse page: no keep-alive keys'), env.keys.length === 0, env.keys.join(','));
    await env.page('SHORTS');
    // The pair: Yellow, then its second keycode 250 ms later.
    const pairEnd = Date.now() + 3000;
    while (env.keys.length < 2 && Date.now() < pairEnd) await wait(20);
    const k = env.keys.slice();
    t(n('Shorts playing: the keep-alive sends Yellow, then its second keycode'),
      k.length >= 2 && k[0] === YELLOW && k[1] === YELLOW_ALT, k.join(','));
    env.state.playerState = 2;
    await wait(300);   // a Yellow already sent has its second keycode to come
    env.keys.length = 0;
    await wait(700);
    t(n('Shorts paused: no keys'), env.keys.length === 0, env.keys.join(','));
    env.state.playerState = 1;
    await wait(700);
    t(n('playing again: keys again'), env.keys.indexOf(YELLOW) !== -1, env.keys.join(','));
    await env.page('WATCH');
    await wait(300);
    env.keys.length = 0;
    await wait(700);
    t(n('watch page: the keep-alive stops'), env.keys.length === 0, env.keys.join(','));
    t(n('keep-alive: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  // ---- YouTube's echo of the keep-alive's Yellow is no press ----
  {
    // YouTube TV sends each Yellow the mod dispatches back a moment later,
    // unflagged, as keycode 170 (measured on webOS 25: 1-24 ms later). Here
    // the echo is trusted, as on a Chrome without isTrusted (Chrome 38), so
    // only the mod's own record of what it sent can tell it from a press.
    const env = boot({ config: { shortcut_key_yellow: 'config_menu' } });
    const echoes = [];
    env.doc.addEventListener('keydown', (e) => {
      if (!e.__ytafSynthetic) return;
      setTimeout(() => {
        echoes.push(e.keyCode);
        trustedKey(env.win, YELLOW_ALT, env.doc.body, 'keydown');
        trustedKey(env.win, YELLOW_ALT, env.doc.body, 'keyup');
      }, 5);
    }, true);
    const panelOpen = () => {
      const c = env.doc.querySelector('.ytaf-ui-container');
      return !!c && env.win.getComputedStyle(c).display !== 'none';
    };
    await wait(50);
    env.addVideo();
    await env.page('SHORTS');
    const echoed = await until(() => echoes.length >= 2, 3000);
    await wait(50);
    t(n('echo: precondition: both keep-alive keys were echoed'), echoed && echoes[0] === YELLOW && echoes[1] === YELLOW_ALT,
      echoes.join(','));
    t(n('echo: the echoed Yellow does not run the Yellow binding'), !panelOpen());
    // Away from the keep-alive (paused: it sends nothing), a real press does.
    env.state.playerState = 2;
    await wait(400);
    trustedKey(env.win, YELLOW, env.doc.body, 'keydown');
    trustedKey(env.win, YELLOW, env.doc.body, 'keyup');
    t(n('echo: control: a real Yellow press runs it'), await until(panelOpen, 1000));
    t(n('echo: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }
});
