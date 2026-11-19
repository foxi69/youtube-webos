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
 */
function runAll(queue, jobs, start, failLine) {
  return new Promise((resolve, reject) => {
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
      child.on('error', (e) => {
        // A child that never started (no pid) is gone now. One that runs (its
        // kill() failed, say) is still counted until its 'close'.
        if (child.pid === undefined) running.delete(child);
        finish(null, new Error(`${t.name} could not be run: ${e.message}`));
      });
      child.on('close', (code) => {
        if (!running.delete(child)) return;
        if (code !== 0 && !outcome) {
          const line = out.split('\n').find((l) => failLine.test(l)) || 'exit ' + code;
          finish({ t, test: t.name, line: line.trim().slice(0, 140) });
        } else next();
      });
    };
    for (let i = 0; i < jobs; i++) next();
  });
}

module.exports = { runAll };
