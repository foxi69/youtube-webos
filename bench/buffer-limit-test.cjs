/**
 * The SourceBuffer memory cap (src/hooks/buffer-limit.js), on a fake
 * MediaSource, SourceBuffer and <video>, alone and under the playback speed's
 * MediaSource hook (src/speed/mse-hook.js) as on webOS 4-6.
 *
 * Played media more than 30 s behind is removed every 5 s, and an append
 * that lands while that remove runs waits for it (a real SourceBuffer would
 * throw InvalidStateError, and playback would stall). With the speed hook,
 * that wait must also cover the first video, and a stand-in audio
 * SourceBuffer added first must not keep the real ones unguarded.
 *
 * Usage: node bench/buffer-limit-test.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');

// mse-hook.js imports '../custom-event-target' (a .ts file) without its extension.
require('./ts-resolve.cjs');

const LIMIT = pathToFileURL(path.resolve(__dirname, '../src/hooks/buffer-limit.js')).href;
const MSE = pathToFileURL(path.resolve(__dirname, '../src/speed/mse-hook.js')).href;

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

const ranges = (list) => ({ length: list.length, start: (i) => list[i][0], end: (i) => list[i][1] });

/**
 * Fake MSE in the globals buffer-limit.js reads. A SourceBuffer is updating
 * from remove() until finish() is called, and throws on an append meanwhile,
 * as a real one does.
 */
function installGlobals() {
  class SourceBuffer extends EventTarget {
    constructor(mime) {
      super();
      this.mime = mime;
      this.updating = false;
      this._buf = [[0, 120]];
      this.appended = [];
      this.removed = [];
    }
    get buffered() { return ranges(this._buf); }
    appendBuffer(data) {
      if (this.updating) {
        const e = new Error('InvalidStateError');
        e.name = 'InvalidStateError';
        throw e;
      }
      this.appended.push(data);
      // A real append runs until its updateend; off by default here.
      if (this.appendUpdates) this.updating = true;
    }
    remove(start, end) {
      this.removed.push([start, end]);
      this.updating = true;
    }
    finish() {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    }
  }
  for (const prop of ['timestampOffset', 'appendWindowStart', 'appendWindowEnd']) {
    Object.defineProperty(SourceBuffer.prototype, prop, {
      configurable: true,
      get() { return this['_' + prop] || 0; },
      set(v) { this['_' + prop] = v; }
    });
  }
  class MediaSource {
    constructor() { this.readyState = 'open'; this._sbs = []; }
    addSourceBuffer(mime) {
      const sb = new SourceBuffer(mime);
      this._sbs.push(sb);
      return sb;
    }
    get sourceBuffers() {
      const list = { length: this._sbs.length, item: (i) => this._sbs[i] };
      this._sbs.forEach((sb, i) => { list[i] = sb; });
      return list;
    }
  }
  let n = 0;
  const videos = [];
  let tick = null;
  Object.assign(globalThis, {
    MediaSource,
    window: globalThis,
    document: { getElementsByTagName: (tag) => (tag === 'video' ? videos : []) },
    setInterval: (fn) => { tick = fn; return 1; }
  });
  globalThis.URL = { createObjectURL: () => `blob:${++n}`, revokeObjectURL: () => {} };
  const video = (ct, src = '') => {
    const v = { currentTime: ct, currentSrc: src, srcObject: null };
    videos.push(v);
    return v;
  };
  return { SourceBuffer, MediaSource, videos, video, tick: () => tick() };
}

let fresh = 0;
/** A new instance of buffer-limit.js (its state is per module). */
const loadLimit = () => import(`${LIMIT}?${++fresh}`);

