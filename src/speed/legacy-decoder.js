/**
 * Playback speed without WebCodecs (webOS 4-6 and 22, Chromium 53-87): the
 * part of WebCodecs the speed engine uses - AudioDecoder, EncodedAudioChunk
 * and the AudioData they give - made from the Web Audio API's
 * decodeAudioData(), which every one of those TVs has.
 *
 * decodeAudioData() decodes whole files, not single frames. So the AAC frames
 * the engine sends are put in ADTS (a 7-byte header per frame, the simplest
 * file AAC has) and decoded about a second at a time. Each piece is decoded
 * with 4 frames before and 4 after it, and only its own frames' samples are
 * kept, so the pieces join without a click: measured on a webOS 4 TV
 * (Chromium 53) with the speed probe, the joined audio matched the whole-file
 * decode to -60 dB, where pieces decoded on their own clicked (#97).
 *
 * Opus is left out: decodeAudioData() on Chromium 53 cannot decode it, in any
 * container. Off 1x the player is offered AAC only (playback-speed.js).
 */

const FRAME = 1024;
// About a second of audio at 44.1 or 48 kHz.
const PIECE = 43;
const PRE = 4;
const POST = 4;
// When no frame has come for this long (the video paused, the engine not
// reading further ahead yet), what there is gets decoded, all but the last
// frames, which stay as the next piece's frames before it...
const FLUSH_MS = 400;
// ...and after this long (the end of the video) those too, without frames
// after them.
const FINAL_MS = 2000;
// Frames this far behind the newest one are forgotten.
const KEEP_S = 20;

// MPEG-4 sampling frequency index (ISO 14496-3 table 1.18).
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** The AAC configuration the description (AudioSpecificConfig) holds, or null when ADTS cannot carry it. */
export function parseAacConfig(cfg) {
  if (!cfg || cfg.codec !== 'mp4a.40.2') return null;
  const d = cfg.description;
  if (!d || d.byteLength < 2) return null;
  const bytes = d instanceof Uint8Array ? d : new Uint8Array(d.buffer || d, d.byteOffset || 0, d.byteLength);
  const aot = bytes[0] >> 3;
  const srIndex = ((bytes[0] & 7) << 1) | (bytes[1] >> 7);
  const channels = (bytes[1] >> 3) & 15;
  // AAC LC only, a rate ADTS can name, 1 to 7 channels.
  if (aot !== 2 || srIndex >= RATES.length || channels < 1 || channels > 7) return null;
  return { aot, srIndex, channels, sampleRate: RATES[srIndex] };
}

/** ADTS file of the given raw AAC frames. */
export function muxAdts(frames, { aot, srIndex, channels }) {
  let total = 0;
  for (let i = 0; i < frames.length; i++) total += frames[i].length + 7;
  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < frames.length; i++) {
    const len = frames[i].length + 7;
    out[at] = 0xff;
    out[at + 1] = 0xf1;
    out[at + 2] = ((aot - 1) << 6) | (srIndex << 2) | (channels >> 2);
    out[at + 3] = ((channels & 3) << 6) | (len >> 11);
    out[at + 4] = (len >> 3) & 0xff;
    out[at + 5] = ((len & 7) << 5) | 0x1f;
    out[at + 6] = 0xfc;
    out.set(frames[i], at + 7);
    at += len;
  }
  return out;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return new Uint8Array(data.slice(0));
}

/** The speed engine's EncodedAudioChunk: the frame and its time. */
class LegacyChunk {
  constructor({ type, timestamp, duration, data }) {
    this.type = type;
    this.timestamp = timestamp;
    this.duration = duration;
    this.data = toBytes(data);
    this.byteLength = this.data.length;
  }
}

/** The speed engine's AudioData: decoded samples, one array per channel. */
class LegacyAudioData {
  constructor(timestamp, sampleRate, channels) {
    this.timestamp = timestamp;
    this.sampleRate = sampleRate;
    this.numberOfChannels = channels.length;
    this.numberOfFrames = channels[0].length;
    this.channels = channels;
  }

  copyTo(dest, { planeIndex }) {
    dest.set(this.channels[planeIndex]);
  }

  close() {
    this.channels = null;
  }
}

/**
 * The AudioDecoder and EncodedAudioChunk the speed engine is given on a TV
 * without WebCodecs, or null when the TV cannot decode this way either.
 */
