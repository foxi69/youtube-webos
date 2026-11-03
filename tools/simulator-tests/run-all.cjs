// Runs run-app-test.cjs on every webOS TV Simulator and every build given,
// starting again when the simulator's page crashes, then a summary.
//   node run-all.cjs [--sdk D:\webOS_TV_SDK] [--versions 6.0,22,23,24] <app dir>...
// The env settings of run-app-test.cjs (LOGO, FEATURES, EFFECTS, ...) pass
// through. webOS 6.0 runs without TV_LIKE unless it is set: with the TV's
// agent its page crashes nearly every time (see README.md).
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i === -1 ? def : args.splice(i, 2)[1];
};
const sdk = opt('--sdk', process.env.WEBOS_SDK || 'D:\\webOS_TV_SDK');
const versions = opt('--versions', '6.0,22,23,24').split(',');
const apps = args.length ? args : ['dist'];
const ATTEMPTS = 5;

const simDir = path.join(sdk, 'Simulator');
const sims = fs.readdirSync(simDir);
const killSims = () => {
  try { execSync('taskkill /F /T /FI "IMAGENAME eq webOS_TV_*"', { stdio: 'ignore' }); } catch { /* none running */ }
};

const summary = [];
for (const v of versions) {
  const dir = sims.find((d) => d.startsWith(`webOS_TV_${v}_Simulator`));
  if (!dir) {
    summary.push([v, '-', 'no simulator in ' + simDir]);
    continue;
  }
  const exe = path.join(simDir, dir, dir + '.exe');
  for (const app of apps) {
    const label = `webos${v}-${path.basename(app)}`;
    const env = Object.assign({}, process.env, { LABEL: label });
    if (v === '6.0' && env.TV_LIKE === undefined) env.TV_LIKE = '0';
    const out = path.resolve(env.OUT || path.join(__dirname, '..', '..', 'simulator-results'));
    let result = 'crashed every time';
    for (let i = 1; i <= ATTEMPTS; i++) {
      killSims();
      console.log(`=== webOS ${v}, ${app}, attempt ${i}`);
      // No results from an earlier run in the summary.
      fs.rmSync(path.join(out, `${label}-results.json`), { force: true });
      const r = spawnSync(process.execPath, [path.join(__dirname, 'run-app-test.cjs'), exe, app], { env, stdio: 'inherit' });
      if (r.status === 3) continue;
      // The test's own results file, for the summary.
      let checks = [];
      try { checks = JSON.parse(fs.readFileSync(path.join(out, `${label}-results.json`), 'utf8')).results; } catch { /* none written */ }
      const fails = checks.filter((x) => !x.ok).map((x) => x.name);
      result = (checks.length ? `${checks.length - fails.length}/${checks.length} passed` : `exit ${r.status}`) +
        (fails.length ? ' | FAIL: ' + fails.join('; ') : '') + (i > 1 ? ` (attempt ${i})` : '');
      break;
    }
    summary.push([v, path.basename(app), result]);
  }
}
killSims();
console.log('\n=== summary');
for (const [v, app, r] of summary) console.log(`webOS ${v.padEnd(4)} ${app.padEnd(16)} ${r}`);
