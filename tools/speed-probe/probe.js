/**
 * Playback speed probe for older webOS TVs (issue #97).
 *
 * The speed engine (src/speed/) needs WebCodecs' AudioDecoder, which only
 * Chromium 94+ (webOS 23 and newer) has. Everything else it does works on
 * older engines. This page checks, on the TV itself, whether the old
 * AudioContext.decodeAudioData() can stand in for AudioDecoder:
 *
 *   1. what the engine has (WebCodecs, WebAssembly, Web Audio, MSE types);
 *   2. whole-file decoding of Opus (Ogg, WebM) and AAC (ADTS, MP4, fragmented MP4);
 *   3. the method itself: raw Opus packets wrapped in Ogg, and raw AAC frames
 *      wrapped in ADTS, decoded one second at a time, with and without
 *      pre-roll, and compared with the whole-file decode at the seams;
 *   4. how fast src/speed/wsola.js stretches the audio on this TV;
 *   5. a listening test at 1x, 1.25x and 1.5x.
 *
 * Built into one HTML file by build.cjs. Written for Chromium 38 (webOS 3).
 */
/* global window, document, MediaSource */
import '../../src/polyfills.js';
import { WsolaStretcher } from '../../src/speed/wsola.js';

const VERSION = 'SP1';

// ---- typed array methods Chromium 38 lacks (45+), used by wsola.js ----------
const typedNative = {
  fill: !!Float32Array.prototype.fill,
  slice: !!Float32Array.prototype.slice,
  copyWithin: !!Float32Array.prototype.copyWithin
};
if (!typedNative.fill) {
  Float32Array.prototype.fill = function fill(v, start, end) {
    const len = this.length;
    let s = start === undefined ? 0 : start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const e = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
    for (; s < e; s++) this[s] = v;
    return this;
  };
}
if (!typedNative.slice) {
  Float32Array.prototype.slice = function slice(start, end) {
    const len = this.length;
    const s = start === undefined ? 0 : start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const e = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
    const out = new Float32Array(Math.max(e - s, 0));
    out.set(this.subarray(s, e));
    return out;
  };
}
if (!typedNative.copyWithin) {
  Float32Array.prototype.copyWithin = function copyWithin(target, start, end) {
    const len = this.length;
    const e = end === undefined ? len : end;
    const part = new Float32Array(this.subarray(start, e));
    this.set(part.subarray(0, Math.max(0, Math.min(part.length, len - target))), target);
    return this;
  };
}

// ---- page ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const resultsEl = $('results');
const summary = { v: VERSION };

function row(name) {
  const tr = document.createElement('tr');
  const a = document.createElement('td');
  const b = document.createElement('td');
  const c = document.createElement('td');
  a.textContent = name;
  b.textContent = '…';
  tr.appendChild(a);
  tr.appendChild(b);
  tr.appendChild(c);
  resultsEl.appendChild(tr);
  return (status, detail, cls) => {
    b.textContent = status;
    b.className = cls || (status === 'OK' || status === 'yes' ? 'ok' : status === 'no' ? 'bad' : '');
    c.textContent = detail || '';
  };
}

function section(title) {
  const tr = document.createElement('tr');
  const th = document.createElement('th');
  th.colSpan = 3;
  th.textContent = title;
  tr.appendChild(th);
  resultsEl.appendChild(tr);
}

function setStatus(text) {
  $('status').textContent = text;
}

function showSummary() {
  const parts = [];
  for (const k in summary) parts.push(k === 'v' ? summary[k] : `${k}:${summary[k]}`);
  $('summary').textContent = parts.join(' | ');
}

window.onerror = (msg, src, line) => {
  const r = row('Script error');
  r('ERROR', `${msg} (line ${line})`, 'bad');
  summary.err = String(msg).slice(0, 40);
  showSummary();
  report('SCRIPT-ERROR');
};

