/**
 * The playback speed's audio engine (src/speed/audio-engine.js) on a fake
 * TV: a WebAudio clock moved by hand, a decoder that answers at once, and a
 * <video> whose clock runs `speed` times as fast as the audio's.
 *
 * Every decoded sample carries its own content time (the video position it
 * belongs to), and the stretch keeps sample values, so what the engine
 * queued can be checked against the picture: a queued sample played at
 * audio time T must hold the content the video shows at T. The queue must
 * also have no gaps or overlaps, stop at once on a pause, a stall or a seek,
 * start again in step, hold a slowly drifting clock in step, and keep only a
 * few seconds of decoded audio.
 *
 * Usage: node bench/speed-engine-test.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');

const ENGINE = pathToFileURL(path.resolve(__dirname, '../src/speed/audio-engine.js')).href;

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

const RATE = 48000;
const FRAME = 1024;
const FRAME_S = FRAME / RATE;
const TICK_S = 0.05;
const CFG = { codec: 'mp4a.40.2', sampleRate: RATE, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) };

/** A fake TV around one engine. */
function setup(AudioEngine, { speed = 1.5, start = 0, videoRate = 1, errors = [] } = {}) {
  const ctx = {
    currentTime: 10,
    state: 'running',
    destination: {},
    sources: [],
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, sampleRate, numberOfChannels: channels, data, copyToChannel(src, c) { data[c].set(src); } };
    },
    createBufferSource() {
      const node = {
        buffer: null,
        connect() {},
        start(when) { node.when = when; },
        stop(at) { node.stoppedAt = at; },
        onended: null
      };
      ctx.sources.push(node);
      return node;
    },
    close() { ctx.state = 'closed'; }
  };
  let tickFn = null;
  let cleared = false;
  const win = {
    AudioContext: function AudioContext() { return ctx; },
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { cleared = true; }
  };

  // Decodes at once: frame k of the stream holds its own content time.
  const decoded = [];
  const decoders = [];
  class Decoder {
    static isConfigSupported(cfg) { return Promise.resolve({ supported: cfg.codec !== 'ac-3' }); }
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.state = 'unconfigured';
      decoders.push(this);
    }
    configure() { this.state = 'configured'; }
    reset() { this.state = 'unconfigured'; }
    close() { this.state = 'closed'; }
    decode(chunk) {
      decoded.push(chunk.timestamp);
      const t0 = chunk.timestamp / 1e6;
      this.output({
        timestamp: chunk.timestamp,
        sampleRate: RATE,
        numberOfFrames: FRAME,
        numberOfChannels: 2,
        copyTo(buf, { planeIndex }) {
          for (let i = 0; i < FRAME; i++) buf[i] = (t0 + i / RATE) * (planeIndex ? -1 : 1);
        },
        close() {}
      });
    }
  }
  class Chunk {
    constructor(init) { Object.assign(this, init); }
  }

  const listeners = {};
  const video = {
    currentTime: start,
    paused: false,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type) => { delete listeners[type]; },
    fire: (type) => listeners[type] && listeners[type]()
  };

  const engine = new AudioEngine({
    win,
    speed,
    onError: (e) => errors.push(e),
    codecs: { AudioDecoder: Decoder, EncodedAudioChunk: Chunk }
  });
  engine.attachVideo(video);

  /** The video's frames for `from` to `to` seconds of content, as the SourceBuffer hands them over. */
  const push = (from, to) => {
    const chunks = [];
    for (let k = Math.round(from / FRAME_S); k * FRAME_S < to; k++) {
      chunks.push({ pts: k * FRAME_S, duration: FRAME_S, data: new Uint8Array(4), key: true });
    }
    engine.push(chunks);
  };

  /** `seconds` of audio clock: the video moves `speed * videoRate` times as far, unless paused or frozen. */
  const run = (seconds, { frozen = false } = {}) => {
    const n = Math.round(seconds / TICK_S);
    for (let i = 0; i < n; i++) {
      ctx.currentTime += TICK_S;
      if (!video.paused && !frozen) video.currentTime += TICK_S * speed * videoRate;
      tickFn();
    }
  };

  /**
   * Like run(), but currentTime shows the video's position only every few
   * ticks (`steps`, used in turn), as on webOS 4-6 (#97): in between it stays
   * on the last value while the picture plays on. Start it on a fresh setup.
   */
  let trueT = start;
  let sinceShown = 0;
  let step = 0;
  const runSteps = (seconds, steps, { frozen = false } = {}) => {
    const n = Math.round(seconds / TICK_S);
    for (let i = 0; i < n; i++) {
      ctx.currentTime += TICK_S;
      if (!video.paused && !frozen) trueT += TICK_S * speed;
      if (++sinceShown >= steps[step % steps.length]) {
        video.currentTime = trueT;
        sinceShown = 0;
        step++;
      }
      tickFn();
    }
  };

  return { engine, ctx, video, push, run, runSteps, trueTime: () => trueT, decoded, decoders, errors, win, cleared: () => cleared };
}

