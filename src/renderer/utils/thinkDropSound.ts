/**
 * ThinkDrop sounds
 *
 * playThinkSound     — soft ascending two-note chime (Think: mind engaging)
 * playDropSound      — water drip mp3 sound (answer ready)
 * playThinkDropSound — alias for playThinkSound (PTT/VAD trigger point)
 * playIntentSound    — intent-specific synthesized sound (web search, memory, screen, command)
 * playDefaultSound   — soft default chime (regex miss fallback)
 *
 * Intent sounds are synthesized via Web Audio API oscillators — no mp3 files needed.
 * Each intent has a unique tone/pattern that's pleasant and distinct:
 *   web_search       — quick ascending blip (searching outward)
 *   memory_retrieve  — soft descending two-note (looking inward/recalling)
 *   memory_store     — soft ascending two-note (putting something away)
 *   screen_analysis  — gentle sweep (scanning)
 *   command_automate — steady double-pulse (working/processing)
 *   general_knowledge — neutral single tone
 *   default          — soft low chime
 */
import waterDripUrl from '../assets/water-drip.mp3';

let _audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new AudioContext();
  }
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume();
  }
  return _audioCtx;
}

// ── Helper: play a single oscillator note with envelope ──────────────────────
function _playNote(
  ctx: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  peakGain: number = 0.15,
  type: OscillatorType = 'sine',
  attackTime: number = 0.02,
  releaseTime: number = 0.08
): void {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, startAt);
  env.gain.linearRampToValueAtTime(peakGain, startAt + attackTime);
  env.gain.exponentialRampToValueAtTime(0.001, startAt + duration + releaseTime);
  osc.connect(env);
  env.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + releaseTime + 0.02);
}

// ── Think sound — soft ascending two-note chime ──────────────────────────────
export function playThinkSound(): void {
  try {
    const ctx = getAudioCtx();
    const t = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const env1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.value = 330;
    env1.gain.setValueAtTime(0, t);
    env1.gain.linearRampToValueAtTime(0.18, t + 0.04);
    env1.gain.linearRampToValueAtTime(0.12, t + 0.12);
    env1.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    osc1.connect(env1); env1.connect(ctx.destination);
    osc1.start(t); osc1.stop(t + 0.34);

    const osc2 = ctx.createOscillator();
    const env2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.value = 494;
    env2.gain.setValueAtTime(0, t + 0.08);
    env2.gain.linearRampToValueAtTime(0.22, t + 0.14);
    env2.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    osc2.connect(env2); env2.connect(ctx.destination);
    osc2.start(t + 0.08); osc2.stop(t + 0.44);
  } catch (err) {
    console.debug('[ThinkSound] Could not play:', err);
  }
}

// ── Drop sound — water drip mp3 ──────────────────────────────────────────────
let _dropAudio: HTMLAudioElement | null = null;

export function playDropSound(): void {
  try {
    if (!_dropAudio) {
      _dropAudio = new Audio(waterDripUrl);
      _dropAudio.volume = 0.8;
    }
    _dropAudio.currentTime = 0;
    _dropAudio.play().catch(err => console.debug('[DropSound] Could not play:', err));
  } catch (err) {
    console.debug('[DropSound] Could not play:', err);
  }
}

// Alias — used at PTT/VAD trigger point in StandalonePromptCapture
export function playThinkDropSound(): void {
  playThinkSound();
}

// ── Intent-specific synthesized sounds ────────────────────────────────────────
// Each intent has a unique tone pattern synthesized via Web Audio API.
// Played when decomposePromptV2 / parseIntentV2 emit 'intent:decided'.

/**
 * web_search — dial-up modem "connect online" sound
 * Quick DTMF beeps + handshake chirp + connect confirmation.
 * Uses real DTMF frequencies (1209, 1336, 1477 Hz) for authenticity.
 */
