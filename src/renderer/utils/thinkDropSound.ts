/**
 * ThinkDrop sounds — all synthesized via Web Audio API (no large assets)
 *
 * playThinkSound     — soft ascending two-note chime (Think: mind engaging)
 * playDropSound      — crisp water drop plop synthesized via Web Audio API
 * playThinkDropSound — alias for playThinkSound (PTT/VAD trigger point)
 */

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

// ── Drop sound — water drop synthesized via Web Audio API ────────────────────
// Three layers: wet click transient + descending pitch sweep + resonant cavity body.
export function playDropSound(): void {
  try {
    const ctx = getAudioCtx();
    const t = ctx.currentTime;

    // ── Layer 1: Wet click transient (filtered noise burst, 8ms) ─────────────
    const clickSize = Math.floor(ctx.sampleRate * 0.008);
    const clickBuf = ctx.createBuffer(1, clickSize, ctx.sampleRate);
    const clickData = clickBuf.getChannelData(0);
    for (let i = 0; i < clickSize; i++) {
      clickData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / clickSize, 2);
    }
    const click = ctx.createBufferSource();
    const clickBpf = ctx.createBiquadFilter();
    const clickGain = ctx.createGain();
    click.buffer = clickBuf;
    clickBpf.type = 'bandpass';
    clickBpf.frequency.value = 3200;
    clickBpf.Q.value = 0.8;
    clickGain.gain.setValueAtTime(0.6, t);
    clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.010);
    click.connect(clickBpf); clickBpf.connect(clickGain); clickGain.connect(ctx.destination);
    click.start(t);

    // ── Layer 2: Descending pitch sweep (the "plink") ─────────────────────────
    // Starts sharp and falls fast — characteristic water drop attack
    const sweep = ctx.createOscillator();
    const sweepEnv = ctx.createGain();
    sweep.type = 'sine';
    sweep.frequency.setValueAtTime(900, t);
    sweep.frequency.exponentialRampToValueAtTime(520, t + 0.04);
    sweep.frequency.exponentialRampToValueAtTime(380, t + 0.18);
    sweepEnv.gain.setValueAtTime(0, t);
    sweepEnv.gain.linearRampToValueAtTime(0.5, t + 0.004);  // fast attack
    sweepEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    sweep.connect(sweepEnv); sweepEnv.connect(ctx.destination);
    sweep.start(t); sweep.stop(t + 0.30);

    // ── Layer 3: Resonant cavity body (low pitched sine, 120Hz, long tail) ───
    // Simulates the hollow acoustic body of liquid — gives the satisfying "depth"
    const body = ctx.createOscillator();
    const bodyEnv = ctx.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(190, t + 0.003);
    body.frequency.exponentialRampToValueAtTime(140, t + 0.15);
    bodyEnv.gain.setValueAtTime(0, t);
    bodyEnv.gain.linearRampToValueAtTime(0.28, t + 0.006);
    bodyEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    body.connect(bodyEnv); bodyEnv.connect(ctx.destination);
    body.start(t + 0.002); body.stop(t + 0.58);

    // ── Layer 4: Subtle second harmonic shimmer ───────────────────────────────
    const shimmer = ctx.createOscillator();
    const shimmerEnv = ctx.createGain();
    shimmer.type = 'sine';
    shimmer.frequency.setValueAtTime(1800, t);
    shimmer.frequency.exponentialRampToValueAtTime(1040, t + 0.04);
    shimmerEnv.gain.setValueAtTime(0.12, t);
    shimmerEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    shimmer.connect(shimmerEnv); shimmerEnv.connect(ctx.destination);
    shimmer.start(t); shimmer.stop(t + 0.13);
  } catch (err) {
    console.debug('[DropSound] Could not play:', err);
  }
}

// Alias — used at PTT/VAD trigger point in StandalonePromptCapture
export function playThinkDropSound(): void {
  playThinkSound();
}
