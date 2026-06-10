// Synthesized Web Audio SFX — no assets, no DOM, no game-state imports.
//
// All sounds are short synthesized stings (oscillators + filtered noise), so
// the game ships zero audio files. Every public entry point is safe to call
// in any environment: without an AudioContext (node, tests, very old
// browsers) or while muted, calls are silent no-ops.
//
// The AudioContext is created lazily on the first (un)mute interaction or
// play attempt after a user gesture — `init()` arms a one-shot gesture
// listener so autoplay policies are satisfied.

const STORAGE_KEY = 'brimstone_sound_muted';

let _ctx = null;
let _master = null;
let _muted = _readMuted();

function _readMuted() {
  try {
    return (typeof localStorage !== 'undefined') && localStorage.getItem(STORAGE_KEY) === '1';
  } catch { return false; }
}

function _persistMuted() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, _muted ? '1' : '0');
    }
  } catch { /* storage unavailable — session-only mute */ }
}

function _AudioCtx() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function _ensureCtx() {
  const Ctor = _AudioCtx();
  if (!Ctor) return null;
  if (!_ctx) {
    try {
      _ctx = new Ctor();
      _master = _ctx.createGain();
      _master.gain.value = 0.5;
      _master.connect(_ctx.destination);
    } catch { return null; }
  }
  if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
  return _ctx;
}

/** Arm a one-shot user-gesture listener so the context can start. */
let _initDone = false;
export function init() {
  if (typeof window === 'undefined' || _initDone) return;
  _initDone = true;
  const unlock = () => { if (!_muted) _ensureCtx(); };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true });
}

export function isMuted() { return _muted; }

export function setMuted(m) {
  _muted = !!m;
  _persistMuted();
  if (!_muted) _ensureCtx();
}

export function toggleMuted() {
  setMuted(!_muted);
  return _muted;
}

// ── Synth building blocks ─────────────────────────────────────────────────────

function _tone(ctx, { freq = 440, endFreq = null, type = 'sine', at = 0, dur = 0.15, gain = 0.25 }) {
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g   = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(_master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function _noise(ctx, { at = 0, dur = 0.1, gain = 0.2, filterFreq = 1200, filterType = 'lowpass' }) {
  const t0 = ctx.currentTime + at;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(filter).connect(g).connect(_master);
  src.start(t0);
}

// ── Sound registry ────────────────────────────────────────────────────────────
// Short gothic-flavored stings. Keep every sound under ~0.8s.

const SOUNDS = {
  click(ctx) {
    // Soft UI tick — quiet and short so rapid taps never grate.
    _noise(ctx, { dur: 0.025, gain: 0.10, filterFreq: 2600, filterType: 'bandpass' });
    _tone(ctx, { freq: 1400, endFreq: 900, type: 'triangle', dur: 0.035, gain: 0.07 });
  },
  hit(ctx) {
    _noise(ctx, { dur: 0.08, gain: 0.3, filterFreq: 900 });
    _tone(ctx, { freq: 180, endFreq: 110, type: 'square', dur: 0.09, gain: 0.18 });
  },
  crush(ctx) {
    _noise(ctx, { dur: 0.22, gain: 0.4, filterFreq: 500 });
    _tone(ctx, { freq: 120, endFreq: 50, type: 'square', dur: 0.28, gain: 0.3 });
    _tone(ctx, { freq: 75, endFreq: 40, type: 'sawtooth', at: 0.04, dur: 0.3, gain: 0.22 });
  },
  counter(ctx) {
    _noise(ctx, { dur: 0.06, gain: 0.18, filterFreq: 3200, filterType: 'highpass' });
    _tone(ctx, { freq: 880, endFreq: 1320, type: 'triangle', dur: 0.1, gain: 0.16 });
    _tone(ctx, { freq: 220, endFreq: 140, type: 'square', at: 0.09, dur: 0.1, gain: 0.16 });
  },
  miss(ctx) {
    _noise(ctx, { dur: 0.12, gain: 0.12, filterFreq: 2400, filterType: 'bandpass' });
  },
  death(ctx) {
    _tone(ctx, { freq: 300, endFreq: 55, type: 'sawtooth', dur: 0.4, gain: 0.25 });
    _noise(ctx, { at: 0.05, dur: 0.3, gain: 0.2, filterFreq: 400 });
  },
  summon(ctx) {
    _tone(ctx, { freq: 160, endFreq: 480, type: 'triangle', dur: 0.3, gain: 0.18 });
    _tone(ctx, { freq: 240, endFreq: 720, type: 'sine', at: 0.06, dur: 0.3, gain: 0.12 });
  },
  phase(ctx) {
    _tone(ctx, { freq: 392, type: 'sine', dur: 0.25, gain: 0.12 });
    _tone(ctx, { freq: 494, type: 'sine', at: 0.12, dur: 0.3, gain: 0.12 });
  },
  nightfall(ctx) {
    _tone(ctx, { freq: 311, type: 'sine', dur: 0.3, gain: 0.14 });
    _tone(ctx, { freq: 233, type: 'sine', at: 0.14, dur: 0.4, gain: 0.14 });
  },
  score(ctx) {
    _tone(ctx, { freq: 523, type: 'triangle', dur: 0.12, gain: 0.16 });
    _tone(ctx, { freq: 784, type: 'triangle', at: 0.11, dur: 0.2, gain: 0.16 });
  },
  victory(ctx) {
    const seq = [523, 659, 784, 1047];
    seq.forEach((f, i) => _tone(ctx, { freq: f, type: 'triangle', at: i * 0.13, dur: 0.22, gain: 0.18 }));
  },
  defeat(ctx) {
    const seq = [392, 311, 262, 196];
    seq.forEach((f, i) => _tone(ctx, { freq: f, type: 'sawtooth', at: i * 0.16, dur: 0.3, gain: 0.14 }));
  },
};

export const SOUND_NAMES = Object.freeze(Object.keys(SOUNDS));

/** Play a named sound. Silent no-op when muted or audio is unavailable. */
export function play(name) {
  if (_muted) return;
  const gen = SOUNDS[name];
  if (!gen) return;
  const ctx = _ensureCtx();
  if (!ctx || ctx.state !== 'running') return;
  try { gen(ctx); } catch { /* never let audio break gameplay */ }
}

/**
 * Pick the right combat sound for an executeBattle-style result.
 * Pure — exported for tests. Priority: death > crush > counter > hit > miss.
 */
export function pickCombatSound(result) {
  if (!result) return null;
  if (result.killed) return 'death';
  if (result.hit && result.damage >= 2) return 'crush';
  if (!result.hit && result.counterDmg > 0) return 'counter';
  if (result.hit) return 'hit';
  return 'miss';
}

/** Play the combat sound for a battle result. */
export function playCombat(result) {
  const name = pickCombatSound(result);
  if (name) play(name);
}
