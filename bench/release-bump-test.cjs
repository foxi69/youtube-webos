/**
 * tools/release-bump.cjs: the version a full release writes back to main
 * (package.json, package-lock.json, assets/appinfo.json) and the version
 * flags of screenshots/fork-trail.svg. Runs on copies of the real files.
 *
 * Usage: node bench/release-bump-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { isNewer, advanceTrail, bump } = require('../tools/release-bump.cjs');

const repo = path.join(__dirname, '..');
const FILES = ['package.json', 'package-lock.json', 'assets/appinfo.json', 'screenshots/fork-trail.svg'];
const FLAG = /<text [^>]*>(\d+\.\d+\.\d+)<\/text>/g;

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};
const throws = (fn, pattern) => { try { fn(); return false; } catch (e) { return pattern.test(e.message); } };

const dirs = [];
/** A copy of the repository files, with the versions and flags given. */
function fixture(pkgVersion, flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-bump-'));
  dirs.push(dir);
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(repo, f), path.join(dir, f));
  }
  const setJson = (f, edit) => {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    edit(data);
    fs.writeFileSync(path.join(dir, f), `${JSON.stringify(data, null, 2)}\n`);
  };
  setJson('package.json', (p) => { p.version = pkgVersion; });
  setJson('package-lock.json', (l) => { l.version = pkgVersion; l.packages[''].version = pkgVersion; });
  setJson('assets/appinfo.json', (a) => { a.version = pkgVersion; });
  let i = 0;
  const svgFile = path.join(dir, 'screenshots/fork-trail.svg');
  fs.writeFileSync(svgFile, fs.readFileSync(svgFile, 'utf8').replace(FLAG, (all, v) => all.replace(v, flags[i++])));
  return dir;
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const json = (dir, f) => JSON.parse(read(dir, f));
const flagsOf = (svg) => [...svg.matchAll(FLAG)].map((m) => m[1]).join(',');
const snapshot = (dir) => FILES.map((f) => read(dir, f)).join('\u0000');

try {
  // ---- isNewer ----
  t('isNewer: a higher patch, minor and major are newer',
    isNewer('0.9.3', '0.9.2') && isNewer('0.10.0', '0.9.2') && isNewer('1.0.0', '0.99.99'));
  t('isNewer: compares numbers, not text', isNewer('0.10.0', '0.9.9') && !isNewer('0.9.9', '0.10.0'));
  t('isNewer: the same version is not newer, nor an older one', !isNewer('0.9.2', '0.9.2') && !isNewer('0.9.1', '0.9.2'));

  // ---- The real files: the trail has the flags fixture() rewrites ----
  const realSvg = read(repo, 'screenshots/fork-trail.svg');
  t('the real trail has three version flags', [...realSvg.matchAll(FLAG)].length === 3, flagsOf(realSvg));

  // ---- A newer release ----
  {
    const dir = fixture('0.9.2', ['0.9.0', '0.9.1', '0.9.2']);
    const changed = bump('0.9.3', dir);
    t('a newer release: every file changes', changed.join(',') === 'package.json,package-lock.json,assets/appinfo.json,screenshots/fork-trail.svg', changed.join(','));
    const lock = json(dir, 'package-lock.json');
    t('a newer release: package.json, both lockfile versions and appinfo.json take it',
      json(dir, 'package.json').version === '0.9.3' && lock.version === '0.9.3' && lock.packages[''].version === '0.9.3' &&
      json(dir, 'assets/appinfo.json').version === '0.9.3', JSON.stringify([lock.version, lock.packages[''].version]));
    const svg = read(dir, 'screenshots/fork-trail.svg');
    t('a newer release: the trail moves on by one', flagsOf(svg) === '0.9.1,0.9.2,0.9.3', flagsOf(svg));
    t('a newer release: the trail\'s label names the new flags',
      svg.indexOf('aria-label="Fox paw prints walking from version 0.9.1 to 0.9.2 to 0.9.3"') !== -1);
    t('a newer release: the other appinfo.json fields stay',
      JSON.stringify(Object.assign(json(repo, 'assets/appinfo.json'), { version: '0.9.3' })) === JSON.stringify(json(dir, 'assets/appinfo.json')));
    t('a newer release: files keep their trailing newline',
      read(dir, 'package.json').endsWith('}\n') && read(dir, 'package-lock.json').endsWith('}\n') && read(dir, 'assets/appinfo.json').endsWith('}\n'));
  }

  // ---- The state main is in now: an old package.json, an up-to-date trail ----
  {
    const dir = fixture('0.9.0', ['0.9.0', '0.9.1', '0.9.2']);
    const svgBefore = read(dir, 'screenshots/fork-trail.svg');
    const changed = bump('0.9.2', dir);
    t('a trail that already has the release: only the version files change',
      changed.join(',') === 'package.json,package-lock.json,assets/appinfo.json' && json(dir, 'package.json').version === '0.9.2' &&
      read(dir, 'screenshots/fork-trail.svg') === svgBefore, changed.join(','));
  }

  // ---- The same release again, and an older one ----
  for (const [name, version] of [['the same release again', '0.9.3'], ['a fix on an older line', '0.8.9']]) {
    const dir = fixture('0.9.3', ['0.9.1', '0.9.2', '0.9.3']);
    const before = snapshot(dir);
    const changed = bump(version, dir);
    t(`${name}: nothing changes`, changed.length === 0 && snapshot(dir) === before, changed.join(','));
  }

  // ---- Bad input ----
  {
    const dir = fixture('0.9.2', ['0.9.0', '0.9.1', '0.9.2']);
    const before = snapshot(dir);
    t('not a version: refused, and nothing written',
      throws(() => bump('0.9', dir), /not a version/) && throws(() => bump('v0.9.3', dir), /not a version/) && snapshot(dir) === before);
    t('a trail without three flags is refused',
      throws(() => advanceTrail(realSvg.replace(FLAG, (all) => all.replace(/\d+\.\d+\.\d+/, 'x')), '0.9.3'), /expected 3 version flags, found 0/));
  }

  // ---- The command line, as the workflow runs it ----
  {
    const dir = fixture('0.9.2', ['0.9.0', '0.9.1', '0.9.2']);
    const out = execFileSync(process.execPath, [path.join(repo, 'tools/release-bump.cjs'), 'v0.9.3', dir], { encoding: 'utf8' });
    t('command line: takes a tag, v and all', json(dir, 'package.json').version === '0.9.3' && /^Updated to v0\.9\.3: /.test(out), out);
    const again = execFileSync(process.execPath, [path.join(repo, 'tools/release-bump.cjs'), 'v0.9.3', dir], { encoding: 'utf8' });
    t('command line: a second run says it has nothing to do', /^Already at v0\.9\.3 or newer/.test(again), again);
    let status = 0;
    try { execFileSync(process.execPath, [path.join(repo, 'tools/release-bump.cjs'), 'latest', dir], { stdio: 'pipe' }); }
    catch (e) { status = e.status; }
    t('command line: a bad version fails the step', status === 1, String(status));
  }
} finally {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
