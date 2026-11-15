/**
 * SponsorBlock over a video's life, in the bundle: "Periodically Check for New
 * Segments" (new segments picked up while playing, the back-off while there
 * are none or the servers fail, nothing fetched while paused, Skip Segments
 * Once kept across a change), the <video> mounting late or replaced by
 * YouTube, and the handler going away (another video, SponsorBlock switched
 * off): its marks, list and badge gone, its own mute undone, nothing skipped.
 * sponsorblock-skip-test covers the skip and sponsorblock-bar-test the bar;
 * none of this ran in a test before.
 *
 *   node bench/sponsorblock-lifecycle-test.cjs <bundle> [legacy|modern]
 *
 * The refresh timers (5 to 30 minutes) are held, not run: the test reads
 * their delays and fires them itself. The <video> and the API are faked as in
 * sponsorblock-skip-test.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const code = fs.readFileSync(bundlePath, 'utf8');

const VIDEO_ID = 'abcdefghijk';
const OTHER_ID = 'zyxwvutsrqp';
const MIN = 60 * 1000;
const REFRESH_DELAYS = [5, 10, 15, 20, 30].map((m) => m * MIN);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

const seg = (category, start, end, actionType = 'skip') =>
  ({ UUID: `${category}-${start}-${actionType}`, category, actionType, segment: [start, end] });

const BAR = '<div class="bar-host"><ytlr-multi-markers-player-bar-renderer><ytlr-progress-bar>' +
  '<div idomkey="progress-bar"></div></ytlr-progress-bar></ytlr-multi-markers-player-bar-renderer></div>';

// A <video> whose time, play state and duration the test sets.
function fakeVideo(win, video, duration) {
  const state = { time: 0, paused: false, muted: false, seeks: [] };
  const fire = (type) => video.dispatchEvent(new win.Event(type));
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => state.time,
      set: (v) => {
        state.time = v;
        state.seeks.push(v);
        fire('seeking');
        setTimeout(() => fire('seeked'), 5);
      }
    },
    duration: { configurable: true, get: () => duration },
    paused: { configurable: true, get: () => state.paused },
    seeking: { configurable: true, get: () => false },
    readyState: { configurable: true, get: () => 4 },
    muted: { configurable: true, get: () => state.muted, set: (v) => { state.muted = !!v; } },
    play: { configurable: true, value: () => { state.paused = false; fire('playing'); return Promise.resolve(); } },
    pause: { configurable: true, value: () => { state.paused = true; fire('pause'); } }
  });
  const playTo = async (time) => {
    state.time = time;
    fire('timeupdate');
    await wait(40);   // the rAF loop, the toast, a seek's 'seeked'
  };
  const seekTo = async (time) => {
    video.currentTime = time;
    await wait(40);
  };
  return { state, playTo, seekTo };
}

/**
 * The bundle on a watch page. net.segments is what the API answers for this
 * video (net.other for OTHER_ID), net.status what both servers answer.
 * opts.noVideo: the <video> is not in the page yet.
 */
