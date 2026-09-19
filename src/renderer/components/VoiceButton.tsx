/**
 * VoiceButton — Voice session toggle
 *
 * Click = start the voice session (main → voice-bridge → hidden Chrome worker
 * does webkitSpeechRecognition). Click again = stop the session.
 * Active/idle state is driven by `voice:session` events from main; the
 * listening/speaking tint follows `voice:state` events.
 */

import React, { useState, useEffect } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

type VoiceState = 'idle' | 'listening' | 'speaking' | 'processing' | 'error';

interface VoiceButtonProps {
  compact?: boolean;
  // Legacy props kept for call-site compatibility — unused in session mode
  mode?: string;
  onTranscript?: (text: string, language: string) => void;
  onResponse?: (text: string, audioBase64: string, format: string) => void;
  icon?: 'mic' | 'voice';
  style?: React.CSSProperties;
}

export default function VoiceButton({ compact = false, icon = 'mic', style = {} }: VoiceButtonProps) {
  const [active, setActive] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');

  // Session + worker state events from main (relayed from the voice bridge)
  useEffect(() => {
    if (!ipcRenderer) return;
    const onSession = (data: { active: boolean }) => {
      setActive(!!data?.active);
      if (!data?.active) setVoiceState('idle');
    };
    const onState = (data: { state: string }) => {
      const s = data?.state;
      if (s === 'listening' || s === 'speaking' || s === 'processing' || s === 'idle' || s === 'error' || s === 'ready') {
        setVoiceState(s === 'ready' ? 'listening' : s as VoiceState);
      }
    };
    const onError = () => setVoiceState('error');
    ipcRenderer.on('voice:session', onSession);
    ipcRenderer.on('voice:state', onState);
    ipcRenderer.on('voice:error', onError);
    return () => {
      ipcRenderer.removeAllListeners?.('voice:session');
      ipcRenderer.removeAllListeners?.('voice:state');
      ipcRenderer.removeAllListeners?.('voice:error');
    };
  }, []);

  const handleClick = () => {
    ipcRenderer?.send(active ? 'voice:session-stop' : 'voice:session-start');
  };

  // ── Styles ────────────────────────────────────────────────────────────────

  const stateColors: Record<VoiceState, string> = {
    idle:       'rgba(255,255,255,0.04)',
    listening:  'rgba(59,130,246,0.18)',
    speaking:   'rgba(168,85,247,0.18)',
    processing: 'rgba(251,191,36,0.15)',
    error:      'rgba(239,68,68,0.18)',
  };

  const stateBorders: Record<VoiceState, string> = {
    idle:       'rgba(255,255,255,0.07)',
    listening:  'rgba(59,130,246,0.4)',
    speaking:   'rgba(168,85,247,0.4)',
    processing: 'rgba(251,191,36,0.35)',
    error:      'rgba(239,68,68,0.4)',
  };

  const stateIconColors: Record<VoiceState, string> = {
    idle:       '#abafb8',
    listening:  '#60a5fa',
    speaking:   '#c084fc',
    processing: '#fbbf24',
    error:      '#f87171',
  };

  const displayState: VoiceState = active ? voiceState : 'idle';

  const title = active
    ? 'Voice session active — click to stop'
    : 'Click to start voice session';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative', zIndex: 20 }}>
      {/* Mic button */}
      <button
        title={title}
        onClick={handleClick}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: '4px',
          padding: '9px',
          borderRadius: '6px',
          backgroundColor: stateColors[displayState],
          border: `1px solid ${stateBorders[displayState]}`,
          color: stateIconColors[displayState],
          cursor: 'pointer',
          fontSize: '0.7rem',
          userSelect: 'none',
          transition: 'background-color 0.15s, border-color 0.15s, color 0.15s',
          outline: 'none',
          position: 'relative',
          overflow: 'hidden',
          ...style,
        }}
        onMouseEnter={e => {
          if (displayState === 'idle') {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(59,130,246,0.1)';
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(59,130,246,0.25)';
            (e.currentTarget as HTMLButtonElement).style.color = '#93c5fd';
          }
        }}
        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
          if (displayState === 'idle') {
            e.currentTarget.style.backgroundColor = stateColors.idle;
            e.currentTarget.style.borderColor = stateBorders.idle;
            e.currentTarget.style.color = stateIconColors.idle;
          }
        }}
      >
        {/* Pulse ring while session is active */}
        {active && (
          <span style={{
            position: 'absolute', inset: 0,
            borderRadius: '6px',
            animation: 'voice-pulse 1.4s ease-in-out infinite',
            backgroundColor: displayState === 'speaking' ? 'rgba(168,85,247,0.15)' : 'rgba(59,130,246,0.15)',
          }} />
        )}

        {/* Mic / voice icon */}
        {icon === 'voice' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="voice">
            <rect x="5" y="10" width="2.5" height="4" rx="1.25" />
            <rect x="9.25" y="7" width="2.5" height="10" rx="1.25" />
            <rect x="13.5" y="4" width="2.5" height="16" rx="1.25" />
            <rect x="17.75" y="9" width="2.5" height="6" rx="1.25" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        )}

        {/* Label */}
        {!compact && (
          <span style={{ fontSize: '0.68rem', lineHeight: 1, fontWeight: 500 }}>
            {active ? 'on' : 'mic'}
          </span>
        )}
      </button>

      {/* CSS animations */}
      <style>{`
        @keyframes voice-pulse {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.04); }
        }
      `}</style>
    </div>
  );
}
