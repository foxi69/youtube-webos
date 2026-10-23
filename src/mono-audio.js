import { configRead, configAddChangeListener } from './config.js';
import { getVideo } from './utils.js';
import { showNotification } from './notifications.js';

/**
 * Mono Audio: left and right mixed into one, on both speakers - for one ear,
 * or a TV that stands where only one speaker is heard. (Idea from
 * andreescocard's fork.)
 *
 * Web Audio downmixes a node that takes exactly one channel ('explicit',
 * 'speakers'), and the destination plays that one channel on every speaker.
 * Two paths need it:
 *   - normal playback: the <video> plays its own sound, so it is routed
 *     through a MediaElementAudioSourceNode first;
 *   - Playback Speed above or below 1x: the speed engine plays the sound
 *     itself, into its own gain node (playback-speed.js calls downmix() on it).
 *
 * A media element source cannot be undone: from then on the element plays
 * only into the graph. So it is made the first time the option is on, never
 * before, and turning the option off just connects it straight to the
 * destination. If the TV gives the graph no samples at all, the sound would be
 * gone until a restart; that is watched for and reported once.
 */

const SILENCE_MS = 5000;

let ctx = null;
let mono = null;
let analyser = null;
let tapSink = null;
let samples = null;
let silentSince = 0;
let silenceTimer = null;
// The silence check has given its answer: sound came through, or it was reported.
let settled = false;
let failed = false;
// The <video> elements already routed through the graph, with their source.
const sources = typeof WeakMap === 'function' ? new WeakMap() : null;

/** Sets `node` to mix its input to one channel (on) or pass it as it comes (off). */
export function downmix(node, on) {
  if (!node) return;
  try {
    node.channelCount = on ? 1 : 2;
    node.channelCountMode = on ? 'explicit' : 'max';
    node.channelInterpretation = 'speakers';
  } catch (e) {
    console.warn('[MonoAudio] Downmix unavailable:', e && e.name);
  }
}

function context() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    mono = ctx.createGain();
    downmix(mono, true);
    mono.connect(ctx.destination);
  }
  return ctx;
}

function resume() {
  if (ctx && ctx.state === 'suspended') {
    const pending = ctx.resume();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  }
}

function route(video, on) {
  if (!video || failed || !sources) return;
  let source = sources.get(video);
  if (!source) {
    if (!on) return;
    try {
      if (!context()) return;
      source = ctx.createMediaElementSource(video);
    } catch (e) {
      failed = true;
      console.warn('[MonoAudio] Not available:', e && e.name);
      return;
    }
    sources.set(video, source);
    video.addEventListener('play', resume);
  }
  source.disconnect();
  source.connect(on ? mono : ctx.destination);
  // disconnect() took the silence check's tap off too.
  if (analyser) source.connect(analyser);
  watchForSilence(source);
  resume();
}

// A TV whose decoder bypasses Web Audio hands the source nothing but zeros:
// real sound is never exactly zero for seconds on end, a quiet passage is.
function watchForSilence(source) {
  if (settled || silenceTimer !== null || !ctx.createAnalyser) return;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  samples = new Uint8Array(analyser.fftSize);
  source.connect(analyser);
  // Into the destination at zero gain, so the graph keeps processing it.
  tapSink = ctx.createGain();
  tapSink.gain.value = 0;
  analyser.connect(tapSink);
  tapSink.connect(ctx.destination);
  silentSince = 0;
  silenceTimer = setInterval(() => {
    const video = getVideo();
    if (!video || video.paused || video.muted || !video.volume || (window.ytafSpeed && window.ytafSpeed.getSpeed() !== 1)) {
      silentSince = 0;
      return;
    }
    analyser.getByteTimeDomainData(samples);
    let flat = true;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] !== 128) {
        flat = false;
        break;
      }
    }
    const now = Date.now();
    if (!flat) {
      // Sound comes through: the TV supports it, nothing more to watch.
      settled = true;
      stopWatching();
    } else if (!silentSince) {
      silentSince = now;
    } else if (now - silentSince >= SILENCE_MS) {
      settled = true;
      stopWatching();
      showNotification('Mono Audio: no sound on this TV - turn it off and restart the app', 8000);
    }
  }, 500);
}

function stopWatching() {
  if (silenceTimer !== null) clearInterval(silenceTimer);
  silenceTimer = null;
  if (analyser) analyser.disconnect();
  if (tapSink) tapSink.disconnect();
  analyser = null;
  tapSink = null;
}

function apply() {
  route(getVideo(), configRead('monoAudio'));
}

// Capture: media events do not bubble. YouTube may swap the <video>.
document.addEventListener(
  'play',
  (evt) => {
    if (configRead('monoAudio') && evt.target instanceof HTMLVideoElement) route(evt.target, true);
  },
  true
);
configAddChangeListener('monoAudio', apply);
if (configRead('monoAudio')) apply();