async function boot(cfg, segments, opts = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(`<!doctype html><html><head></head><body class="WEB_PAGE_TYPE_WATCH"><ytlr-app>
    <div id="ytlr-player__player-container-player">${opts.noVideo ? '' : '<video></video>'}</div>${BAR}</ytlr-app></body></html>`,
  { runScripts: 'outside-only', url: `https://www.youtube.com/tv#/watch?v=${VIDEO_ID}`, virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: true, enableReturnYouTubeDislike: false,
    enableDeArrow: false, upgradeThumbnails: false, enableAutoLogin: false,
    checkForUpdates: false, showWhatsNew: false, sbPeriodicRefresh: true
  }, cfg)));
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };

  // The refresh's timers are held for the test to fire; with opts.fastRetry
  // the 2 s and 4 s waits before asking failed servers again are cut short.
  const held = [];
  const realTimeout = win.setTimeout.bind(win);
  const realClear = win.clearTimeout.bind(win);
  let nextId = 1e7;
  win.setTimeout = (fn, ms, ...args) => {
    if (REFRESH_DELAYS.indexOf(ms) !== -1) { held.push({ fn, ms, id: ++nextId }); return nextId; }
    if (opts.fastRetry && (ms === 2000 || ms === 4000)) return realTimeout(fn, 1, ...args);
    return realTimeout(fn, ms, ...args);
  };
  win.clearTimeout = (id) => {
    const i = held.findIndex((h) => h.id === id);
    if (i !== -1) held.splice(i, 1);
    else realClear(id);
  };
  const refreshes = () => held.map((h) => h.ms / MIN);
  // The pending refresh comes due.
  const fireRefresh = async () => {
    if (held.length !== 1) throw new Error('expected one refresh timer, have ' + JSON.stringify(refreshes()));
    held.shift().fn();
    await wait(80);
  };

  const net = { segments, other: [], status: opts.status || 200, asked: [] };
  win.fetch = (resource) => {
    const url = String(resource && resource.url || resource);
    if (url.indexOf('/skipSegments/') === -1) return new Promise(() => {});
    net.asked.push(url);
    const body = [{ videoID: VIDEO_ID, segments: JSON.parse(JSON.stringify(net.segments)) },
      { videoID: OTHER_ID, segments: JSON.parse(JSON.stringify(net.other)) }];
    return Promise.resolve({ ok: net.status === 200, status: net.status, json: () => Promise.resolve(body) });
  };
  let v = null;
  if (!opts.noVideo) v = fakeVideo(win, win.document.querySelector('video'), 600);
  win.eval(code);
  for (let i = 0; i < 100 && !net.asked.length; i++) await wait(50);
  await wait(150);
  const doc = win.document;
  const toasts = () => (doc.querySelector('.ytaf-notification-container') || {}).textContent || '';
  const overlay = () => doc.getElementById('previewbar');
  const marks = () => {
    const o = overlay();
    return o ? Array.prototype.slice.call(o.querySelectorAll('.previewbar')) : [];
  };
  const lefts = () => marks().map((m) => Math.round(parseFloat(m.style.left))).join();
  const rows = () => Array.prototype.map.call(doc.querySelectorAll('.sb-segments-popup .sb-segment-row'),
    (r) => r.querySelector('.sb-segment-time').textContent);
  const labelsCss = () => (doc.getElementById('sb-labels') || {}).textContent || '';
  const playerState = (s) => { win.dispatchEvent(new win.CustomEvent('yt-player-state-change', { detail: { state: s } })); };
  // A new <video> in the player, replacing the one there.
  const newVideo = () => {
    const el = doc.createElement('video');
    const fv = fakeVideo(win, el, 600);
    const box = doc.getElementById('ytlr-player__player-container-player');
    const old = box.querySelector('video');
    if (old) box.removeChild(old);
    box.appendChild(el);
    return Object.assign({ el }, fv);
  };

  let openedAt = 0;
  const openPanel = async () => {
    win.ytaf_showOptionsPanel(true);
    if (!openedAt) openedAt = Date.now();
    await wait(30);
    doc.querySelectorAll('.ytaf-tab-btn')[3].click();
    await wait(30);
  };
  const toggle = async (text) => {
    const labels = doc.querySelectorAll('.ytaf-ui-container label');
    for (let i = 0; i < labels.length; i++) {
      const span = labels[i].querySelector('.label-text');
      if (span && span.textContent === text) {
        const input = labels[i].querySelector('input');
        input.checked = !input.checked;
        input.dispatchEvent(new win.Event('change', { bubbles: true }));
        await wait(50);
        return input.checked;
      }
    }
    throw new Error('no switch "' + text + '" in the panel');
  };
  return { win, doc, errors, net, ...(v || {}), video: v && doc.querySelector('video'), toasts, overlay, marks, lefts,
    rows, labelsCss, playerState, newVideo, refreshes, fireRefresh, openPanel, toggle, sb: () => win.sponsorblock };
}

