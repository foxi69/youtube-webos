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
const { VIDEO_ID, seg, fakeVideo, bootSponsorBlock } = require('./sponsorblock-fixtures.cjs');

const { modern } = flavorFromArgs();

const { t, run } = createReporter();

// The bundle on a watch page with `segments` from the API (sponsorblock-fixtures.cjs).
// The same `opts` object, so a test can change opts.author afterwards.
const boot = (cfg, segments, opts = {}) => {
  if (opts.consoleErrors === undefined) opts.consoleErrors = false;
  if (!('author' in opts)) opts.author = 'Some Channel';
  return bootSponsorBlock(cfg, segments, opts);
};

const { savedCopy, hashString } = require('./fake-indexeddb.cjs');
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
    const env = await boot({ sbMinSegmentLength: '5', enableMutedSegments: true },
      [seg('sponsor', 30, 33, 'mute'), seg('selfpromo', 100, 120, 'mute')]);
    await env.playTo(30.2);
    t(n('min length: a 3 s muted segment is not muted'), env.state.muted === false && env.state.seeks.length === 0,
      `${env.state.muted} ${env.state.seeks.join()}`);
    await env.playTo(100.2);
    t(n('min length: a 20 s one still is'), env.state.muted === true && env.state.time === 100.2,
      `${env.state.muted} ${env.state.time}`);
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
      env.reported.length === 1 && env.reported[0] === 'POST https://sponsor.ajay.app/api/viewedVideoSponsorTime?UUID=sponsor-30-skip',
      env.reported.join());
  }
  {
    // A jump from the start over a sponsor with a self-promo inside it: both reported.
    const env = await boot({ sbReportSkips: true }, [seg('sponsor', 0, 60), seg('selfpromo', 10, 20)]);
    await wait(50);
    const uuids = env.reported.map((r) => r.split('UUID=')[1]).sort().join();
    t(n('report on: a segment nested in a chain skip is reported too'),
      env.state.seeks.join() === '60' && uuids === 'selfpromo-10-skip,sponsor-0-skip', `${env.state.seeks.join()} ${uuids}`);
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
    const opts = { videoId: 'zzzzzzzzzzz', author: 'Old Channel' };
    const env = await boot({ sbWhitelistChannels: ['New Channel'] }, [seg('sponsor', 30, 60)], opts);
    await env.playTo(30.2);
    t(n('whitelist, the video before reported: its unlisted channel does not make this one skip'),
      env.state.time === 30.2 && env.state.seeks.length === 0, String(env.state.time));
    opts.videoId = VIDEO_ID;
    opts.author = 'New Channel';
    await wait(1300);
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
