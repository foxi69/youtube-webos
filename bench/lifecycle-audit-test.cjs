// Regression checks for background polling and fetch cancellation/cleanup.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { createReporter } = require('./harness.cjs');
const { t, run } = createReporter();
const source = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const transpile = (file) => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A promise that never settles leaves no real timer behind, so Node would exit
// with status 0 before the checks after it ran: that is a failure too.
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.log('FAIL lifecycle-audit: the checks did not run to the end (a promise never settled)');
    process.exitCode = 1;
  }
});

run(async () => {
  for (const modern of [false, true]) {
    // The exact timer handle and abort listener made must be the ones released.
    let calls = 0, next = 0;
    const timers = new Set(), listeners = new Set();
    let timersMade = 0, listenersAdded = 0;
    const signal = {
      aborted: true,
      addEventListener(type, cb) { listenersAdded++; listeners.add(cb); },
      removeEventListener(type, cb) { listeners.delete(cb); }
    };
    const ctx = { Promise, console, setTimeout() { timersMade++; timers.add(++next); return next; },
      clearTimeout(handle) { timers.delete(handle); },
      fetch() { calls++; throw new Error('sync network wrapper error'); } };
    if (modern) ctx.AbortController = AbortController;
    vm.runInNewContext(source('fetch-timeout.js') + '\nthis.fetchJSON = fetchJsonWithTimeout;', ctx);
    await assert.rejects(ctx.fetchJSON('/test', 100, { signal }), { name: 'AbortError' });
    t(`pre-aborted ${modern}: no request or resources`, calls === 0 && timersMade === 0 && listenersAdded === 0);
    signal.aborted = false;
    await assert.rejects(ctx.fetchJSON('/test', 100, { signal }), /sync network wrapper error/);
    t(`sync throw ${modern}: the timer and listener it made are the ones released`,
      calls === 1 && timersMade === 1 && listenersAdded === 1 && timers.size === 0 && listeners.size === 0,
      `made ${timersMade}/${listenersAdded}, left ${timers.size}/${listeners.size}`);
  }

  // The resolveCommand lookup, with a clock and timers in the test's hands.
  const resolver = () => {
    const env = { now: 0, next: 0, timers: new Map() };
    const ctx = { exports: {}, window: {}, console: { debug() {}, warn() {} }, Date: { now: () => env.now },
      setTimeout(fn) { env.timers.set(++env.next, fn); return env.next; } };
    vm.runInNewContext(transpile('app_api/index.ts'), ctx);
    env.ctx = ctx;
    env.Registry = ctx.exports.ResolveCommandRegistry;
    env.drain = () => { const jobs = [...env.timers.values()]; env.timers.clear(); jobs.forEach((fn) => { fn(); }); };
    env.ready = () => {
      ctx.window._yttv = { Ready: function () {} };
      ctx.window._yttv.Ready.instance = { resolveCommand(command) { return command.test; } };
    };
    return env;
  };
  for (const timeoutFirst of [false, true]) {
    const env = resolver();
    const { Registry } = env;
    // The module's eager call plus three startup consumers.
    const pending = [Registry.getInstance(), Registry.getInstance(), Registry.getInstance()];
    t(`resolver ${timeoutFirst}: startup consumers share one poll`, env.timers.size === 1);
    if (timeoutFirst) {
      const settled = Promise.allSettled(pending);
      env.now = 31000;
      env.drain();
      t('resolver: timeout rejects every waiting consumer and leaves no poll',
        (await settled).every((r) => r.status === 'rejected') && env.timers.size === 0);
    }
    env.ready();
    let ready;
    if (timeoutFirst) ready = await Promise.all([Registry.getInstance(), Registry.getInstance()]);
    else { env.drain(); ready = await Promise.all(pending); }
    t(`resolver ${timeoutFirst}: all callers get the same working registry`,
      ready.every((r) => r === ready[0]) && ready[0].dispatchCommand({ test: 'ready' }) === 'ready');
    t(`resolver ${timeoutFirst}: a ready registry needs no new polling`,
      await Registry.getInstance() === ready[0] && env.timers.size === 0);
  }
  {
    // A scan that throws (a YouTube getter) ends the lookup instead of
    // leaving its callers waiting for good.
    const env = resolver();
    const waiting = env.Registry.getInstance();
    let throwing = true;
    env.ctx.window._yttv = { get Broken() { if (throwing) throw new Error('getter failed'); return null; } };
    env.drain();
    const outcome = await Promise.race([
      waiting.then(() => 'resolved', (e) => 'rejected: ' + e.message),
      flush().then(flush).then(() => 'still pending')
    ]);
    t('resolver: a scan that throws rejects the lookup and leaves no poll',
      outcome === 'rejected: getter failed' && env.timers.size === 0, outcome);
    throwing = false;
    env.ready();
    const again = await env.Registry.getInstance();
    t('...and a later caller finds the registry', again.dispatchCommand({ test: 'again' }) === 'again');
  }
  {
    // A caller that joined a lookup started long before it gets a fresh one
    // when that lookup runs out; the caller that started it does not.
    const env = resolver();
    const first = env.Registry.getInstance().then(() => 'resolved', () => 'rejected');
    env.now = 1000;
    const early = env.Registry.getInstance().then(() => 'resolved', () => 'rejected');
    env.now = 20000;
    const late = env.Registry.getInstance();
    env.now = 31000;
    env.drain();
    await flush(); await flush();
    t('resolver: the lookup runs out: its own caller and an early joiner are told, a late joiner starts one fresh lookup',
      await first === 'rejected' && await early === 'rejected' && env.timers.size === 1, `timers ${env.timers.size}`);
    env.ready();
    env.drain();
    const found = await late;
    t('...and the late joiner gets the registry once it appears', found.dispatchCommand({ test: 'late' }) === 'late');
  }

  {
    // The legacy EventTarget stand-in (no constructible EventTarget, Chrome
    // before 64): once, and one registration per capture mode.
    const ctx = { exports: {}, console, Map, CustomEvent: class {} };
    vm.runInNewContext(transpile('custom-event-target.ts'), ctx);
    const target = new ctx.exports.CustomEventTarget();
    let once = 0, both = 0;
    target.addEventListener('x', () => { once++; }, { once: true });
    const cb = () => { both++; };
    target.addEventListener('y', cb, false);
    target.addEventListener('y', cb, { capture: true });
    target.removeEventListener('y', cb, false);
    target.dispatchEvent(new Event('x'));
    target.dispatchEvent(new Event('x'));
    target.dispatchEvent(new Event('y'));
    t('legacy EventTarget: a once listener runs once', once === 1, once);
    t('legacy EventTarget: removing the bubble registration keeps the capture one', both === 1, both);
    target.removeEventListener('y', cb, true);
    target.dispatchEvent(new Event('y'));
    t('...which goes with its own removal', both === 1, both);
  }

  for (const file of ['most-replayed.js', 'time-remaining.js']) {
    // Intervals by handle: clearing must stop the one that runs.
    const intervals = new Map();
    let next = 0, reads = 0;
    const doc = new EventTarget();
    doc.hidden = false;
    doc.querySelector = () => { reads++; return null; };
    doc.getElementById = () => { reads++; return null; };
    let watch = true;
    const win = new EventTarget();
    const ctx = { document: doc, window: win, SELECTORS: { PLAYER_ID: 'player' },
      configRead: () => true, configAddChangeListener() {}, isWatchPage: () => watch,
      getVideo: () => null, setInterval(fn) { intervals.set(++next, fn); return next; },
      clearInterval(handle) { intervals.delete(handle); } };
    vm.runInNewContext(source(file), ctx);
    t(`${file}: one visible timer`, intervals.size === 1);
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    const before = reads;
    t(`${file}: hidden, the running interval is the one cleared`, intervals.size === 0, intervals.size);
    doc.dispatchEvent(new Event('visibilitychange'));
    t(`${file}: repeated hidden event has no work`, reads === before && intervals.size === 0);
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    t(`${file}: resume immediately checks the page, with exactly one interval`, intervals.size === 1 && reads > before);
    doc.dispatchEvent(new Event('visibilitychange'));
    t(`${file}: no duplicate visible timer`, intervals.size === 1 && next === 2);
    watch = false; win.dispatchEvent(new Event('ytaf-page-update'));
    t(`${file}: leaving watch clears timer`, intervals.size === 0);
    doc.dispatchEvent(new Event('visibilitychange'));
    t(`${file}: browse page stays idle`, intervals.size === 0 && next === 2);
  }
  finished = true;
});