const now = () => (window.performance && performance.now ? performance.now() : Date.now());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const db = (x) => (x > 0 ? `${Math.round(20 * Math.log(x) / Math.LN10)} dB` : '-inf dB');

// ---- samples ---------------------------------------------------------------
const SAMPLES = JSON.parse($('samples').textContent);

function b64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function splitPackets(data, sizes) {
  const out = [];
  let at = 0;
  for (let i = 0; i < sizes.length; i++) {
    out.push(data.subarray(at, at + sizes[i]));
    at += sizes[i];
  }
  return out;
}

// ---- Web Audio -------------------------------------------------------------
const AC = window.AudioContext || window.webkitAudioContext;
const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
let realtime = null;
const offline = {};

function decodeCtx(rate, channels) {
  // An offline context at the source's own rate, so decodeAudioData does not
  // resample and the chunked decode can be compared sample for sample.
  if (OAC) {
    const key = `${rate}/${channels}`;
    if (!offline[key]) {
      try {
        offline[key] = new OAC(channels, rate, rate);
      } catch {
        offline[key] = null;
      }
    }
    if (offline[key]) return { ctx: offline[key], resampled: false };
  }
  if (!realtime) realtime = new AC();
  return { ctx: realtime, resampled: realtime.sampleRate !== rate };
}

/** decodeAudioData, callback form (the promise form is Chromium 49+). */
function decode(ctx, bytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    // decodeAudioData detaches the buffer it is given: always a fresh copy.
    const buf = new Uint8Array(bytes).buffer;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('timeout'));
    }, timeoutMs || 15000);
    const t0 = now();
    try {
      const p = ctx.decodeAudioData(
        buf,
        (audio) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ audio, ms: now() - t0 });
        },
        (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(new Error((err && (err.message || err.name)) || 'decode error'));
        }
      );
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      done = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

function channelsOf(audio) {
  const out = [];
  for (let c = 0; c < audio.numberOfChannels; c++) out.push(audio.getChannelData(c));
  return out;
}

// ---- Ogg Opus muxer --------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc;
}

function oggPage(packet, granule, seq, flags) {
  const segs = [];
  let left = packet.length;
  while (left >= 255) {
    segs.push(255);
    left -= 255;
  }
  segs.push(left);
  const page = new Uint8Array(27 + segs.length + packet.length);
  page.set([0x4f, 0x67, 0x67, 0x53, 0, flags], 0);
  // 64-bit granule position, little endian (fits in 32 bits here).
  page[6] = granule & 0xff;
  page[7] = (granule >>> 8) & 0xff;
  page[8] = (granule >>> 16) & 0xff;
  page[9] = (granule >>> 24) & 0xff;
  page.set([0x50, 0x52, 0x4f, 0x42], 14); // serial
  page[18] = seq & 0xff;
  page[19] = (seq >>> 8) & 0xff;
  page[26] = segs.length;
  page.set(segs, 27);
  page.set(packet, 27 + segs.length);
  const crc = oggCrc(page);
  page[22] = crc & 0xff;
  page[23] = (crc >>> 8) & 0xff;
  page[24] = (crc >>> 16) & 0xff;
  page[25] = (crc >>> 24) & 0xff;
  return page;
}

function ascii(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}

/** Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716 3.1). */
function opusSamples(packet) {
  const toc = packet[0];
  const config = toc >> 3;
  let frame;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) frame = config & 1 ? 960 : 480;
  else frame = [120, 240, 480, 960][config & 3];
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : packet[1] & 0x3f;
  return frame * frames;
}