function _playWebSearchSound(ctx: AudioContext): void {
  const t = ctx.currentTime;
  // DTMF beeps — three quick ascending tones
  _playNote(ctx, 1209, t,        0.05, 0.10, 'sine', 0.005, 0.02);
  _playNote(ctx, 1336, t + 0.07, 0.05, 0.10, 'sine', 0.005, 0.02);
  _playNote(ctx, 1477, t + 0.14, 0.05, 0.10, 'sine', 0.005, 0.02);
  // Handshake chirp — frequency sweep up then down (like a modem handshake)
  const sweep = ctx.createOscillator();
  const sweepEnv = ctx.createGain();
  sweep.type = 'sine';
  sweep.frequency.setValueAtTime(600, t + 0.22);
  sweep.frequency.exponentialRampToValueAtTime(1400, t + 0.32);
  sweep.frequency.exponentialRampToValueAtTime(800, t + 0.42);
  sweepEnv.gain.setValueAtTime(0, t + 0.22);
  sweepEnv.gain.linearRampToValueAtTime(0.10, t + 0.26);
  sweepEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.44);
  sweep.connect(sweepEnv); sweepEnv.connect(ctx.destination);
  sweep.start(t + 0.22); sweep.stop(t + 0.46);
  // Connect confirmation — two quick high notes
  _playNote(ctx, 1047, t + 0.48, 0.06, 0.12, 'sine', 0.01, 0.03);
  _playNote(ctx, 1319, t + 0.56, 0.08, 0.14, 'sine', 0.01, 0.04);
}

// ── Helper: filtered noise burst — texture layer (rustle, whir, air) ─────────
function _playNoise(
  ctx: AudioContext,
  startAt: number,
  duration: number,
  opts: { freq?: number; q?: number; peak?: number; type?: BiquadFilterType } = {}
): void {
  const { freq = 2400, q = 0.9, peak = 0.04, type = 'bandpass' } = opts;
  const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = freq;
  filt.Q.value = q;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, startAt);
  env.gain.linearRampToValueAtTime(peak, startAt + 0.02);
  env.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
  src.connect(filt); filt.connect(env); env.connect(ctx.destination);
  src.start(startAt);
  src.stop(startAt + duration + 0.02);
}

// ── Helper: pitch-dropping "thunk" — a stamp / latch settling into place ─────
function _playThunk(ctx: AudioContext, startAt: number, peak = 0.16): void {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(170, startAt);
  osc.frequency.exponentialRampToValueAtTime(70, startAt + 0.10);
  env.gain.setValueAtTime(0, startAt);
  env.gain.linearRampToValueAtTime(peak, startAt + 0.008);
  env.gain.exponentialRampToValueAtTime(0.001, startAt + 0.13);
  osc.connect(env); env.connect(ctx.destination);
  osc.start(startAt); osc.stop(startAt + 0.15);
}

/**
 * memory_retrieve — "recalling": a soft paper-rustle texture (flipping through
 * a mental file) then a descending E5→C5→G4 motif that resolves downward —
 * looking inward and finding something.
 */
function _playMemoryRetrieveSound(ctx: AudioContext): void {
  const t = ctx.currentTime;
  _playNoise(ctx, t, 0.16, { freq: 2800, q: 0.7, peak: 0.035 });
  _playNote(ctx, 659.25, t + 0.09, 0.10, 0.10, 'sine', 0.02, 0.06);  // E5
  _playNote(ctx, 523.25, t + 0.19, 0.10, 0.10, 'sine', 0.02, 0.06);  // C5
  _playNote(ctx, 392.00, t + 0.29, 0.18, 0.12, 'sine', 0.02, 0.10);  // G4 — resolve
}

/**
 * memory_store — "filed away": a low stamp thunk (the latch clicking shut),
 * then an ascending A4→C#5→E5 confirm — put away and indexed.
 */
function _playMemoryStoreSound(ctx: AudioContext): void {
  const t = ctx.currentTime;
  _playThunk(ctx, t);
  _playNote(ctx, 440.00, t + 0.11, 0.08, 0.10, 'sine', 0.015, 0.05);  // A4
  _playNote(ctx, 554.37, t + 0.19, 0.08, 0.11, 'sine', 0.015, 0.05);  // C#5
  _playNote(ctx, 659.25, t + 0.27, 0.14, 0.12, 'sine', 0.015, 0.08);  // E5 — filed
}

/**
 * screen_analysis — sweep + blip-grid tail: the scanner passes, then two
 * quick ticks like a grid locking onto elements.
 */
