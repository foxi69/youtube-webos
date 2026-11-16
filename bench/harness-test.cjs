/**
 * The shared harness itself (bench/harness.cjs): the options the tests rely
 * on do what their description says. No bundle is loaded; the page is empty.
 *
 *   node bench/harness-test.cjs
 */
const { execFileSync } = require('child_process');
const { createReporter, bootPage, manualFrames } = require('./harness.cjs');

const { t, run } = createReporter();
const page = (opts) => bootPage(Object.assign({ code: '', modern: false }, opts));

/** Runs `body` (a script using the harness) in a node of its own: { out, code }. */
function child(body) {
  const script = `const h = require(${JSON.stringify(require.resolve('./harness.cjs'))});\n${body}`;
  try {
    return { out: execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout), code: e.status };
  }
}

run(async () => {
  // The environment: the legacy one takes fetch and Reflect away, the modern
  // one Array#at; `environment: false` leaves jsdom's own.
  const legacy = page({});
  t('legacy: the Chrome 38 environment has no Reflect', typeof legacy.win.Reflect === 'undefined',
    typeof legacy.win.Reflect);
  t('legacy: what was removed is listed', legacy.removed.length > 0, legacy.removed.length);
  t('legacy: Element#remove is put back', typeof legacy.win.Element.prototype.remove === 'function');
  const bare = page({ restoreRemove: false });
  t('restoreRemove: false leaves Element#remove away', typeof bare.win.Element.prototype.remove !== 'function');
  const modern = page({ modern: true });
  t('modern: the Chrome 87 environment has no Array#at', typeof modern.win.Array.prototype.at === 'undefined');
  t('modern: Reflect stays', typeof modern.win.Reflect === 'object');
  const plain = page({ environment: false });
  t('environment: false keeps Reflect on the legacy build', typeof plain.win.Reflect === 'object');
  t('environment: false removes nothing', plain.removed.length === 0, plain.removed.length);
  t('environment: false still sets the build\'s user agent', /Chrome\/38\./.test(plain.win.navigator.userAgent),
    plain.win.navigator.userAgent);
  const plainModern = page({ environment: false, modern: true });
  t('environment: false keeps Array#at on the modern build',
    typeof plainModern.win.Array.prototype.at === 'function');

  // Animation frames.
  let ran = 0;
  const none = page({ raf: 'none' });
  none.win.requestAnimationFrame(() => { ran++; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  t('raf none: a frame never runs', ran === 0 && none.frames === null, ran);
  const own = [];
  const custom = page({ raf: (cb) => { own.push(cb); return 7; } });
  t('raf as a function: it is the page\'s requestAnimationFrame',
    custom.win.requestAnimationFrame(() => {}) === 7 && own.length === 1, own.length);
  const seen = [];
  const manual = page({ raf: 'manual' });
  manual.win.requestAnimationFrame((time) => { seen.push(time); });
  t('raf manual: nothing runs before the pump', seen.length === 0 && manual.frames.pending() === 1);
  t('raf manual: the pump runs what is queued', manual.frames.pump() === 1 && seen.length === 1);
  t('raf manual: a callback gets the time of the pump', Math.abs(seen[0] - Date.now()) < 5000, seen[0]);
  const fixed = page({ raf: 'manual', frameTime: 0 });
  fixed.win.requestAnimationFrame((time) => { seen.push(time); });
  fixed.frames.pump();
  t('raf manual with frameTime: a callback gets that time', seen[1] === 0, seen[1]);
  const queue = manualFrames(16);
  const fake = {};
  queue.install(fake);
  fake.requestAnimationFrame((time) => { seen.push(time); });
  queue.pump();
  t('manualFrames(time): the same on its own', seen[2] === 16, seen[2]);

  // The page's order: `setup` before the environment, `beforeEval` after it.
  const order = page({
    setup: (win) => { win.early = typeof win.Reflect; },
    beforeEval: (win) => { win.late = typeof win.Reflect; }
  });
  t('setup runs before the environment, beforeEval after it',
    order.win.early === 'object' && order.win.late === 'undefined', `${order.win.early} ${order.win.late}`);
  const fetching = page({ fetch: 'pending' });
  t('fetch is set after the environment took the page\'s own away', typeof fetching.win.fetch === 'function');
  t('without it the legacy page has no fetch', typeof legacy.win.fetch === 'undefined');

  // The reporter, in a node of its own (done() ends the process).
  const passed = child('const r = h.createReporter(); r.t("a", true); r.done();');
  t('reporter: all passed prints the count and exits 0',
    passed.code === 0 && passed.out === 'PASS a\n\n1 passed, 0 failed\n', JSON.stringify(passed));
  const failed = child('const r = h.createReporter({ prefix: "legacy" }); r.t("a", false, 0); r.t("b", false, ""); r.done();');
  t('reporter: a failure prints its detail under it and exits 1',
    failed.code === 1 && failed.out === 'FAIL legacy: a\n     0\nFAIL legacy: b\n\n0 passed, 2 failed\n',
    JSON.stringify(failed));
  const summed = child('const r = h.createReporter({ summary: (p, f) => f ? f + " broken" : "all " + p + " fine" });' +
    ' r.t("a", true); r.done();');
  t('reporter: summary() writes the last line', summed.code === 0 && summed.out === 'PASS a\n\nall 1 fine\n',
    JSON.stringify(summed));
  const summedFail = child('const r = h.createReporter({ summary: (p, f) => f ? f + " broken" : "fine" });' +
    ' r.t("a", false); r.done();');
  t('reporter: a failure still exits 1 with a summary of its own',
    summedFail.code === 1 && /\n1 broken\n$/.test(summedFail.out), JSON.stringify(summedFail));
  const thrown = child('h.createReporter().run(() => { throw new Error("boom"); });');
  t('reporter: a throw in run() is a harness failure with exit 1',
    thrown.code === 1 && /^FAIL harness: Error: boom/.test(thrown.out), JSON.stringify(thrown).slice(0, 200));
  const rejected = child('h.createReporter().run(async () => { await null; throw new Error("late"); });');
  t('reporter: so is a rejection', rejected.code === 1 && /^FAIL harness: Error: late/.test(rejected.out),
    JSON.stringify(rejected).slice(0, 200));
});
