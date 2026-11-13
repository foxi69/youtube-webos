#!/usr/bin/env node
/**
 * Brings main up to a published release, so the repository always names the
 * latest one: the version in package.json, package-lock.json and
 * assets/appinfo.json (what a local build and its About tab show), and the
 * three version flags of screenshots/fork-trail.svg (the last three releases,
 * oldest first). Run by .github/workflows/build_repo.yml on a full release.
 *
 * Each file only moves forward: a release older than the version it already
 * has (a fix on an older line) leaves it alone.
 *
 * Usage: node tools/release-bump.cjs <version> [repository root]
 */
const fs = require('fs');
const path = require('path');

const VERSION = /^\d+\.\d+\.\d+$/;
const FLAG = /(<text [^>]*>)(\d+\.\d+\.\d+)(<\/text>)/g;

/** Whether version a is above version b. */
function isNewer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The trail with the new release as its last flag, or null if it has it already. */
function advanceTrail(svg, version) {
  const flags = [...svg.matchAll(FLAG)].map((m) => m[2]);
  if (flags.length !== 3) throw new Error(`fork-trail.svg: expected 3 version flags, found ${flags.length}`);
  if (!isNewer(version, flags[2])) return null;
  const next = flags.slice(1).concat(version);
  let i = 0;
  return svg
    .replace(FLAG, (all, open, old, close) => open + next[i++] + close)
    .replace(/aria-label="[^"]*"/, `aria-label="Fox paw prints walking from version ${next[0]} to ${next[1]} to ${next[2]}"`);
}

/** Updates the files under root; returns the ones it changed. */
function bump(version, root) {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
  const changed = [];
  const at = (name) => path.join(root, name);

  // Each version field on its own: one raised by hand (package.json, say)
  // must not keep the others behind, and none is ever lowered. A missing or
  // malformed one is written.
  const older = (v) => typeof v !== 'string' || !VERSION.test(v) || isNewer(version, v);
  const manifests = [
    ['package.json', (p) => [p]],
    ['package-lock.json', (l) => [l, l.packages && l.packages['']]],
    ['assets/appinfo.json', (a) => [a]]
  ];
  for (const [name, fields] of manifests) {
    const file = at(name);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stale = fields(data).filter((o) => o && typeof o === 'object' && older(o.version));
    if (!stale.length) continue;
    for (const o of stale) o.version = version;
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    changed.push(name);
  }

  const trailFile = at('screenshots/fork-trail.svg');
  const trail = advanceTrail(fs.readFileSync(trailFile, 'utf8'), version);
  if (trail !== null) {
    fs.writeFileSync(trailFile, trail);
    changed.push('screenshots/fork-trail.svg');
  }
  return changed;
}

module.exports = { isNewer, advanceTrail, bump };

if (require.main === module) {
  const [version, root = path.join(__dirname, '..')] = process.argv.slice(2);
  try {
    const changed = bump(String(version || '').replace(/^v/, ''), root);
    console.log(changed.length ? `Updated to ${version}: ${changed.join(', ')}` : `Already at ${version} or newer`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