/** An Ogg Opus file holding `packets`, the first `preSkip` samples to drop. */
function muxOggOpus(packets, channels, preSkip) {
  const head = new Uint8Array(19);
  head.set(ascii('OpusHead'), 0);
  head[8] = 1;
  head[9] = channels;
  head[10] = preSkip & 0xff;
  head[11] = (preSkip >> 8) & 0xff;
  head.set([0x80, 0xbb, 0, 0], 12); // 48000
  const tags = new Uint8Array(16);
  tags.set(ascii('OpusTags'), 0); // vendor length 0, no comments
  const pages = [oggPage(head, 0, 0, 2), oggPage(tags, 0, 1, 0)];
  let granule = 0;
  for (let i = 0; i < packets.length; i++) {
    granule += opusSamples(packets[i]);
    pages.push(oggPage(packets[i], granule, i + 2, i === packets.length - 1 ? 4 : 0));
  }
  return concat(pages);
}

// ---- ADTS ------------------------------------------------------------------
function muxAdts(frames, aot, srIndex, channels) {
  const parts = [];
  for (let i = 0; i < frames.length; i++) {
    const len = frames[i].length + 7;
    const h = new Uint8Array(7);
    h[0] = 0xff;
    h[1] = 0xf1;
    h[2] = ((aot - 1) << 6) | (srIndex << 2) | (channels >> 2);
    h[3] = ((channels & 3) << 6) | (len >> 11);
    h[4] = (len >> 3) & 0xff;
    h[5] = ((len & 7) << 5) | 0x1f;
    h[6] = 0xfc;
    parts.push(h, frames[i]);
  }
  return concat(parts);
}

function concat(parts) {
  let n = 0;
  for (let i = 0; i < parts.length; i++) n += parts[i].length;
  const out = new Uint8Array(n);
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], at);
    at += parts[i].length;
  }
  return out;
}

// ---- comparing a chunked decode with the whole-file one -----------------------
/** Offset of `out` against `ref` around `at`, the one with the least error. */
function align(out, ref, at, range) {
  const win = 2048;
  let best = 0;
  let bestErr = Infinity;
  for (let off = -range; off <= range; off++) {
    let err = 0;
    for (let i = 0; i < win; i += 2) {
      const r = ref[at + off + i];
      if (r === undefined) {
        err = Infinity;
        break;
      }
      const d = out[at + i] - r;
      err += d * d;
    }
    if (err < bestErr) {
      bestErr = err;
      best = off;
    }
  }
  return best;
}

/**
 * How a chunked decode differs from the whole-file one:
 *  - seam: the worst difference in the 4096 samples after each seam, where a
 *    decoder that restarted has not settled yet;
 *  - rest: the worst difference elsewhere (AAC's noise substitution is random,
 *    so a little is normal there);
 *  - jump: the step a seam adds to the audio's own step there, against the
 *    steps around it. A click is a step far larger than its neighbours.
 */
function compare(out, ref, seams, offset) {
  const after = new Uint8Array(out.length);
  for (let s = 0; s < seams.length; s++) {
    for (let i = seams[s]; i < Math.min(out.length, seams[s] + 4096); i++) after[i] = 1;
  }
  let seamMax = 0;
  let restMax = 0;
  const end = Math.min(out.length, ref.length - offset) - 2048;
  for (let i = 2048; i < end; i++) {
    const d = Math.abs(out[i] - ref[i + offset]);
    if (after[i]) {
      if (d > seamMax) seamMax = d;
    } else if (d > restMax) restMax = d;
  }
  let jump = 0;
  for (let s = 0; s < seams.length; s++) {
    const at = seams[s];
    if (at < 300 || at + 300 > out.length || at + offset + 300 > ref.length) continue;
    let sum = 0;
    let n = 0;
    for (let i = at - 256; i < at + 256; i++) {
      if (i === at) continue;
      sum += Math.abs(ref[i + offset] - ref[i + offset - 1]);
      n++;
    }
    // The step the seam adds on top of the one the audio itself has there.
    const extra = Math.abs(out[at] - out[at - 1] - (ref[at + offset] - ref[at + offset - 1]));
    const ratio = extra / Math.max(sum / n, 1e-6);
    if (ratio > jump) jump = ratio;
  }
  return { seamMax, restMax, jump };
}

