/**
 * The playback speed's core, without a TV: the WSOLA time stretch
 * (src/speed/wsola.js) and the MP4 / WebM parsing and rewriting
 * (src/speed/containers.js).
 *
 * WSOLA gets sine waves: the output must last 1/speed of the input, keep the
 * pitch (the same frequency, counted by zero crossings) and the loudness, and
 * not depend on how the input is cut into pushes or the output into pulls.
 * The containers get small MP4 and WebM files built here byte by byte: what
 * is read from them must be what was put in, also when the media arrives one
 * byte at a time (as YouTube may append it), and a rewritten init must still
 * parse, with only its time scale changed.
 *
 * Usage: node bench/speed-core-test.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');

const WSOLA = pathToFileURL(path.resolve(__dirname, '../src/speed/wsola.js')).href;
const CONTAINERS = pathToFileURL(path.resolve(__dirname, '../src/speed/containers.js')).href;
const {
  ascii, u32, u16, bytes, box, fullbox, MP4_TIMESCALE, ASC, esds, audioSampleEntry, mp4Init, mp4Fragment,
  frameBytes, UNKNOWN, el, ID, OPUS_HEAD, webmInit, block, cluster
} = require('./speed-fixtures.cjs');
const SPEEDS = [0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2];

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

// --- signals -------------------------------------------------------------

const RATE = 48000;

function sine(freq, n, { amp = 0.5, phase = 0, rate = RATE } = {}) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(phase + (2 * Math.PI * freq * i) / rate);
  return out;
}

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The frequency of a steady tone, from its rising zero crossings (interpolated). */
function frequency(x, rate = RATE) {
  const ups = [];
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) ups.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  if (ups.length < 3) return 0;
  return ((ups.length - 1) * rate) / (ups[ups.length - 1] - ups[0]);
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/** Runs `input` (one array per channel) through a stretcher at `speed`: pushes of `pushN`, pulls of `pullN` (all there is with 0). */
function stretch(Wsola, input, speed, { pushN = 4800, pullN = 0, opts = {} } = {}) {
  const w = new Wsola({ sampleRate: RATE, channels: input.length, ...opts });
  w.setSpeed(speed);
  const out = input.map(() => []);
  const drain = () => {
    for (;;) {
      const avail = w.available();
      const n = pullN ? Math.min(pullN, avail) : avail;
      if (n <= 0) return;
      const got = w.pull(n);
      got.forEach((c, i) => {
        out[i].push(c);
      });
    }
  };
  for (let i = 0; i < input[0].length; i += pushN) {
    w.push(input.map((c) => c.subarray(i, Math.min(i + pushN, c.length))));
    drain();
  }
  return { w, out: out.map(concat), drain };
}

