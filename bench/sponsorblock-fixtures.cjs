/**
 * What the SponsorBlock tests share: segments in the API's shape, a <video>
 * stand-in whose time the test moves, and the bundle booted on a watch page
 * with the (faked) SponsorBlock API answering, plus the settings panel's
 * SponsorBlock tab.
 *
 *   const { seg, bootSponsorBlock } = require('./sponsorblock-fixtures.cjs');
 *   const env = await bootSponsorBlock({ sbMode_sponsor: 'manual_skip' }, [seg('sponsor', 30, 60)]);
 *   await env.playTo(30.2);
 *
 * Used by sponsorblock-skip-test, -bar-test, -lifecycle-test and -extras-test.
 */
const { readBundle, bootPage, wait } = require('./harness.cjs');
const { fakeIndexedDB } = require('./fake-indexeddb.cjs');

const VIDEO_ID = 'abcdefghijk';
const OTHER_ID = 'zyxwvutsrqp';
const PRIMARY = 'https://sponsor.ajay.app/api/skipSegments/';
const FALLBACK = 'https://sponsorblock.inf.re/api/skipSegments/';

// The seek bar as the TV UI renders it: the multi-markers renderer around
// ytlr-progress-bar around the track. The overlay belongs beside the renderer.
const BAR_MULTI = '<div class="bar-host"><ytlr-multi-markers-player-bar-renderer><ytlr-progress-bar>' +
  '<div idomkey="progress-bar"></div></ytlr-progress-bar></ytlr-multi-markers-player-bar-renderer></div>';
// The older layout: ytlr-progress-bar with its slider, no renderer around it.
const BAR_OLD = '<div class="bar-host"><ytlr-progress-bar><div idomkey="slider"></div></ytlr-progress-bar></div>';

/** A segment as the API sends it; the UUID is unique per category, start and action. */
const seg = (category, start, end, actionType = 'skip') =>
  ({ UUID: `${category}-${start}-${actionType}`, category, actionType, segment: [start, end] });

/**
 * A <video> whose time, play state, duration and readiness the test sets.
 * playTo: playback reaching a time (a 'timeupdate' there); seekTo: a seek, as
 * the remote makes one ('seeking', then 'seeked'); setDuration: a new length.
 */
function fakeVideo(win, video, duration) {
  const state = { time: 0, paused: false, muted: false, seeks: [], ready: 4, duration };
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
    duration: { configurable: true, get: () => state.duration },
    paused: { configurable: true, get: () => state.paused },
    seeking: { configurable: true, get: () => false },
    readyState: { configurable: true, get: () => state.ready },
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
  const setDuration = async (d) => {
    state.duration = d;
    fire('durationchange');
    await wait(20);
  };
  return { state, playTo, seekTo, setDuration };
}

/**
 * The bundle (the command line's, or opts.code) on a watch page of VIDEO_ID.
 * The API answers net.segments for it (and net.other for OTHER_ID); each
 * server answers net.primary / net.fallback, or net.status, or 200.
 *
 * opts:
 *   bar          markup beside the player ('' by default; BAR_MULTI, BAR_OLD)
 *   noVideo      no <video> in the player yet
 *   duration     the video's length (600 s)
 *   startAt      where the video is at the start
 *   readyState   the <video>'s readyState (4)
 *   author       the player gets getVideoData(), with this channel name; read
 *                on each call, so a test can change it on `opts`
 *   videoId      the video getVideoData() reports (VIDEO_ID); read on each call
 *   copy         localStorage empty: the settings come from this IndexedDB copy
 *   idb          the fake IndexedDB's options, with `copy`
 *   storage      localStorage entries at the start
 *   holdClock    the page's Date.now stands still
 *   clock        { now }: the page's Date.now, moved by the test
 *   api          { primary, fallback }: each server's status
 *   status       both servers' status
 *   beforeEval   (win) => void, just before the bundle runs (timer hooks)
 *   consoleErrors  false: a console.error is not a page error (true)
 *
 * Resolves once the handler asked for the segments and applied the answer.
 */
