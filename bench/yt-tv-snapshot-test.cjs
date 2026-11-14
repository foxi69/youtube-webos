/**
 * tools/yt-tv-snapshot.cjs: a snapshot built from a capture keeps what the
 * preview fixes rely on and nothing that identifies a viewer, and the diff
 * names each kind of change on YouTube's side (a value, a field, a place, a
 * name in the code) and stays quiet when nothing changed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, diff } = require('../tools/yt-tv-snapshot.cjs');

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };

const command = (over = {}) => Object.assign({
  playbackEndpoint: { clickTrackingParams: 'SECRETTRACKING', watchEndpoint: { videoId: 'vvvvvvvvvv1' } },
  delayMs: 3000, durationMs: 40000, autotransitionDelayMs: 39000, forceSeamlessAutotransition: true,
  blockAdoption: true, resumeVideo: true
}, over);
const browse = (cmd) => ({
  responseContext: { visitorData: 'SECRETVISITOR' },
  contents: { tvBrowseRenderer: { content: { items: [
    { tileRenderer: { contentId: 'vvvvvvvvvv1', header: { title: 'A private title' }, onFocusCommand: { startInlinePlaybackCommand: cmd } } }
  ] } } }
});
const CODE = 'x;a.blockAdoption&&b();c.forceSeamlessAutotransition;d.autotransitionDelayMs;e.graftPlayback(f);';

function capture(name, cmd, code = CODE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-snap-' + name + '-'));
  fs.writeFileSync(path.join(dir, '05_x_main.js'), code);
  fs.writeFileSync(path.join(dir, '01.json'), JSON.stringify(browse(cmd)));
  fs.writeFileSync(path.join(dir, '02.json'), JSON.stringify({ responseContext: {}, playabilityStatus: {} }));
  return dir;
}

const base = build(capture('base', command()));
const text = JSON.stringify(base);
t('the preview command\'s values are kept', base.previewCommands.length === 1 &&
  base.previewCommands[0].fields.autotransitionDelayMs === 39000 && base.previewCommands[0].fields.blockAdoption === true,
  JSON.stringify(base.previewCommands));
t('where it sits is kept', JSON.stringify(Object.keys(base.previewCommandPaths)) === '["items.[].tileRenderer.onFocusCommand"]',
  JSON.stringify(base.previewCommandPaths));
t('the names in the code are counted', base.code.anchors.blockAdoption.count === 1 && base.code.anchors.graftPlayback.count === 1 &&
  base.code.anchors.disableInlineAdoption.count === 0, JSON.stringify(base.code.anchors.blockAdoption));
t('a player response is not counted as a feed', base.responses === 1, String(base.responses));
t('nothing that identifies a viewer: no ids, titles, tracking or visitor data',
  !/vvvvvvvvvv1|A private title|SECRETTRACKING|SECRETVISITOR/.test(text), text.slice(0, 300));

t('the same capture again: no change', diff(base, build(capture('same', command()))).length === 0);

const value = diff(base, build(capture('value', command({ autotransitionDelayMs: 20000 }))));
t('a value changed is named', value.some((c) => /autotransitionDelayMs 39000 -> 20000/.test(c)), value.join(' | '));
const added = diff(base, build(capture('added', command({ blockAdoptionOnOk: true }))));
t('a new field is named', added.some((c) => /new field blockAdoptionOnOk/.test(c)), added.join(' | '));
const gone = diff(base, build(capture('gone', command({ forceSeamlessAutotransition: undefined }))));
t('a field gone is named', gone.some((c) => /forceSeamlessAutotransition is gone/.test(c)), gone.join(' | '));
const renamed = diff(base, build(capture('code', command(), CODE.replace('blockAdoption', 'disallowAdoption'))));
t('a name gone from the code is named', renamed.some((c) => /"blockAdoption" is gone/.test(c)), renamed.join(' | '));

const movedDir = capture('moved', command());
fs.writeFileSync(path.join(movedDir, '01.json'), JSON.stringify({ responseContext: {}, contents: { x: { items: [
  { lockupViewModel: { onFocusCommand: { startInlinePlaybackCommand: command() } } }] } } }));
const moved = diff(base, build(movedDir));
t('the command at a new place is named', moved.some((c) => /new place: .*lockupViewModel/.test(c)) &&
  moved.some((c) => /no longer at: items/.test(c)), moved.join(' | '));
const none = diff(base, build(capture('none', undefined)));
t('no preview command at all is named', none.some((c) => /no preview command/.test(c)), none.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
