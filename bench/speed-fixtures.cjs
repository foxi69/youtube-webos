/**
 * Small MP4 and WebM files built byte by byte, for the playback speed tests
 * (speed-core-test.cjs, speed-mse-test.cjs).
 */

// --- MP4 -----------------------------------------------------------------

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v) => [(v >>> 8) & 255, v & 255];
const bytes = (...parts) => {
  const flat = [];
  for (const p of parts) for (const b of p) flat.push(b);
  return flat;
};
const box = (type, ...payload) => {
  const body = bytes(...payload);
  return bytes(u32(body.length + 8), ascii(type), body);
};
const fullbox = (type, version, flags, ...payload) =>
  box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...payload);

const MP4_TIMESCALE = 44100;
// AudioSpecificConfig: AAC LC (2), 44.1 kHz, stereo.
const ASC = [0x12, 0x10];

function esds(asc) {
  const decSpec = [0x05, asc.length, ...asc];
  const decConf = [0x04, 13 + decSpec.length, 0x40, 0x15, 0, 0, 0, ...u32(128000), ...u32(128000), ...decSpec];
  const esDescr = [0x03, 3 + decConf.length, 0, 1, 0, ...decConf];
  return fullbox('esds', 0, 0, esDescr);
}

const audioSampleEntry = (type, channels, rate, child) =>
  box(type, [0, 0, 0, 0, 0, 0], u16(1), [0, 0, 0, 0, 0, 0, 0, 0], u16(channels), u16(16), u16(0), u16(0),
    u32(rate * 65536), child);

function mdhd(version, timescale) {
  return version === 1
    ? fullbox('mdhd', 1, 0, [0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0, 2], u32(timescale),
      [0, 0, 0, 0, 0, 0, 0, 0], u16(0x55c4), u16(0))
    : fullbox('mdhd', 0, 0, u32(1), u32(2), u32(timescale), u32(0), u16(0x55c4), u16(0));
}

function mp4Init({ entry, mdhdVersion = 0, timescale = MP4_TIMESCALE, defaultDuration = 1024 }) {
  return Uint8Array.from(bytes(
    box('ftyp', ascii('dash'), u32(0), ascii('iso6')),
    box('moov',
      box('trak',
        box('mdia',
          mdhd(mdhdVersion, timescale),
          box('minf', box('stbl', fullbox('stsd', 0, 0, u32(1), entry))))),
      box('mvex', fullbox('trex', 0, 0, u32(1), u32(1), u32(defaultDuration), u32(0), u32(0))))
  ));
}

/** moof + mdat for `frames` (arrays of bytes) from `baseTime`, 1024 ticks each. */
function mp4Fragment(frames, baseTime, seq) {
  const trunFor = (offset) =>
    fullbox('trun', 0, 0x01 | 0x100 | 0x200, u32(frames.length), u32(offset),
      ...frames.map((f) => bytes(u32(1024), u32(f.length))));
  const moofFor = (offset) => box('moof',
    fullbox('mfhd', 0, 0, u32(seq)),
    box('traf',
      fullbox('tfhd', 0, 0x20000, u32(1)),
      fullbox('tfdt', 1, 0, u32(Math.floor(baseTime / 0x100000000)), u32(baseTime >>> 0)),
      trunFor(offset)));
  const moofLen = moofFor(0).length;
  return bytes(moofFor(moofLen + 8), box('mdat', ...frames));
}

const frameBytes = (i, n = 5 + (i % 7)) => Array.from({ length: n }, (_, k) => (i * 31 + k) & 255);

// --- WebM ----------------------------------------------------------------

function vint(n) {
  if (n < 127) return [0x80 | n];
  if (n < 16383) return [0x40 | (n >> 8), n & 255];
  if (n < 2097151) return [0x20 | (n >> 16), (n >> 8) & 255, n & 255];
  return [0x10 | (n >>> 24), (n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const el = (id, ...payload) => {
  const body = bytes(...payload);
  return bytes(id, vint(body.length), body);
};
const uint = (v, size) => Array.from({ length: size }, (_, i) => Math.floor(v / 256 ** (size - 1 - i)) & 255);

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3], SEGMENT: [0x18, 0x53, 0x80, 0x67], INFO: [0x15, 0x49, 0xa9, 0x66],
  TCSCALE: [0x2a, 0xd7, 0xb1], DURATION: [0x44, 0x89], TRACKS: [0x16, 0x54, 0xae, 0x6b], ENTRY: [0xae],
  NUMBER: [0xd7], CODEC: [0x86], PRIVATE: [0x63, 0xa2], AUDIO: [0xe1], CHANNELS: [0x9f],
  CLUSTER: [0x1f, 0x43, 0xb6, 0x75], TIMECODE: [0xe7], SIMPLE: [0xa3], GROUP: [0xa0], BLOCK: [0xa1]
};
const OPUS_HEAD = [...ascii('OpusHead'), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];

function webmInit({ tcScale = 1000000, withScale = true, track = 1, segmentSize, infoPad = 0 } = {}) {
  const info = el(ID.INFO, withScale ? el(ID.TCSCALE, uint(tcScale, 3)) : [], el(ID.DURATION, [0x46, 0x9c, 0x40, 0]),
    infoPad ? el([0xec], new Array(infoPad).fill(0)) : []);
  const tracks = el(ID.TRACKS,
    el(ID.ENTRY, el(ID.NUMBER, [2]), el(ID.CODEC, ascii('V_VP9'))),
    el(ID.ENTRY, el(ID.NUMBER, [track]), el(ID.CODEC, ascii('A_OPUS')), el(ID.PRIVATE, OPUS_HEAD),
      el(ID.AUDIO, el(ID.CHANNELS, [2]))));
  const body = bytes(info, tracks);
  return Uint8Array.from(bytes(el(ID.EBML, el([0x42, 0x82], ascii('webm'))), ID.SEGMENT,
    segmentSize === 'unknown' ? UNKNOWN : vint(body.length), body));
}

const block = (track, rel, payload, keyFlag = 0x80) => bytes(vint(track), uint(rel & 0xffff, 2), [keyFlag], payload);

function cluster(timecode, frames, { track = 1, group = false } = {}) {
  return el(ID.CLUSTER, el(ID.TIMECODE, uint(timecode, 2)),
    // A video block of another track, to be left out.
    el(ID.SIMPLE, block(2, 0, [0xde, 0xad])),
    ...frames.map((f) => (group ? el(ID.GROUP, el(ID.BLOCK, block(track, f.rel, f.data, 0))) : el(ID.SIMPLE, block(track, f.rel, f.data)))));
}

module.exports = {
  ascii, u32, u16, bytes, box, fullbox, MP4_TIMESCALE, ASC, esds, audioSampleEntry, mdhd, mp4Init, mp4Fragment,
  frameBytes, vint, UNKNOWN, el, uint, ID, OPUS_HEAD, webmInit, block, cluster
};