/** Decode in chunks of about one second, each with `preroll` units before it. */
function chunkedDecode({ units, unitSamples, rate, channels, preroll, mux, firstSkip }) {
  const { ctx, resampled } = decodeCtx(rate, channels);
  const chunks = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let n = 0;
    while (end < units.length && n < rate) n += unitSamples(units[end++]);
    chunks.push([start, end]);
    start = end;
  }
  const outs = [];
  for (let c = 0; c < channels; c++) outs.push([]);
  const seams = [];
  let total = 0;
  let ms = 0;
  let chain = Promise.resolve();
  chunks.forEach(([a, b]) => {
    chain = chain.then(() => {
      const from = Math.max(0, a - preroll);
      let skip = 0;
      for (let i = from; i < a; i++) skip += unitSamples(units[i]);
      const file = mux(units.slice(from, b), skip, a === 0);
      return decode(ctx, file).then(({ audio, ms: t }) => {
        ms += t;
        // Opus drops the pre-roll itself (pre-skip); ADTS has no such field.
        const drop = firstSkip ? 0 : skip;
        const data = channelsOf(audio);
        if (total > 0) seams.push(total);
        for (let c = 0; c < channels; c++) outs[c].push(data[Math.min(c, data.length - 1)].subarray(drop));
        total += audio.length - drop;
      });
    });
  });
  return chain.then(() => {
    const pcm = outs.map((list) => {
      const all = new Float32Array(total);
      let at = 0;
      for (let i = 0; i < list.length; i++) {
        all.set(list[i], at);
        at += list[i].length;
      }
      return all;
    });
    return { pcm, seams, ms, chunks: chunks.length, resampled };
  });
}

// ---- tests -----------------------------------------------------------------
const reference = {};
const listen = {};

function testEnvironment() {
  section('1. This TV');
  const ua = navigator.userAgent;
  const m = ua.match(/Chrom(?:e|ium)\/(\d+)/);
  const chrome = m ? +m[1] : 0;
  const webos =
    chrome >= 120 ? '25' : chrome >= 108 ? '24' : chrome >= 94 ? '23' : chrome >= 87 ? '22' :
    chrome >= 79 ? '6' : chrome >= 68 ? '5' : chrome >= 53 ? '4' : chrome >= 38 ? '3' : '?';
  summary.c = chrome;
  row('Browser engine')(`Chromium ${chrome || '?'}`, `likely webOS ${webos}`, 'ok');
  row('User agent')('', ua);
  const has = (name, ok, note) => {
    row(name)(ok ? 'yes' : 'no', note || '');
    return ok;
  };
  summary.wc = has('WebCodecs AudioDecoder', typeof window.AudioDecoder !== 'undefined', 'what the speed engine uses now') ? 1 : 0;
  summary.wasm = has('WebAssembly', typeof window.WebAssembly !== 'undefined') ? 1 : 0;
  has('AudioContext', !!AC, AC && !window.AudioContext ? 'webkit prefix' : '');
  has('OfflineAudioContext', !!OAC, OAC && !window.OfflineAudioContext ? 'webkit prefix' : '');
  has('MediaSource', typeof window.MediaSource !== 'undefined');
  has('Typed array fill/slice/copyWithin', typedNative.fill && typedNative.slice && typedNative.copyWithin,
    'missing ones are filled in on this page');
  if (AC) {
    try {
      realtime = new AC();
      row('Audio output rate')(`${realtime.sampleRate} Hz`, '', 'ok');
    } catch (e) {
      row('Audio output rate')('ERROR', String(e.message || e), 'bad');
    }
  }
  if (window.MediaSource && MediaSource.isTypeSupported) {
    const types = [
      'audio/webm; codecs="opus"',
      'audio/mp4; codecs="mp4a.40.2"',
      'audio/mp4; codecs="opus"',
      'video/webm; codecs="vp9"',
      'video/mp4; codecs="avc1.640028"'
    ];
    const ok = types.filter((t) => MediaSource.isTypeSupported(t));
    row('MSE types')(`${ok.length}/${types.length}`, ok.map((t) => t.replace(/; codecs=/, ' ')).join(', '), 'ok');
  }
  return Promise.resolve();
}

