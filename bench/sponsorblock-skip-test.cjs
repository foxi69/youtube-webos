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
const { createReporter, flavorFromArgs, wait } = require('./harness.cjs');
const { VIDEO_ID, PRIMARY, FALLBACK, seg, bootSponsorBlock } = require('./sponsorblock-fixtures.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();

const { t, run } = createReporter();

// The bundle on a watch page with `segments` from the API (sponsorblock-fixtures.cjs).
// The same `opts` object, so a test can change opts.author afterwards.
const boot = (cfg, segments, opts = {}) => {
  if (opts.consoleErrors === undefined) opts.consoleErrors = false;
  return bootSponsorBlock(cfg, segments, opts);
};

run(async () => {
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

  // ---- The start chain takes in a segment that adds under a second ----
  {
    const env = await boot({}, [seg('intro', 0, 15), seg('sponsor', 15.1, 15.8)]);
    t(n('a chain whose last segment adds 0.7 s: one jump to that segment\'s end'),
      env.state.time === 15.8 && env.state.seeks.join() === '15.8', env.state.seeks.join(','));
    t(n('...with one toast naming both'), env.toasts() === 'Skipped intro, sponsored', env.toasts());
  }

  // ---- A manual segment from 0:00 is not part of a start chain ----
  {
    const env = await boot({ sbMode_sponsor: 'manual_skip' }, [seg('sponsor', 0, 20), seg('intro', 20.1, 40)]);
    const list = (env.sb() && env.sb().skipSegments || []).map((s) => `${s.start}-${s.end}:${s.mode}`).join();
    // The list is built right before the start chain runs, in the same task.
    t(n('manual segment from 0:00: both segments are in the skip list'),
      list === '0-20:manual_skip,20.1-40:auto_skip', list);
    t(n('...and the video does not jump as it opens'), env.state.time === 0 && env.state.seeks.length === 0,
      env.state.seeks.join(','));
    await env.playTo(0.2);
    t(n('...the blue key is offered for it'), env.toasts() === 'Sponsored: Press Blue to skip', env.toasts());
    const handled = env.sb().handleBlueButton();
    await wait(40);
    t(n('...which skips it to its end'), handled === true && env.state.seeks.join() === '20', env.state.seeks.join(','));
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
    const skipButton = () => env.win.document.querySelector('.ytaf-sb-skip-button');
    t(n('...and the Skip button offers it, with the blue key'), !!skipButton() &&
      skipButton().querySelector('.ytaf-sb-skip-label').textContent === 'Skip Sponsored' &&
      skipButton().querySelector('.ytaf-sb-skip-key').textContent === 'Blue', skipButton() ? skipButton().textContent : 'no button');
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
  {
    // A video YouTube cannot play ("This video isn't available"): the <video>
    // is left with no source, readyState 0 and no duration (webOS 25).
    const env = await boot({ sbMode_highlight: 'auto_skip' }, [seg('poi_highlight', 120, 120, 'poi')],
      { readyState: 0, duration: NaN });
    await wait(60);
    t(n('highlight on an unplayable video: not jumped to'), env.state.seeks.length === 0, env.state.seeks.join(','));
    t(n('...and no toast says it jumped'), !/Jumped to Highlight/.test(env.toasts()), env.toasts());
    const ok = env.sb().handleBlueButton();
    await wait(40);
    t(n('...the blue key does not jump either'), ok === false && env.state.seeks.length === 0 &&
      !/Jumped to Highlight/.test(env.toasts()), `${ok} ${env.state.seeks.join(',')} ${env.toasts()}`);
    env.video.dispatchEvent(new env.win.Event('durationchange'));
    env.video.dispatchEvent(new env.win.Event('loadedmetadata'));
    await wait(40);
    t(n('...nor later, while it stays unloaded'), env.state.seeks.length === 0 && !/Jumped/.test(env.toasts()),
      env.state.seeks.join(','));
  }
  {
    // A playable video whose <video> loads after the segments came: jumped to then.
    const env = await boot({ sbMode_highlight: 'auto_skip' }, [seg('poi_highlight', 120, 120, 'poi')],
      { readyState: 0 });
    t(n('highlight before the video loaded: waits'), env.state.seeks.length === 0, env.state.seeks.join(','));
    env.state.ready = 1;
    env.video.dispatchEvent(new env.win.Event('loadedmetadata'));
    await wait(40);
    t(n('...and jumps once it has loaded, with the toast'), env.state.time === 120 &&
      /Jumped to Highlight/.test(env.toasts()), `${env.state.seeks.join(',')} ${env.toasts()}`);
  }
  {
    // Auto Skip to Start switched off in the panel while the video still loads.
    const env = await boot({ sbMode_highlight: 'auto_skip' }, [seg('poi_highlight', 120, 120, 'poi')],
      { readyState: 0 });
    const doc = env.win.document;
    env.win.ytaf_showOptionsPanel(true);
    await wait(30);
    doc.querySelectorAll('.ytaf-tab-btn')[3].click();
    await wait(30);
    const row = [...doc.querySelectorAll('.shortcut-control-row')]
      .find((r) => (r.querySelector('.shortcut-label') || {}).textContent === 'Highlight');
    row.click();
    await wait(30);
    env.state.ready = 1;
    env.video.dispatchEvent(new env.win.Event('loadedmetadata'));
    await wait(40);
    t(n('highlight mode changed while it waited: no jump once loaded'), env.state.seeks.length === 0 &&
      !/Jumped to Highlight/.test(env.toasts()), `${row.textContent} | ${env.state.seeks.join(',')} ${env.toasts()}`);
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
});
