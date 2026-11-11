/**
 * Behaviour test for the decoder that stands in for WebCodecs on webOS 4-6
 * and 22 (src/speed/legacy-decoder.js), with a fake decodeAudioData.
 *
 * The fake decodes like the TV's did in the speed probe (#97): each frame's
 * samples are right only with a frame before it and a frame after it in the
 * same file, except at the very start and end of the stream. Frame i carries
 * its number, and its samples are i * 1024 + k, so the joined output must be
 * one unbroken ramp: a click (a piece decoded without its neighbours) shows
 * as -1 or -2, a lost or doubled piece as a jump.
 *
 * Usage: node bench/speed-legacy-decoder-test.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(path.resolve(__dirname, '../src/speed/legacy-decoder.js')).href;
const CONTAINERS = pathToFileURL(path.resolve(__dirname, '../src/speed/containers.js')).href;
const ENGINE = pathToFileURL(path.resolve(__dirname, '../src/speed/audio-engine.js')).href;

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

const RATE = 44100;
const DUR = Math.round((1024 / RATE) * 1e6);
// AudioSpecificConfig: AAC LC (2), 44.1 kHz (index 4), stereo.
const ASC = new Uint8Array([0x12, 0x10]);
const CFG = { codec: 'mp4a.40.2', sampleRate: RATE, numberOfChannels: 2, description: ASC };

/**
 * A fake TV: timers run by hand, decodeAudioData as described above. With
 * `hold`, a decode finishes only when the test calls release().
 */
function setup(total, { hold = false } = {}) {
  const timers = new Map();
  let id = 0;
  const calls = [];
  const held = [];
  class FakeOAC {
    constructor(channels, length, rate) {
      this.rate = rate;
    }
    decodeAudioData(buffer, ok, err) {
      const u8 = new Uint8Array(buffer);
      const idx = [];
      for (let p = 0; p < u8.length;) {
        if (u8[p] !== 0xff || (u8[p + 1] & 0xf0) !== 0xf0) {
          Promise.resolve().then(() => err(new Error('bad ADTS')));
          return undefined;
        }
        const len = ((u8[p + 3] & 3) << 11) | (u8[p + 4] << 3) | (u8[p + 5] >> 5);
        idx.push(new DataView(u8.buffer, p + 7, 4).getUint32(0));
        p += len;
      }
      calls.push(idx);
      const n = idx.length * 1024;
      const ch = [new Float32Array(n), new Float32Array(n)];
      idx.forEach((f, j) => {
        let v = null;
        if (j === 0 && f !== 0) v = -1;
        else if (j === idx.length - 1 && f !== total - 1) v = -2;
        for (let k = 0; k < 1024; k++) {
          const s = v === null ? f * 1024 + k : v;
          ch[0][j * 1024 + k] = s;
          ch[1][j * 1024 + k] = -s;
        }
      });
      const audio = { length: n, sampleRate: this.rate, numberOfChannels: 2, getChannelData: (c) => ch[c] };
      if (hold) held.push(() => ok(audio));
      else Promise.resolve().then(() => ok(audio));
      return undefined;
    }
  }
  const win = {
    OfflineAudioContext: FakeOAC,
    Float32Array,
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimeout: (i) => timers.delete(i)
  };
  /** Fires the pending timers of at most `ms`, in order. */
  const fire = (ms) => {
    const due = [...timers.entries()].filter(([, v]) => v.ms <= ms).sort((x, y) => x[1].ms - y[1].ms);
    due.forEach(([k, v]) => {
      timers.delete(k);
      v.fn();
    });
  };
  const release = () => held.splice(0).forEach((f) => { f(); });
  return { win, calls, fire, timers, held, release };
}

const frame = (i) => {
  const data = new Uint8Array(6);
  new DataView(data.buffer).setUint32(0, i);
  return { type: 'key', timestamp: i * DUR, duration: DUR, data };
};

const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