function testWholeFiles() {
  section('2. Whole files with decodeAudioData');
  const files = [
    ['opus.ogg', 'Opus in Ogg', 48000, 'og'],
    ['opus.webm', 'Opus in WebM', 48000, 'wm'],
    ['aac.aac', 'AAC in ADTS', 44100, 'ad'],
    ['aac.m4a', 'AAC in MP4', 44100, 'm4'],
    ['aac-frag.mp4', 'AAC in fragmented MP4 (as YouTube sends)', 44100, 'fm']
  ];
  let chain = Promise.resolve();
  files.forEach(([file, label, rate, key]) => {
    chain = chain.then(() => {
      const set = row(label);
      setStatus(`Decoding ${label}…`);
      const { ctx, resampled } = decodeCtx(rate, 2);
      return decode(ctx, b64(SAMPLES.files[file]))
        .then(({ audio, ms }) => {
          const secs = audio.duration;
          set('OK', `${secs.toFixed(2)} s, ${audio.numberOfChannels} ch, ${audio.sampleRate} Hz, ${Math.round(ms)} ms ` +
            `(${(secs * 1000 / ms).toFixed(0)}x real time)${resampled ? ', resampled' : ''}`);
          summary[key] = 1;
          if (file === 'opus.ogg') reference.opus = channelsOf(audio);
          if (file === 'aac.aac') reference.aac = channelsOf(audio);
        })
        .catch((e) => {
          set('FAIL', String(e.message || e), 'bad');
          summary[key] = 0;
        })
        .then(showSummary);
    });
  });
  return chain;
}

function reportChunked(set, res, ref, rate, range, key) {
  if (!ref) {
    set('OK', `${res.chunks} chunks; no whole-file decode to compare with`);
    return 0;
  }
  const at = Math.min(res.pcm[0].length, ref[0].length) >> 1;
  const offset = align(res.pcm[0], ref[0], at, range);
  const { seamMax, restMax, jump } = compare(res.pcm[0], ref[0], res.seams, offset);
  const secs = res.pcm[0].length / rate;
  const verdict = seamMax < 0.01 && jump < 1 ? 'OK' : seamMax < 0.05 && jump < 4 ? 'WEAK' : 'CLICKS';
  set(verdict, `after seams ${db(seamMax)}, elsewhere ${db(restMax)}, extra step at seam ${jump.toFixed(2)}x, ` +
    `offset ${offset}, ${res.chunks} chunks, ${Math.round(res.ms / secs)} ms per second of audio` +
    `${res.resampled ? ', resampled' : ''}`, verdict === 'OK' ? 'ok' : 'bad');
  summary[key] = `${verdict}${Math.round(20 * Math.log(Math.max(seamMax, 1e-9)) / Math.LN10)}/${jump.toFixed(2)}`;
  return seamMax;
}

