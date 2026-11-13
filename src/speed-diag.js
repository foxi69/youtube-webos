// Diagnostic build only (#97): shows on screen what the speed engine does when
// the speed changes, so a photo tells where the sound drops out on webOS 4-6.
import { AudioEngine } from './speed/audio-engine.js';

// Enough for a whole speed change: the first reload, its cuts and what ends it.
const MAX_EVENTS = 30;
const events = [];
const t0 = Date.now();
let box = null;
let engine = null;
let engineAt = 0;
let firstSoundAt = 0;
let starving = 0;
let stops = 0;
let inTick = false;
const causes = { stall: 0, jump: 0, starve: 0, pause: 0, seek: 0, other: 0 };
const decodes = { n: 0, totalMs: 0, lastMs: 0, maxMs: 0, fail: 0 };

function sec(ms) {
  return (ms / 1000).toFixed(2);
}

function log(text) {
  events.push(`${sec(Date.now() - t0)} ${text}`);
  if (events.length > MAX_EVENTS) events.shift();
}

function pcmAhead(e) {
  // Decoded audio from where the engine reads on, in seconds.
  let end = e.inPos;
  for (let i = 0; i < e.pcm.length; i++) {
    const p = e.pcm[i];
    if (p.t <= end + 0.002 && p.t + p.n / p.rate > end) end = p.t + p.n / p.rate;
  }
  return end - e.inPos;
}

function vt(e) {
  return e && e.video ? e.video.currentTime.toFixed(2) : '-';
}

// Every time queued audio is cut: a pause, a seek, a stall or a resync.
const origStop = AudioEngine.prototype.stopFuture;
// Why: worked out from the engine's state before the cut changes it.
function cause(e) {
  const v = e.video;
  if (v && v.paused) return 'pause';
  if (v && v.seeking) return 'seek';
  if (!inTick) return `other(ready=${v ? v.readyState : '-'})`;
  if (e.clockTicks >= e.stallTicks()) return 'stall';
  if (e.nextWhen <= e.ctx.currentTime) return 'starve';
  return 'jump';
}

AudioEngine.prototype.stopFuture = function () {
  stops++;
  const why = cause(this);
  causes[why.split('(')[0]]++;
  log(`cut ${why} t=${vt(this)} pcmAhead=${pcmAhead(this).toFixed(2)} decoded=${this.pcm.length}`);
  return origStop.apply(this, arguments);
};

const origTick = AudioEngine.prototype.tick;
AudioEngine.prototype.tick = function () {
  if (this.video && !this.video.paused && !this.anchorPending && this.nextWhen <= this.ctx.currentTime) starving++;
  const before = this.sources.size;
  inTick = true;
  let r;
  try {
    r = origTick.apply(this, arguments);
  } finally {
    inTick = false;
  }
  if (!firstSoundAt && engine === this && this.sources.size > before) {
    firstSoundAt = Date.now();
    log(`first sound ${sec(firstSoundAt - engineAt)} s after the engine started`);
  }
  return r;
};

// How long each piece takes to decode (legacy-decoder.js).
const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
let owner = OAC && OAC.prototype;
while (owner && !Object.prototype.hasOwnProperty.call(owner, 'decodeAudioData')) owner = Object.getPrototypeOf(owner);
if (owner) {
  const origDecode = owner.decodeAudioData;
  owner.decodeAudioData = function (buf, ok, fail) {
    const start = Date.now();
    const took = () => {
      const ms = Date.now() - start;
      decodes.n++;
      decodes.totalMs += ms;
      decodes.lastMs = ms;
      if (ms > decodes.maxMs) decodes.maxMs = ms;
    };
    return origDecode.call(this, buf,
      (audio) => { took(); if (ok) ok(audio); },
      (err) => { decodes.fail++; log(`decode failed: ${err && err.message}`); if (fail) fail(err); });
  };
}

function watchVideo(v) {
  ['seeking', 'waiting', 'playing', 'pause', 'stalled'].forEach((type) => {
    v.addEventListener(type, () => { log(`${type} t=${v.currentTime.toFixed(2)}`); });
  });
}

// Why the speed changes (#97, webOS 5): an engine error, a rate YouTube sets,
// a key or the menu. Errors from the MSE hook reach the controller directly,
// so they show through the toast every error raises.
AudioEngine.prototype.reportError = (function (orig) {
  return function (e) {
    log(`engine error: ${e && e.name}: ${e && e.message}`);
    return orig.apply(this, arguments);
  };
})(AudioEngine.prototype.reportError);