function _playScreenAnalysisSound(ctx: AudioContext): void {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(400, t);
  osc.frequency.exponentialRampToValueAtTime(800, t + 0.25);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.10, t + 0.05);
  env.gain.linearRampToValueAtTime(0.08, t + 0.15);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  osc.connect(env);
  env.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.37);
  _playNote(ctx, 1567.98, t + 0.30, 0.035, 0.06, 'sine', 0.004, 0.02); // grid blip
  _playNote(ctx, 1567.98, t + 0.37, 0.035, 0.07, 'sine', 0.004, 0.02); // grid lock
}

/**
 * command_automate — "servo engaging": a short rising saw whir (actuator
 * spooling up) over two firm ticks, resolving on D5 — work has started.
 */
function _playCommandAutomateSound(ctx: AudioContext): void {
  const t = ctx.currentTime;
  const whir = ctx.createOscillator();
  const whirEnv = ctx.createGain();
  whir.type = 'sawtooth';
  whir.frequency.setValueAtTime(180, t);
  whir.frequency.exponentialRampToValueAtTime(520, t + 0.18);
  whirEnv.gain.setValueAtTime(0, t);
  whirEnv.gain.linearRampToValueAtTime(0.045, t + 0.03);
  whirEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.20);
  whir.connect(whirEnv); whirEnv.connect(ctx.destination);
  whir.start(t); whir.stop(t + 0.22);
  _playNote(ctx, 329.63, t,       0.04, 0.09, 'square',   0.005, 0.02); // tick
  _playNote(ctx, 329.63, t + 0.09, 0.04, 0.09, 'square',   0.005, 0.02); // tick
  _playNote(ctx, 587.33, t + 0.22, 0.12, 0.12, 'triangle', 0.01, 0.07); // resolve D5
}

/**
 * general_knowledge — "lightbulb": a bright E6 sparkle strike over a warm E5
 * body, settling on a B5 shimmer — the moment an answer switches on.
 */
function _playGeneralKnowledgeSound(ctx: AudioContext): void {
  const t = ctx.currentTime;
  _playNote(ctx, 1318.51, t,        0.06, 0.09, 'sine',     0.005, 0.04); // sparkle
  _playNote(ctx, 659.25,  t + 0.04, 0.10, 0.12, 'triangle', 0.01,  0.08); // body E5
  _playNote(ctx, 987.77,  t + 0.11, 0.16, 0.11, 'sine',     0.01,  0.10); // B5 shimmer
}

/**
 * default — soft low chime (regex miss fallback)
 * A single low note: C4, gentle
 */
function _playDefaultChimeSound(ctx: AudioContext): void {
  const t = ctx.currentTime;
  _playNote(ctx, 261.63, t, 0.16, 0.12, 'sine', 0.02, 0.10); // C4
}

// Map intent names to synthesized sound functions
const INTENT_SOUND_FNS: Record<string, (ctx: AudioContext) => void> = {
  web_search: _playWebSearchSound,
  memory_retrieve: _playMemoryRetrieveSound,
  memory_store: _playMemoryStoreSound,
  screen_analysis: _playScreenAnalysisSound,
  screen_intelligence: _playScreenAnalysisSound,
  command_automate: _playCommandAutomateSound,
  general_knowledge: _playGeneralKnowledgeSound,
  general_handoff: _playDefaultChimeSound,
};

/**
 * Play the intent-specific synthesized sound for a given stategraph intent.
 * Falls back to the default chime if the intent is not in the map.
 */
export function playIntentSound(intent: string): void {
  try {
    const ctx = getAudioCtx();
    const fn = INTENT_SOUND_FNS[intent] || _playDefaultChimeSound;
    fn(ctx);
  } catch (err) {
    console.debug('[IntentSound] Could not play:', intent, err);
  }
}

/**
 * Play the default ThinkDrop sound (soft low chime).
 * Used when the regex intent guesser misses (no intent identified).
 */
export function playDefaultSound(): void {
  try {
    const ctx = getAudioCtx();
    _playDefaultChimeSound(ctx);
  } catch (err) {
    console.debug('[DefaultSound] Could not play:', err);
  }
}
