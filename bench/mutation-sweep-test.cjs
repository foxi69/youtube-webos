/**
 * The mutation sweep's parallel test run (bench/mutation-sweep-run.cjs),
 * driven with stand-in child processes whose errors and exits the test
 * decides: it settles once, only after every child has exited, with the
 * first failure or null; and a process that cannot start rejects, also after
 * a failure and when two cannot start.
 *
 * Usage: node bench/mutation-sweep-test.cjs
 */
const { EventEmitter } = require('events');
const { createReporter } = require('./harness.cjs');
const { runAll } = require('./mutation-sweep-run.cjs');

const FAIL_LINE = /^FAIL/;
const { t, run } = createReporter();
const tick = () => new Promise((r) => setImmediate(r));

// Stand-in children, by test name: each records kill() and is ended by the test.
function harness() {
  const children = {};
  const start = (item) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = false;
    c.kill = () => { c.killed = true; };
    c.exit = (code, text = '') => { if (text) c.stdout.emit('data', text); c.emit('close', code); };
    c.fail = (message) => c.emit('error', new Error(message));
    children[item.name] = c;
    return c;
  };
  return { children, start };
}
const items = (...names) => names.map((name) => ({ name }));
// The promise's state now: 'pending', or what it settled with.
function watch(promise) {
  const state = { now: 'pending' };
  promise.then((v) => { state.now = { value: v }; }, (e) => { state.now = { error: e.message }; });
  return state;
}

run(async () => {
  {
    const h = harness();
    const s = watch(runAll(items('a', 'b', 'c'), 3, h.start, FAIL_LINE));
    h.children.a.exit(0); h.children.b.exit(0);
    await tick();
    t('all passing: still pending while one runs', s.now === 'pending');
    h.children.c.exit(0);
    await tick();
    t('...and null once every test passed', s.now !== 'pending' && s.now.value === null, JSON.stringify(s.now));
  }
  {
    const h = harness();
    const s = watch(runAll(items('a', 'b', 'c', 'd'), 3, h.start, FAIL_LINE));
    h.children.a.exit(1, 'PASS one\nFAIL the thing broke\n');
    await tick();
    t('a failure: the running others are told to stop, the queued one never starts',
      h.children.b.killed && h.children.c.killed && !h.children.d);
    t('...and it waits for them to exit', s.now === 'pending');
    h.children.b.exit(null); h.children.c.exit(null);
    await tick();
    t('...then it gives the failure, with its FAIL line', s.now !== 'pending' && s.now.value && s.now.value.test === 'a' &&
      s.now.value.line === 'FAIL the thing broke', JSON.stringify(s.now));
  }
  {
    const h = harness();
    const s = watch(runAll(items('a', 'b'), 2, h.start, FAIL_LINE));
    h.children.a.fail('spawn EAGAIN');
    h.children.b.fail('spawn EAGAIN');
    await tick();
    t('two processes that cannot start: it rejects, it does not hang', s.now !== 'pending' && /a could not be run: spawn EAGAIN/.test(s.now.error),
      JSON.stringify(s.now));
  }
  {
    const h = harness();
    const s = watch(runAll(items('a', 'b'), 2, h.start, FAIL_LINE));
    h.children.a.exit(1, 'FAIL x\n');
    h.children.b.fail('spawn ENOMEM');
    h.children.b.exit(null);
    await tick();
    t('a failure, then a process that cannot start: the error wins, no kill counted', s.now !== 'pending' &&
      /b could not be run: spawn ENOMEM/.test(s.now.error), JSON.stringify(s.now));
  }
  {
    const h = harness();
    const s = watch(runAll(items('a', 'b'), 2, h.start, FAIL_LINE));
    h.children.a.fail('spawn EMFILE');
    await tick();
    t('an error while another runs: it waits for that one', s.now === 'pending' && h.children.b.killed);
    h.children.b.exit(1, 'FAIL later\n');
    await tick();
    t('...and still rejects, the later failure does not take its place', s.now !== 'pending' && /a could not be run/.test(s.now.error),
      JSON.stringify(s.now));
  }
  {
    const s = watch(runAll(items('a'), 1, () => { throw new Error('bad argument'); }, FAIL_LINE));
    await tick();
    t('start throwing: it rejects', s.now !== 'pending' && /a could not be run: bad argument/.test(s.now.error), JSON.stringify(s.now));
  }
  {
    const s = watch(runAll([], 4, () => { throw new Error('never'); }, FAIL_LINE));
    await tick();
    t('nothing to run: null', s.now !== 'pending' && s.now.value === null, JSON.stringify(s.now));
  }
});
