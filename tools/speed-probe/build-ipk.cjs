/**
 * Packs the speed probe (issue #97) as a small webOS app, so it runs on the
 * engine the TV's apps use. The TV's Web Browser can have a newer one (a
 * webOS 4.10 TV: Chromium 79 in the browser), so the page alone does not say
 * what the speed engine would run on.
 *
 *   node tools/speed-probe/build.cjs
 *   node tools/speed-probe/build-ipk.cjs
 *
 * Writes dist/speed-probe/speed-probe-<version>-beta.ipk. It needs
 * ares-package (webOS CLI). The app's id is its own, so installing it changes
 * nothing in the YouTube app.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'dist/speed-probe');
const APP = path.join(OUT, 'app');
// webOS takes numbers only here, so "beta" goes into the title and the file name.
const VERSION = '0.9.2';

fs.rmSync(APP, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(APP, 'appinfo.json'), JSON.stringify({
  id: 'com.foxtended.speedprobe',
  version: VERSION,
  vendor: 'YouTube Foxtended',
  type: 'web',
  main: 'index.html',
  title: 'Speed Probe Beta',
  icon: 'icon.png',
  requiredACG: []
}, null, 2));
fs.copyFileSync(path.join(ROOT, 'assets/icon.png'), path.join(APP, 'icon.png'));
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8').replace('<script', () =>
  '<script>window.PROBE_APP = true;</script>\n<script');
fs.writeFileSync(path.join(APP, 'index.html'), html);
execSync(`ares-package -n "${APP}" -o "${OUT}"`, { stdio: 'inherit' });
fs.renameSync(path.join(OUT, `com.foxtended.speedprobe_${VERSION}_all.ipk`), path.join(OUT, `speed-probe-${VERSION}-beta.ipk`));
