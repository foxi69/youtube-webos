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
const { createReporter, flavorFromArgs, wait } = require('./harness.cjs');
const { VIDEO_ID, OTHER_ID, BAR_MULTI, seg, bootSponsorBlock } = require('./sponsorblock-fixtures.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();

const MIN = 60 * 1000;
const REFRESH_DELAYS = [5, 10, 15, 20, 30].map((m) => m * MIN);

const { t, run } = createReporter();

/**
 * The bundle on a watch page (sponsorblock-fixtures.cjs), with Periodically
 * Check for New Segments on. net.segments is what the API answers for this
 * video (net.other for OTHER_ID), net.status what both servers answer.
 * opts.noVideo: the <video> is not in the page yet.
 *
 * The refresh's timers are held for the test to fire; with opts.fastRetry the
 * 2 s and 4 s waits before asking failed servers again are cut short.
 */
async function boot(cfg, segments, opts = {}) {
  const held = [];
  const env = await bootSponsorBlock(Object.assign({ sbPeriodicRefresh: true }, cfg), segments, Object.assign({}, opts, {
    bar: BAR_MULTI,
    beforeEval: (win) => {
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
    }
  }));
  const refreshes = () => held.map((h) => h.ms / MIN);
  // The pending refresh comes due.
  const fireRefresh = async () => {
    if (held.length !== 1) throw new Error('expected one refresh timer, have ' + JSON.stringify(refreshes()));
    held.shift().fn();
    await wait(80);
  };
  const lefts = () => env.marks().map((m) => Math.round(parseFloat(m.style.left))).join();
  const rows = () => Array.prototype.map.call(env.doc.querySelectorAll('.sb-segments-popup .sb-segment-row'),
    (r) => r.querySelector('.sb-segment-time').textContent);
  return Object.assign(env, { refreshes, fireRefresh, lefts, rows });
}

run(async () => {
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
    // The first request is the open's; then five pairs, each official first.
    const pairs = env.net.asked.slice(1);
    t(n('...each time the official server, then the mirror'), env.net.asked.length === 11 &&
      pairs.every((u, i) => u.indexOf(i % 2 === 0 ? 'https://sponsor.ajay.app/' : 'https://sponsorblock.inf.re/') === 0),
      env.net.asked.join(' '));
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
      env.net.asked.every((u, i) => u.indexOf(i % 2 === 0 ? 'https://sponsor.ajay.app/' : 'https://sponsorblock.inf.re/') === 0),
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
});