function testChunked() {
  section('3. One second at a time (the method; without pre-roll it is expected to click)');
  const op = SAMPLES.opus;
  const opusPackets = splitPackets(b64(op.data), op.sizes);
  const aac = SAMPLES.aac;
  const aacFrames = splitPackets(b64(aac.data), aac.sizes);

  const runs = [
    { label: 'Opus → Ogg, no pre-roll', key: 'op0', opus: true, preroll: 0 },
    { label: 'Opus → Ogg, 80 ms pre-roll', key: 'op4', opus: true, preroll: 4 },
    { label: 'Opus → Ogg, 200 ms pre-roll', key: 'op10', opus: true, preroll: 10 },
    { label: 'Opus → Ogg, 400 ms pre-roll', key: 'op20', opus: true, preroll: 20 },
    { label: 'AAC → ADTS, no pre-roll', key: 'aa0', opus: false, preroll: 0 },
    { label: 'AAC → ADTS, 1 frame pre-roll', key: 'aa1', opus: false, preroll: 1 },
    { label: 'AAC → ADTS, 2 frames pre-roll', key: 'aa2', opus: false, preroll: 2 }
  ];
  let chain = Promise.resolve();
  runs.forEach((run) => {
    chain = chain.then(() => {
      const set = row(run.label);
      setStatus(`Decoding ${run.label}…`);
      const job = run.opus
        ? chunkedDecode({
            units: opusPackets,
            unitSamples: opusSamples,
            rate: 48000,
            channels: op.channels,
            preroll: run.preroll,
            firstSkip: true,
            mux: (packets, skip, first) => muxOggOpus(packets, op.channels, skip + (first ? op.preSkip : 0))
          })
        : chunkedDecode({
            units: aacFrames,
            unitSamples: () => 1024,
            rate: aac.rate,
            channels: aac.channels,
            preroll: run.preroll,
            firstSkip: false,
            mux: (frames) => muxAdts(frames, aac.aot, aac.srIndex, aac.channels)
          });
      return job
        .then((res) => {
          const err = reportChunked(set, res, run.opus ? reference.opus : reference.aac,
            run.opus ? 48000 : aac.rate, 2200, run.key);
          const name = run.opus ? 'opus' : 'aac';
          if (!listen[name] || err < listen[name].err) listen[name] = { pcm: res.pcm, rate: run.opus ? 48000 : aac.rate, err };
        })
        .catch((e) => {
          set('FAIL', String(e.message || e), 'bad');
          summary[run.key] = 'F';
        })
        .then(showSummary);
    });
  });
  return chain;
}

function stretch(pcm, rate, speed) {
  const st = new WsolaStretcher({ sampleRate: rate, channels: pcm.length, searchStep: 2, corrStep: 2 });
  st.setSpeed(speed);
  const block = 4800;
  const outs = [];
  for (let c = 0; c < pcm.length; c++) outs.push([]);
  let total = 0;
  const drain = () => {
    const n = st.available();
    if (!n) return;
    const got = st.pull(n);
    for (let c = 0; c < pcm.length; c++) outs[c].push(got[c]);
    total += got[0].length;
  };
  for (let at = 0; at < pcm[0].length; at += block) {
    st.push(pcm.map((ch) => ch.subarray(at, Math.min(at + block, ch.length))));
    drain();
  }
  st.flush();
  drain();
  return outs.map((list) => {
    const all = new Float32Array(total);
    let at = 0;
    for (let i = 0; i < list.length; i++) {
      all.set(list[i], at);
      at += list[i].length;
    }
    return all;
  });
}

function testWsola() {
  section('4. Time-stretch speed (src/speed/wsola.js)');
  const src = listen.opus || listen.aac;
  if (!src) {
    row('WSOLA')('SKIP', 'nothing decoded to stretch', 'bad');
    return Promise.resolve();
  }
  let chain = Promise.resolve();
  [1.25, 1.5, 2].forEach((speed) => {
    chain = chain.then(() => wait(50)).then(() => {
      const set = row(`WSOLA at ${speed}x`);
      const t0 = now();
      stretch(src.pcm, src.rate, speed);
      const ms = now() - t0;
      const secs = src.pcm[0].length / src.rate;
      // The engine runs on the page's own thread next to YouTube: it needs
      // to be many times faster than real time, not just faster.
      const x = (secs * 1000) / ms;
      set(x >= 8 ? 'OK' : x >= 3 ? 'TIGHT' : 'SLOW', `${x.toFixed(1)}x real time (${Math.round(ms)} ms for ${secs.toFixed(1)} s)`,
        x >= 8 ? 'ok' : 'bad');
      if (speed === 1.5) summary.ws = x.toFixed(1);
      showSummary();
    });
  });
  return chain;
}

