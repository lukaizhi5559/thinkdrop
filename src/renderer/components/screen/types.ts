/**
 * ScreenOutput — the renderer-side mirror of shared/screen-output.cjs.
 *
 * GhostLayer's "screen as an output" contract: producers POST a ScreenOutput
 * to the overlay-control server (/screen/display), main.js normalizes it and
 * forwards it here over the 'ghostlayer:display' IPC channel.
 *
 * Keep field names/values in sync with shared/screen-output.cjs — main.js is
 * the validator; this file only types what arrives after normalization.
 */

export type ScreenKind = 'text' | 'image' | 'chart' | 'effect' | 'emoji' | 'alert' | 'deck' | 'scene' | 'three';
export type ScreenMood = 'neutral' | 'warm' | 'happy' | 'sad' | 'alert' | 'playful' | 'calm';
export type ScreenPosition = 'center' | 'top' | 'bottom' | 'banner' | 'fullscreen';
export type ScreenScrim = 'none' | 'dim' | 'blur' | 'black' | 'white';
export type ScreenAnimate = { in?: string; idle?: string; out?: string };

export interface ScreenChart {
  type: 'pie' | 'donut' | 'bar' | 'line' | 'area' | 'stat';
  data: any[];
  xKey?: string;
  yKey?: string;
  label?: string;
}

export interface ScreenSlide {
  title?: string;
  body?: string;
  bullets?: string[];
  image?: string;
  chart?: ScreenChart;
}

export interface ScreenDeck {
  slides: ScreenSlide[];
  transition: 'slide' | 'fade' | 'zoom';
  slideMs: number;
  controls: boolean;
}

export interface ScreenScene {
  name?: string;
  html?: string;
  css?: string;
  js?: string;
  libs?: ('three')[]; // vendor libs injected by the renderer — see /screen/vendor
}

export interface ScreenThree {
  scene: 'starfield' | 'particles' | 'wave' | 'cube' | 'knot' | 'globe';
  color?: string;
  speed: number;   // 0–2 rotation/drift multiplier
  density: number; // 0.1–1 particle/geometry count multiplier
  text?: string;   // optional caption chip
}

export interface ScreenOutput {
  id: string;
  kind: ScreenKind;
  mood: ScreenMood;
  emoji: string | null;
  animate: ScreenAnimate;
  animateSpeed: 'slow' | 'slower' | 'fast' | 'faster' | null;
  title: string | null;
  position: ScreenPosition;
  scrim: ScreenScrim;
  opacity: number;
  durationMs: number;      // 0 = sticky
  dismiss: 'auto' | 'manual';
  blocking: boolean;
  /** capture pointer input only while the cursor is over the content —
   *  wheel scroll / swipe nav. No full-window capture, no backdrop dismiss. */
  interactive: boolean;
  priority: number;
  createdAt: number;

  // kind payloads (populated per kind)
  text?: string | null;
  fontSize?: 'md' | 'lg' | 'xl' | 'hero';
  screen?: { width: number; height: number }; // real display dims (injected by main.js)
  url?: string;
  dataUrl?: string;
  caption?: string;
  /** kind-scoped: image → 'contain'|'cover'; text → 'auto'|'scroll' */
  fit?: 'contain' | 'cover' | 'auto' | 'scroll';
  chart?: ScreenChart;
  effect?: 'rain' | 'snow' | 'confetti' | 'fireworks' | 'emoji-rain';
  intensity?: number; // effect: 0.05–1 particle density/speed multiplier
  severity?: 'info' | 'warn' | 'block';
  deck?: ScreenDeck;
  scene?: ScreenScene;
  three?: ScreenThree;
}

/** IPC payloads */
export interface ScreenClearMessage {
  id: string | null; // null = clear all
}

/** Mood → accent color (mirrors MOOD_MAP in shared/screen-output.cjs). */
export const MOOD_ACCENT: Record<ScreenMood, string> = {
  neutral: '#94a3b8',
  warm: '#fbbf24',
  happy: '#facc15',
  sad: '#93c5fd',
  alert: '#f87171',
  playful: '#f472b6',
  calm: '#34d399',
};