(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- New segments picked up while the video plays ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)]);
    t(n('refresh: a video with segments is asked about again in 15 minutes'), env.refreshes().join() === '15',
      JSON.stringify(env.refreshes()));
    env.net.segments = [seg('sponsor', 30, 60), seg('sponsor', 300, 330)];
    await env.fireRefresh();
    t(n('...when it comes due the API is asked'), env.net.asked.length === 2, String(env.net.asked.length));
    t(n('...a new segment is announced'), /SponsorBlock: 1 new segment/.test(env.toasts()), env.toasts());
    t(n('...its mark is drawn on the bar'), env.lefts() === '5,50', env.lefts());
    t(n('...and it is listed'), env.rows().join() === '00:30 to 01:00,05:00 to 05:30', env.rows().join());
    await env.playTo(290);
    await env.playTo(300.2);
    t(n('...and skipped when reached'), env.state.time === 330, env.state.seeks.join(','));
    t(n('...the next check again in 15 minutes'), env.refreshes().join() === '15', JSON.stringify(env.refreshes()));

    const bar = env.overlay();
    await env.fireRefresh();
    t(n('the same answer again: nothing redrawn'), env.net.asked.length === 3 && env.overlay() === bar &&
      env.lefts() === '5,50');

    env.net.segments = [seg('sponsor', 300, 330)];
    await env.fireRefresh();
    t(n('a segment taken out of the database: its mark goes'), env.lefts() === '50', env.lefts());
    await env.seekTo(20);
    await env.playTo(30.2);
    t(n('...and it is no longer skipped'), env.state.time === 30.2, env.state.seeks.join(','));
    t(n('refresh: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- The servers failing: the back-off ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)]);
    env.net.status = 500;
    const delays = [];
    for (let i = 0; i < 5; i++) {
      await env.fireRefresh();
      delays.push(env.refreshes().join());
    }
    t(n('both servers failing: asked again after 5, 10, 20, 30, 30 minutes'), delays.join(' ') === '5 10 20 30 30',
      delays.join(' '));
    t(n('...each time the official server, then the mirror'), env.net.asked.length === 11, String(env.net.asked.length));
    t(n('...the segments it had are kept'), env.lefts() === '5', env.lefts());
    env.net.status = 200;
    await env.fireRefresh();
    t(n('the servers back: every 15 minutes again'), env.refreshes().join() === '15', JSON.stringify(env.refreshes()));
  }

  // ---- No segments yet ----
  {
    const env = await boot({}, []);
    t(n('no segments at open: the handler stays for the refresh'), !!env.sb() && !env.sb().isDestroyed);
    t(n('...nothing on the bar, nothing listed'), env.overlay() === null && env.rows().length === 0);
    const delays = [env.refreshes().join()];
    for (let i = 0; i < 4; i++) {
      await env.fireRefresh();
      delays.push(env.refreshes().join());
    }
    t(n('...asked again after 5, 10, 20, 30, 30 minutes while there are none'), delays.join(' ') === '5 10 20 30 30',
      delays.join(' '));
    env.net.segments = [seg('sponsor', 30, 60), seg('intro', 120, 130)];
    await env.fireRefresh();
    t(n('segments submitted meanwhile: announced'), /SponsorBlock: 2 new segments/.test(env.toasts()), env.toasts());
    t(n('...drawn on the bar'), env.lefts() === '5,20', env.lefts());
    await env.playTo(10);
    await env.playTo(30.2);
    t(n('...and skipped'), env.state.time === 60, env.state.seeks.join(','));
    t(n('...then checked every 15 minutes'), env.refreshes().join() === '15', JSON.stringify(env.refreshes()));
  }
  {
    const env = await boot({ sbPeriodicRefresh: false }, []);
    t(n('no segments with the refresh off: the handler goes'), !!env.sb() && env.sb().isDestroyed === true &&
      env.refreshes().length === 0);
  }
  {
    const env = await boot({}, [], { status: 500, fastRetry: true });
    t(n('both servers failing at open: asked three times each, the official one first'), env.net.asked.length === 6 &&
      env.net.asked.every((u, i) => (i % 2 === 0) === (u.indexOf('https://sponsor.ajay.app/') === 0)),
      env.net.asked.join(' '));
    t(n('...then again in 5 minutes'), env.refreshes().join() === '5', JSON.stringify(env.refreshes()));
    env.net.status = 200;
    env.net.segments = [seg('sponsor', 30, 60)];
    await env.fireRefresh();
    t(n('...which finds the segments'), env.lefts() === '5' && /1 new segment/.test(env.toasts()), env.lefts());
  }

  // ---- Paused: nothing fetched until playback goes on ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)]);
    env.video.pause();
    await env.fireRefresh();
    t(n('a refresh due while paused fetches nothing'), env.net.asked.length === 1, String(env.net.asked.length));
    env.net.segments = [seg('sponsor', 30, 60), seg('outro', 500, 600)];
    env.video.play();
    await wait(80);
    t(n('...playback going on fetches it'), env.net.asked.length === 2 && env.lefts() === '5,83', env.lefts());
    t(n('...and the next one is scheduled'), env.refreshes().join() === '15', JSON.stringify(env.refreshes()));
  }

  // ---- Skip Segments Once across a change ----
  {
    const env = await boot({ skipSegmentsOnce: true }, [seg('sponsor', 100, 130)]);
    await env.playTo(90);
    await env.playTo(100.2);
    t(n('skip once: the segment is skipped'), env.state.time === 130);
    env.net.segments = [seg('intro', 20, 40), seg('sponsor', 100, 130)];
    await env.fireRefresh();
    await env.seekTo(90);
    await env.playTo(100.2);
    t(n('...a segment added before it: it still plays the second time'), env.state.time === 100.2, env.state.seeks.join(','));
    await env.seekTo(10);
    await env.playTo(20.2);
    t(n('...and the new one is skipped'), env.state.time === 40, env.state.seeks.join(','));
  }

  // ---- The switch in the panel ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)]);
    await env.openPanel();
    const off = await env.toggle('Periodically Check for New Segments');
    t(n('the refresh switched off mid-video: no check pending'), off === false && env.refreshes().length === 0,
      JSON.stringify(env.refreshes()));
    const on = await env.toggle('Periodically Check for New Segments');
    t(n('...switched on: checked again in 15 minutes'), on === true && env.refreshes().join() === '15',
      JSON.stringify(env.refreshes()));
  }

  // ---- The <video> late, or replaced ----
  {
    const env = await boot({ sbMode_highlight: 'auto_skip' },
      [seg('intro', 0, 20), seg('poi_highlight', 120, 120, 'poi')], { noVideo: true });
    t(n('no <video> yet: the segments are fetched anyway'), env.net.asked.length === 1);
    const v = env.newVideo();
    await wait(100);
    t(n('...the <video> mounting later: the intro from 0:00 skipped on it'), v.state.seeks[0] === 20, v.state.seeks.join(','));
    t(n('...and the highlight jump made'), v.state.time === 120, v.state.seeks.join(','));
  }
  {
    const env = await boot({}, [seg('sponsor', 200, 230)], { noVideo: true });
    const v = env.newVideo();
    await wait(100);
    await v.playTo(190);
    await v.playTo(200.2);
    t(n('a <video> mounting later is skipped on'), v.state.time === 230, v.state.seeks.join(','));
  }
  {
    const env = await boot({ enableMutedSegments: true, sbPeriodicRefresh: false },
      [seg('sponsor', 30, 60), seg('sponsor', 100, 130, 'mute')]);
    const old = env.state;
    await env.playTo(110);
    t(n('replaced <video>: the old one was muted in a mute segment'), old.muted === true);
    const v = env.newVideo();
    env.playerState(1);
    await wait(50);
    t(n('...the old one gets its sound back'), old.muted === false);
    await v.playTo(10);
    await v.playTo(30.2);
    t(n('...the new one is skipped on'), v.state.time === 60, v.state.seeks.join(','));
    old.time = 30.5;
    env.video.dispatchEvent(new env.win.Event('timeupdate'));
    await wait(40);
    t(n('...the old one is left alone'), old.time === 30.5 && old.seeks.length === 0, old.seeks.join(','));
    t(n('replaced <video>: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- Another video ----
  {
    const env = await boot({ enableMutedSegments: true, sbShowTimeWithSkips: true },
      [seg('sponsor', 30, 60), seg('sponsor', 100, 130, 'mute')]);
    env.net.other = [seg('selfpromo', 300, 360)];
    const first = env.sb();
    await env.playTo(110);
    t(n('another video: muted in the first one\'s mute segment'), env.state.muted === true);
    env.win.location.hash = `#/watch?v=${VIDEO_ID}&t=110`;
    await wait(100);
    t(n('the same video under another address keeps its handler'), env.sb() === first && !first.isDestroyed &&
      env.net.asked.length === 1);
    env.win.location.hash = `#/watch?v=${OTHER_ID}`;
    await wait(300);
    t(n('another video: the first handler is gone'), first.isDestroyed === true && env.sb() !== first &&
      env.sb().videoID === OTHER_ID);
    t(n('...its mute undone'), env.state.muted === false);
    t(n('...the bar shows the new video\'s segments only'), env.lefts() === '50' &&
      env.doc.querySelectorAll('#previewbar').length === 1, env.lefts());
    t(n('...so does the list'), env.rows().join() === '05:00 to 06:00', env.rows().join());
    t(n('...and the time with skips'), /\(9:00\)/.test(env.labelsCss()), env.labelsCss());
    await env.playTo(20);
    await env.playTo(30.2);
    t(n('...the first video\'s segment is not skipped'), env.state.time === 30.2, env.state.seeks.join(','));
    await env.playTo(300.2);
    t(n('...the new one\'s is'), env.state.time === 360, env.state.seeks.join(','));
    t(n('another video: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- SponsorBlock switched off in the panel ----
  {
    const env = await boot({ enableMutedSegments: true, sbShowTimeWithSkips: true },
      [seg('sponsor', 30, 60), seg('sponsor', 100, 130, 'mute')]);
    const first = env.sb();
    await env.playTo(110);
    await env.openPanel();
    t(n('switched off: the list was there'), env.rows().length === 2 && env.marks().length === 2);
    t(n('SponsorBlock switched off'), await env.toggle('SponsorBlock') === false);
    t(n('...the handler is gone at once'), first.isDestroyed === true && !env.sb());
    t(n('...the mute it made is undone'), env.state.muted === false);
    t(n('...no marks, no list, no time with skips'), env.overlay() === null && env.rows().length === 0 &&
      env.labelsCss() === '', env.labelsCss());
    t(n('...no refresh pending'), env.refreshes().length === 0, JSON.stringify(env.refreshes()));
    await env.playTo(20);
    await env.playTo(30.2);
    t(n('...nothing skipped'), env.state.time === 30.2 && env.state.seeks.length === 0, env.state.seeks.join(','));
    env.playerState(1);
    env.win.dispatchEvent(new env.win.Event('resize'));
    await wait(50);
    t(n('...the player\'s events after it change nothing'), env.overlay() === null && env.state.seeks.length === 0);
    t(n('SponsorBlock switched on again'), await env.toggle('SponsorBlock') === true);
    await wait(100);
    t(n('...segments fetched and drawn again'), env.net.asked.length === 2 && env.marks().length === 2 &&
      !!env.sb() && env.sb() !== first);
    t(n('switch off and on: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
