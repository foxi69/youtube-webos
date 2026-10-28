/**
 * Behaviour test for keepStretchableAudio (src/speed/containers.js): off 1x
 * the player's offer keeps only the audio the speed engine can stretch.
 * The offer is the audio list a webOS 25 TV was given for aqz-KE-bpKQ
 * (Big Buck Bunny 4K60), where YouTube picked AC-3 and the speed fell back.
 *
 * Usage: node bench/speed-audio-offer-test.cjs
 */
/* global __dirname */
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(path.resolve(__dirname, '../src/speed/containers.js')).href;

const audio = (mime) => ({ mimeType: mime });
const video = (mime) => ({ mimeType: mime, width: 3840 });
const offer = () => [
  video('video/mp4; codecs="av01.0.13M.08"'),
  video('video/webm; codecs="vp9"'),
  audio('audio/mp4; codecs="mp4a.40.2"'),
  audio('audio/webm; codecs="opus"'),
  audio('audio/mp4; codecs="mp4a.40.5"'),
  audio('audio/mp4; codecs="ec-3"'),
  audio('audio/mp4; codecs="ac-3"'),
  audio('audio/mp4; codecs="iamf.001.001.Opus"')
];

let passed = 0;
let failed = 0;
const t = (name, ok) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};

import(MODULE).then(({ keepStretchableAudio }) => {
  {
    const sd = { adaptiveFormats: offer() };
    const removed = keepStretchableAudio(sd);
    const mimes = sd.adaptiveFormats.map((f) => f.mimeType).join(' ');
    t('AC-3, E-AC-3 and IAMF go', removed === 3 && !/ac-3|ec-3|iamf/.test(mimes));
    t('AAC and Opus stay', /mp4a\.40\.2/.test(mimes) && /mp4a\.40\.5/.test(mimes) && /opus/.test(mimes));
    t('video formats stay', sd.adaptiveFormats.filter((f) => f.mimeType.startsWith('video/')).length === 2);
  }
  {
    // Only surround audio: better 1x with sound than no audio at all.
    const sd = { adaptiveFormats: [video('video/mp4; codecs="avc1.640028"'), audio('audio/mp4; codecs="ac-3"')] };
    t('a list with no stretchable audio is left alone', keepStretchableAudio(sd) === 0 && sd.adaptiveFormats.length === 2);
  }
  {
    const sd = { adaptiveFormats: offer().filter((f) => !/ac-3|ec-3|iamf/.test(f.mimeType)) };
    const before = sd.adaptiveFormats;
    t('nothing to remove: the same list', keepStretchableAudio(sd) === 0 && sd.adaptiveFormats === before);
  }
  t('no streamingData / no list', keepStretchableAudio(null) === 0 && keepStretchableAudio({}) === 0);

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
