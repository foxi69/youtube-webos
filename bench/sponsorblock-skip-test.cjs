/**
 * SponsorBlock's core, end to end in the bundle: segments from the (faked)
 * API, picked by the settings, and what playback does at each one. Until this
 * test nothing ran the skip itself (handleTimeUpdate, the start chain, the
 * manual skip, muting, the highlight, "skip to previous").
 *
 *   node bench/sponsorblock-skip-test.cjs <bundle> [legacy|modern]
 *
 * The <video> is a stand-in whose time the test moves: a 'timeupdate' after
 * each move, 'seeking'/'seeked' after each seek the bundle makes.
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
const PRIMARY = 'https://sponsor.ajay.app/api/skipSegments/';
const FALLBACK = 'https://sponsorblock.inf.re/api/skipSegments/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

const seg = (category, start, end, actionType = 'skip') =>
  ({ UUID: `${category}-${start}`, category, actionType, segment: [start, end] });

// A <video> whose time, play state and duration the test sets.
function fakeVideo(win, video, duration) {
  const state = { time: 0, paused: false, muted: false, seeks: [], ready: 4 };
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
    readyState: { configurable: true, get: () => state.ready },
    muted: { configurable: true, get: () => state.muted, set: (v) => { state.muted = !!v; } },
    play: { configurable: true, value: () => { state.paused = false; fire('playing'); return Promise.resolve(); } },
    pause: { configurable: true, value: () => { state.paused = true; fire('pause'); } }
  });
  // Playback reaching `time`: a timeupdate there, as the element sends.
  const playTo = async (time) => {
    state.time = time;
    fire('timeupdate');
    await wait(40);   // the rAF loop, the toast, a seek's 'seeked'
  };
  return { state, playTo };
}

/**
 * The bundle on a watch page with `segments` from the API. `api` decides what
 * each server answers: { primary: status, fallback: status } (200 by default).
 */
async function boot(cfg, segments, opts = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(`<!doctype html><html><body class="WEB_PAGE_TYPE_WATCH"><ytlr-app>
    <div id="ytlr-player__player-container-player"><video></video></div></ytlr-app></body></html>`,
  { runScripts: 'outside-only', url: `https://www.youtube.com/tv#/watch?v=${VIDEO_ID}`, virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, modern ? UA.webos23 : UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: true, enableReturnYouTubeDislike: false,
    enableDeArrow: false, upgradeThumbnails: false, enableAutoLogin: false,
    checkForUpdates: false, showWhatsNew: false, sbPeriodicRefresh: false
  }, cfg)));
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  // Chrome 23 has it; the Chrome 38 environment takes it away all the same
  // (as in upstream-fixes-test).
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  const asked = [];
  const api = opts.api || {};
  win.fetch = (resource) => {
    const url = String(resource && resource.url || resource);
    if (url.indexOf('/skipSegments/') === -1) return new Promise(() => {});
    asked.push(url);
    const status = url.indexOf(PRIMARY) === 0 ? (api.primary || 200) : (api.fallback || 200);
    const body = [{ videoID: VIDEO_ID, segments: JSON.parse(JSON.stringify(segments)) }];
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
  };
  const video = win.document.querySelector('video');
  const v = fakeVideo(win, video, opts.duration || 600);
  if (opts.startAt) v.state.time = opts.startAt;
  if (opts.readyState !== undefined) v.state.ready = opts.readyState;
  // opts.holdClock: the page's Date.now stands still, so a window the bundle
  // times with it (the highlight's 4 s) cannot run out on a slow machine.
  if (opts.holdClock) {
    const held = win.Date.now();
    win.Date.now = () => held;
  }
  win.eval(code);
  // The handler starts a moment after the page (about 0.8 s): wait for its
  // request, then for the answer to be applied.
  for (let i = 0; i < 100 && !asked.length; i++) await wait(50);
  await wait(150);
  const toasts = () => (win.document.querySelector('.ytaf-notification-container') || {}).textContent || '';
  return { win, errors, asked, video, ...v, toasts, sb: () => win.sponsorblock };
}

