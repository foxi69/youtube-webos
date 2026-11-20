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
      setTimeout(fn, ms = 0) { env.timers.set(++env.next, { fn, at: env.now + ms }); return env.next; } };
    vm.runInNewContext(transpile('app_api/index.ts'), ctx);
    env.ctx = ctx;
    env.Registry = ctx.exports.ResolveCommandRegistry;
    // Moves the clock to `to`, running each timer due by then at its own time,
    // in order (one set by a timer runs too, when due by `to`).
    env.advance = (to) => {
      for (;;) {
        let id = null, at = Infinity;
        for (const [k, job] of env.timers) if (job.at <= to && job.at < at) { id = k; at = job.at; }
        if (id === null) break;
        const { fn } = env.timers.get(id);
        env.timers.delete(id);
        env.now = Math.max(env.now, at);
        fn();
      }
      env.now = Math.max(env.now, to);
    };
    // Runs the timers set now (late, when the clock was moved past them).
    env.drain = () => env.advance(Math.max(env.now, ...[...env.timers.values()].map((job) => job.at)));
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
      let done = 0;
      pending.forEach((p) => { p.then(() => { done++; }, () => { done++; }); });
      // Every poll due before the deadline runs, at its own time: still
      // looking, every caller waiting.
      const before = env.next;
      env.advance(29900);
      await flush(); await flush();
      t('resolver: before the deadline every consumer still waits, with one poll scheduled',
        done === 0 && env.timers.size === 1 && env.next - before > 20,
        `settled ${done}, timers ${env.timers.size}, polls ${env.next - before}`);
      // The deadline (30 s) plus at most one poll gap (1 s).
      env.advance(31000);
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
    // A throwing candidate before the resolver: passed over, the resolver found.
    const env = resolver();
    env.ready();
    const Ready = env.ctx.window._yttv.Ready;
    env.ctx.window._yttv = { get Broken() { throw new Error('getter failed'); }, Ready };
    // The module's own startup lookup is waiting on its next poll.
    const finding = env.Registry.getInstance();
    env.drain();
    const found = await finding;
    t('resolver: a candidate that throws is passed over for the one after it', found.dispatchCommand({ test: 'next' }) === 'next');
  }
  {
    // A getter that throws a falsy value still fails the scan (no resolver):
    // the callers are told at once, not after the deadline.
    const env = resolver();
    const waiting = env.Registry.getInstance();
    env.ctx.window._yttv = { get First() { throw false; }, get Second() { throw new Error('second'); } };
    env.drain();
    const outcome = await Promise.race([
      waiting.then(() => 'resolved', (e) => 'rejected: ' + e),
      flush().then(flush).then(() => 'still pending')
    ]);
    t('resolver: a scan whose first failure is a thrown false still fails, with no poll left',
      outcome === 'rejected: false' && env.timers.size === 0, outcome);
  }
  {
    // Hooks set while the startup lookup runs out hold once a later lookup
    // finds the resolver.
    const env = resolver();
    const setting = env.Registry.setHooks({ hooked: () => 'from the hook' }).then(() => 'resolved', () => 'rejected');
    env.now = 31000;
    env.drain();
    await flush();
    const startup = await setting;
    env.ready();
    const later = await env.Registry.getInstance();
    t('resolver: hooks set before a failed lookup are in place once a later one finds it',
      startup === 'rejected' && env.ctx.window._yttv.Ready.instance.resolveCommand({ hooked: 1 }) === 'from the hook' &&
      later.dispatchCommand({ test: 'plain' }) === 'plain', startup);
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
    // The queue's command waits for the resolver while the viewer starts
    // another video: that video is not replaced, the queued one plays at the
    // next end.
    const dispatched = [];
    let release = null;
    const win = new EventTarget();
    win.location = { hash: '#/watch?v=current0001' };
    const ctx = { window: win, console, setTimeout, clearTimeout, showNotification() {},
      ResolveCommandRegistry: { getInstance: () => new Promise((resolve) => { release = resolve; }) } };
    vm.runInNewContext(source('video-queue.js') + '\nthis.addToQueue = addToQueue;', ctx);
    const registry = { dispatchCommand: (command) => { dispatched.push(command.watchEndpoint.videoId); } };
    const state = (s, videoId) => win.dispatchEvent(Object.assign(new Event('yt-player-state-change'), { detail: { state: s, videoId } }));
    ctx.addToQueue('queued00001', 'Queued');
    state(1, 'current0001');
    state(0, 'current0001');
    win.location.hash = '#/watch?v=chosen00001';
    state(1, 'chosen00001');
    release(registry);
    await flush();
    t('queue: a video the viewer started while the resolver was looked for is not replaced', dispatched.length === 0, dispatched.join());
    state(0, 'chosen00001');
    release(registry);
    await flush();
    t('...and the queued video plays at the next end', dispatched.join() === 'queued00001', dispatched.join());
    // Control: nothing else starts meanwhile, and the late resolver plays it.
    ctx.addToQueue('queued00002', 'Second');
    state(1, 'queued00001');
    state(0, 'queued00001');
    release(registry);
    await flush();
    t('queue: with no other video meanwhile, the late resolver plays the queued one', dispatched.join() === 'queued00001,queued00002', dispatched.join());
  }
  {
    // The queue with every resolver lookup settled by the test, one by one.
    const queueEnv = () => {
      const env = { lookups: [], dispatched: [], notes: [] };
      const win = new EventTarget();
      win.location = { hash: '#/watch?v=current0001' };
      env.ctx = { window: win, console: { warn() {} }, setTimeout, clearTimeout,
        showNotification: (note) => { env.notes.push(note); },
        ResolveCommandRegistry: { getInstance: () => new Promise((resolve, reject) => { env.lookups.push({ resolve, reject }); }) } };
      vm.runInNewContext(source('video-queue.js') +
        '\nthis.addToQueue = addToQueue; this.clearQueue = clearQueue; this.playNextInQueue = playNextInQueue;' +
        ' this.noteQueuePlayability = noteQueuePlayability;', env.ctx);
      env.registry = { dispatchCommand: (command) => { env.dispatched.push(command.watchEndpoint.videoId); } };
      env.state = (s, videoId) => win.dispatchEvent(Object.assign(new Event('yt-player-state-change'), { detail: { state: s, videoId } }));
      return env;
    };
    {
      // Next pressed again while the first command waits: nothing is lost.
      const env = queueEnv();
      env.ctx.addToQueue('aaaaaaaaaaa', 'A');
      env.ctx.addToQueue('bbbbbbbbbbb', 'B');
      env.ctx.playNextInQueue();
      env.ctx.playNextInQueue();
      t('queue: Next pressed again during the lookup says the video is on its way, with no new lookup',
        env.lookups.length === 1 && env.notes[env.notes.length - 1] === 'On its way: A', `lookups ${env.lookups.length} | ${env.notes.join(' / ')}`);
      env.lookups[0].resolve(env.registry);
      await flush();
      t('...the first video plays once, the second stays queued', env.dispatched.join() === 'aaaaaaaaaaa', env.dispatched.join());
      env.state(1, 'aaaaaaaaaaa');
      env.state(0, 'aaaaaaaaaaa');
      env.lookups[1].resolve(env.registry);
      await flush();
      t('...and the second plays at the end of the first', env.dispatched.join() === 'aaaaaaaaaaa,bbbbbbbbbbb', env.dispatched.join());
    }
    {
      // An earlier attempt for the same video fails after a newer one started
      // (put back by a video the viewer chose, then that one's end).
      const env = queueEnv();
      env.ctx.addToQueue('aaaaaaaaaaa', 'A');
      env.state(1, 'current0001');
      env.state(0, 'current0001');
      env.ctx.window.location.hash = '#/watch?v=chosen00001';
      env.state(1, 'chosen00001');
      env.state(0, 'chosen00001');
      env.lookups[0].reject(new Error('timed out'));
      await flush();
      env.lookups[1].resolve(env.registry);
      await flush();
      t('queue: an earlier attempt failing late neither drops the newer one nor reports a failure',
        env.dispatched.join() === 'aaaaaaaaaaa' && !env.notes.some((note) => note.startsWith('Could not play')),
        `${env.dispatched.join()} | ${env.notes.join(' / ')}`);
    }
    {
      // Another video starts during the lookup, and the player names no id.
      const env = queueEnv();
      env.ctx.addToQueue('aaaaaaaaaaa', 'A');
      env.state(1, 'current0001');
      env.state(0, 'current0001');
      env.ctx.window.location.hash = '#/watch?v=chosen00001';
      env.state(1, null);
      env.lookups[0].resolve(env.registry);
      await flush();
      t('queue: a video playing with no id is not replaced', env.dispatched.length === 0, env.dispatched.join());
      env.state(0, null);
      env.lookups[1].resolve(env.registry);
      await flush();
      t('...and the queued video plays at its end', env.dispatched.join() === 'aaaaaaaaaaa', env.dispatched.join());
    }
    {
      // Queue Next pressed while the current video plays: during the lookup it
      // reports PLAYING again (after buffering), with its id and with none.
      const env = queueEnv();
      env.ctx.addToQueue('aaaaaaaaaaa', 'A');
      env.state(1, 'current0001');
      env.ctx.playNextInQueue();
      env.state(3, 'current0001');
      env.state(1, 'current0001');
      env.state(1, null);
      env.lookups[0].resolve(env.registry);
      await flush();
      t('queue: the video that was on reporting PLAYING again during the lookup does not stop the switch',
        env.dispatched.join() === 'aaaaaaaaaaa' && env.lookups.length === 1, `${env.dispatched.join()} | lookups ${env.lookups.length}`);
    }
    {
      // The queue cleared during the lookup, then another video starts.
      const env = queueEnv();
      env.ctx.addToQueue('aaaaaaaaaaa', 'A');
      env.state(1, 'current0001');
      env.state(0, 'current0001');
      env.ctx.clearQueue();
      env.ctx.window.location.hash = '#/watch?v=other000001';
      env.state(1, 'other000001');
      env.lookups[0].resolve(env.registry);
      await flush();
      env.state(0, 'other000001');
      await flush();
      t('queue: a video cleared during its lookup is neither sent late nor put back',
        env.dispatched.length === 0 && env.lookups.length === 1, `${env.dispatched.join()} | lookups ${env.lookups.length}`);
    }
    // A refusal of the queued video on its way: A is sent at the current
    // video's end, then YouTube answers with `status`; the settle timer is the
    // test's. `before` runs between the send and the answer, `after` before
    // the timer fires. The clock is the test's: it stands 1 ms short of the
    // settle time first, then at it. Returns what was told and sent then, and
    // just before.
    const refusal = async (status, { before = () => {}, after = () => {} } = {}) => {
      const env = queueEnv();
      let now = 0;
      const timers = new Map();
      let nextId = 0;
      env.ctx.setTimeout = (fn, ms = 0) => { timers.set(++nextId, { fn, at: now + ms }); return nextId; };
      env.ctx.clearTimeout = (id) => { timers.delete(id); };
      const advanceTo = (to) => {
        now = to;
        for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
          if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
        }
      };
      env.ctx.addToQueue('aaaaaaaaaaa', 'A');
      env.ctx.addToQueue('bbbbbbbbbbb', 'B');
      env.state(1, 'current0001');
      env.state(0, 'current0001');
      env.lookups[0].resolve(env.registry);
      await flush();
      env.ctx.window.location.hash = '#/watch?v=aaaaaaaaaaa';
      before(env);
      env.ctx.noteQueuePlayability(status);
      after(env);
      advanceTo(1999);
      const early = { refused: env.notes.includes('Could not play: A'), lookups: env.lookups.length };
      advanceTo(2000);
      if (env.lookups[1]) env.lookups[1].resolve(env.registry);
      await flush();
      return { early, refused: env.notes.includes('Could not play: A'), sent: env.dispatched.join() };
    };
    {
      for (const status of ['ERROR', 'UNPLAYABLE']) {
        const r = await refusal(status);
        t(`queue: a queued video refused with ${status}: still waited for at 1999 ms (not reported, nothing next)`,
          !r.early.refused && r.early.lookups === 1, JSON.stringify(r.early));
        t(`queue: ...${status} at 2000 ms: reported, and the next one plays`,
          r.refused && r.sent === 'aaaaaaaaaaa,bbbbbbbbbbb', JSON.stringify(r));
      }
      const r = await refusal('LOGIN_REQUIRED');
      t('...not one the viewer can answer (LOGIN_REQUIRED)', !r.refused && r.sent === 'aaaaaaaaaaa', JSON.stringify(r));
    }
    {
      // The viewer left for another video while the answers settled.
      const r = await refusal('ERROR', { after: (env) => { env.ctx.window.location.hash = '#/watch?v=other000001'; } });
      t('queue: a refusal settling with another video on screen is not reported and moves nothing',
        !r.refused && r.sent === 'aaaaaaaaaaa', JSON.stringify(r));
    }
    {
      // The video that was on reports PLAYING once more before the refusal:
      // the queued one is still on its way. Control: the queued one playing.
      let r = await refusal('ERROR', { before: (env) => env.state(1, 'current0001') });
      t('queue: the previous video playing again does not count as the queued one opening',
        r.refused && r.sent === 'aaaaaaaaaaa,bbbbbbbbbbb', JSON.stringify(r));
      r = await refusal('ERROR', { before: (env) => env.state(1, 'aaaaaaaaaaa') });
      t('...the queued one playing does: a refusal after it moves nothing', !r.refused && r.sent === 'aaaaaaaaaaa', JSON.stringify(r));
    }
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
    // The same registration again: kept once, as by the browser.
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
    // One listener removes the next during a dispatch: the removed one does
    // not run, as with a real EventTarget.
    const ran = [];
    const second = () => { ran.push('second'); };
    target.addEventListener('z', () => { ran.push('first'); target.removeEventListener('z', second); });
    target.addEventListener('z', second);
    target.dispatchEvent(new Event('z'));
    t('legacy EventTarget: a listener removed during the dispatch does not run', ran.join() === 'first', ran.join());
    // A once listener that dispatches its own event: it is gone before it runs.
    let inner = 0;
    const reenter = () => { inner++; if (inner === 1) target.dispatchEvent(new Event('r')); };
    target.addEventListener('r', reenter, { once: true });
    target.dispatchEvent(new Event('r'));
    t('legacy EventTarget: a once listener dispatching its own event runs once', inner === 1, inner);
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
    const before = reads;
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    t(`${file}: hidden, the running interval is the one cleared, with no page read`,
      intervals.size === 0 && reads === before, `${intervals.size} ${reads - before}`);
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
