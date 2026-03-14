/**
 * ThinkDrop sounds
 *
 * playThinkSound     — soft ascending two-note chime (Think: mind engaging)
 * playDropSound      — water drip mp3 sound
 * playThinkDropSound — alias for playThinkSound (PTT/VAD trigger point)
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