const sameSamples = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function wsolaTests() {
  const { WsolaStretcher } = await import(WSOLA);
  // As the engine makes it (audio-engine.js).
  const engineOpts = { searchStep: 2, corrStep: 2 };
  const N = RATE * 4;
  const tone = sine(440, N);

  for (const speed of SPEEDS) {
    const { out } = stretch(WsolaStretcher, [tone], speed, { opts: engineOpts });
    const got = out[0];
    // The stretcher holds back no more than a frame of input (46 ms) and half
    // its search range (6 ms), which come out 1/speed as long: every final
    // sample is handed out.
    const expected = N / speed;
    const held = ((0.046 + 0.006) * RATE) / speed + 64;
    const lag = expected - got.length;
    t(`WSOLA ${speed}x: output lasts input / speed, less what it holds back`,
      lag >= 0 && lag < held, `${got.length} samples for ${expected}, ${(lag / RATE).toFixed(3)} s short`);
    // Steady part: past the fade-in of the first frame, before the tail.
    const mid = got.subarray(Math.floor(0.2 * RATE), got.length - Math.floor(0.2 * RATE));
    const f = frequency(mid);
    t(`WSOLA ${speed}x: the pitch stays (440 Hz, within 1%)`, Math.abs(f - 440) < 4.4, `${f.toFixed(2)} Hz`);
    const level = rms(mid) / rms(tone);
    t(`WSOLA ${speed}x: the loudness stays (within 10%)`, Math.abs(level - 1) < 0.1, level.toFixed(3));
    let peak = 0;
    for (let i = 0; i < got.length; i++) peak = Math.max(peak, Math.abs(got[i]));
    t(`WSOLA ${speed}x: no sample above the input's peak by more than 10%`, peak <= 0.55, peak.toFixed(3));
    let finite = true;
    for (let i = 0; i < got.length; i++) if (!Number.isFinite(got[i])) finite = false;
    t(`WSOLA ${speed}x: every sample a number`, finite);
  }

  // A change of pitch half way: the output follows, at the same speed.
  {
    const twoTones = concat([sine(300, RATE * 2), sine(600, RATE * 2)]);
    const { out } = stretch(WsolaStretcher, [twoTones], 1.5, { opts: engineOpts });
    const half = Math.floor((RATE * 2) / 1.5);
    const f1 = frequency(out[0].subarray(Math.floor(0.2 * RATE), half - Math.floor(0.2 * RATE)));
    const f2 = frequency(out[0].subarray(half + Math.floor(0.2 * RATE), out[0].length - Math.floor(0.2 * RATE)));
    t('WSOLA 1.5x: a tone that changes keeps both pitches', Math.abs(f1 - 300) < 3 && Math.abs(f2 - 600) < 6,
      `${f1.toFixed(1)} Hz, ${f2.toFixed(1)} Hz`);
  }

  // How the input is cut into pushes, and the output into pulls, changes nothing.
  for (const speed of [0.5, 1.25, 2]) {
    const ref = stretch(WsolaStretcher, [tone], speed, { pushN: N, opts: engineOpts }).out[0];
    const small = stretch(WsolaStretcher, [tone], speed, { pushN: 4410, opts: engineOpts }).out[0];
    const odd = stretch(WsolaStretcher, [tone], speed, { pushN: 997, pullN: 313, opts: engineOpts }).out[0];
    // The last pull of each run can stop at a different point: compare what both have.
    const n = Math.min(ref.length, small.length, odd.length);
    t(`WSOLA ${speed}x: the same output for one push, 0.1 s pushes and odd pushes and pulls`,
      n > N / speed - 0.2 * RATE && sameSamples(ref.subarray(0, n), small.subarray(0, n)) &&
        sameSamples(ref.subarray(0, n), odd.subarray(0, n)),
      `compared ${n}`);
  }

  // Stereo: both channels take the same segments, so a channel that is the
  // other upside down stays that.
  {
    const left = sine(440, RATE * 2);
    const right = left.map((v) => -v);
    const { out } = stretch(WsolaStretcher, [left, right], 1.5, { opts: engineOpts });
    t('WSOLA stereo: the channels stay in step', out[0].length === out[1].length &&
      out[0].every((v, i) => v === -out[1][i]));
  }

  // reset() leaves nothing of the earlier input behind.
  {
    const w = new WsolaStretcher({ sampleRate: RATE, channels: 1, ...engineOpts });
    w.setSpeed(2);
    w.push([sine(1000, RATE)]);
    while (w.available()) w.pull(w.available());
    w.reset();
    const run = (s) => {
      s.push([tone.subarray(0, RATE)]);
      return s.pull(s.available())[0];
    };
    const fresh = new WsolaStretcher({ sampleRate: RATE, channels: 1, ...engineOpts });
    fresh.setSpeed(2);
    t('WSOLA reset: the same output as a new stretcher', sameSamples(run(w), run(fresh)));
  }

  // Pulling more than there is gives what there is; nothing is pulled twice.
  {
    const w = new WsolaStretcher({ sampleRate: RATE, channels: 1, ...engineOpts });
    w.setSpeed(1.5);
    w.push([tone.subarray(0, RATE)]);
    const avail = w.available();
    const got = w.pull(avail + 1000)[0];
    t('WSOLA pull: at most what is available', got.length === avail && w.available() === 0,
      `${got.length} of ${avail}`);
    t('WSOLA pull(0): nothing', w.pull(0)[0].length === 0);
  }

  // 1x passes the input through as it is.
  {
    const w = new WsolaStretcher({ sampleRate: RATE, channels: 1 });
    w.push([tone.subarray(0, 1000)]);
    t('WSOLA 1x: the input unchanged', sameSamples(w.pull(5000)[0], tone.subarray(0, 1000)));
  }
}