function decoder(mod, env) {
  const { AudioDecoder, EncodedAudioChunk } = mod.legacyAudioCodecs(env.win);
  const out = [];
  const errors = [];
  const dec = new AudioDecoder({
    output: (d) => {
      const a = new Float32Array(d.numberOfFrames);
      const b = new Float32Array(d.numberOfFrames);
      d.copyTo(a, { planeIndex: 0, format: 'f32-planar' });
      d.copyTo(b, { planeIndex: 1, format: 'f32-planar' });
      out.push({ ts: d.timestamp, rate: d.sampleRate, a, b });
      d.close();
    },
    error: (e) => errors.push(e)
  });
  const send = (from, to) => {
    for (let i = from; i < to; i++) dec.decode(new EncodedAudioChunk(frame(i)));
  };
  return { dec, out, errors, send };
}

/** Whether the outputs join into the ramp from frame `first` to frame `end`. */
function ramp(out, first, end) {
  let expect = first * 1024;
  for (const o of out) {
    if (o.ts !== Math.round((expect / 1024) * DUR) && Math.abs(o.ts - (expect / RATE) * 1e6) > 30) {
      return `piece at ${o.ts} us, expected sample ${expect}`;
    }
    for (let k = 0; k < o.a.length; k++) {
      if (o.a[k] !== expect + k || o.b[k] !== -(expect + k)) return `sample ${expect + k} is ${o.a[k]}`;
    }
    expect += o.a.length;
  }
  return expect === end * 1024 ? true : `ends at sample ${expect}, expected ${end * 1024}`;
}

