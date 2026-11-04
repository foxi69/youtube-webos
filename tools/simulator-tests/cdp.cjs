// A small Chrome DevTools Protocol client (Node 22+, its built-in WebSocket)
// for a webOS TV Simulator started with --remote-debugging-port, or a TV's
// inspector (ares-inspect prints its localhost port). Used by the other
// scripts here, and on its own to look at a running simulator or TV:
//   node cdp.cjs <port> list
//   node cdp.cjs <port> eval <js expression>      on the YouTube page
//   node cdp.cjs <port> key <Key> [keyCode]       a real key press (Enter, ArrowUp, Back 461, Green 404)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stalled endpoint fails after 2 s, so the callers' retry loops go on.
const targets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();

// Before starting a simulator: is something still on the port (an earlier
// simulator, whose page the run would test)? Only a refused connection means
// free; an answer, an empty list or a timeout means in use.
const portInUse = (port) => targets(port).then(() => true, (e) => !(e && e.cause && e.cause.code === 'ECONNREFUSED'));

// The YouTube page: on webOS 22+ (site isolation) the app's start page makes a
// new target when it goes to YouTube, so look for the YouTube URL.
async function youtubePage(port, waitMs = 0) {
  const end = Date.now() + waitMs;
  do {
    try {
      const t = (await targets(port)).find((x) => x.type === 'page' && /youtube\.com/.test(x.url));
      if (t) return t;
    } catch {
      // not up yet
    }
    if (waitMs) await sleep(50);
  } while (Date.now() < end);
  return null;
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const handlers = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else if (msg.method) for (const h of handlers) h(msg);
  };
  const ready = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  // A closed socket (the page or the simulator gone) fails what is pending
  // and what comes after at once, and tells the handlers ({ method: 'closed' }).
  ws.onclose = () => {
    for (const done of waiting.values()) done({ error: { message: 'socket closed' } });
    waiting.clear();
    for (const h of handlers) h({ method: 'closed' });
  };
  const send = (method, params = {}, timeout = 20000) => ready.then(() => new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) return resolve({ error: { message: 'socket closed ' + method } });
    const n = ++id;
    const timer = setTimeout(() => { waiting.delete(n); resolve({ error: { message: 'timeout ' + method } }); }, timeout);
    waiting.set(n, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ id: n, method, params }));
  }));
  // The value of an expression (promises awaited), or { __error }.
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.error) return { __error: r.error.message };
    if (r.result.exceptionDetails) return { __error: (r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text };
    return r.result.result.value;
  };
  // A real key press, as a remote's: YouTube's player controls only come up
  // for these (an in-page KeyboardEvent does not keep them).
  const key = async (keyCode, name = '') => {
    const base = { key: name, code: name, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    const down = keyCode === 13 ? { type: 'keyDown', text: '\r', unmodifiedText: '\r' } : { type: 'rawKeyDown' };
    await send('Input.dispatchKeyEvent', Object.assign(down, base));
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    await sleep(350);
  };
  return { send, evaluate, key, on: (h) => handlers.push(h), close: () => ws.close() };
}

// An in-page key event (as utils.js sendKey does): what YouTube's welcome and
// account screens take, where real CDP keys and pointer clicks do not get through.
const PAGE_KEY = 'function k(code,name){[\'keydown\',\'keyup\'].forEach(function(t){var e=new KeyboardEvent(t,{bubbles:true,cancelable:true,key:name,code:name});Object.defineProperty(e,\'keyCode\',{get:function(){return code}});Object.defineProperty(e,\'which\',{get:function(){return code}});document.body.dispatchEvent(e)})}';

// A value as a JavaScript literal, to put into the code sent to the page:
// JSON with the characters that could end a script or a line escaped.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// The settings panel's labels (config.js), key -> label: effects-page.js
// finds each setting's control by them.
function settingLabels() {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'config.js'), 'utf8');
  const out = {};
  for (const m of src.matchAll(/\['(\w+)',\s*\{[^\n]*?desc:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g)) out[m[1]] = m[3].replace(/\\(.)/g, '$1');
  return out;
}

module.exports = { sleep, targets, portInUse, youtubePage, client, PAGE_KEY, js, settingLabels };

if (require.main === module) {
  const [port, cmd, ...rest] = process.argv.slice(2);
  const KEYS = { Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Back: 461, Green: 404 };
  (async () => {
    if (cmd === 'list') {
      for (const t of await targets(port)) console.log(`${t.type}\t${t.url}`);
      return;
    }
    const t = await youtubePage(port);
    if (!t) throw new Error('no YouTube page on port ' + port);
    const c = client(t.webSocketDebuggerUrl);
    if (cmd === 'eval') {
      const v = await c.evaluate(rest.join(' '));
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    } else if (cmd === 'key') {
      const [name, code] = rest;
      await c.key(+(code || KEYS[name] || 0), name);
      console.log('sent', name);
    } else {
      throw new Error('commands: list, eval <expression>, key <Key> [keyCode]');
    }
    c.close();
  })().catch((e) => { console.error(String(e)); process.exit(1); });
}
