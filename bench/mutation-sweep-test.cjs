/**
 * The mutation sweep's parallel test run (bench/mutation-sweep-run.cjs),
 * driven with stand-in child processes whose errors and exits the test
 * decides: it settles once, only after every child has exited, with the
 * first failure or null; and a process that cannot start rejects, also after
 * a failure and when two cannot start; a child past the deadline is stopped
 * and is the failure; cancel() stops the run and rejects.
 *
 * Usage: node bench/mutation-sweep-test.cjs
 */
const { EventEmitter } = require('events');
const { createReporter } = require('./harness.cjs');
const { runAll } = require('./mutation-sweep-run.cjs');

const FAIL_LINE = /^FAIL/;
const { t, run } = createReporter();
const tick = () => new Promise((r) => setImmediate(r));

// Stand-in children, by test name: each records kill() and is ended by the
// test. As Node's: a started child has a pid; one that could not start has
// none and emits 'error', then 'close'; a running one can emit 'error' (a
// failed kill()) and still runs until its 'close'.
function harness() {
  const children = {};
  let pid = 1000;
  const start = (item) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.pid = ++pid;
    c.killed = false;
    c.kill = (signal) => { c.killed = true; c.signal = signal; };
    c.exit = (code, text = '') => { if (text) c.stdout.emit('data', text); c.emit('close', code); };
    c.fail = (message) => { c.pid = undefined; c.emit('error', new Error(message)); c.emit('close', -2); };
    c.failRunning = (message) => c.emit('error', new Error(message));
    children[item.name] = c;
    return c;
  };
  return { children, start };
}
// The run's clock: timers are held, and fired by the test.
function clock() {
  const timers = [];
  return {
    timers,
    set: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clear: (timer) => { timer.cleared = true; }
  };
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
  {
    // One at a time: a test that passed lets the next one in the queue start.
    const h = harness();
    const s = watch(runAll(items('a', 'b', 'c'), 1, h.start, FAIL_LINE));
    t('one job: only the first starts', !!h.children.a && !h.children.b && !h.children.c, Object.keys(h.children).join());
    h.children.a.exit(0);
    t('...the first passed: the second starts, the third waits', !!h.children.b && !h.children.c, Object.keys(h.children).join());
    h.children.b.exit(0);
    t('...the second passed: the third starts', !!h.children.c, Object.keys(h.children).join());
    h.children.c.exit(0);
    await tick();
    t('...and null once all three passed', s.now !== 'pending' && s.now.value === null, JSON.stringify(s.now));
  }
  {
    // A running child whose kill() fails: Node tells it with an 'error', and
    // the child runs on. The run waits for its 'close'.
    const h = harness();
    const s = watch(runAll(items('a', 'b'), 2, h.start, FAIL_LINE));
    h.children.a.exit(1, 'FAIL x\n');
    h.children.b.failRunning('kill EPERM');
    await tick();
    t('a failed kill() of a running child: still pending while it runs', s.now === 'pending', JSON.stringify(s.now));
    h.children.b.exit(null);
    await tick();
    t('...and it rejects with that error once the child has closed', s.now !== 'pending' && /b could not be run: kill EPERM/.test(s.now.error),
      JSON.stringify(s.now));
  }
  {
    // The deadline: a child that never ends by itself is stopped, and is the failure.
    const h = harness();
    const c = clock();
    const s = watch(runAll(items('a', 'b', 'c'), 2, h.start, FAIL_LINE, 5000, c));
    t('a deadline: one timer of that length for each running child', c.timers.length === 2 && c.timers[0].ms === 5000 && c.timers[1].ms === 5000,
      JSON.stringify(c.timers));
    t('...and nothing is stopped before it', !h.children.a.killed && !h.children.b.killed);
    c.timers[0].fn();
    await tick();
    t('past the deadline: that child gets SIGKILL, the other runs on', h.children.a.signal === 'SIGKILL' && !h.children.b.killed,
      String(h.children.a.signal));
    t('...and the run waits for it to exit', s.now === 'pending', JSON.stringify(s.now));
    h.children.a.exit(null, 'FAIL printed before it hung\n');
    await tick();
    t('...it exited: the other is told to stop, the queued one never starts', h.children.b.killed && !h.children.c);
    h.children.b.exit(null);
    await tick();
    t('...and the failure is the deadline, not a line it printed', s.now !== 'pending' && !!s.now.value && s.now.value.test === 'a' &&
      s.now.value.line === 'did not finish in 5 s', JSON.stringify(s.now));
    t('...with both timers cleared', c.timers.every((timer) => timer.cleared), JSON.stringify(c.timers.map((timer) => timer.cleared)));
  }
  {
    // A child that ends in time: its timer is cleared, and the next one gets its own.
    const h = harness();
    const c = clock();
    const s = watch(runAll(items('a', 'b'), 1, h.start, FAIL_LINE, 5000, c));
    h.children.a.exit(0);
    t('ended in time: its timer is cleared, the next child has a new one', c.timers.length === 2 && c.timers[0].cleared && !c.timers[1].cleared,
      JSON.stringify(c.timers.map((timer) => timer.cleared)));
    h.children.b.exit(0);
    await tick();
    t('...and null once both passed', s.now !== 'pending' && s.now.value === null && c.timers[1].cleared, JSON.stringify(s.now));
  }
  {
    // No deadline given: no timer.
    const h = harness();
    const c = clock();
    const s = watch(runAll(items('a'), 1, h.start, FAIL_LINE, 0, c));
    t('no deadline: no timer is set', !!h.children.a && c.timers.length === 0, String(c.timers.length));
    h.children.a.exit(0);
    await tick();
    t('...and it ends as before', s.now !== 'pending' && s.now.value === null, JSON.stringify(s.now));
  }
  {
    // cancel(): the running children are stopped and waited for, nothing more starts.
    const h = harness();
    const all = runAll(items('a', 'b', 'c'), 2, h.start, FAIL_LINE);
    const s = watch(all);
    t('before cancel(): two run, none stopped', !!h.children.a && !!h.children.b && !h.children.a.killed && !h.children.b.killed);
    all.cancel();
    await tick();
    t('cancel(): the running children are told to stop', h.children.a.killed && h.children.b.killed);
    t('...and it waits for them to exit', s.now === 'pending', JSON.stringify(s.now));
    h.children.a.exit(null);
    await tick();
    t('...still pending while one runs, the queued one not started', s.now === 'pending' && !h.children.c, JSON.stringify(s.now));
    h.children.b.exit(1, 'FAIL late\n');
    await tick();
    t('...then it rejects as stopped, not with the late failure', s.now !== 'pending' && s.now.error === 'stopped', JSON.stringify(s.now));
  }
  {
    // cancel() after a failure, while the others are still exiting: stopped wins.
    const h = harness();
    const all = runAll(items('a', 'b'), 2, h.start, FAIL_LINE);
    const s = watch(all);
    h.children.a.exit(1, 'FAIL x\n');
    all.cancel();
    h.children.b.exit(null);
    await tick();
    t('cancel() after a failure: it rejects as stopped', s.now !== 'pending' && s.now.error === 'stopped', JSON.stringify(s.now));
  }
  {
    // cancel() after the run ended: nothing changes.
    const h = harness();
    const all = runAll(items('a'), 1, h.start, FAIL_LINE);
    const s = watch(all);
    h.children.a.exit(0);
    await tick();
    all.cancel();
    await tick();
    t('cancel() after the end: the result stays', s.now !== 'pending' && s.now.value === null, JSON.stringify(s.now));
  }

  // ---- Every mutant still finds its line ----
  // The sweep skips a mutant whose `from` is not in its file exactly once,
  // and a skipped one is counted neither killed nor survived: a change to the
  // source that moves the text away must move the mutant along.
  {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    const stale = JSON.parse(fs.readFileSync(path.join(__dirname, 'mutants.json'), 'utf8'))
      .map((m) => [m.id, fs.readFileSync(path.join(root, m.file), 'utf8').split(m.from).length - 1])
      .filter(([, n]) => n !== 1);
    t('every mutant in bench/mutants.json is found exactly once in its file', stale.length === 0,
      stale.map(([id, n]) => id + ': ' + n + ' times').join(', '));
  }
});
