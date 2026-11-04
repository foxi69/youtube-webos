/**
 * Runs the speed probe in each installed webOS TV Simulator and prints what
 * it found, one simulator at a time:
 *
 *   node tools/speed-probe/build.cjs
 *   node tools/speed-probe/run-simulators.cjs <SIMULATOR_DIR> [version ...]
 *
 * SIMULATOR_DIR holds the unzipped simulators (webOS_TV_22_Simulator_1.4.1\
 * webOS_TV_22_Simulator_1.4.1.exe and so on); the versions (6.0, 22, ...)
 * pick some of them. The probe is wrapped in a small web app, the simulator is
 * started with it (as `ares-launch -s` does), the probe posts its results to a
 * local server, and the simulator is closed again.
 *
 * The simulators run Chromium of the TV's version on the PC: this checks that
 * the probe and the method run on each engine, not the TV's own decoders or
 * speed. Full results go to dist/speed-probe/simulators.txt.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const PAGE = path.join(ROOT, 'dist/speed-probe/index.html');
const OUT = path.join(ROOT, 'dist/speed-probe/simulators.txt');
const TIMEOUT_MS = 180000;

const [simDir, ...only] = process.argv.slice(2);
if (!simDir) {
  console.error('Usage: node tools/speed-probe/run-simulators.cjs <SIMULATOR_DIR> [version ...]');
  process.exit(2);
}
if (!fs.existsSync(PAGE)) {
  console.error(`${PAGE} is missing: run node tools/speed-probe/build.cjs first`);
  process.exit(2);
}

function findSimulators() {
  const found = [];
  for (const dir of fs.readdirSync(simDir)) {
    const m = dir.match(/^webOS_TV_([\d.]+)_Simulator_[\d.]+$/);
    if (!m) continue;
    const exe = path.join(simDir, dir, `${dir}.${process.platform === 'win32' ? 'exe' : 'appimage'}`);
    if (fs.existsSync(exe) && (!only.length || only.includes(m[1]))) found.push({ version: m[1], exe });
  }
  return found.sort((a, b) => parseFloat(a.version) - parseFloat(b.version));
}

function makeApp(reportUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-probe-app-'));
  fs.writeFileSync(path.join(dir, 'appinfo.json'), JSON.stringify({
    id: 'com.foxtended.speedprobe',
    version: '1.0.0',
    vendor: 'YouTube Foxtended',
    type: 'web',
    main: 'index.html',
    title: 'Speed Probe',
    icon: 'icon.png'
  }, null, 2));
  fs.copyFileSync(path.join(ROOT, 'assets/icon.png'), path.join(dir, 'icon.png'));
  const html = fs.readFileSync(PAGE, 'utf8').replace('<script', () =>
    `<script>window.PROBE_APP = true; window.PROBE_REPORT = ${JSON.stringify(reportUrl)};</script>\n<script`);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}

function kill(child) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

(async () => {
  const sims = findSimulators();
  if (!sims.length) {
    console.error(`No simulators found in ${simDir}`);
    process.exit(1);
  }
  let pending = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      if (req.method === 'POST' && pending) pending(body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const app = makeApp(url);
  const all = [];

  for (const sim of sims) {
    process.stdout.write(`webOS ${sim.version}: `);
    const started = Date.now();
    const child = spawn(sim.exe, [app, '{}'], { stdio: 'ignore', windowsHide: false });
    const body = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), TIMEOUT_MS);
      pending = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
      child.on('exit', (code) => {
        clearTimeout(timer);
        setTimeout(() => resolve(`EXITED ${code}`), 500);
      });
    });
    pending = null;
    kill(child);
    const secs = Math.round((Date.now() - started) / 1000);
    const first = body ? body.split('\n')[0] : `TIMEOUT after ${TIMEOUT_MS / 1000} s`;
    console.log(`${first} (${secs} s)`);
    all.push(`===== webOS ${sim.version} (${path.basename(sim.exe)}) =====\n${body || first}\n`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  server.close();
  fs.rmSync(app, { recursive: true, force: true });
  fs.writeFileSync(OUT, all.join('\n'));
  console.log(`\nFull results: ${path.relative(ROOT, OUT)}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
