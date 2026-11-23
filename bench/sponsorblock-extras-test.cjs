/**
 * SponsorBlock's extras: Ignore Segments Shorter Than, Never Skip on These
 * Channels (and its shortcut action), the undo of an auto skip with Blue, the
 * time saved, and Count My Skips on SponsorBlock.
 *
 *   node bench/sponsorblock-extras-test.cjs <bundle> [legacy|modern]
 *
 * The harness is sponsorblock-skip-test's, with the player's channel name.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, trustedKey, wait, until } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();

const VIDEO_ID = 'abcdefghijk';
const PRIMARY = 'https://sponsor.ajay.app/api/skipSegments/';

const { t, run } = createReporter();

const seg = (category, start, end, actionType = 'skip') =>
  ({ UUID: `${category}-${start}`, category, actionType, segment: [start, end] });

// A <video> whose time, play state and duration the test sets; state.dropSeeked:
// that many next seeks send no 'seeked' (lost, as on the TV).
function fakeVideo(win, video, duration) {
  const state = { time: 0, paused: false, muted: false, seeks: [], ready: 4, dropSeeked: 0 };
  const fire = (type) => video.dispatchEvent(new win.Event(type));
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => state.time,
      set: (v) => {
        state.time = v;
        state.seeks.push(v);
        fire('seeking');
        if (state.dropSeeked > 0) state.dropSeeked--;
        else setTimeout(() => fire('seeked'), 5);
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
  const { win, errors, evaluate } = bootPage({
    code,
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    inner: '\n    <div id="ytlr-player__player-container-player"><video></video></div>',
    url: `https://www.youtube.com/tv#/watch?v=${VIDEO_ID}`,
    ignoreNavigation: true,
    consoleErrors: false,
    // opts.copy: localStorage empty, the settings come from this copy in IndexedDB.
    config: opts.copy ? undefined : Object.assign({
      enableAdBlock: false, enableSponsorBlock: true, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, sbPeriodicRefresh: false
    }, cfg),
    evaluate: false,
    storage: opts.storage
  });
  const asked = [];
  const reported = [];
  const api = opts.api || {};
  win.fetch = (resource, init) => {
    const url = String(resource && resource.url || resource);
    if (url.indexOf('/viewedVideoSponsorTime') !== -1) {
      reported.push((init && init.method) + ' ' + url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    if (url.indexOf('/skipSegments/') === -1) return new Promise(() => {});
    asked.push(url);
    const status = url.indexOf(PRIMARY) === 0 ? (api.primary || 200) : (api.fallback || 200);
    const body = [{ videoID: VIDEO_ID, segments: JSON.parse(JSON.stringify(segments)) }];
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
  };
  const player = win.document.getElementById('ytlr-player__player-container-player');
  // opts.videoId: the video the player reports (the one before, say), undefined for none.
  player.getVideoData = () => ({
    video_id: 'videoId' in opts ? opts.videoId : VIDEO_ID,
    author: 'author' in opts ? opts.author : 'Some Channel'
  });
  const video = win.document.querySelector('video');
  const v = fakeVideo(win, video, 'duration' in opts ? opts.duration : 600);
  if (opts.startAt) v.state.time = opts.startAt;
  if (opts.readyState !== undefined) v.state.ready = opts.readyState;
  // opts.holdClock: the page's Date.now stands still, so a window the bundle
  // times with it (the highlight's 4 s) cannot run out on a slow machine.
  if (opts.holdClock) {
    const held = win.Date.now();
    win.Date.now = () => held;
  }
  // opts.clock: the page's Date.now is { now }, moved by the test.
  if (opts.clock) {
    opts.clock.now = win.Date.now();
    win.Date.now = () => opts.clock.now;
  }
  if (opts.copy) win.indexedDB = fakeIndexedDB(opts.copy, [], opts.idb || {});
  // opts.refuse: keys localStorage refuses to store (quota); opts.refused counts the refusals.
  // Refused by setItem and by assignment alike (the app writes both ways), as
  // settings-backup-test's stand-in does.
  if (opts.refuse) {
    const real = win.localStorage;
    const refuse = (key) => {
      if (opts.refuse.indexOf(key) !== -1) { opts.refused = (opts.refused || 0) + 1; throw new Error('QuotaExceededError'); }
    };
    const proxy = new Proxy(real, {
      get(target, prop) {
        if (prop === 'setItem') return (key, value) => { refuse(key); target.setItem(key, value); };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) { refuse(prop); target.setItem(prop, String(value)); return true; }
    });
    Object.defineProperty(win, 'localStorage', { configurable: true, get: () => proxy });
  }
  // opts.beforeEvaluate(win): set up the page (hold a timer, say) before the bundle runs.
  if (opts.beforeEvaluate) opts.beforeEvaluate(win);
  evaluate();
  // The handler starts a moment after the page (about 0.8 s): wait for its
  // request, then for the answer to be applied.
  for (let i = 0; i < 100 && !asked.length; i++) await wait(50);
  await wait(150);
  const toasts = () => (win.document.querySelector('.ytaf-notification-container') || {}).textContent || '';
  return { win, errors, asked, reported, video, ...v, toasts, sb: () => win.sponsorblock };
}


const { fakeIndexedDB, savedCopy, hashString } = require('./fake-indexeddb.cjs');
const stored = (win) => JSON.parse(win.localStorage.getItem('ytaf-configuration') || '{}');
const BLUE = 406;
const press = async (win, code) => {
  trustedKey(win, code, win.document.body, 'keydown');
  trustedKey(win, code, win.document.body, 'keyup');
  await wait(200);
};

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- Ignore Segments Shorter Than ----
  {
    const env = await boot({ sbMinSegmentLength: '5' }, [seg('sponsor', 30, 33), seg('selfpromo', 100, 120)]);
    await env.playTo(30.2);
    t(n('min length: a 3 s segment is not skipped'), env.state.time === 30.2 && env.state.seeks.length === 0, String(env.state.time));
    await env.playTo(100.2);
    t(n('min length: a 20 s one still is'), env.state.time === 120, String(env.state.time));
    t(n('min length: no page error'), env.errors.length === 0, env.errors[0]);
  }
  {
    // Not skipped, but marked on the bar: the backward shortcut still goes to it.
    const env = await boot({ sbMinSegmentLength: '5' }, [seg('sponsor', 30, 33)]);
    await env.playTo(70);
    const ok = env.sb().skipToPreviousSegment();
    await wait(40);
    t(n('min length: the backward shortcut goes back to a 3 s segment'), ok === true && env.state.time === 30, String(env.state.time));
  }
  {
    const env = await boot({ sbMinSegmentLength: '5', enableMutedSegments: true },
      [seg('sponsor', 30, 33, 'mute'), seg('selfpromo', 100, 120, 'mute')]);
    await env.playTo(30.2);
    t(n('min length: a 3 s muted segment is not muted'), env.state.muted === false && env.state.seeks.length === 0,
      `${env.state.muted} ${env.state.seeks.join()}`);
    await env.playTo(100.2);
    t(n('min length: a 20 s one still is'), env.state.muted === true && env.state.time === 100.2,
      `${env.state.muted} ${env.state.time}`);
  }

  {
    // At the boundary: 3.2 to 8.2 is 5 s (8.2 - 3.2 is 4.999999999999999 in
    // JavaScript) and is skipped; 13.2 to 18.1 is shorter and plays.
    const env = await boot({ sbMinSegmentLength: '5' }, [seg('sponsor', 3.2, 8.2), seg('selfpromo', 13.2, 18.1)]);
    await env.playTo(3.4);
    t(n('min length: a segment of exactly the minimum, in fractions, is skipped'), env.state.time === 8.2, String(env.state.time));
    await env.playTo(13.4);
    t(n('min length: one a tenth shorter plays'), env.state.time === 13.4, String(env.state.time));
  }
  {
    const env = await boot({ sbMinSegmentLength: '5', enableMutedSegments: true }, [seg('sponsor', 3.2, 8.2, 'mute')]);
    await env.playTo(3.4);
    t(n('min length: a muted segment of exactly the minimum, in fractions, is muted'), env.state.muted === true, String(env.state.muted));
  }

  // ---- Never Skip on These Channels ----
  {
    const env = await boot({ sbWhitelistChannels: ['some channel'] }, [seg('sponsor', 30, 60)]);
    await env.playTo(30.2);
    t(n('whitelist: nothing is skipped on a listed channel (no case)'), env.state.time === 30.2 && env.state.seeks.length === 0);
    await env.playTo(70);
    const ok = env.sb().skipToPreviousSegment();
    await wait(40);
    t(n('whitelist: the backward shortcut still goes to a segment marked on the bar'), ok === true && env.state.time === 30,
      String(env.state.time));
  }
  {
    const env = await boot({ sbWhitelistChannels: ['Other Channel'] }, [seg('sponsor', 30, 60)]);
    await env.playTo(30.2);
    t(n('whitelist: another channel is skipped as before'), env.state.time === 60, String(env.state.time));
  }
  {
    const env = await boot({ shortcut_key_8: 'sb_whitelist_channel' }, [seg('sponsor', 30, 60)]);
    await press(env.win, 56);
    t(n('whitelist action: the channel playing goes on the list'),
      JSON.stringify(stored(env.win).sbWhitelistChannels) === '["Some Channel"]', JSON.stringify(stored(env.win).sbWhitelistChannels));
    await env.playTo(30.2);
    t(n('whitelist action: ...and its segment is not skipped'), env.state.time === 30.2, String(env.state.time));
    await press(env.win, 56);
    t(n('whitelist action: pressed again, it comes off'), JSON.stringify(stored(env.win).sbWhitelistChannels) === '[]');
  }
  {
    // The player still reports the video before: the action waits for this one.
    const opts = { videoId: 'zzzzzzzzzzz', author: 'Old Channel' };
    const env = await boot({ shortcut_key_8: 'sb_whitelist_channel' }, [seg('sponsor', 30, 60)], opts);
    await press(env.win, 56);
    t(n('whitelist action, the video before reported: its channel is not added'),
      JSON.stringify(stored(env.win).sbWhitelistChannels || []) === '[]' && /not known yet/.test(env.toasts()),
      `${JSON.stringify(stored(env.win).sbWhitelistChannels)} ${env.toasts()}`);
    opts.videoId = VIDEO_ID;
    opts.author = 'New Channel';
    await press(env.win, 56);
    t(n('whitelist action: once this video is reported, its channel is added'),
      JSON.stringify(stored(env.win).sbWhitelistChannels) === '["New Channel"]', JSON.stringify(stored(env.win).sbWhitelistChannels));
  }
  {
    // No video in the address (a Short without v=): the player's channel,
    // perhaps still the video before's, is not added.
    const env = await boot({ shortcut_key_8: 'sb_whitelist_channel' }, [seg('sponsor', 30, 60)]);
    env.win.location.hash = '#/shorts';
    await wait(50);
    await press(env.win, 56);
    // ...and no "try again": with no video to check by, it would not help.
    t(n('whitelist action, no video in the address: no channel is added, and none to add is said'),
      JSON.stringify(stored(env.win).sbWhitelistChannels || []) === '[]' && /No channel to add/.test(env.toasts()) &&
      !/not known yet/.test(env.toasts()),
      `${JSON.stringify(stored(env.win).sbWhitelistChannels)} ${env.toasts()}`);
  }
  {
    // webOS 25: the player has no author, the title tray names the channel.
    const tray = '<ytlr-video-title-tray><ytlr-video-metadata-line><yt-formatted-string>Tray Channel' +
      '</yt-formatted-string></ytlr-video-metadata-line></ytlr-video-title-tray>';
    const env = await boot({ shortcut_key_8: 'sb_whitelist_channel' }, [seg('sponsor', 30, 60)], { author: '' });
    env.win.document.body.insertAdjacentHTML('beforeend', tray);
    await press(env.win, 56);
    t(n('whitelist action, no author: the title tray names the channel'),
      JSON.stringify(stored(env.win).sbWhitelistChannels) === '["Tray Channel"]', JSON.stringify(stored(env.win).sbWhitelistChannels));
    // The tray has no video identity: with the player on another video it is not read.
    const other = await boot({ shortcut_key_8: 'sb_whitelist_channel' }, [seg('sponsor', 30, 60)], { author: '', videoId: 'zzzzzzzzzzz' });
    other.win.document.body.insertAdjacentHTML('beforeend', tray);
    await press(other.win, 56);
    t(n('whitelist action, no author, the video before reported: the tray is not taken for this one'),
      JSON.stringify(stored(other.win).sbWhitelistChannels || []) === '[]', JSON.stringify(stored(other.win).sbWhitelistChannels));
  }

  // ---- Undo with Blue, the time saved ----
  // The page's clock stands still unless moved: the 8 s window cannot run out on a slow machine.
  {
    const clock = {};
    // Earlier runs saved 100 s in 4 skips: this one's is added to them.
    const env = await boot({ sbTimeSaved: 100, sbSkipCount: 4 }, [seg('sponsor', 30, 60)], { clock });
    await env.playTo(30.2);
    t(n('undo: the segment was skipped'), env.state.time === 60);
    await wait(300);
    t(n('stats: the time saved is added to the total so far'),
      stored(env.win).sbTimeSaved === 100 + (60 - 30.2) && stored(env.win).sbSkipCount === 5,
      JSON.stringify([stored(env.win).sbTimeSaved, stored(env.win).sbSkipCount]));
    await press(env.win, BLUE);
    t(n('undo: Blue just after goes back to where the skip started'), Math.abs(env.state.time - 30.2) < 0.01, String(env.state.time));
    await env.playTo(31);
    t(n('undo: ...and the segment plays'), env.state.time === 31, String(env.state.time));
    t(n('undo: "Skip undone" is shown'), env.toasts().indexOf('Skip undone') !== -1, env.toasts());
    await wait(300);
    t(n('stats: the undone skip is taken off again, the earlier ones stay'),
      Math.abs(stored(env.win).sbTimeSaved - 100) < 1e-9 && stored(env.win).sbSkipCount === 4,
      JSON.stringify([stored(env.win).sbTimeSaved, stored(env.win).sbSkipCount]));
    t(n('report off: nothing is sent'), env.reported.length === 0, env.reported.join());
  }
  for (const [label, seekAway, swallowed] of [
    ['undo after a seek', 70, false],
    ['undo after a seek close by', 61, false],
    ['undo after a seek, the skip’s own seeked lost', 70, true],
    ['undo after playing on', null, false]
  ]) {
    // Skipped from 30.2 to 60, five seconds on: a seek of the viewer's ends the
    // undo, though each target is within what playing could have reached.
    const clock = {};
    const env = await boot({ sbTimeSaved: 100, sbSkipCount: 4 }, [seg('sponsor', 30, 60)], { clock });
    // The skip's own seek sends no 'seeked': the undo is armed all the same,
    // not landed.
    if (swallowed) env.state.dropSeeked = 1;
    await env.playTo(30.2);
    t(n(label + ': precondition: the segment was skipped'), env.state.time === 60, String(env.state.time));
    await wait(30);
    t(n(label + ': precondition: the skip can be undone'), !!env.sb().lastAutoSkip && !!env.sb().lastAutoSkip.landed === !swallowed,
      JSON.stringify(env.sb().lastAutoSkip));
    clock.now += 5000;
    if (seekAway) {
      env.video.currentTime = seekAway;
      await wait(30);
    } else {
      await env.playTo(70);
    }
    await press(env.win, BLUE);
    if (seekAway) {
      t(n(label + ': Blue stays where the viewer went'), env.state.time === seekAway, String(env.state.time));
      t(n(label + ': "Skip undone" is not shown'), env.toasts().indexOf('Skip undone') === -1, env.toasts());
    } else {
      t(n(label + ': Blue still goes back'), Math.abs(env.state.time - 30.2) < 0.01, String(env.state.time));
    }
  }
  {
    // localStorage emptied: a skip before the copy of the settings is read
    // adds to the copy's totals, and its undo after the read takes it off them.
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const copy = savedCopy([['ytaf-configuration', JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4, foxThemeApplied: true })]]);
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock, copy, idb: { gate } });
    await env.playTo(30.2);
    t(n('stats before the read: precondition: the segment was skipped'), env.state.time === 60, String(env.state.time));
    release();
    await wait(400);
    t(n('stats before the read: the skip is added to the restored totals'),
      Math.abs(stored(env.win).sbTimeSaved - (100 + 60 - 30.2)) < 1e-9 && stored(env.win).sbSkipCount === 5,
      JSON.stringify([stored(env.win).sbTimeSaved, stored(env.win).sbSkipCount]));
    await press(env.win, BLUE);
    await wait(300);
    t(n('stats before the read: its undo after the read leaves the restored totals'),
      Math.abs(stored(env.win).sbTimeSaved - 100) < 1e-9 && stored(env.win).sbSkipCount === 4,
      JSON.stringify([stored(env.win).sbTimeSaved, stored(env.win).sbSkipCount]));
  }
  {
    // A skip before the read, and localStorage refusing the shared record: the
    // skip stays in the journal, and the next start adds it to the copy's totals.
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const copy = savedCopy([['ytaf-configuration', JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4, foxThemeApplied: true })]]);
    const opts = { clock, copy, idb: { gate }, refuse: ['ytaf-configuration'] };
    const env = await boot({}, [seg('sponsor', 30, 60)], opts);
    await env.playTo(30.2);
    t(n('refused shared record: precondition: the segment was skipped'), env.state.time === 60, String(env.state.time));
    // Refused before the read too: the restore's own refusal is one more.
    const refusedBefore = opts.refused || 0;
    release();
    // The restore over: its journal has the account's counts taken out (they
    // are in the account's copy) and keeps the shared ones. Before it, the
    // journal from the skip would pass the check below with no restore at all.
    const journal = () => { try { return JSON.parse(env.win.localStorage.getItem('ytaf-settings-changed')); } catch { return null; } };
    const settled = await until(() => {
      const j = journal();
      return !!j && !!j.own && !!j.own[''] && Object.keys(j.own[''].counted || {}).length === 0;
    }, 3000);
    t(n('refused shared record: precondition: the restore ran'), settled && opts.refused > refusedBefore,
      JSON.stringify(journal()) + ' ' + refusedBefore + '->' + opts.refused);
    t(n('refused shared record: precondition: localStorage refused it'), opts.refused > 0, String(opts.refused));
    const left = {};
    for (let i = 0; i < env.win.localStorage.length; i++) {
      const k = env.win.localStorage.key(i);
      left[k] = env.win.localStorage.getItem(k);
    }
    const next = await boot({}, [seg('sponsor', 30, 60)], { copy, storage: left });
    await wait(400);
    t(n('refused shared record: the next start has the totals of the copy with the skip'),
      Math.abs(stored(next.win).sbTimeSaved - (100 + 60 - 30.2)) < 1e-9 && stored(next.win).sbSkipCount === 5,
      JSON.stringify([stored(next.win).sbTimeSaved, stored(next.win).sbSkipCount]));
  }
  {
    // Separate settings on in the copy, a skip before the read, and both the
    // shared record and the account's refused by localStorage, while the copy
    // aborts its writes: the account's merged totals are nowhere stored, so
    // the skip stays in the journal and the next start adds it once.
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const PROFILE = 'ytaf-configuration::' + hashString('accountId=abc');
    const copy = savedCopy([
      ['ytaf-configuration', JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [PROFILE, JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 })]
    ]);
    const storage = { 'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }) };
    const idb = { gate, abortWrites: true, txIds: [] };
    const opts = { clock, copy, storage, idb, refuse: ['ytaf-configuration', PROFILE] };
    const env = await boot({}, [seg('sponsor', 30, 60)], opts);
    await env.playTo(30.2);
    t(n('both refused, copy aborts: precondition: the segment was skipped'), env.state.time === 60, String(env.state.time));
    release();
    const tried = await until(() => idb.txIds.some(([note]) => note === 'put ' + PROFILE), 3000);
    t(n('both refused, copy aborts: precondition: the account\u2019s record was tried in the copy, and aborted'),
      tried && copy.get(PROFILE) === JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 }), JSON.stringify(idb.txIds));
    await wait(50);
    const journal = JSON.parse(env.win.localStorage.getItem('ytaf-settings-changed') || 'null');
    t(n('both refused, copy aborts: the skip stays in the journal'),
      !!journal && !!journal.own && !!journal.own[''] && !!journal.own[''].counted.sbSkipCount, JSON.stringify(journal));
    const left = {};
    for (let i = 0; i < env.win.localStorage.length; i++) {
      const k = env.win.localStorage.key(i);
      left[k] = env.win.localStorage.getItem(k);
    }
    const next = await boot({}, [seg('sponsor', 30, 60)], { copy, storage: left });
    const own = () => JSON.parse(next.win.localStorage.getItem(PROFILE) || '{}');
    await until(() => own().sbSkipCount !== undefined, 3000);
    t(n('both refused, copy aborts: the next start has the account\u2019s totals with the skip, once'),
      Math.abs(own().sbTimeSaved - (100 + 60 - 30.2)) < 1e-9 && own().sbSkipCount === 5, JSON.stringify(own()));
  }
  {
    // Two owners of one account: a skip with no account loaded, then Separate
    // Settings switched on and a skip in the account, both before the read.
    // The recovery's first write of the account's record is refused, the
    // second (with both merged) stored; the shared record stays refused and
    // the copy aborts. The next start has each skip once.
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const PROFILE = 'ytaf-configuration::' + hashString('accountId=abc');
    const copy = savedCopy([
      ['ytaf-configuration', JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [PROFILE, JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 })]
    ]);
    const storage = { 'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }) };
    const idb = { gate, abortWrites: true };
    // After the release, the account's record is written twice: back from the
    // copy (it was written from the defaults before the read), then with the
    // first owner's merge (the copy's 4 skips and its 1). That one is refused,
    // known by what it holds, not by its place among the writes.
    const ctl = { armed: false, refusedProfile: 0 };
    const firstMerge = (value) => { try { return JSON.parse(value).sbSkipCount === 5; } catch { return false; } };
    const beforeEvaluate = (w) => {
      const real = w.localStorage;
      const check = (key, value) => {
        if (key === 'ytaf-configuration') throw new Error('QuotaExceededError');
        if (key === PROFILE && ctl.armed && firstMerge(value)) { ctl.refusedProfile++; throw new Error('QuotaExceededError'); }
      };
      const proxy = new Proxy(real, {
        get(target, prop) {
          if (prop === 'setItem') return (key, value) => { check(key, value); target.setItem(key, value); };
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, prop, value) { check(prop, String(value)); target.setItem(prop, String(value)); return true; }
      });
      Object.defineProperty(w, 'localStorage', { configurable: true, get: () => proxy });
    };
    const env = await boot({}, [seg('sponsor', 30, 60), seg('sponsor', 70, 80)], { clock, copy, storage, idb, beforeEvaluate });
    await env.playTo(30.2);
    t(n('two owners: precondition: the first segment was skipped with no account loaded'), env.state.time === 60, String(env.state.time));
    trustedKey(env.win, 404, env.win.document.body, 'keydown');
    trustedKey(env.win, 404, env.win.document.body, 'keyup');
    await until(() => env.win.document.querySelector('.ytaf-ui-container label'), 2000);
    const label = Array.prototype.slice.call(env.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Separate Settings for Each Account');
    if (label) label.querySelector('input').click();
    t(n('two owners: precondition: Separate Settings switched on before the read'), !!label && label.querySelector('input').checked === true);
    trustedKey(env.win, 404, env.win.document.body, 'keydown');
    trustedKey(env.win, 404, env.win.document.body, 'keyup');
    await wait(100);
    await env.playTo(70.2);
    t(n('two owners: precondition: the second segment was skipped in the account'), env.state.time === 80, String(env.state.time));
    await wait(300);
    ctl.armed = true;
    release();
    const merged = await until(() => { try { return JSON.parse(env.win.localStorage.getItem(PROFILE)).sbSkipCount === 6; } catch { return false; } }, 3000);
    t(n('two owners: precondition: the first write was refused, the second stored both skips'),
      merged && ctl.refusedProfile === 1, `${ctl.refusedProfile} ${env.win.localStorage.getItem(PROFILE)}`);
    await wait(100);
    const left = {};
    for (let i = 0; i < env.win.localStorage.length; i++) {
      const k = env.win.localStorage.key(i);
      left[k] = env.win.localStorage.getItem(k);
    }
    const next = await boot({}, [seg('sponsor', 30, 60)], { copy, storage: left });
    const own = () => JSON.parse(next.win.localStorage.getItem(PROFILE) || '{}');
    const recovered = await until(() => next.win.localStorage.getItem('ytaf-settings-recovering') === null, 3000);
    t(n('two owners: precondition: the next start recovered (the mark left, then cleared)'),
      left['ytaf-settings-recovering'] === '1' && recovered, String(left['ytaf-settings-recovering']));
    await wait(100);
    t(n('two owners: the next start has each skip once'),
      own().sbSkipCount === 6 && Math.abs(own().sbTimeSaved - (100 + (60 - 30.2) + (80 - 70.2))) < 1e-9, JSON.stringify(own()));
  }
  {
    // Its control: the same, with the copy storing the account's merged
    // record. The journal lets the skip go once it is there, and the next
    // start (the copy's 129.8 s) does not add it again.
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const PROFILE = 'ytaf-configuration::' + hashString('accountId=abc');
    const copy = savedCopy([
      ['ytaf-configuration', JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [PROFILE, JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 })]
    ]);
    const storage = { 'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }) };
    const opts = { clock, copy, storage, idb: { gate }, refuse: ['ytaf-configuration', PROFILE] };
    const env = await boot({}, [seg('sponsor', 30, 60)], opts);
    await env.playTo(30.2);
    release();
    const stored = await until(() => { try { return JSON.parse(copy.get(PROFILE)).sbSkipCount === 5; } catch { return false; } }, 3000);
    t(n('both refused, copy stores: precondition: the copy has the account\u2019s merged totals'), stored, copy.get(PROFILE));
    const cleared = await until(() => {
      const j = JSON.parse(env.win.localStorage.getItem('ytaf-settings-changed') || 'null');
      return !!j && !!j.own && !!j.own[''] && Object.keys(j.own[''].counted || {}).length === 0;
    }, 2000);
    t(n('both refused, copy stores: the journal lets the skip go'), cleared, env.win.localStorage.getItem('ytaf-settings-changed'));
    const left = {};
    for (let i = 0; i < env.win.localStorage.length; i++) {
      const k = env.win.localStorage.key(i);
      left[k] = env.win.localStorage.getItem(k);
    }
    const next = await boot({}, [seg('sponsor', 30, 60)], { copy, storage: left });
    const own = () => JSON.parse(next.win.localStorage.getItem(PROFILE) || '{}');
    await until(() => own().sbSkipCount !== undefined, 3000);
    t(n('both refused, copy stores: the next start counts the skip once'),
      Math.abs(own().sbTimeSaved - (100 + 60 - 30.2)) < 1e-9 && own().sbSkipCount === 5, JSON.stringify(own()));
  }
  for (const laterWrite of [false, true]) {
    // The account's record survives in localStorage and refuses the merge, the
    // copy takes it (129.8 s) and the journal lets the skip go: the next start
    // takes the copy's, not the 100 s left behind. With a later write stored
    // locally (the copy refusing that one), the local record is the newest.
    const name = laterWrite ? 'stale record, written later' : 'stale record';
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const PROFILE = 'ytaf-configuration::' + hashString('accountId=abc');
    const old = JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 });
    const copy = savedCopy([
      ['ytaf-configuration', JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [PROFILE, old]
    ]);
    const storage = { 'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }), [PROFILE]: old };
    const idb = { gate };
    const opts = { clock, copy, storage, idb, refuse: ['ytaf-configuration', PROFILE] };
    const env = await boot({}, [seg('sponsor', 30, 60), seg('sponsor', 70, 80)], opts);
    await env.playTo(30.2);
    t(n(name + ': precondition: the segment was skipped'), env.state.time === 60, String(env.state.time));
    release();
    const inCopy = await until(() => { try { return JSON.parse(copy.get(PROFILE)).sbSkipCount === 5; } catch { return false; } }, 3000);
    t(n(name + ': precondition: the copy has the merged totals'), inCopy, copy.get(PROFILE));
    t(n(name + ': precondition: localStorage still has the older record'), env.win.localStorage.getItem(PROFILE) === old,
      env.win.localStorage.getItem(PROFILE));
    t(n(name + ': the record is marked as older than the copy'),
      await until(() => (env.win.localStorage.getItem('ytaf-settings-seeded') || '').indexOf(PROFILE) !== -1, 2000),
      String(env.win.localStorage.getItem('ytaf-settings-seeded')));
    if (laterWrite) {
      idb.abortWrites = true;
      opts.refuse.splice(opts.refuse.indexOf(PROFILE), 1);
      await env.playTo(70.2);
      t(n(name + ': precondition: the second segment was skipped'), env.state.time === 80, String(env.state.time));
      const local = await until(() => { try { return JSON.parse(env.win.localStorage.getItem(PROFILE)).sbSkipCount === 6; } catch { return false; } }, 2000);
      t(n(name + ': precondition: the later write is in localStorage only'),
        local && JSON.parse(copy.get(PROFILE)).sbSkipCount === 5, String(env.win.localStorage.getItem(PROFILE)));
      t(n(name + ': the mark goes with it'),
        (env.win.localStorage.getItem('ytaf-settings-seeded') || '').indexOf(PROFILE) === -1,
        String(env.win.localStorage.getItem('ytaf-settings-seeded')));
    }
    await wait(50);
    const left = {};
    for (let i = 0; i < env.win.localStorage.length; i++) {
      const k = env.win.localStorage.key(i);
      left[k] = env.win.localStorage.getItem(k);
    }
    const next = await boot({}, [seg('sponsor', 30, 60)], { copy, storage: left });
    const want = laterWrite ? 6 : 5;
    const own = () => JSON.parse(next.win.localStorage.getItem(PROFILE) || '{}');
    // Waited for the restore to finish (its mark gone), not for the totals:
    // localStorage may hold the wanted count before the copy is read.
    const finished = await until(() => next.win.localStorage.getItem('ytaf-settings-recovering') === null, 3000);
    t(n(name + ': precondition: the next start finished its restore'), finished);
    await wait(100);
    const saved = 100 + (60 - 30.2) + (laterWrite ? 80 - 70.2 : 0);
    t(n(name + ': the next start has the newest totals, each skip once'),
      own().sbSkipCount === want && Math.abs(own().sbTimeSaved - saved) < 1e-9, JSON.stringify(own()));
  }
  {
    // An earlier run marked the account's record as older than the copy. This
    // one skips before the read and stores the merge (the copy's 100 s plus
    // the skip) in localStorage; the shared record is still refused and the
    // copy's write aborts. The local record is the newest now, so the mark
    // goes and the next start keeps it, not the copy's older one.
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const PROFILE = 'ytaf-configuration::' + hashString('accountId=abc');
    const old = JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 });
    const copy = savedCopy([
      ['ytaf-configuration', JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [PROFILE, old]
    ]);
    const storage = {
      'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }),
      [PROFILE]: JSON.stringify({ sbTimeSaved: 0, sbSkipCount: 0 }),
      'ytaf-settings-recovering': '1',
      'ytaf-settings-seeded': JSON.stringify([PROFILE])
    };
    const opts = { clock, copy, storage, idb: { gate, abortWrites: true }, refuse: ['ytaf-configuration'] };
    const env = await boot({}, [seg('sponsor', 30, 60)], opts);
    await env.playTo(30.2);
    t(n('marked, merge stored: precondition: the segment was skipped'), env.state.time === 60, String(env.state.time));
    release();
    const merged = await until(() => { try { return JSON.parse(env.win.localStorage.getItem(PROFILE)).sbSkipCount === 5; } catch { return false; } }, 3000);
    t(n('marked, merge stored: precondition: localStorage has the merge, the copy its older record, the shared record refused'),
      merged && copy.get(PROFILE) === old && opts.refused > 0 && env.win.localStorage.getItem('ytaf-settings-recovering') === '1',
      `${env.win.localStorage.getItem(PROFILE)} ${copy.get(PROFILE)} ${opts.refused}`);
    t(n('marked, merge stored: the mark goes'),
      (env.win.localStorage.getItem('ytaf-settings-seeded') || '').indexOf(PROFILE) === -1,
      String(env.win.localStorage.getItem('ytaf-settings-seeded')));
    await wait(50);
    const left = {};
    for (let i = 0; i < env.win.localStorage.length; i++) {
      const k = env.win.localStorage.key(i);
      left[k] = env.win.localStorage.getItem(k);
    }
    const next = await boot({}, [seg('sponsor', 30, 60)], { copy, storage: left });
    const own = () => JSON.parse(next.win.localStorage.getItem(PROFILE) || '{}');
    const recovered = await until(() => next.win.localStorage.getItem('ytaf-settings-recovering') === null, 3000);
    t(n('marked, merge stored: precondition: the next start recovered (the mark left, then cleared)'),
      left['ytaf-settings-recovering'] === '1' && recovered, String(left['ytaf-settings-recovering']));
    await wait(100);
    t(n('marked, merge stored: the next start keeps the merge, the skip once'),
      own().sbSkipCount === 5 && Math.abs(own().sbTimeSaved - (100 + 60 - 30.2)) < 1e-9, JSON.stringify(own()));
  }
  {
    // The same with Separate Settings for Each Account: the counters are the
    // account's, and the skip before the read adds to the account's totals.
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const PROFILE = 'ytaf-configuration::' + hashString('accountId=abc');
    const copy = savedCopy([
      ['ytaf-configuration', JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [PROFILE, JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 })]
    ]);
    const storage = { 'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }) };
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock, copy, storage, idb: { gate } });
    await env.playTo(30.2);
    release();
    await wait(400);
    const own = () => JSON.parse(env.win.localStorage.getItem(PROFILE) || '{}');
    t(n('stats before the read, per account: the skip is added to the account’s totals'),
      Math.abs(own().sbTimeSaved - (100 + 60 - 30.2)) < 1e-9 && own().sbSkipCount === 5, JSON.stringify(own()));
    await press(env.win, BLUE);
    await wait(300);
    t(n('stats before the read, per account: its undo leaves the account’s totals'),
      Math.abs(own().sbTimeSaved - 100) < 1e-9 && own().sbSkipCount === 4, JSON.stringify(own()));
  }
  {
    // A skip in one account, then a switch to another within the 8 s: Blue
    // takes nothing back, so neither account's totals change for it.
    const clock = {};
    const A = 'ytaf-configuration::' + hashString('accountId=abc');
    const B = 'ytaf-configuration::' + hashString('accountId=xyz');
    const storage = {
      'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }),
      [A]: JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 }),
      [B]: JSON.stringify({ sbTimeSaved: 7, sbSkipCount: 1 })
    };
    const env = await boot({ perAccountSettings: true }, [seg('sponsor', 30, 60)], { clock, storage });
    const rec = (key) => JSON.parse(env.win.localStorage.getItem(key) || '{}');
    await env.playTo(30.2);
    t(n('switch after a skip: precondition: the segment was skipped'), env.state.time === 60, String(env.state.time));
    t(n('switch after a skip: precondition: the skip is in the first account’s totals'),
      await until(() => rec(A).sbSkipCount === 5, 2000), JSON.stringify(rec(A)));
    const changes = [];
    env.win.addEventListener('ytaf-profile-change', (e) => changes.push(e.detail));
    env.win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: { accountId: 'xyz' } }));
    env.win.dispatchEvent(new env.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
    env.win.dispatchEvent(new env.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
    t(n('switch after a skip: precondition: switched from the first account to the other'),
      changes.length === 1 && changes[0].from === hashString('accountId=abc') && changes[0].to === hashString('accountId=xyz'),
      JSON.stringify(changes));
    await press(env.win, BLUE);
    t(n('switch after a skip: Blue does not go back'), env.state.time === 60, String(env.state.time));
    t(n('switch after a skip: no "Skip undone"'), env.toasts().indexOf('Skip undone') === -1, env.toasts());
    await wait(300);
    t(n('switch after a skip: the other account’s totals are untouched'),
      rec(B).sbTimeSaved === 7 && rec(B).sbSkipCount === 1, JSON.stringify(rec(B)));
    t(n('switch after a skip: the first account keeps the skip'),
      Math.abs(rec(A).sbTimeSaved - (100 + 60 - 30.2)) < 1e-9 && rec(A).sbSkipCount === 5, JSON.stringify(rec(A)));
  }
  {
    // The same while the copy is read: separate settings switched on in abc,
    // a skip there, then a switch to xyz that waits for the read. The read
    // loads xyz from none, and Blue still takes nothing back from it.
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const A = 'ytaf-configuration::' + hashString('accountId=abc');
    const B = 'ytaf-configuration::' + hashString('accountId=xyz');
    const copy = savedCopy([
      ['ytaf-configuration', JSON.stringify({ perAccountSettings: false, foxThemeApplied: true, enableSponsorBlock: true })],
      [A, JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 })],
      [B, JSON.stringify({ sbTimeSaved: 7, sbSkipCount: 1 })]
    ]);
    const storage = { 'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }) };
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock, copy, storage, idb: { gate } });
    const rec = (key) => JSON.parse(env.win.localStorage.getItem(key) || '{}');
    trustedKey(env.win, 404, env.win.document.body, 'keydown');
    trustedKey(env.win, 404, env.win.document.body, 'keyup');
    await until(() => env.win.document.querySelector('.ytaf-ui-container label'), 2000);
    const label = Array.prototype.slice.call(env.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Separate Settings for Each Account');
    const box = label && label.querySelector('input');
    t(n('switch during the read: precondition: separate settings off before the read'), !!box && box.checked === false);
    box.click();
    t(n('switch during the read: precondition: on now'), box.checked === true);
    await env.playTo(30.2);
    t(n('switch during the read: precondition: the segment was skipped'), env.state.time === 60, String(env.state.time));
    const changes = [];
    env.win.addEventListener('ytaf-profile-change', (e) => changes.push(e.detail));
    env.win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: { accountId: 'xyz' } }));
    env.win.dispatchEvent(new env.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
    env.win.dispatchEvent(new env.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
    t(n('switch during the read: precondition: the switch waits for the read'), changes.length === 0, JSON.stringify(changes));
    release();
    const loaded = await until(() => changes.length > 0, 3000);
    t(n('switch during the read: precondition: the read loads xyz, from none'), loaded && changes[0].from === null &&
      changes[0].to === hashString('accountId=xyz'), JSON.stringify(changes));
    t(n('switch during the read: precondition: the skip went to abc’s totals'),
      await until(() => rec(A).sbSkipCount === 5, 2000), JSON.stringify(rec(A)));
    // The panel stays open (it keeps Blue from the player), so the undo Blue
    // runs is asked for directly; Blue reaching it is checked above.
    t(n('switch during the read: precondition: the skip can still be taken back by time and place'),
      !!env.sb() && !!env.sb().lastAutoSkip, JSON.stringify(env.sb() && env.sb().lastAutoSkip));
    const undone = env.sb().undoLastSkip();
    t(n('switch during the read: the undo takes nothing back'), undone === false && env.state.time === 60,
      undone + ' ' + env.state.time);
    await wait(300);
    t(n('switch during the read: xyz’s totals are untouched'), rec(B).sbTimeSaved === 7 && rec(B).sbSkipCount === 1,
      JSON.stringify(rec(B)));
    t(n('switch during the read: abc keeps the skip'),
      Math.abs(rec(A).sbTimeSaved - (100 + 60 - 30.2)) < 1e-9 && rec(A).sbSkipCount === 5, JSON.stringify(rec(A)));
  }  {
    // A skip before the read with no account loaded: the read puts it in
    // abc's totals and loads abc. A switch to xyz after that ends the undo.
    const clock = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const A = 'ytaf-configuration::' + hashString('accountId=abc');
    const B = 'ytaf-configuration::' + hashString('accountId=xyz');
    const copy = savedCopy([
      ['ytaf-configuration', JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [A, JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 })],
      [B, JSON.stringify({ sbTimeSaved: 7, sbSkipCount: 1 })]
    ]);
    const storage = { 'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }) };
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock, copy, storage, idb: { gate } });
    const rec = (key) => JSON.parse(env.win.localStorage.getItem(key) || '{}');
    await env.playTo(30.2);
    t(n('switch after the read: precondition: skipped before the read'), env.state.time === 60, String(env.state.time));
    const changes = [];
    env.win.addEventListener('ytaf-profile-change', (e) => changes.push(e.detail));
    release();
    t(n('switch after the read: precondition: the read put the skip in abc’s totals'),
      await until(() => rec(A).sbSkipCount === 5, 3000), JSON.stringify(rec(A)));
    env.win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: { accountId: 'xyz' } }));
    env.win.dispatchEvent(new env.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
    env.win.dispatchEvent(new env.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
    t(n('switch after the read: precondition: abc loaded from none, then xyz from abc'), changes.length === 2 &&
      changes[0].from === null && changes[1].from === hashString('accountId=abc') && changes[1].to === hashString('accountId=xyz'),
      JSON.stringify(changes));
    await press(env.win, BLUE);
    t(n('switch after the read: Blue does not go back'), env.state.time === 60, String(env.state.time));
    await wait(300);
    t(n('switch after the read: xyz’s totals are untouched'), rec(B).sbTimeSaved === 7 && rec(B).sbSkipCount === 1,
      JSON.stringify(rec(B)));
  }

  {
    // Separate settings on, no account readable at the start (no restore): the
    // skip goes to the shared totals. An existing account then loads (from
    // none, not by a restore): Blue must not take the skip off its totals.
    const A = 'ytaf-configuration::' + hashString('accountId=abc');
    const clock = {};
    const storage = { [A]: JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4 }) };
    const env = await boot({ perAccountSettings: true }, [seg('sponsor', 30, 60)], { clock, storage });
    const rec = (key) => JSON.parse(env.win.localStorage.getItem(key) || '{}');
    await env.playTo(30.2);
    t(n('account loaded after a skip: precondition: skipped with no account loaded'), env.state.time === 60, String(env.state.time));
    const changes = [];
    env.win.addEventListener('ytaf-profile-change', (e) => changes.push(e.detail));
    env.win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: { accountId: 'abc' } }));
    env.win.dispatchEvent(new env.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
    env.win.dispatchEvent(new env.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
    await wait(50);
    t(n('account loaded after a skip: precondition: abc loaded from none, not by a restore'),
      changes.length === 1 && changes[0].from === null && !changes[0].restored, JSON.stringify(changes));
    await press(env.win, BLUE);
    t(n('account loaded after a skip: Blue does not go back'), env.state.time === 60, String(env.state.time));
    await wait(300);
    t(n('account loaded after a skip: abc’s totals are untouched'), rec(A).sbTimeSaved === 100 && rec(A).sbSkipCount === 4,
      JSON.stringify(rec(A)));
  }
  {
    // Per-account settings in the copy, but no record of this account: it
    // starts from the restored shared totals, which hold the early skip once.
    let release;
    const gate = new Promise((r) => { release = r; });
    const PROFILE = 'ytaf-configuration::' + hashString('accountId=abc');
    const copy = savedCopy([['ytaf-configuration', JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, sbTimeSaved: 100, sbSkipCount: 4 })]]);
    const storage = { 'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }) };
    const env = await boot({}, [seg('sponsor', 30, 60)], { copy, storage, idb: { gate } });
    await env.playTo(30.2);
    t(n('stats before the read, new account: precondition: the segment was skipped'), env.state.time === 60, String(env.state.time));
    release();
    await wait(400);
    const own = JSON.parse(env.win.localStorage.getItem(PROFILE) || '{}');
    t(n('stats before the read, new account: the skip is counted once'),
      Math.abs(own.sbTimeSaved - (100 + 60 - 30.2)) < 1e-9 && own.sbSkipCount === 5, JSON.stringify(own));
  }
  {
    const env = await boot({ sbReportSkips: true }, [seg('sponsor', 30, 60)]);
    await env.playTo(30.2);
    await wait(50);
    t(n('report on: the skipped segment is reported viewed, by its UUID'),
      env.reported.length === 1 && env.reported[0] === 'POST https://sponsor.ajay.app/api/viewedVideoSponsorTime?UUID=sponsor-30',
      env.reported.join());
  }
  {
    // A jump from the start over a sponsor with a self-promo inside it: both reported.
    const env = await boot({ sbReportSkips: true }, [seg('sponsor', 0, 60), seg('selfpromo', 10, 20)]);
    await wait(50);
    const uuids = env.reported.map((r) => r.split('UUID=')[1]).sort().join();
    t(n('report on: a segment nested in a chain skip is reported too'),
      env.state.seeks.join() === '60' && uuids === 'selfpromo-10,sponsor-0', `${env.state.seeks.join()} ${uuids}`);
  }
  {
    // The jump from the start made at 0.4 s: a segment nested at 0.1 to 0.25 s
    // is behind the playhead, played and not crossed, so not reported. (The
    // case above, a jump made at 0, reports both.)
    const env = await boot({ sbReportSkips: true }, [seg('sponsor', 0, 60), seg('selfpromo', 0.1, 0.25)], { startAt: 0.4 });
    await wait(50);
    const uuids = env.reported.map((r) => r.split('UUID=')[1]).sort().join();
    t(n('report on: precondition: the jump from the start was made at 0.4 s'), env.state.seeks.join() === '60',
      env.state.seeks.join());
    t(n('report on: a start jump from 0.4 s does not report a segment already behind it'), uuids === 'sponsor-0', uuids);
  }
  for (const [from, want] of [[0.4, 'selfpromo-0.3'], [0, 'selfpromo-0.3,sponsor-0']]) {
    // A chain of 0 to 0.2 and 0.3 to 60: its first segment is crossed only by a jump made before 0.2 s.
    const env = await boot({ sbReportSkips: true }, [seg('sponsor', 0, 0.2), seg('selfpromo', 0.3, 60)], { startAt: from });
    await wait(50);
    const uuids = env.reported.map((r) => r.split('UUID=')[1]).sort().join();
    t(n(`report on: chain from ${from} s: precondition: it jumped to 60`), env.state.seeks.join() === '60', env.state.seeks.join());
    t(n(`report on: chain from ${from} s: reports what the jump crossed`), uuids === want, uuids);
  }
  {
    // The same cut chain without reporting: the jump lands at the manual
    // segment's start, which then offers its own skip. Blue within the 8 s
    // takes the auto skip back (to 31 s), not the manual skip to 70 s.
    const clock = {};
    const env = await boot({ sbMode_outro: 'manual_skip' },
      [seg('sponsor', 30, 40), seg('selfpromo', 40.1, 60), seg('outro', 40.1, 70)], { clock });
    await env.playTo(31);
    await wait(50);
    t(n('auto skip onto a manual segment: precondition: the jump stopped at 40.1'), env.state.time === 40.1, String(env.state.time));
    await env.playTo(40.3);
    t(n('auto skip onto a manual segment: precondition: the manual segment is offered'), !!env.sb().currentManualSegment);
    clock.now += 500;
    await press(env.win, BLUE);
    t(n('auto skip onto a manual segment: Blue takes the auto skip back, to 31 s'), Math.abs(env.state.time - 31) < 0.01,
      String(env.state.time));
  }
  {
    // 30 to 40 and 40.1 to 60 chain, and a manual segment at 40.1 cuts the
    // jump at its start: 40.1 to 60 is not crossed, so not reported.
    const env = await boot({ sbReportSkips: true, sbMode_outro: 'manual_skip' },
      [seg('sponsor', 30, 40), seg('selfpromo', 40.1, 60), seg('outro', 40.1, 70)]);
    await env.playTo(31);
    await wait(50);
    const uuids = env.reported.map((r) => r.split('UUID=')[1]).sort().join();
    t(n('report on, cut at a chained start: precondition: the jump stopped at 40.1'), env.state.seeks[0] === 40.1,
      env.state.seeks.join());
    t(n('report on, cut at a chained start: only the segment crossed is reported'), uuids === 'sponsor-30', uuids);
  }
  {
    // A manual segment at 40 cuts the jump inside both auto segments: both
    // were skipped up to there, so both are reported, and it stops at 40.
    const env = await boot({ sbReportSkips: true, sbMode_outro: 'manual_skip' },
      [seg('sponsor', 0, 60), seg('selfpromo', 10, 50), seg('outro', 40, 70)]);
    await wait(50);
    const uuids = env.reported.map((r) => r.split('UUID=')[1]).sort().join();
    t(n('report on: a manual segment cuts the chain: the jump stops at its start'), env.state.seeks[0] === 40, env.state.seeks.join());
    t(n('report on: a manual segment cuts the chain: the auto segments it crossed are reported, the manual one is not'),
      uuids === 'selfpromo-10,sponsor-0', uuids);
  }
  {
    // A segment nested in the one skipped, already behind the playhead: not
    // crossed by the jump, so not reported.
    const env = await boot({ sbReportSkips: true }, [seg('sponsor', 30, 100), seg('selfpromo', 35, 40)]);
    await env.playTo(80);
    await wait(50);
    t(n('report on: precondition: the skip from 80 s'), env.state.time === 100, String(env.state.time));
    t(n('report on: a nested segment behind the playhead is not reported'),
      env.reported.length === 1 && env.reported[0].indexOf('UUID=sponsor-30') !== -1 && env.reported[0].indexOf('selfpromo') === -1,
      env.reported.join());
  }
  {
    // After a seek elsewhere, Blue is no undo (the clock held, so only the distance decides).
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock });
    await env.playTo(30.2);
    await env.playTo(300);
    await press(env.win, BLUE);
    t(n('undo: not after the viewer went somewhere else'), env.state.time === 300, String(env.state.time));
    await wait(300);
    t(n('stats: a Blue that undoes nothing leaves the skip counted'),
      Math.abs(stored(env.win).sbTimeSaved - (60 - 30.2)) < 1e-9 && stored(env.win).sbSkipCount === 1,
      JSON.stringify([stored(env.win).sbTimeSaved, stored(env.win).sbSkipCount]));
  }
  {
    // More than 8 s later, where playback would be by then: no undo.
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock });
    await env.playTo(30.2);
    t(n('undo after 8 s: precondition: skipped, with an undo armed'), env.state.time === 60 && !!env.sb().lastAutoSkip,
      String(env.state.time));
    clock.now += 9000;
    await env.playTo(69);
    await press(env.win, BLUE);
    t(n('undo: not after its 8 s'), env.state.time === 69, String(env.state.time));
  }
  {
    // Two segments back to back, skipped in one jump: both play after the undo.
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 40), seg('selfpromo', 40, 60)], { clock });
    await env.playTo(30.2);
    t(n('undo, two segments: skipped in one jump'), env.state.time === 60, String(env.state.time));
    await press(env.win, BLUE);
    await env.playTo(35);
    await env.playTo(40.1);
    t(n('undo, two segments: the second one plays too'), env.state.time === 40.1, String(env.state.time));
    t(n('undo, two segments: the exemption lasts while playback is inside them'), !!env.sb().undone);
    await env.playTo(62);
    t(n('undo, two segments: passing them ends it'), env.sb().undone === null);
  }
  {
    // Two undos, each ending at its own landing point: A (30 to 60) undone,
    // then B (25 to 30, stopped at A's start) undone. Past 30, B's ends while
    // A's goes on: from 25 again, B is skipped and A still plays.
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 60), seg('selfpromo', 25, 30)], { clock });
    await env.playTo(30.2);
    t(n('two undos: precondition: A skipped'), env.state.time === 60, String(env.state.time));
    await press(env.win, BLUE);
    env.video.currentTime = 20;
    await wait(30);
    await env.playTo(25.2);
    t(n('two undos: precondition: B skipped, stopped at the undone A'), env.state.time === 30, String(env.state.time));
    // A second Blue at the same instant is a repeat: the clock moves on a little.
    clock.now += 500;
    await press(env.win, BLUE);
    t(n('two undos: precondition: B undone'), env.state.time === 25.2, String(env.state.time));
    await env.playTo(28);
    await env.playTo(36);
    env.video.currentTime = 20;
    await wait(30);
    await env.playTo(25.2);
    t(n('two undos: past B’s end, B is skipped again'), env.state.time === 30, String(env.state.time));
    await env.playTo(30.5);
    t(n('two undos: ...and A, still undone, plays'), env.state.time === 30.5, String(env.state.time));
  }
  {
    // A refresh puts a segment before it: the undo still frees the skipped one.
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock });
    await env.playTo(30.2);
    env.sb().applyRefreshedSegments([seg('selfpromo', 5, 10), seg('sponsor', 30, 60)], 'refreshed');
    await wait(50);
    await press(env.win, BLUE);
    t(n('undo after a refresh: Blue goes back'), Math.abs(env.state.time - 30.2) < 0.01, String(env.state.time));
    await env.playTo(31);
    t(n('undo after a refresh: the segment it skipped plays'), env.state.time === 31, String(env.state.time));
  }

  {
    // A refresh puts a segment that overlaps the undone one before it: no
    // jump through the undone one from there.
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock });
    await env.playTo(30.2);
    await press(env.win, BLUE);
    t(n('undo, then an overlapping segment: Blue went back'), Math.abs(env.state.time - 30.2) < 0.01, String(env.state.time));
    env.sb().applyRefreshedSegments([seg('selfpromo', 20, 35), seg('sponsor', 30, 60)], 'overlap');
    await wait(50);
    await env.playTo(30.5);
    await env.playTo(31);
    t(n('undo, then an overlapping segment: the undone one still plays'), env.state.time === 31, String(env.state.time));
    // Back in the new segment before the undone one: its skip stops at the undone one's start.
    await env.playTo(25);
    t(n('undo, then an overlapping segment: a skip from before it stops at its start'), env.state.time === 30, String(env.state.time));
    // That skip undone too: the first undone segment still plays, its exemption kept.
    // (The clock moved on a little: a second Blue at the same instant is a repeat.)
    clock.now += 500;
    await press(env.win, BLUE);
    t(n('two undos: precondition: Blue took the second skip back'), Math.abs(env.state.time - 25) < 0.01, String(env.state.time));
    // Past the second undone segment (20-35), inside only the first (30-60).
    await env.playTo(30.5);
    await env.playTo(36);
    t(n('two undos: the first undone segment still plays'), env.state.time === 36, String(env.state.time));
  }
  {
    // A combined skip undone; a refresh keeps its first segment and puts a
    // longer one around it. Past that first segment, it no longer holds the
    // new one's skip back.
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 35), seg('selfpromo', 35.1, 60)], { clock });
    await env.playTo(30.2);
    t(n('undone, ended segment: precondition: skipped in one jump'), env.state.time === 60, String(env.state.time));
    await press(env.win, BLUE);
    t(n('undone, ended segment: precondition: Blue went back'), Math.abs(env.state.time - 30.2) < 0.01, String(env.state.time));
    // By start, as a refresh hands them over.
    env.sb().applyRefreshedSegments([seg('selfpromo', 20, 55), seg('sponsor', 30, 35)], 'refreshed');
    await wait(50);
    await env.playTo(36);
    t(n('undone, ended segment: the new segment around it is skipped to its end'), env.state.time === 55, String(env.state.time));
  }
  {
    // A chain skip at the start undone, then a refresh puts a segment around
    // the undone one: the chain is not taken again over it.
    const clock = {};
    const env = await boot({}, [seg('sponsor', 0.2, 20)], { clock });
    await wait(100);
    t(n('undone chain: precondition: the chain skip at the start'), env.state.time === 20, String(env.state.time));
    await press(env.win, BLUE);
    t(n('undone chain: precondition: Blue went back to the start'), env.state.time < 0.5, String(env.state.time));
    env.sb().applyRefreshedSegments([seg('selfpromo', 0, 60), seg('sponsor', 0.2, 20)], 'around');
    await wait(50);
    env.sb().hasPerformedChainSkip = false;
    const jumped = env.sb().executeChainSkip(env.video);
    t(n('undone chain: no chain skip across the undone segment nested in the new one'), !jumped && env.state.time < 20,
      `${jumped} ${env.state.time}`);
  }
  {
    // Its control: the same refreshed segments with no undo in force: the
    // chain skip from the start does go over both, to 60 s.
    const env = await boot({}, [seg('sponsor', 0.2, 20)]);
    await wait(100);
    env.sb().applyRefreshedSegments([seg('selfpromo', 0, 60), seg('sponsor', 0.2, 20)], 'around');
    await wait(50);
    // Back at the start with no event (a seek's seeked could skip by itself),
    // and the chain skip asked before anything else runs.
    env.state.time = 0;
    env.sb().hasPerformedChainSkip = false;
    const jumped = env.sb().executeChainSkip(env.video);
    t(n('undone chain: control: with no undo, the same segments are skipped to 60 s'), jumped === true && env.state.time === 60,
      `${jumped} ${env.state.time}`);
  }

  // ---- Never Skip on These Channels and the highlight ----
  {
    const env = await boot({ sbWhitelistChannels: ['Some Channel'], sbMode_highlight: 'auto_skip' },
      [seg('poi_highlight', 90, 91, 'poi')]);
    await wait(200);
    // The highlight loaded on this very video: its jump was decided, not missing.
    t(n('whitelist: precondition: the listed video has its highlight'),
      !!env.sb().highlightSegment && env.sb().highlightSegment.segment[0] === 90);
    t(n('whitelist: no jump to the highlight on a listed channel'), env.state.seeks.length === 0, env.state.seeks.join());
    // ...and asked for, it still jumps there.
    const jumped = env.sb().jumpToNextHighlight();
    t(n('whitelist: the highlight shortcut still jumps there on a listed channel'), jumped === true && env.state.time === 90,
      String(env.state.time));
  }
  {
    const env = await boot({ sbWhitelistChannels: ['Other Channel'], sbMode_highlight: 'auto_skip' },
      [seg('poi_highlight', 90, 91, 'poi')]);
    await wait(200);
    t(n('whitelist: another channel jumps to the highlight as before'), env.state.seeks[0] === 90, env.state.seeks.join());
  }
  {
    const opts = { author: '' };
    const env = await boot({ sbWhitelistChannels: ['Other Channel'], sbMode_highlight: 'auto_skip' },
      [seg('poi_highlight', 90, 91, 'poi')], opts);
    await wait(200);
    t(n('whitelist, channel unknown: the highlight jump waits'), env.state.seeks.length === 0, env.state.seeks.join());
    opts.author = 'Some Channel';
    await wait(1300);
    t(n('whitelist, channel known and not listed: the jump comes then'), env.state.seeks[0] === 90, env.state.seeks.join());
  }

  {
    // The channel not known yet, and the list emptied while the jump waits: it
    // comes, from the change of the list itself. The channel's 1 s retry is
    // held (not run), so it cannot be what makes the jump.
    const held = [];
    const opts = {
      author: '',
      beforeEvaluate: (w) => {
        const realSet = w.setTimeout.bind(w);
        const realClear = w.clearTimeout.bind(w);
        w.setTimeout = (fn, ms, ...args) => {
          if (ms !== 1000) return realSet(fn, ms, ...args);
          held.push({ id: -700 - held.length, fn });
          return held[held.length - 1].id;
        };
        w.clearTimeout = (id) => { if (!held.some((h) => h.id === id)) realClear(id); };
      }
    };
    const env = await boot({ sbWhitelistChannels: ['Other Channel'], sbMode_highlight: 'auto_skip' },
      [seg('poi_highlight', 90, 91, 'poi')], opts);
    await wait(200);
    t(n('whitelist emptied while the jump waits: it waits first'), env.state.seeks.length === 0, env.state.seeks.join());
    t(n('whitelist emptied while the jump waits: precondition: the channel retry is set, and held'),
      !!env.sb() && held.some((h) => h.id === env.sb().channelRetryTimer), String(env.sb() && env.sb().channelRetryTimer));
    // The panel, on its SponsorBlock tab, where the list is.
    trustedKey(env.win, 404);
    await wait(100);
    env.win.document.querySelectorAll('.ytaf-tab-btn')[3].click();
    await wait(100);
    const entry = Array.prototype.slice.call(env.win.document.querySelectorAll('.ytaf-list-btn'))
      .find((b) => b.textContent === '\u2715 Other Channel');
    if (entry) entry.click();
    const jumped = await until(() => env.state.seeks[0] === 90, 1500);
    t(n('whitelist emptied while the jump waits: the jump comes, with the retry still held'), !!entry && jumped,
      env.state.seeks.join());
  }

  // ---- The channel known only after its ten retries ----
  for (const known of [true, false]) {
    // The channel's 1 s retries are held and run by hand; after the tenth the
    // channel counts as not listed. Known at the next play (a listed one): its
    // segment plays; still unknown (the control): it is skipped.
    const held = [];
    const opts = {
      author: '',
      beforeEvaluate: (w) => {
        const realSet = w.setTimeout.bind(w);
        w.setTimeout = (fn, ms, ...args) => {
          if (ms !== 1000) return realSet(fn, ms, ...args);
          held.push(fn);
          return -900 - held.length;
        };
      }
    };
    const env = await boot({ sbWhitelistChannels: ['Some Channel'] }, [seg('sponsor', 30, 60)], opts);
    const name = 'channel after its retries (' + (known ? 'known then' : 'still unknown') + ')';
    for (let i = 0; i < 40 && env.sb() && (env.sb().channelRetries || 0) < 10; i++) {
      if (held.length) held.shift()();
      await wait(10);
    }
    t(n(name + ': precondition: its ten retries ran'), !!env.sb() && env.sb().channelRetries === 10, String(env.sb() && env.sb().channelRetries));
    if (known) opts.author = 'Some Channel';
    // Built again only once the channel is known, not on every play before that.
    const handler = env.sb();
    const rebuild = handler.rebuildSkipSegments;
    let rebuilds = 0;
    handler.rebuildSkipSegments = function () { rebuilds++; return rebuild.apply(this, arguments); };
    env.win.dispatchEvent(new env.win.CustomEvent('yt-player-state-change', { detail: { state: 1 } }));
    t(n(name + ': the play builds the segments again ' + (known ? 'once' : 'not at all')), rebuilds === (known ? 1 : 0), String(rebuilds));
    await env.playTo(30.2);
    if (known) t(n(name + ': known at the next play, listed: nothing is skipped'), env.state.time === 30.2, String(env.state.time));
    else t(n(name + ': control: counted as not listed, skipped'), env.state.time === 60, String(env.state.time));
  }

  // ---- The channel not known yet ----
  {
    const opts = { author: '' };
    const env = await boot({ sbWhitelistChannels: ['Some Channel'] }, [seg('sponsor', 30, 60)], opts);
    await env.playTo(30.2);
    t(n('whitelist, channel unknown: nothing skipped yet'), env.state.time === 30.2, String(env.state.time));
    opts.author = 'Other Channel';
    await wait(1300);
    await env.playTo(30.5);
    t(n('whitelist, channel known and not listed: skipped'), env.state.time === 60, String(env.state.time));
  }
  // ---- The player still reports the video before ----
  {
    // The one before is on the list, this one is not: its segment is skipped once the player reports it.
    const opts = { videoId: 'zzzzzzzzzzz', author: 'Old Channel' };
    const env = await boot({ sbWhitelistChannels: ['Old Channel'] }, [seg('sponsor', 30, 60)], opts);
    await env.playTo(30.2);
    t(n('whitelist, the video before reported: its listed channel is not taken for this one'),
      env.state.time === 30.2 && env.state.seeks.length === 0, String(env.state.time));
    opts.videoId = VIDEO_ID;
    opts.author = 'New Channel';
    await wait(1300);
    await env.playTo(30.5);
    t(n('whitelist, the video before reported: once this one is, its segment is skipped'), env.state.time === 60, String(env.state.time));
  }
  {
    // The one before is not on the list, this one is: nothing is skipped, also once the player reports it.
    // The retry's 1 s timer is held, not scheduled: the player's data
    // changes while it waits, and the test runs it, so the rebuild it makes is
    // seen, and a slow run cannot let it fire first.
    const held = [];
    const opts = {
      videoId: 'zzzzzzzzzzz', author: 'Old Channel',
      beforeEvaluate: (w) => {
        const realSet = w.setTimeout.bind(w);
        const realClear = w.clearTimeout.bind(w);
        w.setTimeout = (fn, ms, ...args) => {
          if (ms !== 1000) return realSet(fn, ms, ...args);
          held.push({ id: -800 - held.length, fn, cleared: false });
          return held[held.length - 1].id;
        };
        w.clearTimeout = (id) => {
          const h = held.find((x) => x.id === id);
          if (h) h.cleared = true;
          else realClear(id);
        };
      }
    };
    const env = await boot({ sbWhitelistChannels: ['New Channel'] }, [seg('sponsor', 30, 60)], opts);
    await env.playTo(30.2);
    t(n('whitelist, the video before reported: its unlisted channel does not make this one skip'),
      env.state.time === 30.2 && env.state.seeks.length === 0, String(env.state.time));
    const sb = env.sb();
    const retry = held.find((h) => h.id === sb.channelRetryTimer);
    t(n('whitelist, the video before reported: precondition: the retry is waiting, held'), !!retry && !retry.cleared,
      String(sb.channelRetryTimer));
    opts.videoId = VIDEO_ID;
    opts.author = 'New Channel';
    let rebuilt = 0;
    const rebuild = sb.rebuildSkipSegments;
    sb.rebuildSkipSegments = function counted() {
      rebuilt++;
      return rebuild.apply(this, arguments);
    };
    retry.fn();
    t(n('whitelist, the video before reported: the retry sees this video and builds the list again, with nothing to skip'),
      rebuilt === 1 && sb.channelRetryTimer === null && sb.skipSegments.length === 0,
      `${rebuilt} ${sb.channelRetryTimer} ${sb.skipSegments.length}`);
    await env.playTo(30.5);
    t(n('whitelist, the video before reported: once this one is, still not skipped'),
      env.state.time === 30.5 && env.state.seeks.length === 0, String(env.state.time));
  }
  {
    // Data with no video ID: its channel name is taken as it is (known, not listed: skipped at once).
    const env = await boot({ sbWhitelistChannels: ['Other Channel'] }, [seg('sponsor', 30, 60)], { videoId: undefined });
    await env.playTo(30.2);
    t(n('whitelist, no video ID in the data: its channel counts as known'), env.state.time === 60, String(env.state.time));
  }

  // ---- Undo, the highlight's guard and a new <video> ----
  {
    // Auto Skip to Start jumped to the highlight at 90; a skip from 93 is
    // undone while the highlight's guard still holds: the undo stays.
    const clock = {};
    const env = await boot({ sbMode_highlight: 'auto_skip' }, [seg('poi_highlight', 90, 90, 'poi'), seg('sponsor', 93, 120)], { clock });
    await wait(100);
    t(n('undo and highlight: jumped to the highlight first'), env.state.seeks[0] === 90, env.state.seeks.join());
    // The guard's own 4 s timer is held: only the undo can end the guard, not a slow machine.
    const guard = env.sb()._highlightGuard;
    t(n('undo and highlight: precondition: the highlight guard is on'), !!guard && !!guard.timer);
    if (guard) env.win.clearTimeout(guard.timer);
    await env.playTo(93.2);
    t(n('undo and highlight: the segment was skipped'), env.state.time === 120, String(env.state.time));
    await press(env.win, BLUE);
    await wait(100);
    t(n('undo and highlight: the undo is not taken back to the highlight'), Math.abs(env.state.time - 93.2) < 0.01, env.state.seeks.join());
    t(n('undo and highlight: ...with the guard still on after the undo seek'), !!guard && env.sb()._highlightGuard === guard);
  }
  {
    // The highlight's guard holds, then the channel goes on Never Skip on
    // These Channels: a seek before the highlight is not taken back to it.
    const clock = {};
    const env = await boot({ sbMode_highlight: 'auto_skip', shortcut_key_8: 'sb_whitelist_channel' },
      [seg('poi_highlight', 90, 90, 'poi')], { clock });
    await wait(100);
    const guard = env.sb()._highlightGuard;
    t(n('highlight guard, channel listed: precondition: jumped, guard on'), env.state.seeks[0] === 90 && !!guard, env.state.seeks.join());
    if (guard) env.win.clearTimeout(guard.timer);
    await press(env.win, 56);
    t(n('highlight guard, channel listed: precondition: listed'),
      JSON.stringify(stored(env.win).sbWhitelistChannels) === '["Some Channel"]', JSON.stringify(stored(env.win).sbWhitelistChannels));
    env.video.currentTime = 85;
    await wait(100);
    t(n('highlight guard, channel listed: a seek before the highlight stays'), env.state.time === 85, env.state.seeks.join());
  }
  {
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock });
    await env.playTo(30.2);
    await press(env.win, BLUE);
    t(n('undo, new <video>: undone on the first one'), !!env.sb().undone);
    // YouTube puts another <video> in the player.
    const box = env.win.document.getElementById('ytlr-player__player-container-player');
    const old = box.querySelector('video');
    const el = env.win.document.createElement('video');
    fakeVideo(env.win, el, 600);
    box.removeChild(old);
    box.appendChild(el);
    await wait(600);
    t(n('undo, new <video>: the exemption goes with the old one'), env.sb().video === el && !env.sb().undone,
      `${env.sb().video === el} ${!!env.sb().undone}`);
  }
});
