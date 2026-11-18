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
run(async () => {
  for (const modern of [false, true]) {
    let calls = 0, timer = 0, listeners = 0;
    const signal = { aborted: true, addEventListener() { listeners++; }, removeEventListener() { listeners--; } };
    const ctx = { Promise, console, setTimeout() { timer++; return 1; }, clearTimeout() { timer--; },
      fetch() { calls++; throw new Error('sync network wrapper error'); } };
    if (modern) ctx.AbortController = AbortController;
    vm.runInNewContext(source('fetch-timeout.js') + '\nthis.fetchJSON = fetchJsonWithTimeout;', ctx);
    await assert.rejects(ctx.fetchJSON('/test', 100, { signal }), { name: 'AbortError' });
    t(`pre-aborted ${modern}: no request or resources`, calls === 0 && timer === 0 && listeners === 0);
    signal.aborted = false;
    await assert.rejects(ctx.fetchJSON('/test', 100, { signal }), /sync network wrapper error/);
    t(`sync throw ${modern}: timer and listener released`, calls === 1 && timer === 0 && listeners === 0);
  }
  for (const timeoutFirst of [false, true]) {
    let now = 0, next = 0;
    const timers = new Map();
    const ctx = { exports: {}, window: {}, console: { debug() {}, warn() {} }, Date: { now: () => now },
      setTimeout(fn) { timers.set(++next, fn); return next; } };
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/app_api/index.ts'), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    vm.runInNewContext(code, ctx);
    const Registry = ctx.exports.ResolveCommandRegistry;
    // The module's eager call plus three startup consumers.
    const pending = [Registry.getInstance(), Registry.getInstance(), Registry.getInstance()];
    t(`resolver ${timeoutFirst}: startup consumers share one poll`, timers.size === 1);
    const drain = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach((fn) => { fn(); }); };
    if (timeoutFirst) {
      const settled = Promise.allSettled(pending);
      now = 31000;
      drain();
      t('resolver: timeout rejects every waiting consumer and leaves no poll',
        (await settled).every((r) => r.status === 'rejected') && timers.size === 0);
    }
    ctx.window._yttv = { Ready: function () {} };
    ctx.window._yttv.Ready.instance = { resolveCommand(command) { return command.test; } };
    let ready;
    if (timeoutFirst) ready = await Promise.all([Registry.getInstance(), Registry.getInstance()]);
    else { drain(); ready = await Promise.all(pending); }
    t(`resolver ${timeoutFirst}: all callers get the same working registry`,
      ready.every((r) => r === ready[0]) && ready[0].dispatchCommand({ test: 'ready' }) === 'ready');
    t(`resolver ${timeoutFirst}: a ready registry needs no new polling`,
      await Registry.getInstance() === ready[0] && timers.size === 0);
  }
  for (const file of ['most-replayed.js', 'time-remaining.js']) {
    let interval = null, starts = 0, clears = 0, reads = 0;
    const doc = new EventTarget();
    doc.hidden = false;
    doc.querySelector = () => { reads++; return null; };
    doc.getElementById = () => { reads++; return null; };
    let watch = true;
    const win = new EventTarget();
    const ctx = { document: doc, window: win, SELECTORS: { PLAYER_ID: 'player' },
      configRead: () => true, configAddChangeListener() {}, isWatchPage: () => watch,
      getVideo: () => null, setInterval(fn) { starts++; interval = fn; return starts; },
      clearInterval() { clears++; interval = null; } };
    vm.runInNewContext(source(file), ctx);
    t(`${file}: one visible timer`, starts === 1 && !!interval);
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    const before = reads;
    t(`${file}: no background timer`, interval === null && clears === 1);
    doc.dispatchEvent(new Event('visibilitychange'));
    t(`${file}: repeated hidden event has no work`, reads === before && clears === 1);
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    t(`${file}: resume immediately checks the page`, starts === 2 && reads > before);
    doc.dispatchEvent(new Event('visibilitychange'));
    t(`${file}: no duplicate visible timer`, starts === 2);
    watch = false; win.dispatchEvent(new Event('ytaf-page-update'));
    t(`${file}: leaving watch clears timer`, interval === null && clears === 2);
    doc.dispatchEvent(new Event('visibilitychange'));
    t(`${file}: browse page stays idle`, starts === 2);
  }
});
