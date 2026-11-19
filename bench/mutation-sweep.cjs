/**
 * A mutation sweep: does a test fail when the logic it covers breaks?
 *
 * Each mutant in the list is one small change to a source file (a guard
 * dropped, a condition turned round, a limit moved). For each, the file is
 * changed, the modern bundle built, and the tests CI runs on it, with the
 * tests that read the sources directly, run side by side until one fails. A
 * mutant no test notices is a gap in the tests. The file is put back after
 * each mutant, also when the run is stopped.
 *
 *   node bench/mutation-sweep.cjs [mutants.json] [--only id,id] [--jobs n]
 *
 * mutants.json (bench/mutants.json by default): [{ id, file, from, to, why }],
 * `from` found exactly once in `file`. A mutant with `equivalent` (why no
 * test can tell it from the original) is listed and not run. Prints one line
 * per mutant and a summary; exits 1 when a mutant survived, 2 when the run
 * itself broke (a build or a test that could not run to its end).
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { runAll } = require('./mutation-sweep-run.cjs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1]; };
const only = flag('--only');
const jobsArg = flag('--jobs');
const jobs = jobsArg === null ? Math.max(2, require('os').cpus().length - 2) : Number(jobsArg);
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error(`--jobs takes a whole number from 1 up, not "${jobsArg}"`);
  process.exit(2);
}
const listFile = path.resolve(args[0] || path.join(__dirname, 'mutants.json'));
let mutants = JSON.parse(fs.readFileSync(listFile, 'utf8'));
if (only) { const ids = only.split(','); mutants = mutants.filter((m) => ids.includes(m.id)); }

const BUNDLE = 'dist-mut/webOSUserScripts/userScript.js';
const LEGACY = 'dist/webOSUserScripts/userScript.js';

// Every test bench/ci.sh runs: on the modern bundle (the loop and each
// `run <test> "$M"`), with no bundle (`run <test>`, `node bench/<test>.cjs`),
// and the ones it runs on the legacy bundle only, on a legacy build of the
// mutant. That legacy build is dist/ itself, built from each mutant, so the
// tests that read dist/ with no bundle given (launch-test: dist/index.js)
// see the mutant too; dist/ is built again from the sources at the end. The
// perf build's test is left out.
const ci = fs.readFileSync(path.join(__dirname, 'ci.sh'), 'utf8').replace(/\\\n/g, ' ');
const tests = [];
const add = (name, argv) => { if (!tests.some((t) => t.name === name && t.argv.join() === argv.join())) tests.push({ name, argv }); };
const words = (text) => text.trim().split(/\s+/).filter(Boolean);
const loop = /for t in (.*?); do\s*run "\$t" "\$M" modern/s.exec(ci);
if (!loop) throw new Error('bench/ci.sh: the modern test loop was not found');
for (const t of words(loop[1])) add(t, [BUNDLE, 'modern']);
for (const m of ci.matchAll(/^\s*run ([\w-]+) "\$M"(.*)$/gm)) add(m[1], [BUNDLE, ...words(m[2])]);
const modernNames = new Set(tests.map((t) => t.name));
for (const m of ci.matchAll(/^\s*run ([\w-]+)\s*$/gm)) add(m[1], []);
for (const m of ci.matchAll(/^\s*node bench\/([\w-]+)\.cjs\s*$/gm)) add(m[1], []);
for (const m of ci.matchAll(/^\s*run ([\w-]+) "\$B"(.*)$/gm)) {
  if (!modernNames.has(m[1]) && m[1] !== 'perfmon-test') add(m[1], [LEGACY, ...words(m[2])]);
}

// 'dist': the legacy build (dist/: the launcher and the legacy bundle); 'modern': dist-mut/.
function build(kind) {
  const argv = { dist: [], modern: ['--env', 'modern', '--output-path', 'dist-mut'] }[kind];
  const r = spawnSync('npx webpack --mode=production --stats errors-only ' + argv.join(' '),
    { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Stopped (a signal) or not run at all: no answer about the mutant.
  if (r.error || r.signal) throw new Error(`the ${kind} build did not finish: ${r.error ? r.error.message : r.signal}`);
  if (r.status === 0) return null;
  // A failed build is always a message, also one that printed nothing.
  return ((r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ') || `exit ${r.status}`);
}

const FAIL_LINE = /^FAIL|^\s*\w*Error\b/;

// Runs the tests `jobs` at a time, but those in `skip` (mutation-sweep-run.cjs):
// the first failure, or null, once the others it stopped have exited; a test
// process that cannot be started rejects, so the source is put back.
function runTests(skip = []) {
  return runAll(tests.filter((t) => !skip.includes(t.name)), jobs,
    (t) => spawn(process.execPath, [path.join('bench', t.name + '.cjs'), ...t.argv], { cwd: ROOT }), FAIL_LINE);
}

// A failure under load is run again alone: the FAIL line it gives then, or
// null when it passes (a test that failed only side by side with others). A
// run that did not end by itself (not started, or stopped by spawnSync, e.g.
// past its output limit) throws: no result, and the source is put back.
function confirm(t) {
  const r = spawnSync(process.execPath, [path.join('bench', t.name + '.cjs'), ...t.argv],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Not started, stopped by spawnSync, or ended by a signal (Ctrl-C, the OOM
  // killer): no result, never a kill.
  if (r.error || r.signal) {
    throw new Error(`${t.name}, run again alone, did not finish: ${r.error ? r.error.message : 'stopped by ' + r.signal}`);
  }
  if (r.status === 0) return null;
  return ((r.stdout + r.stderr).split('\n').find((l) => FAIL_LINE.test(l)) || 'exit ' + r.status).trim().slice(0, 140);
}

// dist/ holds a mutant's build (from the mutant's build until it is built again from the sources).
let distFromMutant = false;
let original = null;
let originalFile = null;
const restore = () => { if (originalFile !== null) { fs.writeFileSync(originalFile, original); originalFile = null; } };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restore();
    console.error('Stopped: dist/ may hold a mutant\'s build; build it again before using it.');
    process.exit(130);
  });
}

// A run stopped hard (no signal handler) leaves a mutant in place: refuse to
// start on a tree with changed sources, or it would become the baseline.
const changed = spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' });
if (changed.status !== 0 || changed.stdout.trim()) {
  console.error('src/ has changes (a mutant left by a stopped run?); put them back first:\n' +(changed.stdout || changed.stderr));
  process.exit(2);
}

(async () => {
  const startBuild = build('dist') || build('modern');
  if (startBuild) throw new Error('the unchanged sources do not build: ' + startBuild);
  const base = await runTests();
  if (base) throw new Error(`the unchanged sources fail ${base.test}: ${base.line}`);
  console.log(`baseline: ${tests.length} tests pass; ${mutants.length} mutants, ${jobs} at a time`);

  const survived = [];
  // Not run: equivalent, `from` not found once, or not building.
  const notRun = [];
  let killedCount = 0;
  for (const m of mutants) {
    if (m.equivalent) { notRun.push(m.id); console.log(`EQUIV ${m.id}: ${m.equivalent}`); continue; }
    const file = path.join(ROOT, m.file);
    const src = fs.readFileSync(file, 'utf8');
    const n = src.split(m.from).length - 1;
    if (n !== 1) { notRun.push(m.id); console.log(`SKIP ${m.id}: "from" found ${n} times in ${m.file}`); continue; }
    original = src;
    originalFile = file;
    fs.writeFileSync(file, src.replace(m.from, () => m.to));
    const t0 = Date.now();
    try {
      distFromMutant = true;
      const err = build('modern') || build('dist');
      const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
      if (err) { notRun.push(m.id); console.log(`BUILD ${m.id} (${secs()}): does not build: ${err}`); continue; }
      // Killed only by a failure that holds when its test runs again alone;
      // a test that passes alone is noted and left out of the next round,
      // until the rest of the suite has run through (each round leaves one
      // more out, so this ends): survival is told only after that.
      let killed = null;
      const flaky = [];
      while (!killed) {
        const failed = await runTests(flaky);
        if (!failed) break;
        const line = confirm(failed.t);
        if (line) killed = { test: failed.test, line };
        else flaky.push(failed.test);
      }
      const note = flaky.length ? ` [failed only under load: ${flaky.join(', ')}]` : '';
      if (killed) { killedCount++; console.log(`killed ${m.id} (${secs()}) by ${killed.test}: ${killed.line}${note}`); }
      else { survived.push(m); console.log(`SURVIVED ${m.id} (${secs()}): ${m.why}${note}`); }
    } finally {
      restore();
    }
  }
  // dist/ holds the last mutant's build: built from the sources again.
  const clean = build('dist');
  if (!clean) distFromMutant = false;
  if (clean) console.log('dist/ could not be built again from the sources: ' + clean);
  console.log(`\n${killedCount} of ${killedCount + survived.length} killed; survived: ${survived.map((m) => m.id).join(', ') || 'none'}` +
    (notRun.length ? `; not run: ${notRun.join(', ')}` : ''));
  process.exit(survived.length ? 1 : 0);
})().catch((e) => {
  restore();
  console.error(e.message);
  // A run that broke after a mutant's build: dist/ is built again from the
  // sources, or the viewer is told it is not.
  if (distFromMutant) {
    let clean;
    try { clean = build('dist'); } catch (err) { clean = err.message; }
    if (clean) console.error('dist/ may hold a build of a mutant and could not be built again: ' + clean);
  }
  process.exit(2);
});
