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

// ---- watch-code: the daily check of the public bundle, the network stubbed ----
const { mainBundleUrl, watchCode, codeAnchors } = require('../tools/yt-tv-snapshot.cjs');
const BASE = '/s/_/kabuki/_/js/k=kabuki.base_cr.en_US.abc.es5.O/am=AAAA/d=1/excm=main/rs=XYZ/m=base';
const PAGE = '<html><script nonce="n">var a="' + BASE + '";</script>' +
  '<link href="/s/_/kabuki/_/ss/k\\u003dkabuki.base_cr.W.L.W.O/m\\u003dmain"></html>';
t('the main bundle\'s URL is the base one with m=main',
  mainBundleUrl(PAGE) === 'https://www.youtube.com' + BASE.replace(/m=base$/, 'm=main'), String(mainBundleUrl(PAGE)));
t('a page without a base bundle gives none', mainBundleUrl('<html>nothing</html>') === null);

const pad = 'x'.repeat(120000);
const BUNDLE = pad + CODE;
function snapshotFile(withPublic) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-snap-watch-')), 'snap.json');
  const snap = { taken: '2026-11-14', code: { anchors: {} } };
  if (withPublic) snap.publicCode = { taken: '2026-11-14', bytes: BUNDLE.length, anchors: codeAnchors(BUNDLE) };
  fs.writeFileSync(file, JSON.stringify(snap));
  return file;
}
const stub = (page, bundle) => async (url) => (url.indexOf('m=main') !== -1 ? bundle : page);

(async () => {
  const same = await watchCode(snapshotFile(true), { fetchFn: stub(PAGE, BUNDLE) });
  t('watch: the same bundle is status 0', same.status === 0 && /No change/.test(same.report), JSON.stringify(same));

  const changedBundle = pad + CODE.replace('blockAdoption', 'disallowAdoption') + 'x.graftPlayback(y);';
  const changed = await watchCode(snapshotFile(true), { fetchFn: stub(PAGE, changedBundle) });
  t('watch: a changed bundle is status 1 and names each change', changed.status === 1 &&
    /"blockAdoption" is gone/.test(changed.report) && /"graftPlayback" found 1 -> 2 times/.test(changed.report),
    changed.report);

  const down = await watchCode(snapshotFile(true), { fetchFn: async () => { throw new Error('network down'); } });
  t('watch: a fetch that fails is status 2, not a change', down.status === 2 && /network down/.test(down.report), down.report);
  const noBundle = await watchCode(snapshotFile(true), { fetchFn: stub('<html></html>', BUNDLE) });
  t('watch: a page without the bundle is status 2', noBundle.status === 2 && /no base bundle/.test(noBundle.report), noBundle.report);
  const tiny = await watchCode(snapshotFile(true), { fetchFn: stub(PAGE, 'blocked') });
  t('watch: a bundle too small to be one (a block page) is status 2', tiny.status === 2 && /only 7 bytes/.test(tiny.report),
    tiny.report);

  const fresh = snapshotFile(false);
  const first = await watchCode(fresh, { fetchFn: stub(PAGE, BUNDLE) });
  t('watch: no stored public bundle yet is status 1', first.status === 1 && /no publicCode/.test(first.report), first.report);
  const writing = snapshotFile(true);
  await watchCode(writing, { write: true, fetchFn: stub(PAGE, changedBundle) });
  const after = await watchCode(writing, { fetchFn: stub(PAGE, changedBundle) });
  t('watch --write: the new counts are taken, the next check is status 0', after.status === 0, after.report);
  t('watch --write: the TV capture\'s code part is left alone',
    JSON.stringify(JSON.parse(fs.readFileSync(writing, 'utf8')).code) === '{"anchors":{}}');
  const unwritten = snapshotFile(true);
  const before = fs.readFileSync(unwritten, 'utf8');
  await watchCode(unwritten, { fetchFn: stub(PAGE, changedBundle) });
  t('watch without --write leaves the snapshot as it was', fs.readFileSync(unwritten, 'utf8') === before);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