/** The live queue: sources not stopped, by start time. */
// A source told to stop later still plays until then.
const live = (ctx) => ctx.sources.filter((s) => s.stoppedAt === undefined || s.stoppedAt > ctx.currentTime)
  .sort((a, b) => a.when - b.when);
/** Every source stopped, now: a stop put off to later would still be heard. */
const stoppedNow = (ctx) => ctx.sources.every((s) => s.stoppedAt !== undefined && s.stoppedAt <= ctx.currentTime);

/**
 * How far the queued content is from the picture: for each queued sample,
 * |its content time - the video's time when it plays|, skipping `skip` s
 * after each restart (the stretch fades its first frame in from silence).
 * The video time at audio time T is `video(T)`.
 */
function offsets(sources, video, { skip = 0.06 } = {}) {
  const out = [];
  let prevEnd = null;
  let restart = null;
  for (const s of sources) {
    if (prevEnd === null || Math.abs(s.when - prevEnd) > 1e-6) restart = s.when;
    const ch = s.buffer.data[0];
    for (let i = 0; i < ch.length; i += 64) {
      const at = s.when + i / RATE;
      if (at - restart < skip) continue;
      out.push(Math.abs(ch[i] - video(at)));
    }
    prevEnd = s.when + s.buffer.length / RATE;
  }
  return out;
}

const max = (a) => a.reduce((m, v) => Math.max(m, v), 0);
/** Every offset under `limit`, and at least one measured (none would prove nothing). */
const within = (off, limit) => off.length > 0 && max(off) < limit;

