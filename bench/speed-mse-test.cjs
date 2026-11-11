/**
 * The playback speed's MediaSource hook (src/speed/mse-hook.js) on a fake
 * MediaSource, SourceBuffer and <video>.
 *
 * Off 1x the video SourceBuffer gets its init's time scale rewritten and
 * every time it is told converted, the audio goes to a stand-in SourceBuffer
 * that hands the frames to the engine, and the <video> reports content time.
 * Checked here: what reaches the real SourceBuffer, what the engine gets, the
 * stand-in's events and errors as a real SourceBuffer has them, and that the
 * element is left alone once another video starts.
 *
 * Usage: node bench/speed-mse-test.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');
const {
  box, bytes, mp4Init, mp4Fragment, audioSampleEntry, esds, ASC, frameBytes, MP4_TIMESCALE, webmInit, cluster
} = require('./speed-fixtures.cjs');

// mse-hook.js imports '../custom-event-target' (a .ts file) without its extension.
require('./ts-resolve.cjs');

const MSE = pathToFileURL(path.resolve(__dirname, '../src/speed/mse-hook.js')).href;

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

const ranges = (list) => ({ length: list.length, start: (i) => list[i][0], end: (i) => list[i][1] });
const accessor = (proto, prop, field) =>
  Object.defineProperty(proto, prop, {
    configurable: true,
    get() { return this[field]; },
    set(v) { this[field] = v; }
  });

/** A fake browser: MediaSource, SourceBuffer, <video> and object URLs, each recording what it is given. */
function makeWin() {
  class SourceBuffer {
    constructor(mime) {
      this.mime = mime;
      this.appends = [];
      this.removes = [];
      this._tso = 0;
      this._aws = 0;
      this._awe = Infinity;
      this._buf = [[0, 10]];
    }
    appendBuffer(data) {
      this.appends.push(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    }
    remove(start, end) { this.removes.push([start, end]); }
  }
  accessor(SourceBuffer.prototype, 'timestampOffset', '_tso');
  accessor(SourceBuffer.prototype, 'appendWindowStart', '_aws');
  accessor(SourceBuffer.prototype, 'appendWindowEnd', '_awe');
  Object.defineProperty(SourceBuffer.prototype, 'buffered', { configurable: true, get() { return ranges(this._buf); } });

  class MediaSource {
    constructor() { this._sbs = []; this._dur = NaN; }
    addSourceBuffer(mime) {
      const sb = new SourceBuffer(mime);
      this._sbs.push(sb);
      return sb;
    }
  }
  accessor(MediaSource.prototype, 'duration', '_dur');
  Object.defineProperty(MediaSource.prototype, 'sourceBuffers', {
    configurable: true,
    get() {
      const list = { length: this._sbs.length, item: (i) => this._sbs[i] };
      this._sbs.forEach((sb, i) => { list[i] = sb; });
      return list;
    }
  });

  class HTMLMediaElement {
    constructor() {
      this._src = '';
      this._ct = 0;
      this._dur = NaN;
      this._rate = 1;
      this._buf = [[0, 20]];
    }
  }
  accessor(HTMLMediaElement.prototype, 'src', '_src');
  accessor(HTMLMediaElement.prototype, 'currentTime', '_ct');
  accessor(HTMLMediaElement.prototype, 'duration', '_dur');
  accessor(HTMLMediaElement.prototype, 'playbackRate', '_rate');
  Object.defineProperty(HTMLMediaElement.prototype, 'buffered', { configurable: true, get() { return ranges(this._buf); } });
  Object.defineProperty(HTMLMediaElement.prototype, 'seekable', { configurable: true, get() { return ranges([[0, 30]]); } });
  class HTMLVideoElement extends HTMLMediaElement {}

  let n = 0;
  const URL = {
    createObjectURL: () => `blob:${++n}`,
    revokeObjectURL: () => {}
  };
  return { MediaSource, HTMLMediaElement, HTMLVideoElement, SourceBuffer, URL, EventTarget, Event };
}

/** The hook on a fake browser, at `speed` (a function, to change it later). */
async function setup(speedFn) {
  const { installMseHook } = await import(MSE);
  const win = makeWin();
  const env = { win, sinks: [], errors: [], rates: [], native: 0 };
  env.hook = installMseHook(win, {
    getSpeed: speedFn,
    createAudioSink: ({ speed, element }) => {
      const sink = {
        speed, element, video: element, configs: [], pushed: [], discards: [], resets: 0,
        configure(cfg) { sink.configs.push(cfg); },
        push(samples) { sink.pushed.push(...samples); },
        discard(a, b) { sink.discards.push([a, b]); },
        reset() { sink.resets++; }
      };
      env.sinks.push(sink);
      return sink;
    },
    onRateRequest: (r) => env.rates.push(r),
    onError: (e) => env.errors.push(e),
    onNativeAudio: () => env.native++
  });
  /** A MediaSource attached to a new <video>, as YouTube does it. */
  env.open = () => {
    const ms = new win.MediaSource();
    const el = new win.HTMLVideoElement();
    el.src = win.URL.createObjectURL(ms);
    return { ms, el };
  };
  return env;
}

const flush = () => new Promise((r) => setImmediate(r));
const VIDEO_MP4 = 'video/mp4; codecs="avc1.640028"';
const AUDIO_MP4 = 'audio/mp4; codecs="mp4a.40.2"';
const AUDIO_WEBM = 'audio/webm; codecs="opus"';
const videoInit = (timescale = 90000) => mp4Init({ entry: box('avc1', new Array(78).fill(0)), timescale });
const aacInit = () => mp4Init({ entry: audioSampleEntry('mp4a', 2, MP4_TIMESCALE, esds(ASC)) });
const mdhdTimescale = (u8) => {
  for (let i = 0; i + 4 < u8.length; i++) {
    if (u8[i] === 0x6d && u8[i + 1] === 0x64 && u8[i + 2] === 0x68 && u8[i + 3] === 0x64) {
      const p = i + 4 + 4 + 8;
      return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
    }
  }
  return null;
};

(async () => {
  const { SpeedTimeMap, isSupportedSpeed } = await import(MSE);

  // ---- The time map ----
  {
    const m = new SpeedTimeMap(1.5);
    t('time map: content and element time', m.toElement(30) === 20 && m.toContent(20) === 30);
    let threw = false;
    try { new SpeedTimeMap(3); } catch { threw = true; }
    t('time map: an unsupported speed is refused', threw && !isSupportedSpeed(3) && isSupportedSpeed(0.25));
    const r = m.mapRanges(ranges([[2, 4]]), 'toContent');
    let out = false;
    try { r.start(1); } catch (e) { out = e instanceof RangeError; }
    t('time map: ranges mapped, an index out of range throws', r.start(0) === 3 && r.end(0) === 6 && out);
  }

  // ---- 1x: everything native ----
  {
    const env = await setup(() => 1);
    const { ms } = env.open();
    const v = ms.addSourceBuffer(VIDEO_MP4);
    const a = ms.addSourceBuffer(AUDIO_MP4);
    t('1x: native SourceBuffers, no audio engine', v instanceof env.win.SourceBuffer && a instanceof env.win.SourceBuffer &&
      env.sinks.length === 0);
    t('1x: the previous engine is told to stop (native audio plays)', env.native === 1);
    env.hook.uninstall();
  }

  // ---- The speed is decided once per MediaSource ----
  {
    let speed = 1.5;
    const env = await setup(() => speed);
    const { ms } = env.open();
    ms.addSourceBuffer(VIDEO_MP4);
    speed = 1;
    const a = ms.addSourceBuffer(AUDIO_MP4);
    t('the speed is decided at the first SourceBuffer: the audio follows the video', !(a instanceof env.win.SourceBuffer) &&
      env.sinks.length === 1 && env.native === 0);
    const { ms: ms2 } = env.open();
    t('a new MediaSource reads the speed again', ms2.addSourceBuffer(AUDIO_MP4) instanceof env.win.SourceBuffer);
    env.hook.uninstall();
  }

  // ---- 1.5x: the video SourceBuffer ----
  {
    const env = await setup(() => 1.5);
    const { ms } = env.open();
    const v = ms.addSourceBuffer(VIDEO_MP4);
    const init = videoInit();
    v.appendBuffer(init.buffer);
    t('video: the init\'s timescale x 1.5', mdhdTimescale(v.appends[0]) === 135000 && v.appends[0].length === init.length,
      mdhdTimescale(v.appends[0]));
    const media = Uint8Array.from(mp4Fragment([frameBytes(0)], 0, 1));
    v.appendBuffer(media);
    t('video: media passes through unchanged', v.appends[1].length === media.length && v.appends[1].every((b, i) => b === media[i]));
    const webm = ms.addSourceBuffer('video/webm; codecs="vp9"');
    webm.appendBuffer(webmInit());
    t('video WebM: the TimecodeScale / 1.5', webm.appends[0].length === webmInit().length && env.errors.length === 0);
    // An init cut across two appends cannot be rewritten: reported (the speed
    // falls back to 1x), appended as it is. Cut after the ftyp, and inside the moov.
    v.appendBuffer(init.subarray(0, 20));
    v.appendBuffer(init.subarray(0, 30));
    t('video: an init split across appends is reported and appended unchanged',
      env.errors.length === 2 && /split/.test(env.errors[0].message) && /mdhd/.test(env.errors[1].message) &&
        v.appends[2].length === 20 && v.appends[3].length === 30, env.errors.map((e) => e.message).join(' | '));
    v.timestampOffset = 15;
    t('video: timestampOffset in content time (15 s is 10 s of element time)', v._tso === 10 && v.timestampOffset === 15);
    v.appendWindowEnd = Infinity;
    v.appendWindowStart = 3;
    t('video: append window converted too', v._aws === 2 && v.appendWindowStart === 3 && v.appendWindowEnd === Infinity);
    t('video: buffered in content time', v.buffered.end(0) === 15);
    v.remove(30, Infinity);
    t('video: remove() in content time', v.removes[0][0] === 20 && v.removes[0][1] === Infinity);
    ms.duration = 150;
    t('MediaSource: duration in content time', ms._dur === 100 && ms.duration === 150);
    env.hook.uninstall();
  }

  // ---- 1.5x: the audio stand-in ----
  {
    const env = await setup(() => 1.5);
    const { ms, el } = env.open();
    ms.addSourceBuffer(VIDEO_MP4);
    const a = ms.addSourceBuffer(AUDIO_MP4);
    const sink = env.sinks[0];
    t('audio: an engine at the speed, for this <video>', sink.speed === 1.5 && sink.element === el);
    t('audio: listed in sourceBuffers', ms.sourceBuffers.length === 2 && ms.sourceBuffers.item(1) === a && ms.sourceBuffers[1] === a);

    const events = [];
    for (const type of ['updatestart', 'update', 'updateend', 'abort']) {
      a.addEventListener(type, () => events.push(`${type}:${a.updating}`));
    }
    a.appendBuffer(aacInit().buffer);
    let refused = '';
    try { a.appendBuffer(new Uint8Array(4)); } catch (e) { refused = e.name; }
    t('audio: a second append while updating is refused', refused === 'InvalidStateError', refused);
    await flush();
    t('audio: updatestart, then update and updateend with updating already false', events.join(' ') ===
      'updatestart:true update:false updateend:false', events.join(' '));
    t('audio: the init configures the engine', sink.configs.length === 1 && sink.configs[0].codec === 'mp4a.40.2');

    a.timestampOffset = 100;
    const frag = Uint8Array.from(bytes(mp4Fragment([frameBytes(0), frameBytes(1)], 0, 1), mp4Fragment([frameBytes(2)], 2048, 2)));
    // In two pieces, the cut inside the first fragment.
    a.appendBuffer(frag.subarray(0, 40));
    await flush();
    a.appendBuffer(frag.subarray(40));
    await flush();
    const pts = sink.pushed.map((s) => +(s.pts - 100).toFixed(6));
    t('audio: every frame to the engine once, at its time plus timestampOffset',
      pts.join(',') === [0, 1024, 2048].map((x) => +(x / MP4_TIMESCALE).toFixed(6)).join(','), pts.join(','));
    t('audio: buffered covers what was appended', a.buffered.length === 1 && Math.abs(a.buffered.start(0) - 100) < 1e-9 &&
      Math.abs(a.buffered.end(0) - (100 + 3072 / MP4_TIMESCALE)) < 1e-9);

    // A fragment right after: buffered stays one range.
    a.appendBuffer(Uint8Array.from(mp4Fragment([frameBytes(4)], 3072, 3)));
    await flush();
    t('audio: buffered of appends one after the other is one range', a.buffered.length === 1 &&
      Math.abs(a.buffered.end(0) - (100 + 4096 / MP4_TIMESCALE)) < 1e-9, a.buffered.length);

    a.remove(100.01, 100.03);
    await flush();
    t('audio: remove() tells the engine and splits buffered', sink.discards.some(([x, y]) => x === 100.01 && y === 100.03) &&
      a.buffered.length === 2);

    // abort() during an update: abort and updateend at once; the late end does nothing.
    events.length = 0;
    a.appendBuffer(new Uint8Array(0));
    a.abort();
    await flush();
    t('audio: abort() ends the update at once; the late end is dropped', events.join(' ') ===
      'updatestart:true abort:false updateend:false', events.join(' '));

    // Behind the playhead: kept for 60 s, then dropped from the engine and from buffered.
    el._ct = 200 / 1.5;
    a.timestampOffset = 190;
    a.appendBuffer(Uint8Array.from(mp4Fragment([frameBytes(3)], 4096, 3)));
    await flush();
    t('audio: what is over 60 s behind the playhead is dropped', sink.discards.some(([x, y]) => x === 0 && Math.abs(y - 140) < 1e-9) &&
      a.buffered.length === 1 && a.buffered.start(0) > 140, JSON.stringify(sink.discards));

    a.changeType(AUDIO_WEBM);
    t('audio: changeType() resets the engine and waits for a new init', sink.resets === 1 && a.initInfo === null);
    a.appendBuffer(webmInit());
    await flush();
    a.timestampOffset = 0;
    a.appendBuffer(Uint8Array.from(cluster(1000, [{ rel: 0, data: [1] }, { rel: 20, data: [2] }, { rel: 40, data: [3] }])));
    await flush();
    const opus = sink.pushed.slice(-3);
    t('audio WebM: Opus configured, frames with durations from the next frame (the last as the one before)',
      sink.configs[1].codec === 'opus' && opus.map((f) => f.pts).join() === '1,1.02,1.04' &&
        opus.every((f) => Math.abs(f.duration - 0.02) < 1e-9), opus.map((f) => `${f.pts}/${f.duration}`).join(' '));

    // Init and media in one append, as the first append can be.
    a.changeType(AUDIO_MP4);
    a.timestampOffset = 50;
    const before = sink.pushed.length;
    a.appendBuffer(Uint8Array.from(bytes(Array.from(aacInit()), mp4Fragment([frameBytes(5), frameBytes(6)], 0, 1))));
    await flush();
    const both = sink.pushed.slice(before);
    t('audio: init and media in one append: configured, and the frames at their time plus timestampOffset',
      sink.configs.length === 3 && both.length === 2 && both[0].pts === 50 &&
        Math.abs(both[1].pts - (50 + 1024 / MP4_TIMESCALE)) < 1e-9, both.map((f) => f.pts).join());

    // A video init on the audio SourceBuffer: not audio the engine can play.
    env.errors.length = 0;
    a.changeType(AUDIO_MP4);
    a.appendBuffer(videoInit());
    await flush();
    t('audio: an init without AAC or Opus is reported as not supported',
      env.errors.length === 1 && env.errors[0].name === 'NotSupportedError', env.errors.map((e) => e.name).join());

    // Bytes that never parse are not kept for ever.
    env.errors.length = 0;
    a.changeType(AUDIO_MP4);
    const junk = new Uint8Array(1024 * 1024).fill(7);
    for (let i = 0; i < 5; i++) {
      a.appendBuffer(junk);
      await flush();
    }
    t('audio: unparsable data is dropped past 4 MB, and said', a.rest.length <= 4 * 1024 * 1024 &&
      env.errors.some((e) => /unparsable/.test(e.message)), `${a.rest.length} kept`);
    env.hook.uninstall();
  }

  // ---- The <video> in content time, and let go for the next video ----
  {
    const env = await setup(() => 1.5);
    const { ms, el } = env.open();
    ms.addSourceBuffer(VIDEO_MP4);
    el._ct = 20;
    el._dur = 100;
    t('element: currentTime, duration, buffered and seekable in content time',
      el.currentTime === 30 && el.duration === 150 && el.buffered.end(0) === 30 && el.seekable.end(0) === 45);
    el.currentTime = 60;
    t('element: a seek in content time', el._ct === 40);
    el.playbackRate = 2;
    t('element: playbackRate says the speed and passes a request on', el.playbackRate === 1.5 && env.rates.join() === '2');
    el._dur = NaN;
    t('element: an unknown duration stays NaN', Number.isNaN(el.duration));
    // The same session attached again (src set again): no second shim on top.
    const sameUrl = el.src;
    el.src = sameUrl;
    el._ct = 20;
    t('element: attached once however often its src is set', el.currentTime === 30, el.currentTime);
    // Another video at 2x on the same element: its own shim, not one on top of the other.
    const ms2 = new env.win.MediaSource();
    el.src = env.win.URL.createObjectURL(ms2);
    t('element: a new src lets the old shim go', el.currentTime === 20, el.currentTime);
    env.hook.uninstall();
    const env2 = await setup(() => 2);
    const { ms: ms3, el: el3 } = env2.open();
    ms3.addSourceBuffer(VIDEO_MP4);
    const ms4 = new env2.win.MediaSource();
    el3.src = env2.win.URL.createObjectURL(ms4);
    ms4.addSourceBuffer(VIDEO_MP4);
    el3._ct = 10;
    t('element: the next MediaSource\'s shim replaces the old one (x2, not x4)', el3.currentTime === 20, el3.currentTime);
    env2.hook.uninstall();
  }

  // ---- The next video's MediaSource ready before its src is set ----
  {
    let speed = 1.5;
    const env = await setup(() => speed);
    const { ms, el } = env.open();
    ms.addSourceBuffer(VIDEO_MP4);
    speed = 2;
    const ms2 = new env.win.MediaSource();
    const url2 = env.win.URL.createObjectURL(ms2);
    ms2.addSourceBuffer(VIDEO_MP4);
    el.src = url2;
    el._ct = 10;
    t('element: a src whose MediaSource is already at 2x gets the 2x shim, the 1.5x one gone', el.currentTime === 20,
      el.currentTime);
    env.hook.uninstall();
  }

  // ---- revokeObjectURL and uninstall ----
  {
    const env = await setup(() => 1.5);
    const ms = new env.win.MediaSource();
    const el = new env.win.HTMLVideoElement();
    const url = env.win.URL.createObjectURL(ms);
    env.win.URL.revokeObjectURL(url);
    el.src = url;
    ms.addSourceBuffer(VIDEO_MP4);
    el._ct = 20;
    t('a revoked URL is forgotten: its element is not shimmed', el.currentTime === 20);
    const proto = env.win.MediaSource.prototype.addSourceBuffer;
    env.hook.uninstall();
    t('uninstall: the originals are back', env.win.MediaSource.prototype.addSourceBuffer !== proto &&
      Object.getOwnPropertyDescriptor(env.win.HTMLMediaElement.prototype, 'src').get.toString().includes('this[field]'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
