/**
 * Behaviour test for what a speed change keeps across its reload
 * (src/speed/player-state.js), with a fake player and timers: the subtitles
 * in use before it (off stays off, a track stays on), until the viewer
 * presses a key; and the quality the viewer picked in YouTube's menu.
 *
 * Usage: node bench/speed-keep-state-test.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(path.resolve(__dirname, '../src/speed/player-state.js')).href;

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

const EN = { languageCode: 'en', vss_id: '.en', kind: '' };
const EN_AUTO = { languageCode: 'en', vss_id: 'a.en', kind: 'asr' };

/** A player whose captions module answers like YouTube's; one-shot timers run by run(). */
function setup(track) {
  const timers = [];
  const player = {
    track,
    sets: [],
    getOption(module, name) {
      if (module !== 'captions' || name !== 'track') throw new Error('unknown option');
      return this.track;
    },
    setOption(module, name, value) {
      this.sets.push(value);
      this.track = value;
    },
    loadModule() {}
  };
  const win = { setTimeout: (fn, ms) => timers.push({ fn, ms }) };
  const run = () => {
    for (const x of timers.sort((a, b) => a.ms - b.ms).splice(0)) x.fn();
  };
  return { player, win, run };
}

/** A yt-player-quality record as YouTube and Force Max Quality write it. */
function storage(data, expiration = Date.now() + 1e9) {
  const value = data === null ? null : JSON.stringify({ data: JSON.stringify(data), creation: 1234, expiration });
  return { getItem: () => value };
}

import(MODULE).then(({ readCaptions, keepCaptions, readQualityRecord }) => {
  {
    // Turned off by hand, then the reload turns the default track back on.
    const s = setup({});
    const saved = readCaptions(s.player);
    s.player.track = EN;
    keepCaptions(s.win, s.player, saved, () => 0);
    t('subtitles turned off stay off after the reload', readCaptions(s.player).languageCode === undefined,
      JSON.stringify(s.player.track));
    // The captions module settles and turns them on once more.
    s.player.track = EN;
    s.run();
    t('and stay off when the player turns them on again meanwhile', readCaptions(s.player).languageCode === undefined,
      JSON.stringify(s.player.track));
  }
  {
    // On before, dropped by the reload.
    const s = setup(EN);
    const saved = readCaptions(s.player);
    s.player.track = {};
    keepCaptions(s.win, s.player, saved, () => 0);
    t('subtitles that were on come back with the same track', s.player.track === EN, JSON.stringify(s.player.track));
  }
  {
    // Another track of the same language is a different state.
    const s = setup(EN);
    const saved = readCaptions(s.player);
    s.player.track = EN_AUTO;
    keepCaptions(s.win, s.player, saved, () => 0);
    t('the auto-generated track is not taken for the chosen one', s.player.track === EN, JSON.stringify(s.player.track));
  }
  {
    // Already right: nothing is set.
    const s = setup({});
    keepCaptions(s.win, s.player, readCaptions(s.player), () => 0);
    s.run();
    t('nothing is set when the subtitles are already right', s.player.sets.length === 0, s.player.sets.length);
  }
  {
    // The viewer turns them on by hand after the reload.
    const s = setup({});
    keepCaptions(s.win, s.player, readCaptions(s.player), () => Date.now() + 1);
    s.player.track = EN;
    s.run();
    t('a key pressed after the reload leaves the viewer\'s change alone', s.player.track === EN, JSON.stringify(s.player.track));
  }
  {
    // Unreadable before the reload: on or off cannot be told, so nothing is forced.
    const s = setup(EN);
    const getOption = s.player.getOption;
    s.player.getOption = () => { throw new Error('captions module not ready'); };
    const saved = readCaptions(s.player);
    s.player.getOption = getOption;
    keepCaptions(s.win, s.player, saved, () => 0);
    s.run();
    t('unreadable subtitles before the reload are left to the player', saved === null && s.player.sets.length === 0 &&
      s.player.track === EN, JSON.stringify({ saved, sets: s.player.sets }));
    t('no captions API: nothing to keep', readCaptions({}) === null);
  }
  {
    // On before; after the reload the module throws until it loads: turning them on is tried.
    const s = setup(EN);
    const saved = readCaptions(s.player);
    s.player.getOption = () => { throw new Error('captions module not loaded'); };
    keepCaptions(s.win, s.player, saved, () => 0);
    t('subtitles that were on are turned on while the module still loads', s.player.sets[0] === EN,
      JSON.stringify(s.player.sets));
  }

  const level = (s, now = Date.now()) => { const r = readQualityRecord(s, now); return r && r.level; };
  const r720 = readQualityRecord(storage({ quality: 720, previousQuality: 1080 }), Date.now());
  t('a 720p record, with when it was written', r720 && r720.level === 'hd720' && r720.at === 1234, JSON.stringify(r720));
  t('4320 (Force Max Quality, or a range of Max) names no pick',
    level(storage({ quality: 4320, previousQuality: 1080 })) === null);
  t('an expired record is not read',
    readQualityRecord(storage({ quality: 720, previousQuality: 720 }, Date.now() - 1), Date.now()) === null);
  t('no record, nothing read', readQualityRecord(storage(null), Date.now()) === null);
  t('no storage, nothing read', readQualityRecord(undefined, Date.now()) === null);

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