(async () => {
  const { AudioEngine } = await import(ENGINE);
  const tick = () => new Promise((r) => setImmediate(r));

  // ---- Steady playback, at each speed ----
  for (const speed of [0.5, 1.25, 2]) {
    const env = setup(AudioEngine, { speed });
    env.engine.configure(CFG);
    await tick();
    env.push(0, 30);
    const c0 = env.ctx.currentTime;
    const v0 = env.video.currentTime;
    env.run(6);
    const q = env.ctx.sources;
    t(`${speed}x: audio is queued`, q.length > 20, q.length);
    let gaps = 0;
    for (let i = 1; i < q.length; i++) {
      if (Math.abs(q[i].when - (q[i - 1].when + q[i - 1].buffer.length / RATE)) > 1e-6) gaps++;
    }
    t(`${speed}x: the buffers follow each other with no gap or overlap`, gaps === 0, `${gaps} gaps`);
    const ahead = q[q.length - 1].when + q[q.length - 1].buffer.length / RATE - env.ctx.currentTime;
    t(`${speed}x: about 0.4 s queued ahead, no more`, ahead > 0.3 && ahead < 0.6, ahead.toFixed(3));
    // The video at audio time T: where it was at c0, plus speed x the time since.
    const off = offsets(q, (T) => v0 + (T - c0) * speed);
    t(`${speed}x: every queued sample is the content the picture shows then (within 60 ms)`,
      off.length > 1000 && within(off, 0.06), `max ${max(off).toFixed(3)} s over ${off.length}`);
    t(`${speed}x: both channels`, q.every((s) => s.buffer.data[1].every((v, i) => v === -s.buffer.data[0][i])));
    t(`${speed}x: no error`, env.errors.length === 0, env.errors.map(String).join());
    env.engine.destroy();
  }

  // ---- Pause, then play on ----
  {
    const env = setup(AudioEngine);
    env.engine.configure(CFG);
    await tick();
    env.push(0, 30);
    env.run(2);
    env.video.paused = true;
    env.video.fire('pause');
    const stopped = stoppedNow(env.ctx);
    const count = env.ctx.sources.length;
    env.run(1);
    t('pause: everything queued stops at once, nothing new while paused', stopped && env.ctx.sources.length === count,
      `${env.ctx.sources.filter((s) => s.stoppedAt === undefined).length} still on, ${env.ctx.sources.length - count} new`);
    env.video.paused = false;
    env.video.fire('playing');
    const c0 = env.ctx.currentTime;
    const v0 = env.video.currentTime;
    env.run(2);
    const q = live(env.ctx).filter((s) => s.when >= c0);
    const off = offsets(q, (T) => v0 + (T - c0) * 1.5);
    t('play on: the audio starts again in step', q.length > 5 && within(off, 0.08), `max ${max(off).toFixed(3)} s`);
    env.engine.destroy();
  }

  // ---- A seek ----
  {
    const env = setup(AudioEngine);
    env.engine.configure(CFG);
    await tick();
    env.push(0, 10);
    env.run(2);
    env.video.fire('seeking');
    const stopped = stoppedNow(env.ctx);
    env.video.currentTime = 60;
    env.push(55, 75);
    env.video.fire('playing');
    const c0 = env.ctx.currentTime;
    env.run(2);
    const q = live(env.ctx).filter((s) => s.when >= c0);
    // The anchor waits for the first real movement, one tick after c0.
    const off = offsets(q, (T) => 60 + (T - c0) * 1.5);
    t('seek: the old audio stops at once', stopped);
    t('seek: the audio picks up at the new position', q.length > 5 && within(off, 0.12), `max ${max(off).toFixed(3)} s`);
    t('seek: the new position is decoded, not the whole archive',
      env.decoded.some((us) => us / 1e6 > 59) && !env.decoded.some((us) => us / 1e6 > 66), `${env.decoded.length} decoded`);
    env.engine.destroy();
  }

  // ---- A stall without a pause event ----
  {
    const env = setup(AudioEngine);
    env.engine.configure(CFG);
    await tick();
    env.push(0, 30);
    env.run(2);
    env.run(0.3, { frozen: true });
    const stopped = stoppedNow(env.ctx);
    const c0 = env.ctx.currentTime;
    const v0 = env.video.currentTime;
    env.run(2);
    const q = live(env.ctx).filter((s) => s.when >= c0);
    const off = offsets(q, (T) => v0 + (T - c0) * 1.5);
    t('stall: the queue stops instead of running ahead of a frozen picture', stopped);
    t('stall: the audio comes back in step when the picture moves', q.length > 5 && within(off, 0.12),
      `max ${max(off).toFixed(3)} s`);
    env.engine.destroy();
  }

  // ---- A video clock that moves in steps (webOS 4-6, #97) ----
  // currentTime changes every 4 to 9 ticks (0.2-0.45 s), as photographed on a
  // webOS 4 TV: that is no stall and no jump, the audio must play on.
  const STEPS = [4, 7, 5, 9, 6, 8];
  for (const speed of [1.25, 1.5]) {
    const env = setup(AudioEngine, { speed });
    env.engine.configure(CFG);
    await tick();
    env.push(0, 30);
    const c0 = env.ctx.currentTime;
    const v0 = env.trueTime();
    env.runSteps(10, STEPS);
    const q = env.ctx.sources;
    const stops = q.filter((s) => s.stoppedAt !== undefined).length;
    t(`steps ${speed}x: the engine saw the clock's steps`, env.engine.clockGaps.length > 0 &&
      env.engine.clockGaps.every((g) => STEPS.includes(g)), env.engine.clockGaps.join());
    t(`steps ${speed}x: audio is queued`, q.length > 50, q.length);
    t(`steps ${speed}x: nothing is cut`, stops === 0, `${stops} buffers stopped`);
    const off = offsets(q, (T) => v0 + (T - c0) * speed);
    t(`steps ${speed}x: every queued sample is the content the picture shows then (within 60 ms)`,
      off.length > 1000 && within(off, 0.06), `max ${max(off).toFixed(3)} s over ${off.length}`);
    env.engine.destroy();
  }
  {
    // How long a frozen clock may last: from the median of its last steps.
    const env = setup(AudioEngine);
    const limit = (gaps) => {
      env.engine.clockGaps = gaps;
      return env.engine.stallTicks();
    };
    t('stall limit: 20 ticks (1 s) until 3 steps are seen', limit([]) === 20 && limit([1, 1]) === 20, limit([1, 1]));
    t('stall limit: 4 ticks (0.2 s) on a clock that moves every tick', limit([1, 1, 1]) === 4 && limit([1, 2, 1]) === 4,
      limit([1, 2, 1]));
    t('stall limit: 3 times the median step', limit([6, 7, 30]) === 21 && limit([4, 9, 5, 9, 6]) === 18,
      `${limit([6, 7, 30])} ${limit([4, 9, 5, 9, 6])}`);
    t('stall limit: never more than 40 ticks (2 s)', limit([14, 14, 30]) === 40 && limit([13, 13, 30]) === 39,
      `${limit([14, 14, 30])} ${limit([13, 13, 30])}`);
    env.engine.destroy();
  }
  {
    // The control: on that clock a real stall still stops the audio, later.
    const env = setup(AudioEngine);
    env.engine.configure(CFG);
    await tick();
    env.push(0, 30);
    env.runSteps(4, STEPS);
    const before = env.ctx.sources.filter((s) => s.stoppedAt !== undefined).length;
    env.runSteps(0.5, STEPS, { frozen: true });
    const early = stoppedNow(env.ctx);
    env.runSteps(1.5, STEPS, { frozen: true });
    const stopped = stoppedNow(env.ctx);
    const c0 = env.ctx.currentTime;
    const v0 = env.trueTime();
    env.runSteps(3, STEPS);
    const q = live(env.ctx).filter((s) => s.when >= c0);
    const off = offsets(q, (T) => v0 + (T - c0) * 1.5);
    t('steps stall: playing in steps cut nothing before it', before === 0, `${before} stopped`);
    t('steps stall: a freeze as long as a few steps is not cut yet', !early);
    t('steps stall: a freeze of 2 s is', stopped);
    t('steps stall: the audio comes back in step', q.length > 5 && within(off, 0.12), `max ${max(off).toFixed(3)} s`);
    env.engine.destroy();
  }

  // ---- The video clock runs 3% fast or slow: soft corrections keep it in step ----
  for (const videoRate of [1.03, 0.97]) {
    const env = setup(AudioEngine, { videoRate });
    env.engine.configure(CFG);
    await tick();
    env.push(0, 60);
    const c0 = env.ctx.currentTime;
    const v0 = env.video.currentTime;
    env.run(20);
    const stops = env.ctx.sources.filter((s) => s.stoppedAt !== undefined).length;
    // Over the last 5 s of audio clock.
    const q = env.ctx.sources.filter((s) => s.stoppedAt === undefined || s.stoppedAt > s.when)
      .filter((s) => s.when > env.ctx.currentTime - 5 && s.when < env.ctx.currentTime);
    const off = offsets(q, (T) => v0 + (T - c0) * 1.5 * videoRate);
    const how = videoRate > 1 ? 'fast' : 'slow';
    t(`drift: the audio stays in step with a clock 3% ${how} (within 0.25 s)`, q.length > 10 && within(off, 0.25),
      `max ${max(off).toFixed(3)} s`);
    t(`drift (${how}): by soft corrections, not by stopping the audio again and again`, stops <= 2,
      `${stops} buffers stopped`);
    env.engine.destroy();
  }

  // ---- Memory: only a few seconds of decoded audio are kept ----
  {
    const env = setup(AudioEngine);
    env.engine.configure(CFG);
    await tick();
    env.push(0, 40);
    env.run(16);
    const oldest = env.engine.pcm.length ? env.engine.pcm[0].t : Infinity;
    const kept = env.engine.pcm.reduce((s, p) => s + p.n / p.rate, 0);
    t('memory: decoded audio more than 2 s behind is dropped', oldest > env.video.currentTime - 2.2,
      `oldest ${oldest.toFixed(2)} at ${env.video.currentTime.toFixed(2)}`);
    t('memory: and no more than about 3 s ahead is decoded', kept < 6, `${kept.toFixed(2)} s kept`);
    env.engine.destroy();
  }

  // ---- discard(): queued audio of a removed range stops ----
  {
    const env = setup(AudioEngine);
    env.engine.configure(CFG);
    await tick();
    env.push(0, 30);
    env.run(2);
    const now = env.video.currentTime;
    env.engine.discard(now, now + 1);
    t('discard: the queued audio of the range stops', live(env.ctx).length === 0);
    t('discard: its decoded audio is dropped',
      !env.engine.pcm.some((p) => p.t < now + 1 && p.t + p.n / p.rate > now));
    env.engine.destroy();
  }

  // ---- Configuration and errors ----
  {
    const errors = [];
    const env = setup(AudioEngine, { errors });
    env.engine.configure({ ...CFG, codec: 'ac-3' });
    await tick();
    t('configure: an unsupported codec is reported once, as NotSupportedError',
      errors.length === 1 && errors[0].name === 'NotSupportedError');
    env.push(0, 1);
    t('after an error: nothing more is decoded', env.decoded.length === 0);
    env.engine.destroy();
  }
  {
    const env = setup(AudioEngine);
    env.engine.configure({ ...CFG, sampleRate: 44100 });
    env.engine.configure(CFG);
    await tick();
    t('configure twice before the check answers: only the latest gets a decoder',
      env.decoders.length === 1 && env.engine.decoder === env.decoders[0] && env.engine.cfg.sampleRate === RATE,
      `${env.decoders.length} decoders`);
    const before = env.engine.decoder;
    env.engine.configure({ ...CFG, description: new Uint8Array([0x11, 0x90]) });
    await tick();
    t('configure with the same settings: the decoder stays', env.engine.decoder === before);
    env.engine.destroy();
  }
  {
    const errors = [];
    const env = setup(AudioEngine, { errors });
    env.engine.configure(CFG);
    await tick();
    env.push(0, 1);
    const before = env.decoded.length;
    env.decoders[0].error(new Error('decode failed'));
    env.push(1, 3);
    env.run(0.5);
    t('a decoder error: reported once, then nothing more is decoded or queued',
      errors.length === 1 && env.decoded.length === before && env.ctx.sources.length === 0,
      `${errors.length} errors, ${env.decoded.length - before} more decoded, ${env.ctx.sources.length} queued`);
    env.engine.destroy();
  }
  {
    const errors = [];
    const env = setup(AudioEngine, { errors });
    env.engine.configure(CFG);
    await tick();
    env.push(0, 5);
    env.engine.extractPcm = () => { throw new Error('boom'); };
    env.run(0.5);
    t('an error in a tick is reported once (the speed falls back to 1x)', errors.length === 1 && errors[0].message === 'boom',
      errors.length);
    env.engine.destroy();
    t('destroy: the timer and the audio context are closed', env.cleared() && env.ctx.state === 'closed');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
