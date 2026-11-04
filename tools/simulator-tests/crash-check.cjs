// Is a crash ours? Starts the app in a simulator with or without our bundle
// and reports whether its page crashes within the given seconds.
//   node crash-check.cjs <simulator .exe> <app dir> <with|without> [seconds, 120]
// Run it a few times each way: the webOS 6.0 simulator's page crashes on
// today's YouTube without our code too.
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { sleep, portInUse, youtubePage, client } = require('./cdp.cjs');

const [exe, appArg, mode, secs = '120'] = process.argv.slice(2);
const port = process.env.PORT || 9229;
const appDir = path.resolve(appArg);
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

(async () => {
  if (await portInUse(port)) {
    console.log(`port ${port} is in use: close the simulator on it, or set PORT`);
    process.exit(2);
  }
  const sim = spawn(exe, [appDir, '{}', `--remote-debugging-port=${port}`], { stdio: 'ignore' });
  let result = 'ALIVE';
  sim.on('exit', () => { if (result === 'ALIVE') result = 'SIMULATOR EXITED at ' + at(); });
  const t = await youtubePage(port, 60000);
  const stopSim = () => { try { execSync(`taskkill /PID ${sim.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } };
  if (!t) {
    console.log('the app did not start');
    stopSim();
    process.exit(2);
  }
  const c = client(t.webSocketDebuggerUrl);
  c.on((msg) => {
    if (msg.method === 'Inspector.targetCrashed') result = 'CRASHED at ' + at();
    if ((msg.method === 'Inspector.detached' || msg.method === 'closed') && result === 'ALIVE') result = 'CLOSED at ' + at();
  });
  if (mode === 'with') {
    // As run-app-test.cjs puts it in: at DOMContentLoaded, once.
    const bundle = fs.readFileSync(path.join(appDir, 'webOSUserScripts', 'userScript.js'), 'utf8');
    const wrapped = `(function(){if(window.__ytafInjected||!/youtube\\.com$/.test(location.host))return;window.__ytafInjected=1;function go(){\n${bundle}\n;window.__ytafRan=1}` +
      'if(document.readyState!==\'loading\'){go();return;}document.addEventListener(\'DOMContentLoaded\',go);})();';
    const reg = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: wrapped });
    const ran = await c.evaluate(wrapped + ';1');
    const failed = (reg.error && reg.error.message) || (ran && ran.__error);
    if (failed) {
      console.log('our code could not be put into the page: ' + failed);
      stopSim();
      process.exit(2);
    }
  }
  await c.send('Runtime.runIfWaitingForDebugger');
  const end = Date.now() + +secs * 1000;
  // eslint-disable-next-line no-unmodified-loop-condition -- the event handler above sets it
  while (Date.now() < end && result === 'ALIVE') await sleep(250);
  // ALIVE with our code only counts when the bundle ran to its end.
  if (mode === 'with' && result === 'ALIVE' && (await c.evaluate('window.__ytafRan')) !== 1) result = 'OUR CODE DID NOT FINISH';
  console.log(`${mode} our code: ${result}`);
  stopSim();
  process.exit(0);
})();
