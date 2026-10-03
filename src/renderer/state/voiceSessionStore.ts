/**
 * voiceSessionStore — external store for the live voice bridge session.
 *
 * Mic `level` arrives ~10Hz and interim transcripts nearly as often; keeping
 * this in UnifiedOverlay root state re-rendered the entire overlay tree on
 * every frame of a voice session. PromptInputBar/VoiceBars are the only
 * consumers, so the session lives here and they subscribe via
 * useSyncExternalStore — zero renders anywhere else.
 */
import { useSyncExternalStore } from 'react';

export interface VoiceSessionState {
  active: boolean;
  state: string;      // 'ready' | 'listening' | 'speaking' | 'processing' | 'idle' | 'error'
  interimText: string;
  finalText: string;
  level: number;      // 0..1 mic amplitude
}

const IDLE: VoiceSessionState = { active: false, state: 'idle', interimText: '', finalText: '', level: 0 };

let _state: VoiceSessionState = IDLE;
const _listeners = new Set<() => void>();
let _lastLevelAt = 0;

function _emit() {
  for (const l of _listeners) l();
}

export const voiceSessionStore = {
  get: (): VoiceSessionState => _state,
  subscribe(fn: () => void): () => void {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  },
  set(patch: Partial<VoiceSessionState>) {
    _state = { ..._state, ...patch };
    _emit();
  },
  setActive(active: boolean) {
    _state = active
      ? { ..._state, active: true }
      : { ...IDLE };
    _emit();
  },
  /** Mic level arrives ~10Hz — throttled to ~6Hz. */
  setLevel(level: number) {
    const now = Date.now();
    if (now - _lastLevelAt < 150) return;
    _lastLevelAt = now;
    _state = { ..._state, level };
    _emit();
  },
};

export function useVoiceSession(): VoiceSessionState {
  return useSyncExternalStore(voiceSessionStore.subscribe, voiceSessionStore.get);
}
