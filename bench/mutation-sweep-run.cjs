/**
 * The mutation sweep's parallel test run (bench/mutation-sweep.cjs), on its
 * own so bench/mutation-sweep-test.cjs can drive it with stand-in processes.
 *
 * runAll(queue, jobs, start, failLine) runs the items of `queue`, `jobs` at a
 * time; `start(item)` returns a child process (stdout, stderr, kill(), and
 * 'error' and 'close' events). It resolves with the first failure, as
 * { t, test, line }, or null when every item passed, and only once every child
 * still running has exited, so whatever runs next runs alone. A child that
 * cannot be started (an 'error', or `start` throwing) rejects instead, also
 * when a failure came first: a run that broke is no result, and the caller
 * puts the mutant's file back. Settles exactly once.
 *
 * With `deadlineMs`, a child still running after that long is stopped
 * (SIGKILL: a loop that never yields cannot refuse it) and is that run's
 * failure, "did not finish in N s". `timers` ({ set, clear }) is the clock, the
 * test's own in bench/mutation-sweep-test.cjs.
 *
 * The promise has cancel(): no more items start, the running children are
 * told to stop, and it rejects ("stopped") once they have exited.
 */
function runAll(queue, jobs, start, failLine, deadlineMs = 0, timers = { set: setTimeout, clear: clearTimeout }) {
  let cancel;
  const all = new Promise((resolve, reject) => {
    const running = new Set();
    let outcome = null;
    let settled = false;
    const settle = () => {
      if (settled || !outcome || running.size) return;
      settled = true;
      if (outcome.error) reject(outcome.error);
      else resolve(outcome.result);
    };
    const finish = (result, error) => {
      if (!outcome) {
        outcome = { result, error };
        for (const c of running) c.kill();
      } else if (error && !outcome.error) {
        // A process error wins over a failure met before it.
        outcome = { result: null, error };
      }
      settle();
    };
    const next = () => {
      if (outcome) return settle();
      if (!queue.length) {
        if (!running.size) finish(null);
        return;
      }
      const t = queue.shift();
      let child;
      try {
        child = start(t);
      } catch (e) {
        finish(null, new Error(`${t.name} could not be run: ${e.message}`));
        return;
      }
      let out = '';
      if (child.stdout) child.stdout.on('data', (d) => { out += d; });
      if (child.stderr) child.stderr.on('data', (d) => { out += d; });
      running.add(child);
      let timedOut = false;
      const timer = deadlineMs ? timers.set(() => { timedOut = true; child.kill('SIGKILL'); }, deadlineMs) : null;
      child.on('error', (e) => {
        // A child that never started (no pid) is gone now. One that runs (its
        // kill() failed, say) is still counted until its 'close'.
        if (child.pid === undefined) running.delete(child);
        finish(null, new Error(`${t.name} could not be run: ${e.message}`));
      });
      child.on('close', (code) => {
        if (!running.delete(child)) return;
        if (timer !== null) timers.clear(timer);
        if (code !== 0 && !outcome) {
          const line = timedOut ? `did not finish in ${deadlineMs / 1000} s`
            : out.split('\n').find((l) => failLine.test(l)) || 'exit ' + code;
          finish({ t, test: t.name, line: line.trim().slice(0, 140) });
        } else next();
      });
    };
    cancel = () => finish(null, new Error('stopped'));
    for (let i = 0; i < jobs; i++) next();
  });
  all.cancel = cancel;
  return all;
}

module.exports = { runAll };