// --- MP4 -----------------------------------------------------------------

/**
 * Feeds `data` in pieces of `step` bytes as the audio SourceBuffer does
 * (mse-hook.js): what is left over goes before the next piece, and a piece
 * that is not yet a box (fewer bytes than a header) is kept whole.
 */
function feed(data, step, classify, demux, list) {
  let rest = new Uint8Array(0);
  const got = [];
  for (let i = 0; i < data.length; i += step) {
    const chunk = data.subarray(i, i + step);
    const u8 = new Uint8Array(rest.length + chunk.length);
    u8.set(rest, 0);
    u8.set(chunk, rest.length);
    if (classify(u8) === 'unknown') {
      rest = u8;
      continue;
    }
    const res = demux(u8);
    got.push(...res[list]);
    rest = res.rest;
  }
  return { got, rest };
}

const sameFrames = (a, b) =>
  a.length === b.length &&
  a.every((f, i) => Math.abs(f.pts - b[i].pts) < 1e-9 && sameSamples(Array.from(f.data), Array.from(b[i].data)));

async function mp4Tests() {
  const c = await import(CONTAINERS);

  // Boxes: a 64-bit size, a size of 0 (to the end), and cut ones.
  {
    const big = Uint8Array.from(bytes(u32(1), ascii('free'), u32(0), u32(20), [1, 2, 3, 4], box('mdat', [9])));
    const boxes = c.parseBoxes(big, 0, big.length);
    t('MP4 boxes: a 64-bit size', boxes.length === 2 && boxes[0].headerSize === 16 && boxes[0].end === 20 &&
      boxes[1].type === 'mdat' && !boxes[1].truncated, JSON.stringify(boxes));
    const toEnd = Uint8Array.from(bytes(u32(0), ascii('mdat'), [1, 2, 3]));
    const b0 = c.parseBoxes(toEnd, 0, toEnd.length);
    t('MP4 boxes: size 0 runs to the end', b0.length === 1 && b0[0].end === toEnd.length && !b0[0].truncated);
    const cut = Uint8Array.from(box('moof', [1, 2, 3, 4, 5, 6])).subarray(0, 10);
    const bc = c.parseBoxes(cut, 0, cut.length);
    t('MP4 boxes: a cut box is marked', bc.length === 1 && bc[0].truncated && bc[0].type === 'moof');
    const header = Uint8Array.from([0, 0, 0, 40, 0x6d]);
    const bh = c.parseBoxes(header, 0, header.length);
    t('MP4 boxes: a cut header is marked', bh.length === 1 && bh[0].truncated && bh[0].start === 0);
    const tiny = Uint8Array.from(bytes(u32(4), ascii('free')));
    t('MP4 boxes: a size below its header is cut, not looped on', c.parseBoxes(tiny, 0, tiny.length)[0].truncated);
  }

  const aacInit = mp4Init({ entry: audioSampleEntry('mp4a', 2, MP4_TIMESCALE, esds(ASC)) });
  t('MP4: an init is told from media', c.classifyMp4(aacInit) === 'init');

  // AAC: codec string from the real object type, rate, channels, the config bytes.
  {
    const cfg = c.audioConfigFromInit(aacInit);
    t('MP4 AAC: codec, rate and channels', cfg.codec === 'mp4a.40.2' && cfg.sampleRate === MP4_TIMESCALE &&
      cfg.numberOfChannels === 2, JSON.stringify({ ...cfg, description: undefined }));
    t('MP4 AAC: the AudioSpecificConfig', cfg.description && sameSamples(Array.from(cfg.description), ASC));
    const he = c.audioConfigFromInit(mp4Init({ entry: audioSampleEntry('mp4a', 2, 48000, esds([0x2b, 0x92, 0x08, 0x00])) }));
    t('MP4 HE-AAC: the codec string says 5', he.codec === 'mp4a.40.5' && he.sampleRate === 48000, he.codec);
    const info = c.parseInitInfo(aacInit);
    t('MP4: timescale and trex defaults', info.timescale === MP4_TIMESCALE && info.trex.defaultDuration === 1024,
      JSON.stringify(info));
  }

  // Opus in MP4: dOps becomes the OpusHead WebCodecs takes.
  {
    const dOps = box('dOps', [0, 2], u16(312), u32(48000), u16(0xfffe), [0]);
    const cfg = c.audioConfigFromInit(mp4Init({ entry: audioSampleEntry('Opus', 2, 48000, dOps), timescale: 48000 }));
    const head = cfg.description ? Array.from(cfg.description) : [];
    t('MP4 Opus: codec and channels', cfg.codec === 'opus' && cfg.numberOfChannels === 2 && cfg.sampleRate === 48000);
    t('MP4 Opus: OpusHead, little-endian', head.length === 19 &&
      String.fromCharCode(...head.slice(0, 8)) === 'OpusHead' && head[8] === 1 && head[9] === 2 &&
      head[10] === (312 & 255) && head[11] === 312 >> 8 &&
      head[12] === (48000 & 255) && head[13] === ((48000 >> 8) & 255) && head[14] === 0 &&
      head[16] === 0xfe && head[17] === 0xff && head[18] === 0, head.join(','));
  }

  t('MP4: a video init is not audio', c.audioConfigFromInit(mp4Init({ entry: box('avc1', new Array(78).fill(0)) })).unsupported);

  // The time scale rewrite: only those four bytes change, in both mdhd versions.
  for (const version of [0, 1]) {
    const init = mp4Init({ entry: audioSampleEntry('mp4a', 2, MP4_TIMESCALE, esds(ASC)), mdhdVersion: version });
    for (const speed of [0.25, 1.5, 2]) {
      const res = c.rewriteInitTimescale(init, speed);
      const ts = c.findMdhdTimescale(res.data);
      const at = c.findMdhdTimescale(init);
      // The bytes that changed, and which: the timescale's own four only.
      const outside = [];
      for (let i = 0; i < init.length; i++) {
        if (init[i] !== res.data[i] && (i < at.offset || i >= at.offset + 4)) outside.push(i);
      }
      t(`MP4 mdhd v${version} ${speed}x: timescale x speed, nothing else changed`,
        ts.timescale === Math.round(MP4_TIMESCALE * speed) && ts.offset === at.offset &&
          res.data.length === init.length && outside.length === 0 && at.timescale === MP4_TIMESCALE,
        `${ts.timescale} at ${ts.offset} (was ${at.offset}), changed outside it: ${outside.join(',')}`);
    }
  }

  // Fragments: every frame with its time and bytes, whole or one byte at a time.
  const info = c.parseInitInfo(aacInit);
  const FRAMES = 12;
  const media = Uint8Array.from(bytes(
    mp4Fragment(Array.from({ length: FRAMES / 2 }, (_, i) => frameBytes(i)), 0x100000000 + 44100 * 10, 1),
    mp4Fragment(Array.from({ length: FRAMES / 2 }, (_, i) => frameBytes(i + FRAMES / 2)), 0x100000000 + 44100 * 10 + 1024 * (FRAMES / 2), 2)
  ));
  const expected = Array.from({ length: FRAMES }, (_, i) => ({
    pts: (0x100000000 + 44100 * 10 + 1024 * i) / MP4_TIMESCALE,
    data: Uint8Array.from(frameBytes(i))
  }));
  {
    const whole = c.demuxFragments(media, info);
    t('MP4 fragments: every frame, its time (64-bit tfdt) and its bytes', sameFrames(whole.samples, expected) &&
      whole.rest.length === 0, `${whole.samples.length} frames, rest ${whole.rest.length}`);
    t('MP4 fragments: durations from the trun', whole.samples.every((s) => Math.abs(s.duration - 1024 / MP4_TIMESCALE) < 1e-12));
    const demux = (u8) => c.demuxFragments(u8, info);
    // A fragment here is 189 bytes: these steps also cut inside the next
    // fragment's first header, which must be kept for the next piece.
    for (const step of [1, 2, 4, 5, 11, 50]) {
      const { got, rest } = feed(media, step, c.classifyMp4, demux, 'samples');
      t(`MP4 fragments fed ${step} byte(s) at a time: the same frames, none twice`,
        sameFrames(got, expected) && rest.length === 0, `${got.length} frames, rest ${rest.length}`);
    }
  }

  // Durations and sizes from the tfhd's defaults, the trun naming only its count.
  {
    const data = [frameBytes(0, 6), frameBytes(1, 6), frameBytes(2, 6)];
    const moofFor = (offset) => box('moof', fullbox('mfhd', 0, 0, u32(1)), box('traf',
      fullbox('tfhd', 0, 0x20000 | 0x08 | 0x10, u32(1), u32(2048), u32(6)),
      fullbox('tfdt', 0, 0, u32(88200)),
      fullbox('trun', 0, 0x01, u32(3), u32(offset))));
    const frag = Uint8Array.from(bytes(moofFor(moofFor(0).length + 8), box('mdat', ...data)));
    const res = c.demuxFragments(frag, info);
    t('MP4 fragments: durations and sizes from the tfhd defaults', res.samples.length === 3 &&
      res.samples.every((smp, i) => Math.abs(smp.pts - (88200 + 2048 * i) / MP4_TIMESCALE) < 1e-9 &&
        sameSamples(Array.from(smp.data), data[i])),
      res.samples.map((smp) => `${smp.pts}:${smp.data.length}`).join(' '));
  }

  // A malformed trun (a count far beyond what the box holds) is not looped over.
  {
    const bad = Uint8Array.from(bytes(box('moof', box('traf', fullbox('tfhd', 0, 0x20000, u32(1)),
      fullbox('trun', 0, 0x200, u32(0x7fffffff))))));
    const started = Date.now();
    const res = c.demuxFragments(bad, info);
    t('MP4 fragments: a huge sample count is refused at once', res.samples.length === 0 && Date.now() - started < 200);
  }
}