(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- Auto skip ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)]);
    t(n('the handler fetched this video\'s segments'), env.sb() && env.sb().videoID === VIDEO_ID &&
      env.asked.length === 1 && env.asked[0].indexOf(PRIMARY) === 0, env.asked.join(' '));
    await env.playTo(10);
    t(n('before the segment nothing is skipped'), env.state.time === 10 && env.state.seeks.length === 0);
    await env.playTo(30.2);
    t(n('a sponsor segment is skipped to its end'), env.state.time === 60, String(env.state.time));
    t(n('...with a toast naming it'), /Skipped sponsored segment/i.test(env.toasts()), env.toasts());
    await env.playTo(61);
    t(n('...and playback goes on after it'), env.state.time === 61 && env.state.seeks.length === 1, env.state.seeks.join(','));
    t(n('auto skip: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- Segments back to back are skipped in one jump ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60), seg('selfpromo', 60.1, 90)]);
    await env.playTo(10);
    await env.playTo(30.2);
    t(n('two segments back to back: one jump past both'), env.state.time === 90 && env.state.seeks.length === 1,
      env.state.seeks.join(','));
    t(n('...and the toast names both'), / and /.test(env.toasts()), env.toasts());
  }

  // ---- The start chain: segments from 0:00 skipped as the video opens ----
  {
    const env = await boot({}, [seg('intro', 0, 15), seg('sponsor', 15.1, 40)]);
    t(n('segments from 0:00 on: skipped at once to the end of the chain'), env.state.time === 40,
      env.state.seeks.join(','));
  }

  // ---- The start chain when the segments come before the video's metadata (common on a TV) ----
  {
    const env = await boot({}, [seg('intro', 0, 15), seg('sponsor', 15.1, 40)], { readyState: 0 });
    t(n('segments before the metadata: no jump yet'), env.state.time === 0 && env.state.seeks.length === 0,
      env.state.seeks.join(','));
    env.state.ready = 1;
    env.video.dispatchEvent(new env.win.Event('loadedmetadata'));
    await wait(40);
    t(n('...the chain is skipped once the metadata is in'), env.state.time === 40 && env.state.seeks.length === 1,
      env.state.seeks.join(','));
  }

  // ---- Close to a segment: the skip comes at its start, not with the next timeupdate ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)]);
    await env.playTo(10);
    await env.playTo(29.5);
    t(n('half a second before a segment: nothing skipped yet'), env.state.time === 29.5 && env.state.seeks.length === 0);
    // Playback crosses the start between two timeupdates (they come about every 250 ms).
    env.state.time = 30.05;
    await wait(100);
    t(n('...crossing its start skips it without waiting for a timeupdate'), env.state.time === 60,
      String(env.state.time));
  }

  // ---- What each category's setting does ----
  {
    const env = await boot({ sbMode_sponsor: 'disable' }, [seg('sponsor', 30, 60)]);
    await env.playTo(10);
    await env.playTo(30.2);
    t(n('a disabled category is not skipped'), env.state.time === 30.2 && env.state.seeks.length === 0);
  }
  {
    const env = await boot({ sbMode_sponsor: 'seek_bar' }, [seg('sponsor', 30, 60)]);
    await env.playTo(10);
    await env.playTo(30.2);
    t(n('a category shown on the bar only is not skipped'), env.state.time === 30.2 && env.state.seeks.length === 0);
  }
  {
    const env = await boot({ sbMode_sponsor: 'manual_skip' }, [seg('sponsor', 30, 60)]);
    await env.playTo(10);
    await env.playTo(30.2);
    t(n('manual skip: playback stays in the segment'), env.state.time === 30.2 && env.state.seeks.length === 0);
    t(n('...and a toast offers the blue key'), /Sponsored: Press Blue to skip/.test(env.toasts()), env.toasts());
    const handled = env.sb().handleBlueButton();
    await wait(40);
    t(n('...which skips it to its end'), handled === true && env.state.time === 60, String(env.state.time));
  }

  // ---- Mute segments ----
  {
    const env = await boot({ enableMutedSegments: true }, [seg('sponsor', 30, 60, 'mute')]);
    await env.playTo(10);
    await env.playTo(35);
    t(n('a mute segment mutes, and is not skipped'), env.state.muted === true && env.state.time === 35);
    t(n('...with a toast'), /Muted Sponsored segment/.test(env.toasts()), env.toasts());
    await env.playTo(61);
    t(n('...and the sound comes back after it'), env.state.muted === false);
  }
  {
    const env = await boot({ enableMutedSegments: false }, [seg('sponsor', 30, 60, 'mute')]);
    await env.playTo(10);
    await env.playTo(35);
    t(n('with "Allow segments that mute audio" off a mute segment does nothing'),
      env.state.muted === false && env.state.time === 35 && env.state.seeks.length === 0);
  }
  {
    const env = await boot({ enableMutedSegments: true }, [seg('sponsor', 30, 60, 'mute')]);
    env.state.muted = true;   // the viewer's own mute
    await env.playTo(35);
    await env.playTo(61);
    t(n('the viewer\'s own mute stays after a mute segment'), env.state.muted === true);
  }

  // ---- Skip Segments Once ----
  for (const once of [true, false]) {
    const env = await boot({ skipSegmentsOnce: once }, [seg('sponsor', 30, 60)]);
    await env.playTo(10);
    await env.playTo(30.2);
    env.video.currentTime = 20;   // the viewer goes back
    await wait(40);
    await env.playTo(30.2);
    t(n(`Skip Segments Once ${once ? 'on: the second time it plays' : 'off: skipped again'}`),
      once ? env.state.time === 30.2 : env.state.time === 60, env.state.seeks.join(','));
  }

  // ---- Skip to previous segment: that segment then plays ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)]);
    await env.playTo(10);
    await env.playTo(30.2);
    await env.playTo(70);
    const ok = env.sb().skipToPreviousSegment();
    await wait(40);
    t(n('skip to previous: back to the segment\'s start'), ok === true && env.state.time === 30, String(env.state.time));
    await env.playTo(31);
    t(n('...and that segment then plays'), env.state.time === 31, env.state.seeks.join(','));
  }

  // ---- The highlight ----
  {
    const env = await boot({ sbMode_highlight: 'auto_skip' }, [seg('poi_highlight', 120, 120, 'poi')]);
    t(n('highlight on Auto Skip to Start: the video opens at it'), env.state.time === 120, env.state.seeks.join(','));
    t(n('...with a toast'), /Jumped to Highlight/.test(env.toasts()), env.toasts());
  }
  {
    // YouTube's resume seek undoing the jump, a moment after it: jumped again.
    const env = await boot({ sbMode_highlight: 'auto_skip' }, [seg('poi_highlight', 120, 120, 'poi')]);
    env.video.currentTime = 45;
    await wait(40);
    t(n('highlight: a seek away right after the jump (YouTube resuming) is undone'), env.state.time === 120,
      env.state.seeks.join(','));
  }
  {
    // A segment that starts right after the highlight: its skip is
    // SponsorBlock's own, not one to undo.
    const env = await boot({ sbMode_highlight: 'auto_skip' }, [seg('poi_highlight', 120, 120, 'poi'), seg('sponsor', 122, 140)],
      { holdClock: true });
    await env.playTo(122.2);
    await wait(40);
    t(n('highlight, then a segment right after it: skipped, and not jumped back'), env.state.time === 140 &&
      env.state.seeks.join() === '120,140', env.state.seeks.join(','));
    await env.playTo(141);
    t(n('...and playback goes on after it'), env.state.time === 141 && env.state.seeks.join() === '120,140',
      env.state.seeks.join(','));
  }
  for (const once of [true, false]) {
    // The highlight at the start of a segment: the highlight's own 'seeked'
    // skips the segment; the skip's 'seeked' must not jump back to the highlight.
    const env = await boot({ sbMode_highlight: 'auto_skip', skipSegmentsOnce: once },
      [seg('poi_highlight', 120, 120, 'poi'), seg('sponsor', 120, 140)], { holdClock: true });
    await wait(60);
    t(n(`highlight at a segment's start (Skip Segments Once ${once ? 'on' : 'off'}): skipped, not jumped back`),
      env.state.time === 140 && env.state.seeks.join() === '120,140', env.state.seeks.join(','));
  }
  {
    const env = await boot({ sbMode_highlight: 'ask' }, [seg('poi_highlight', 120, 120, 'poi')]);
    t(n('highlight on Ask: offered, not jumped to'), env.state.time === 0 && /Highlight available/.test(env.toasts()),
      env.toasts());
    const ok = env.sb().handleBlueButton();
    await wait(40);
    t(n('...the blue key jumps to it'), ok === true && env.state.time === 120, String(env.state.time));
  }

  // ---- The fallback server ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)], { api: { primary: 500 } });
    t(n('the official server failing: the mirror is asked'), env.asked.length === 2 &&
      env.asked[0].indexOf(PRIMARY) === 0 && env.asked[1].indexOf(FALLBACK) === 0, env.asked.join(' '));
    await env.playTo(10);
    await env.playTo(30.2);
    t(n('...and its segments are skipped'), env.state.time === 60, String(env.state.time));
  }
  {
    const env = await boot({}, [seg('sponsor', 30, 60)], { api: { primary: 404 } });
    t(n('a 404 is an answer (no segments): the mirror is not asked'), env.asked.length === 1, env.asked.join(' '));
    // The stand-in's 404 carries a segment in its body all the same: it must not be read.
    await env.playTo(10);
    await env.playTo(30.2);
    t(n('...and nothing is skipped from a 404\'s body'), env.state.time === 30.2 && env.state.seeks.length === 0,
      `${env.state.time} ${env.state.seeks.join()}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