export function legacyAudioCodecs(win) {
  const OAC = win.OfflineAudioContext || win.webkitOfflineAudioContext;
  const F32 = win.Float32Array || Float32Array;
  // Chromium 45 and newer: the stretcher copies and clears with these. Below
  // that (webOS 3, Chromium 38) the speed stays off.
  if (!OAC || typeof F32.prototype.slice !== 'function' || typeof F32.prototype.fill !== 'function') return null;

  class LegacyAudioDecoder {
    static isConfigSupported(cfg) {
      return Promise.resolve({ supported: !!parseAacConfig(cfg), config: cfg });
    }

    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.state = 'unconfigured';
      this.gen = 0;
      this.ctx = null;
    }

    configure(cfg) {
      const aac = parseAacConfig(cfg);
      if (!aac) {
        this.fail(Object.assign(new Error('Not supported'), { name: 'NotSupportedError' }));
        return;
      }
      if (!this.ctx || !this.aac || this.aac.sampleRate !== aac.sampleRate || this.aac.channels !== aac.channels) {
        // At the stream's own rate, so the samples are not resampled.
        this.ctx = new OAC(aac.channels, aac.sampleRate, aac.sampleRate);
      }
      this.aac = aac;
      this.clear();
      this.state = 'configured';
    }

    clear() {
      this.gen++;
      // Every frame the engine sent, sorted by time; `done` once decoded.
      this.frames = [];
      this.busy = false;
      // How far a pause or the end lets pieces go (nextPiece).
      this.level = 0;
      this.stopTimers();
    }

    stopTimers() {
      if (this.flushTimer) win.clearTimeout(this.flushTimer);
      if (this.finalTimer) win.clearTimeout(this.finalTimer);
      this.flushTimer = null;
      this.finalTimer = null;
    }

    decode(chunk) {
      if (this.state !== 'configured') return;
      const f = { ts: chunk.timestamp, dur: chunk.duration, data: chunk.data, done: false };
      const list = this.frames;
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].ts < f.ts) lo = mid + 1;
        else hi = mid;
      }
      // Sent again (its audio was dropped): decoded again.
      if (lo < list.length && list[lo].ts === f.ts) list[lo] = f;
      else list.splice(lo, 0, f);
      // Forget what is far behind.
      const newest = list[list.length - 1].ts;
      let cut = 0;
      while (cut < list.length && list[cut].ts < newest - KEEP_S * 1e6) cut++;
      if (cut) list.splice(0, cut);
      this.level = 0;
      // After the engine's whole batch, not after each frame of it.
      if (!this.queued) {
        this.queued = true;
        Promise.resolve().then(() => {
          this.queued = false;
          this.pump();
        });
      }
      this.stopTimers();
      this.flushTimer = win.setTimeout(() => {
        this.flushTimer = null;
        this.level = 1;
        this.pump();
      }, FLUSH_MS);
      this.finalTimer = win.setTimeout(() => {
        this.finalTimer = null;
        this.level = 2;
        this.pump();
      }, FINAL_MS);
    }

    /** Whether frame i follows frame i - 1 with no gap. */
    joins(i) {
      const a = this.frames[i - 1];
      const b = this.frames[i];
      return !!a && !!b && Math.abs(a.ts + a.dur - b.ts) < 2000;
    }

    /**
     * The next piece to decode, [a, b), with the frames before and after it
     * it is decoded with, [from, to); or null to wait for more frames.
     * `level` 0: only a piece whose frames after it are all there (or end at
     * a gap); 1, on a pause: also a shorter one, ending its frames-after short
     * of the last frame; 2, at the end: whatever there is.
     */
    nextPiece(level) {
      const list = this.frames;
      let a = 0;
      while (a < list.length && list[a].done) a++;
      if (a >= list.length) return null;
      // [a, r): the frames that follow one another from a, decoded or not.
      let r = a + 1;
      while (r < list.length && this.joins(r)) r++;
      let b = a + 1;
      while (b < r && b - a < PIECE && !list[b].done) b++;
      // A gap ends the run for good: what follows will not fill it.
      const gap = r < list.length;
      const postReady = r - b >= POST || gap;
      const cut = b < r && list[b].done;
      if (!((b - a === PIECE || cut || (b === r && gap)) && postReady)) {
        if (level === 1 && r - a > POST) b = Math.min(b, r - POST);
        else if (level < 2) return null;
      }
      let from = a;
      while (from > 0 && a - from < PRE && this.joins(from)) from--;
      return { from, a, b, to: Math.min(r, b + POST) };
    }

    pump() {
      if (this.busy || this.state !== 'configured') return;
      const piece = this.nextPiece(this.level);
      if (!piece) return;
      const { from, a, b, to } = piece;
      const list = this.frames;
      const frames = list.slice(from, to);
      const own = list.slice(a, b);
      for (let i = 0; i < own.length; i++) own[i].done = true;
      const file = muxAdts(frames.map((f) => f.data), this.aac);
      const gen = this.gen;
      const drop = (a - from) * FRAME;
      const need = own.length * FRAME;
      this.busy = true;
      const done = (audio) => {
        if (gen !== this.gen) return;
        this.busy = false;
        const keep = Math.max(0, Math.min(need, audio.length - drop));
        if (keep > 0) {
          const channels = [];
          for (let c = 0; c < audio.numberOfChannels; c++) {
            channels.push(audio.getChannelData(c).slice(drop, drop + keep));
          }
          this.output(new LegacyAudioData(own[0].ts, audio.sampleRate, channels));
        }
        this.pump();
      };
      const failed = (e) => {
        if (gen !== this.gen) return;
        this.busy = false;
        this.fail(e || new Error('Unable to decode audio data'));
      };
      try {
        // decodeAudioData takes the buffer it is given: always a fresh one.
        const p = this.ctx.decodeAudioData(file.buffer, done, failed);
        if (p && typeof p.catch === 'function') p.catch(failed);
      } catch (e) {
        failed(e);
      }
    }

    fail(e) {
      if (this.state === 'closed') return;
      this.close();
      this.error(e);
    }

    reset() {
      if (this.state === 'closed') return;
      this.clear();
      this.state = 'unconfigured';
    }

    close() {
      this.clear();
      this.state = 'closed';
    }
  }

  return { AudioDecoder: LegacyAudioDecoder, EncodedAudioChunk: LegacyChunk };
}
