// Is a crash ours? Starts the app in a simulator with or without our bundle
// and reports whether its page crashes within the given seconds.
//   node crash-check.cjs <simulator .exe> <app dir> <with|without> [seconds, 120]
// Run it a few times each way: the webOS 6.0 simulator's page crashes on
// today's YouTube without our code too.
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { sleep, youtubePage, client } = require('./cdp.cjs');

const [exe, appArg, mode, secs = '120'] = process.argv.slice(2);
const port = process.env.PORT || 9229;
const appDir = path.resolve(appArg);
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

(async () => {
  const sim = spawn(exe, [appDir, '{}', `--remote-debugging-port=${port}`], { stdio: 'ignore' });
  const t = await youtubePage(port, 60000);
  if (!t) { console.log('the app did not start'); process.exit(2); }
  const c = client(t.webSocketDebuggerUrl);
  let result = 'ALIVE';
  c.on((msg) => {
    if (msg.method === 'Inspector.targetCrashed') result = 'CRASHED at ' + at();
    if (msg.method === 'Inspector.detached' && result === 'ALIVE') result = 'CLOSED at ' + at();
  });
  if (mode === 'with') {
    // As run-app-test.cjs puts it in: at DOMContentLoaded, once.
    const bundle = fs.readFileSync(path.join(appDir, 'webOSUserScripts', 'userScript.js'), 'utf8');
    const wrapped = `(function(){if(window.__ytafInjected||!/youtube\\.com$/.test(location.host))return;window.__ytafInjected=1;function go(){\n${bundle}\n}` +
      'if(document.readyState!==\'loading\'){go();return;}document.addEventListener(\'DOMContentLoaded\',go);})();';
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: wrapped });
    await c.evaluate(wrapped + ';1');
  }
  await c.send('Runtime.runIfWaitingForDebugger');
  const end = Date.now() + +secs * 1000;
  // eslint-disable-next-line no-unmodified-loop-condition -- the event handler above sets it
  while (Date.now() < end && result === 'ALIVE') await sleep(250);
  console.log(`${mode} our code: ${result}`);
  try { execSync(`taskkill /PID ${sim.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
  process.exit(0);
})();