// The bundle, read once for every boot of a test file.
let bundle = null;
async function bootSponsorBlock(cfg, segments, opts = {}) {
  const bar = opts.bar || '';
  const { win, doc, errors, evaluate } = bootPage({
    code: opts.code || bundle || (bundle = readBundle()),
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    inner: `\n    <div id="ytlr-player__player-container-player">${opts.noVideo ? '' : '<video></video>'}</div>${bar}`,
    url: `https://www.youtube.com/tv#/watch?v=${VIDEO_ID}`,
    ignoreNavigation: true,
    consoleErrors: opts.consoleErrors !== false,
    config: opts.copy ? undefined : Object.assign({
      enableAdBlock: false, enableSponsorBlock: true, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, sbPeriodicRefresh: false
    }, cfg),
    evaluate: false,
    storage: opts.storage
  });
  const api = opts.api || {};
  const net = {
    segments, other: [], asked: [], reported: [],
    status: opts.status || 200, primary: api.primary, fallback: api.fallback
  };
  win.fetch = (resource, init) => {
    const url = String(resource && resource.url || resource);
    if (url.indexOf('/viewedVideoSponsorTime') !== -1) {
      net.reported.push((init && init.method) + ' ' + url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    if (url.indexOf('/skipSegments/') === -1) return new Promise(() => {});
    net.asked.push(url);
    const status = (url.indexOf(PRIMARY) === 0 ? net.primary : net.fallback) || net.status;
    const body = [{ videoID: VIDEO_ID, segments: JSON.parse(JSON.stringify(net.segments)) },
      { videoID: OTHER_ID, segments: JSON.parse(JSON.stringify(net.other)) }];
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
  };
  const player = doc.getElementById('ytlr-player__player-container-player');
  // Only with a channel to give: a player with getVideoData() is read by
  // other parts of the app too.
  if ('author' in opts) {
    player.getVideoData = () => ({ video_id: 'videoId' in opts ? opts.videoId : VIDEO_ID, author: opts.author });
  }
  let v = null;
  if (!opts.noVideo) {
    v = fakeVideo(win, doc.querySelector('video'), 'duration' in opts ? opts.duration : 600);
    if (opts.startAt) v.state.time = opts.startAt;
    if (opts.readyState !== undefined) v.state.ready = opts.readyState;
  }
  if (opts.holdClock) {
    const held = win.Date.now();
    win.Date.now = () => held;
  }
  if (opts.clock) {
    opts.clock.now = win.Date.now();
    win.Date.now = () => opts.clock.now;
  }
  if (opts.copy) win.indexedDB = fakeIndexedDB(opts.copy, [], opts.idb || {});
  if (opts.beforeEval) opts.beforeEval(win);
  evaluate();
  // The handler starts a moment after the page (about 0.8 s): wait for its
  // request, then for the answer to be applied.
  for (let i = 0; i < 100 && !net.asked.length; i++) await wait(50);
  await wait(150);

  const toasts = () => (doc.querySelector('.ytaf-notification-container') || {}).textContent || '';
  const overlay = () => doc.getElementById('previewbar');
  const marks = () => {
    const o = overlay();
    return o ? Array.prototype.slice.call(o.querySelectorAll('.previewbar')) : [];
  };
  const labelsCss = () => (doc.getElementById('sb-labels') || {}).textContent || '';
  const playerState = (s) => { win.dispatchEvent(new win.CustomEvent('yt-player-state-change', { detail: { state: s } })); };
  // A new <video> in the player, replacing the one there.
  const newVideo = () => {
    const el = doc.createElement('video');
    const fv = fakeVideo(win, el, 600);
    const old = player.querySelector('video');
    if (old) player.removeChild(old);
    player.appendChild(el);
    return Object.assign({ el }, fv);
  };

  // The settings panel, on its SponsorBlock tab. The panel ignores a toggle
  // in its first 500 ms, so closePanel waits that out.
  let openedAt = 0;
  const openPanel = async () => {
    win.ytaf_showOptionsPanel(true);
    if (!openedAt) openedAt = Date.now();
    await wait(30);
    doc.querySelectorAll('.ytaf-tab-btn')[3].click();
    await wait(30);
  };
  const closePanel = async () => {
    await wait(Math.max(0, openedAt + 600 - Date.now()));
    win.ytaf_showOptionsPanel(false);
    await wait(30);
  };
  const row = (text) => {
    const all = doc.querySelectorAll('.ytaf-ui-container .shortcut-control-row');
    for (let i = 0; i < all.length; i++) {
      if ((all[i].querySelector('.shortcut-label') || {}).textContent === text) return all[i];
    }
    throw new Error('no control "' + text + '" in the panel');
  };
  /** One step of a cycle control: the row clicked (next), or its '<' (back). */
  const cycle = async (text, back = false) => {
    const r = row(text);
    (back ? r.querySelector('.arrow-btn') : r).click();
    await wait(30);
    return r.querySelector('.current-value').textContent;
  };
  /** A switch of the panel flipped; resolves to its new state. */
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

  return {
    win, doc, errors, net, asked: net.asked, reported: net.reported, player,
    ...(v || {}), video: v ? doc.querySelector('video') : null,
    toasts, overlay, marks, labelsCss, playerState, newVideo,
    openPanel, closePanel, row, cycle, toggle,
    sb: () => win.sponsorblock
  };
}

module.exports = { VIDEO_ID, OTHER_ID, PRIMARY, FALLBACK, BAR_MULTI, BAR_OLD, seg, fakeVideo, bootSponsorBlock };