(async () => {
  // ---- Trimming ----
  {
    const g = installGlobals();
    const { initBufferLimit } = await loadLimit();
    initBufferLimit();
    const ms = new globalThis.MediaSource();
    const url = URL.createObjectURL(ms);
    g.video(100, url);
    const sb = ms.addSourceBuffer('video/mp4');
    g.tick();
    t('trim: what is over 30 s behind the playhead is removed', sb.removed.length === 1 &&
      sb.removed[0][0] === 0 && sb.removed[0][1] === 70, JSON.stringify(sb.removed));
    g.tick();
    t('trim: not while the remove still runs', sb.removed.length === 1);

    // An append while the remove runs waits for it, then goes in once.
    let threw = null;
    try { sb.appendBuffer('a1'); } catch (e) { threw = e.name; }
    t('trim: an append during the remove waits instead of throwing', threw === null && sb.appended.length === 0, threw);
    sb.finish();
    t('trim: then it is appended, once', sb.appended.join() === 'a1');
    sb.finish();
    t('trim: and only once', sb.appended.join() === 'a1');
    sb.appendBuffer('a2');
    t('trim: later appends go straight in', sb.appended.join() === 'a1,a2');

    sb._buf = [[65, 120]];
    g.tick();
    t('trim: no remove for less than 10 s', sb.removed.length === 1);
    g.videos[0].currentTime = 20;
    sb._buf = [[0, 60]];
    g.tick();
    t('trim: nothing in the first 30 s of a video', sb.removed.length === 1);

    // Two videos: the MediaSource's own <video> decides, not the other one.
    g.videos[0].currentTime = 200;
    g.videos.unshift({ currentTime: 50, currentSrc: 'blob:other', srcObject: null });
    sb._buf = [[0, 220]];
    g.tick();
    t('trim: the MediaSource\'s own <video> by its object URL', sb.removed.length === 2 && sb.removed[1][1] === 170,
      JSON.stringify(sb.removed));
    sb.finish();

    ms.readyState = 'closed';
    const stats = globalThis.__ytafBufferStats();
    g.tick();
    t('trim: a closed globalThis.MediaSource is let go', globalThis.__ytafBufferStats().buffers.length === 0 && stats.buffers.length === 1 &&
      stats.appendPatched === true, JSON.stringify(stats));
  }

  // ---- The player's own append comes first when the trim ends ----
  // Its updateend listener (added before the held-back append's) runs first
  // and appends its next piece: the held-back one then waits for that append
  // instead of throwing InvalidStateError and being lost (from #129).
  {
    const g = installGlobals();
    const { initBufferLimit } = await loadLimit();
    initBufferLimit();
    const ms = new globalThis.MediaSource();
    g.video(100, URL.createObjectURL(ms));
    const sb = ms.addSourceBuffer('video/mp4');
    sb.appendUpdates = true;
    let playerTurn = true;
    sb.addEventListener('updateend', () => { if (playerTurn) { playerTurn = false; sb.appendBuffer('B'); } });
    g.tick();
    let threw = null;
    try { sb.appendBuffer('A'); } catch (e) { threw = e.name; }
    sb.finish(); // the trim ends: the player's B goes first
    sb.finish(); // B ends: the held-back A goes in
    t('trim: a held-back append waits for the player\'s own append, and is not lost',
      sb.removed.length === 1 && threw === null && sb.appended.join() === 'B,A',
      threw || `${sb.removed.length} removes, appended ${sb.appended.join()}`);
  }

  // ---- A stand-in SourceBuffer added first leaves the real ones guarded ----
  {
    const g = installGlobals();
    const { initBufferLimit } = await loadLimit();
    // A globalThis.MediaSource whose first SourceBuffer is not a real one (as the speed
    // hook's audio stand-in is).
    class StandIn extends EventTarget {
      constructor() { super(); this.updating = false; }
      get buffered() { return ranges([]); }
      appendBuffer() {}
      remove() {}
    }
    const realAdd = globalThis.MediaSource.prototype.addSourceBuffer;
    globalThis.MediaSource.prototype.addSourceBuffer = function (mime) {
      return mime.startsWith('audio/') ? new StandIn() : realAdd.call(this, mime);
    };
    initBufferLimit();
    const ms = new globalThis.MediaSource();
    g.video(100, URL.createObjectURL(ms));
    ms.addSourceBuffer('audio/mp4');
    const sb = ms.addSourceBuffer('video/mp4');
    g.tick();
    let threw = null;
    try { sb.appendBuffer('v1'); } catch (e) { threw = e.name; }
    sb.finish();
    t('stand-in first: an append during the real SourceBuffer\'s trim still waits', sb.removed.length === 1 &&
      threw === null && sb.appended.join() === 'v1', threw || sb.appended.join());
  }

  // ---- Under the speed hook (webOS 4-6): the first video is guarded too ----
  {
    const g = installGlobals();
    const { installMseHook } = await import(MSE);
    const { initBufferLimit } = await loadLimit();
    // A <video> element type for the speed hook's src handling.
    class HTMLMediaElement {}
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      get() { return this._src; },
      set(v) { this._src = v; }
    });
    const win = { MediaSource: globalThis.MediaSource, URL, HTMLMediaElement, EventTarget, Event };
    // The speed hook first, then the buffer limit around it, as the app does.
    const hook = installMseHook(win, {
      getSpeed: () => 1.5,
      createAudioSink: () => ({ configure() {}, push() {}, discard() {}, reset() {}, video: null }),
      onRateRequest: () => {},
      onError: (e) => { throw e; },
      onNativeAudio: () => {}
    });
    initBufferLimit();
    const ms = new globalThis.MediaSource();
    g.video(100, URL.createObjectURL(ms));
    // YouTube's first SourceBuffers after the app starts.
    ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.640028"');
    // The speed hook reports buffered in content time: 120 s of element time is 180 s.
    g.videos[0].currentTime = 150;
    g.tick();
    const media = new Uint8Array([0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]);
    let threw = null;
    try { sb.appendBuffer(media); } catch (e) { threw = e.name; }
    sb.finish();
    t('speed hook: the first video\'s append during a trim waits for it', sb.removed.length === 1 && threw === null &&
      sb.appended.length === 1, threw || `${sb.removed.length} removes, ${sb.appended.length} appends`);
    t('speed hook: the trim is in element time (content 120 s is 80 s)', sb.removed.length === 1 &&
      sb.removed[0][1] === 80, JSON.stringify(sb.removed));
    hook.uninstall();

    // A SourceBuffer without one of the properties the hook converts: left
    // as it is, not an exception out of addSourceBuffer (no video at all).
    delete g.SourceBuffer.prototype.appendWindowStart;
    const hook2 = installMseHook(win, {
      getSpeed: () => 1.5,
      createAudioSink: () => ({ configure() {}, push() {}, discard() {}, reset() {}, video: null }),
      onRateRequest: () => {},
      onError: () => {},
      onNativeAudio: () => {}
    });
    let err = null;
    try { new globalThis.MediaSource().addSourceBuffer('video/mp4; codecs="avc1.640028"'); } catch (e) { err = e; }
    t('speed hook: a SourceBuffer lacking appendWindowStart still gets made', err === null, err && err.message);
    hook2.uninstall();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