// ---- listening ---------------------------------------------------------------
let playing = null;

function play(which, speed) {
  stop();
  const src = listen[which];
  if (!src) {
    setStatus(`No ${which === 'opus' ? 'Opus' : 'AAC'} audio decoded, nothing to play.`);
    return;
  }
  if (!realtime) realtime = new AC();
  if (realtime.resume) realtime.resume();
  setStatus(`Preparing ${which === 'opus' ? 'Opus' : 'AAC'} at ${speed}x…`);
  setTimeout(() => {
    const pcm = speed === 1 ? src.pcm : stretch(src.pcm, src.rate, speed);
    const buf = realtime.createBuffer(pcm.length, pcm[0].length, src.rate);
    for (let c = 0; c < pcm.length; c++) buf.getChannelData(c).set(pcm[c]);
    const node = realtime.createBufferSource();
    node.buffer = buf;
    node.connect(realtime.destination);
    (node.start || node.noteOn).call(node, 0);
    playing = node;
    setStatus(`Playing ${which === 'opus' ? 'Opus' : 'AAC'} at ${speed}x (decoded one second at a time). Listen for clicks or gaps.`);
  }, 30);
}

function stop() {
  if (!playing) return;
  try {
    (playing.stop || playing.noteOff).call(playing, 0);
  } catch {
    // already ended
  }
  playing = null;
}

function setupButtons() {
  const buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.getAttribute('data-act');
      if (act === 'stop') {
        stop();
        setStatus('Stopped.');
      } else {
        const [which, speed] = act.split(':');
        play(which, +speed);
      }
    });
  });
  // Remote control: Left/Right move between the buttons, OK presses one.
  document.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    let next = -1;
    if (e.keyCode === 37) next = i <= 0 ? buttons.length - 1 : i - 1;
    else if (e.keyCode === 39) next = i < 0 || i === buttons.length - 1 ? 0 : i + 1;
    else if ((e.keyCode === 38 || e.keyCode === 40) && i < 0) next = 0;
    if (next >= 0) {
      buttons[next].focus();
      e.preventDefault();
    }
  });
  buttons[0].focus();
}

/**
 * For unattended runs (the webOS TV Simulator): when the page sets
 * window.PROBE_REPORT to a URL, the results are posted there as text when the
 * run ends. A plain-text POST needs no CORS preflight from a file:// page.
 */
function report(state) {
  const url = window.PROBE_REPORT;
  if (!url) return;
  const lines = [`${state} | ${$('summary').textContent}`];
  const rows = resultsEl.querySelectorAll('tr');
  for (let i = 0; i < rows.length; i++) lines.push(rows[i].textContent ? rowText(rows[i]) : '');
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'text/plain');
    xhr.send(lines.join('\n'));
  } catch {
    // nothing to report to
  }
}

function rowText(tr) {
  const cells = tr.children;
  const out = [];
  for (let i = 0; i < cells.length; i++) out.push(cells[i].textContent);
  return out.join(' | ');
}

function run() {
  setupButtons();
  showSummary();
  testEnvironment()
    .then(testWholeFiles)
    .then(testChunked)
    .then(testWsola)
    .then(() => {
      setStatus('Done. A photo of the orange box is enough (the table has the details). Then try the buttons.');
      $('done').style.display = 'block';
      showSummary();
      report('DONE');
    })
    .catch((e) => {
      row('Probe')('ERROR', String((e && e.message) || e), 'bad');
      setStatus('Stopped on an error. Take a photo of the screen.');
      showSummary();
      report('ERROR');
    });
}

if (!AC) {
  setStatus('This browser has no Web Audio: playback speed cannot work here.');
  summary.ac = 0;
  showSummary();
  report('NO-AUDIO');
} else {
  run();
}
