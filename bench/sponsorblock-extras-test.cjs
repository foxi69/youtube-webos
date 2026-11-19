/**
 * SponsorBlock's extras: Ignore Segments Shorter Than, Never Skip on These
 * Channels (and its shortcut action), the undo of an auto skip with Blue, the
 * time saved, and Count My Skips on SponsorBlock.
 *
 *   node bench/sponsorblock-extras-test.cjs <bundle> [legacy|modern]
 *
 * The page and the API are sponsorblock-fixtures.cjs's.
 */
const { createReporter, flavorFromArgs, trustedKey, wait } = require('./harness.cjs');
const { seg, bootSponsorBlock } = require('./sponsorblock-fixtures.cjs');

const { modern } = flavorFromArgs();

const { t, run } = createReporter();

// The bundle on a watch page with `segments` from the API (sponsorblock-fixtures.cjs).
// The same `opts` object, so a test can change opts.author afterwards.
const boot = (cfg, segments, opts = {}) => {
  if (opts.consoleErrors === undefined) opts.consoleErrors = false;
  if (!('author' in opts)) opts.author = 'Some Channel';
  return bootSponsorBlock(cfg, segments, opts);
};

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

  // ---- Never Skip on These Channels ----
  {
    const env = await boot({ sbWhitelistChannels: ['some channel'] }, [seg('sponsor', 30, 60)]);
    await env.playTo(30.2);
    t(n('whitelist: nothing is skipped on a listed channel (no case)'), env.state.time === 30.2 && env.state.seeks.length === 0);
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

  // ---- Undo with Blue, the time saved ----
  // The page's clock stands still unless moved: the 8 s window cannot run out on a slow machine.
  {
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock });
    await env.playTo(30.2);
    t(n('undo: the segment was skipped'), env.state.time === 60);
    await wait(300);
    t(n('stats: the time saved is counted'), Math.round(stored(env.win).sbTimeSaved) === 30 && stored(env.win).sbSkipCount === 1,
      JSON.stringify([stored(env.win).sbTimeSaved, stored(env.win).sbSkipCount]));
    await press(env.win, BLUE);
    t(n('undo: Blue just after goes back to where the skip started'), Math.abs(env.state.time - 30.2) < 0.01, String(env.state.time));
    await env.playTo(31);
    t(n('undo: ...and the segment plays'), env.state.time === 31, String(env.state.time));
    t(n('undo: "Skip undone" is shown'), env.toasts().indexOf('Skip undone') !== -1, env.toasts());
    t(n('report off: nothing is sent'), env.reported.length === 0, env.reported.join());
  }
  {
    const env = await boot({ sbReportSkips: true }, [seg('sponsor', 30, 60)]);
    await env.playTo(30.2);
    await wait(50);
    t(n('report on: the skipped segment is reported viewed, by its UUID'),
      env.reported.length === 1 && env.reported[0] === 'POST https://sponsor.ajay.app/api/viewedVideoSponsorTime?UUID=sponsor-30-skip',
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
  }
  {
    // More than 8 s later, where playback would be by then: no undo.
    const clock = {};
    const env = await boot({}, [seg('sponsor', 30, 60)], { clock });
    await env.playTo(30.2);
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
  }

  // ---- Never Skip on These Channels and the highlight ----
  {
    const env = await boot({ sbWhitelistChannels: ['Some Channel'], sbMode_highlight: 'auto_skip' },
      [seg('poi_highlight', 90, 91, 'poi')]);
    await wait(200);
    t(n('whitelist: no jump to the highlight on a listed channel'), env.state.seeks.length === 0, env.state.seeks.join());
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
    // The channel not known yet, and the list emptied while the jump waits: it comes.
    const opts = { author: '' };
    const env = await boot({ sbWhitelistChannels: ['Other Channel'], sbMode_highlight: 'auto_skip' },
      [seg('poi_highlight', 90, 91, 'poi')], opts);
    await wait(200);
    t(n('whitelist emptied while the jump waits: it waits first'), env.state.seeks.length === 0, env.state.seeks.join());
    // The panel, on its SponsorBlock tab, where the list is.
    trustedKey(env.win, 404);
    await wait(100);
    env.win.document.querySelectorAll('.ytaf-tab-btn')[3].click();
    await wait(100);
    const entry = Array.prototype.slice.call(env.win.document.querySelectorAll('.ytaf-list-btn'))
      .find((b) => b.textContent === '\u2715 Other Channel');
    if (entry) entry.click();
    await wait(1300);
    t(n('whitelist emptied while the jump waits: the jump comes'), !!entry && env.state.seeks[0] === 90, env.state.seeks.join());
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
  // ---- Undo, the highlight's guard and a new <video> ----
  {
    // Auto Skip to Start jumped to the highlight at 90; a skip from 93 is
    // undone while the highlight's guard still holds: the undo stays.
    const clock = {};
    const env = await boot({ sbMode_highlight: 'auto_skip' }, [seg('poi_highlight', 90, 90, 'poi'), seg('sponsor', 93, 120)], { clock });
    await wait(100);
    t(n('undo and highlight: jumped to the highlight first'), env.state.seeks[0] === 90, env.state.seeks.join());
    await env.playTo(93.2);
    t(n('undo and highlight: the segment was skipped'), env.state.time === 120, String(env.state.time));
    await press(env.win, BLUE);
    await wait(100);
    t(n('undo and highlight: the undo is not taken back to the highlight'), Math.abs(env.state.time - 93.2) < 0.01, env.state.seeks.join());
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