let ctrlHooked = null;
function hookController(ctrl) {
  if (!ctrl || ctrlHooked === ctrl) return;
  ctrlHooked = ctrl;
  ['setSpeed', 'stop', 'reset', 'onError'].forEach((name) => {
    const orig = ctrl[name];
    if (typeof orig !== 'function') return;
    ctrl[name] = function (a, b) {
      const arg = name === 'onError' ? `${a && a.name}: ${a && a.message}` : a === undefined ? '' : String(a);
      log(`${name}(${arg}${b && b.immediate ? ', immediate' : ''}) at speed ${ctrl.getSpeed()}`);
      return orig.apply(this, arguments);
    };
  });
}

let lastSpeed = null;
let lastReload = 0;
let lastRate = null;
let hookedPlayer = null;
function watchState(ctrl) {
  const speed = ctrl.getSpeed();
  if (lastSpeed !== null && speed !== lastSpeed) log(`speed ${lastSpeed} -> ${speed}`);
  lastSpeed = speed;
  const reload = ctrl.lastReloadAt ? ctrl.lastReloadAt() : 0;
  if (reload && reload !== lastReload) log(`reload at ${sec(reload - t0)}`);
  lastReload = reload;
  const player = document.querySelector('.html5-video-player');
  if (!player) return;
  try {
    const rate = player.getPlaybackRate();
    if (lastRate !== null && rate !== lastRate) log(`player rate ${lastRate} -> ${rate}`);
    lastRate = rate;
  } catch {
    // no rate yet
  }
  if (hookedPlayer !== player && typeof player.seekTo === 'function') {
    hookedPlayer = player;
    const seekTo = player.seekTo;
    player.seekTo = function (to) {
      log(`player.seekTo(${Number(to).toFixed(2)})`);
      return seekTo.apply(this, arguments);
    };
  }
}

let toastObserver = null;
function watchToasts() {
  if (toastObserver || !document.body || typeof MutationObserver === 'undefined') return;
  toastObserver = new MutationObserver((records) => {
    records.forEach((r) => {
      r.addedNodes.forEach((n) => {
        if (n.nodeType !== 1 || !n.closest || !n.closest('.ytaf-notification-container')) return;
        const text = (n.textContent || '').trim();
        if (text) log(`toast: ${text}`);
      });
    });
  });
  toastObserver.observe(document.body, { childList: true, subtree: true });
}

function render() {
  if (window.ytafSpeed) {
    hookController(window.ytafSpeed);
    watchState(window.ytafSpeed);
  }
  watchToasts();
  const ctrl = window.ytafSpeed;
  const e = ctrl && ctrl.activeEngine ? ctrl.activeEngine() : null;
  if (e !== engine) {
    engine = e;
    engineAt = Date.now();
    firstSoundAt = 0;
    if (e) {
      log(`engine started, speed ${e.speed}, ctx ${e.ctx.state} ${e.ctx.sampleRate} Hz`);
      if (e.video && !e.video.__speedDiag) { e.video.__speedDiag = true; watchVideo(e.video); }
    } else {
      log('no engine (1x: native audio)');
    }
  }
  const lines = [`SPEED DIAG (#97)  speed=${ctrl ? ctrl.getSpeed() : '?'}`];
  if (e) {
    const now = e.ctx.currentTime;
    lines.push(`video t=${vt(e)} paused=${e.video && e.video.paused} ready=${e.video && e.video.readyState}`);
    lines.push(`ctx ${e.ctx.state} anchorWait=${e.anchorPending} queued=${(e.nextWhen - now).toFixed(2)}s`);
    lines.push(`pcmAhead=${pcmAhead(e).toFixed(2)}s pieces=${e.pcm.length} chunks=${e.chunks.length}`);
    lines.push(`decoder=${e.decoder ? e.decoder.state : '-'} failed=${e.failed}`);
  }
  lines.push(`starving ticks=${starving} cuts=${stops}`);
  lines.push(`  stall ${causes.stall} jump ${causes.jump} starve ${causes.starve} pause ${causes.pause} seek ${causes.seek} other ${causes.other}`);
  if (e) lines.push(`clock steps ${e.clockGaps.join(',')} ticks, stall after ${e.stallTicks()}`);
  lines.push(`decodes ${decodes.n} last=${decodes.lastMs}ms avg=${decodes.n ? Math.round(decodes.totalMs / decodes.n) : 0}ms max=${decodes.maxMs}ms fail=${decodes.fail}`);
  if (!box && document.body) {
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:8px;left:8px;width:46%;z-index:2147483647;' +
      'background:rgba(0,0,0,.82);color:#ff0;font:13px/1.25 monospace;padding:8px;' +
      'white-space:pre-wrap;word-break:break-all;pointer-events:none;border:2px solid #f80';
    document.body.appendChild(box);
  }
  if (box) box.textContent = lines.join('\n') + '\n--\n' + events.join('\n');
}

setInterval(render, 250);