// --- WebM ----------------------------------------------------------------

async function webmTests() {
  const c = await import(CONTAINERS);

  // Variable-length integers.
  {
    const cases = [[[0x81], 1], [[0x40, 0x7f], 127], [[0x20, 0x40, 0x00], 16384], [[0x10, 0x00, 0x00, 0x01], 1]];
    t('WebM vints: 1 to 4 bytes', cases.every(([b, v]) => {
      const r = c.readVint(Uint8Array.from(b), 0);
      return r && r.value === v && r.length === b.length;
    }));
    t('WebM vints: all ones is unknown size', c.readVint(Uint8Array.from(UNKNOWN), 0).value === -1 &&
      c.readVint(Uint8Array.from([0xff]), 0).value === -1);
    t('WebM vints: a cut one is null', c.readVint(Uint8Array.from([0x20, 0x01]), 0) === null);
    t('WebM vints: a zero first byte is null', c.readVint(Uint8Array.from([0x00, 1, 2, 3, 4, 5, 6, 7, 8]), 0) === null);
  }

  const init = webmInit({ tcScale: 1000000 });
  t('WebM: an init is told from media', c.classifyWebm(init) === 'init');
  {
    const cfg = c.audioConfigFromWebmInit(init);
    t('WebM Opus: codec, channels, track number and CodecPrivate', cfg.codec === 'opus' && cfg.numberOfChannels === 2 &&
      cfg.trackNumber === 1 && sameSamples(Array.from(cfg.description), OPUS_HEAD), JSON.stringify({ ...cfg, description: undefined }));
    const ts = c.findTimecodeScale(init);
    t('WebM: the TimecodeScale', ts && ts.value === 1000000 && ts.size === 3);
  }

  // The TimecodeScale rewrite: in place when there is one, added when not.
  for (const speed of [0.25, 0.75, 2]) {
    const res = c.rewriteTimecodeScale(init, speed);
    const ts = c.findTimecodeScale(res.data);
    t(`WebM ${speed}x: TimecodeScale / speed, in place`, ts.value === Math.round(1000000 / speed) &&
      res.data.length === init.length && c.audioConfigFromWebmInit(res.data).codec === 'opus', ts && ts.value);
  }
  for (const segmentSize of [undefined, 'unknown', 'info 120']) {
    // 'info 120': an Info of 120 bytes, 127 with the TimecodeScale added,
    // which a 1-byte size cannot say (0xFF means unknown).
    const bare = webmInit({ withScale: false, segmentSize: segmentSize === 'unknown' ? 'unknown' : undefined,
      infoPad: segmentSize === 'info 120' ? 111 : 0 });
    const res = c.rewriteTimecodeScale(bare, 2);
    const ts = c.findTimecodeScale(res.data);
    const cfg = c.audioConfigFromWebmInit(res.data);
    const top = c.parseElements(res.data, 0, res.data.length);
    t(`WebM without a TimecodeScale (${segmentSize || 'known Segment size'}): one is added, the rest still parses`,
      ts && ts.value === 500000 && cfg.codec === 'opus' && cfg.trackNumber === 1 &&
        top.length === 2 && !top[1].truncated && top[1].end === res.data.length,
      `${ts && ts.value}, ${top.map((e) => `${e.id}:${e.end}`).join(' ')} of ${res.data.length}`);
  }

  // Clusters: the audio track's frames with their times, the video's left out.
  const frames = (base) => [{ rel: -5, data: [1, 2, 3] }, { rel: 0, data: [4, 5] }, { rel: 20, data: [6, 7, 8, 9] }]
    .map((f, i) => ({ ...f, data: f.data.map((b) => (b + base + i) & 255) }));
  const media = Uint8Array.from(bytes(cluster(1000, frames(0)), cluster(1060, frames(50), { group: true })));
  const expected = [
    ...frames(0).map((f) => ({ pts: (1000 + f.rel) / 1000, data: f.data })),
    ...frames(50).map((f) => ({ pts: (1060 + f.rel) / 1000, data: f.data }))
  ];
  const info = { timecodeScale: 1000000, trackNumber: 1 };
  {
    const whole = c.demuxClusters(media, info);
    t('WebM clusters: the audio frames, their times (negative offsets too) and bytes; blocks in groups too',
      sameFrames(whole.frames, expected) && whole.rest.length === 0,
      `${whole.frames.length} frames: ${whole.frames.map((f) => f.pts).join(', ')}`);
    // One block with the key flag (0x80) and one without: both ways read.
    const flagged = c.demuxClusters(Uint8Array.from(el(ID.CLUSTER, el(ID.TIMECODE, [0]),
      el(ID.SIMPLE, block(1, 0, [1, 2], 0x80)), el(ID.SIMPLE, block(1, 10, [3, 4], 0x00)))), info);
    t('WebM clusters: a SimpleBlock\'s key flag is read, set and clear',
      flagged.frames.length === 2 && flagged.frames[0].key === true && flagged.frames[1].key === false,
      flagged.frames.map((f) => f.key).join(','));
    const demux = (u8) => c.demuxClusters(u8, info);
    for (const step of [1, 2, 5, 33]) {
      const { got, rest } = feed(media, step, c.classifyWebm, demux, 'frames');
      t(`WebM clusters fed ${step} byte(s) at a time: the same frames, none twice`,
        sameFrames(got, expected) && rest.length === 0, `${got.length} frames, rest ${rest.length}`);
    }
    const scaled = c.demuxClusters(media, { timecodeScale: 500000, trackNumber: 1 });
    t('WebM clusters: times follow the TimecodeScale', Math.abs(scaled.frames[0].pts - 0.4975) < 1e-9, scaled.frames[0].pts);
  }

  // Init and media in one append, as the first append can be.
  {
    const both = Uint8Array.from(bytes(Array.from(webmInit({ segmentSize: 'unknown' })), cluster(0, frames(0))));
    t('WebM: init and media together', c.classifyWebm(both) === 'init+media' &&
      c.demuxClusters(both, info).frames.length === 3);
  }

  // Laced blocks are refused (the engine then falls back to 1x), not misread.
  {
    const laced = Uint8Array.from(el(ID.CLUSTER, el(ID.TIMECODE, [0]), el(ID.SIMPLE, block(1, 0, [0, 1, 2], 0x82))));
    let name = '';
    try {
      c.demuxClusters(laced, info);
    } catch (e) {
      name = e.name;
    }
    t('WebM: a laced block is refused as not supported', name === 'NotSupportedError', name || 'no error');
  }
}

(async () => {
  await wsolaTests();
  await mp4Tests();
  await webmTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