(async () => {
  const mod = await import(MODULE);

  // ---- What it takes ----
  {
    const { AudioDecoder } = mod.legacyAudioCodecs(setup(1).win);
    const ok = async (cfg) => (await AudioDecoder.isConfigSupported(cfg)).supported;
    t('AAC LC is decodable', await ok(CFG));
    t('Opus is not (decodeAudioData on Chromium 53 cannot)', !(await ok({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array(19) })));
    t('HE-AAC is not (ADTS cannot carry it)', !(await ok({ codec: 'mp4a.40.5', sampleRate: 44100, numberOfChannels: 2, description: new Uint8Array([0x2b, 0x92, 0x08, 0x00]) })));
    t('an AAC LC label over another object type is not', !(await ok({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, description: new Uint8Array([0x2a, 0x10]) })));
    t('no description: not', !(await ok({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2 })));
    const noSlice = setup(1).win;
    noSlice.Float32Array = function () {};
    t('webOS 3 (Chromium 38: no typed array slice): off', mod.legacyAudioCodecs(noSlice) === null);
    t('no OfflineAudioContext: off', mod.legacyAudioCodecs({ Float32Array }) === null);
  }

  // ---- The ADTS header ----
  {
    const file = mod.muxAdts([new Uint8Array(10), new Uint8Array(3)], { aot: 2, srIndex: 4, channels: 2 });
    const len = ((file[3] & 3) << 11) | (file[4] << 3) | (file[5] >> 5);
    t('ADTS: 7-byte headers, the frame length in them', file.length === 27 && len === 17 && file[0] === 0xff && file[1] === 0xf1);
    t('ADTS: LC, 44.1 kHz, stereo', file[2] >> 6 === 1 && ((file[2] >> 2) & 15) === 4 && (((file[2] & 1) << 2) | (file[3] >> 6)) === 2);
  }

  // ---- A whole video, sent at once ----
  {
    const env = setup(130);
    const { dec, out, errors, send } = decoder(mod, env);
    dec.configure(CFG);
    send(0, 130);
    await settle();
    t('whole pieces go as soon as the frames after them are there', out.length === 2 && env.calls[1][0] === 39 && env.calls[1][env.calls[1].length - 1] === 89,
      JSON.stringify(env.calls.map((c) => [c[0], c[c.length - 1]])));
    env.fire(400);
    await settle();
    // The last 4 frames wait for frames after them that never come: never
    // decoded without them, as on a pause they would click.
    t('the joined audio is the whole ramp but the last 4 frames, no click, no gap', ramp(out, 0, 126) === true, ramp(out, 0, 126));
    env.fire(60000);
    await settle();
    t('and nothing is ever decoded without its frames after it', ramp(out, 0, 126) === true && env.timers.size === 0, ramp(out, 0, 126));
    t('at the stream rate', out.every((o) => o.rate === RATE));
    t('no error', errors.length === 0, errors[0]);
  }

  // ---- A pause: the engine stops sending, then goes on ----
  {
    const env = setup(130);
    const { dec, out, send } = decoder(mod, env);
    dec.configure(CFG);
    send(0, 60);
    await settle();
    env.fire(400);
    await settle();
    const before = out.reduce((n, o) => n + o.a.length, 0) / 1024;
    t('on a pause, all but the last frames are decoded', before === 56, before);
    env.fire(60000);
    await settle();
    t('however long the pause, the last frames wait', out.reduce((n, o) => n + o.a.length, 0) / 1024 === 56);
    send(60, 130);
    await settle();
    env.fire(400);
    await settle();
    t('and it joins on without a click', ramp(out, 0, 126) === true, ramp(out, 0, 126));
  }

  // ---- Frames sent again, out of order ----
  {
    const env = setup(130);
    const { dec, out, send } = decoder(mod, env);
    dec.configure(CFG);
    send(0, 100);
    await settle();
    const n = out.length;
    // The engine dropped this audio and sends it again.
    send(43, 86);
    await settle();
    t('frames sent again are decoded again, with their neighbours', out.length > n && ramp(out.slice(n, n + 1), 43, 86) === true,
      ramp(out.slice(n, n + 1), 43, 86));
  }

  // ---- reset() and close() ----
  {
    const env = setup(130, { hold: true });
    const { dec, out, send } = decoder(mod, env);
    dec.configure(CFG);
    send(0, 50);
    await settle();
    t('a piece is being decoded', env.held.length === 1 && out.length === 0);
    // reset() before it is done; then it finishes.
    dec.reset();
    env.release();
    await settle();
    t('reset(): a piece that finishes after it gives nothing', out.length === 0 && dec.state === 'unconfigured');
    dec.configure(CFG);
    send(0, 50);
    await settle();
    env.release();
    await settle();
    t('configured again, it decodes again', out.length === 1 && ramp(out, 0, 43) === true, ramp(out, 0, 43));
    dec.close();
    send(50, 60);
    t('close(): the flush timer is cleared', env.timers.size === 0, env.timers.size);
    env.fire(60000);
    await settle();
    env.release();
    await settle();
    t('close(): nothing more', out.length === 1 && dec.state === 'closed');
  }

  // ---- discard() while a piece is being decoded ----
  {
    const env = setup(130, { hold: true });
    const { dec, out, send } = decoder(mod, env);
    dec.configure(CFG);
    send(0, 50);
    await settle();
    // The player removes frames 10-19 from its buffer meanwhile.
    dec.discard(10 * DUR, 20 * DUR);
    env.release();
    await settle();
    const runs = out.map((o) => `${Math.round(o.ts / DUR)}+${o.a.length / 1024}`).join(',');
    t('discard(): a piece being decoded leaves the removed frames out', runs === '0+10,20+23' &&
      ramp(out.slice(0, 1), 0, 10) === true && ramp(out.slice(1), 20, 43) === true, runs);
  }

  // ---- 960-sample frames ----
  {
    const { AudioDecoder } = mod.legacyAudioCodecs(setup(1).win);
    t('AAC LC with 960-sample frames is not (ADTS cannot say so)',
      !(await AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, description: new Uint8Array([0x12, 0x14]) })).supported);
  }

  // ---- A configuration it cannot take ----
  {
    const env = setup(1);
    const { dec, errors } = decoder(mod, env);
    dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array(19) });
    t('configure() with Opus: an error, the engine falls back to 1x', errors.length === 1 && errors[0].name === 'NotSupportedError' && dec.state === 'closed');
  }

  // ---- In the speed engine ----
  {
    const { AudioEngine } = await import(ENGINE);
    const env = setup(130);
    const win = Object.assign({}, env.win, {
      AudioContext: class {
        constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; }
        createGain() { return { gain: { value: 1 }, connect() {} }; }
        close() { this.state = 'closed'; }
      },
      setInterval: () => 1,
      clearInterval: () => {}
    });
    const errors = [];
    const engine = new AudioEngine({ win, speed: 1.5, onError: (e) => errors.push(e), codecs: mod.legacyAudioCodecs(win) });
    engine.attachVideo({ currentTime: 0, paused: true, addEventListener() {}, removeEventListener() {} });
    engine.configure(CFG);
    await settle();
    const chunks = [];
    for (let i = 0; i < 130; i++) {
      const f = frame(i);
      chunks.push({ pts: f.timestamp / 1e6, duration: DUR / 1e6, key: true, data: f.data });
    }
    engine.push(chunks);
    await settle();
    const got = engine.pcm.reduce((n, p) => n + p.n, 0);
    // Two whole pieces; the third waits for the frames after it.
    t('the engine decodes through it: whole pieces, in order, at their times',
      errors.length === 0 && got === 86 * 1024 &&
        engine.pcm[0].t === 0 && engine.pcm[1].t === (43 * DUR) / 1e6 && engine.pcm[0].ch[0][1025] === 1025,
      `${errors[0] || ''} ${got / 1024} frames, starts ${engine.pcm.map((p) => p.t).join(',')}`);
    engine.destroy();
  }

  // ---- The engine's discard() reaches a piece being decoded ----
  {
    const { AudioEngine } = await import(ENGINE);
    const env = setup(130, { hold: true });
    const win = Object.assign({}, env.win, {
      AudioContext: class {
        constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; }
        createGain() { return { gain: { value: 1 }, connect() {} }; }
        close() { this.state = 'closed'; }
      },
      setInterval: () => 1,
      clearInterval: () => {}
    });
    const engine = new AudioEngine({ win, speed: 1.5, onError: () => {}, codecs: mod.legacyAudioCodecs(win) });
    engine.attachVideo({ currentTime: 0, paused: true, addEventListener() {}, removeEventListener() {} });
    engine.configure(CFG);
    await settle();
    const chunks = [];
    for (let i = 0; i < 130; i++) {
      const f = frame(i);
      chunks.push({ pts: f.timestamp / 1e6, duration: DUR / 1e6, key: true, data: f.data });
    }
    engine.push(chunks);
    await settle();
    const decoding = env.held.length > 0 && engine.pcm.length === 0;
    engine.discard(0.2, 0.4);
    env.release();
    await settle();
    env.release();
    await settle();
    const overlap = engine.pcm.filter((p) => p.t < 0.4 && p.t + p.n / p.rate > 0.2);
    t('engine.discard(): a piece being decoded does not bring the range back',
      decoding && engine.pcm.length > 0 && overlap.length === 0,
      `decoding ${decoding}, ${engine.pcm.length} blocks, overlapping ${overlap.map((p) => `${p.t}+${p.n / p.rate}`).join(',')}`);
    engine.destroy();
  }

  // ---- The player's offer without WebCodecs ----
  {
    const { keepStretchableAudio, LEGACY_STRETCHABLE_AUDIO_RE } = await import(CONTAINERS);
    const sd = { adaptiveFormats: [
      { mimeType: 'video/mp4; codecs="avc1.640028"' },
      { mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
      { mimeType: 'audio/mp4; codecs="mp4a.40.5"' },
      { mimeType: 'audio/webm; codecs="opus"' },
      { mimeType: 'audio/mp4; codecs="ac-3"' }
    ] };
    keepStretchableAudio(sd, LEGACY_STRETCHABLE_AUDIO_RE);
    const mimes = sd.adaptiveFormats.map((f) => f.mimeType);
    t('off 1x the offer keeps AAC LC only, and the video',
      mimes.length === 2 && mimes[0].indexOf('avc1') !== -1 && mimes[1].indexOf('mp4a.40.2') !== -1, JSON.stringify(mimes));
    const opusOnly = { adaptiveFormats: [{ mimeType: 'audio/webm; codecs="opus"' }] };
    t('a video with no AAC keeps its offer (and plays at 1x)', keepStretchableAudio(opusOnly, LEGACY_STRETCHABLE_AUDIO_RE) === 0 && opusOnly.adaptiveFormats.length === 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
