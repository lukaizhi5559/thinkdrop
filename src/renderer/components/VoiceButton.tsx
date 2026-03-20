/**
 * VoiceButton — Companion window toggle
 *
 * Click = open Chrome companion window (localhost:5173?mode=voice-companion).
 * Click again = close it via SSE signal.
 * Chrome handles all STT (webkitSpeechRecognition) and TTS (speechSynthesis).
 */

import React, { useState, useEffect } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

type VoiceState = 'idle' | 'listening' | 'error';

interface VoiceButtonProps {
  compact?: boolean;
  // Legacy props kept for call-site compatibility — unused in companion mode
  mode?: string;
  onTranscript?: (text: string, language: string) => void;
  onResponse?: (text: string, audioBase64: string, format: string) => void;
}

export default function VoiceButton({ compact = false }: VoiceButtonProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [companionOpen, setCompanionOpen] = useState(false);

  // Listen for companion closed signal (e.g. user closes Chrome tab)
  useEffect(() => {
    if (!ipcRenderer) return;
    const onClosed = () => {
      setCompanionOpen(false);
      setVoiceState('idle');
    };
    ipcRenderer.on('voice:companion-closed', onClosed);
    return () => { ipcRenderer.removeAllListeners?.('voice:companion-closed'); };
  }, []);

  const handleClick = () => {
    if (companionOpen) {
      ipcRenderer?.send('voice:companion-close');
      setCompanionOpen(false);
      setVoiceState('idle');
    } else {
      ipcRenderer?.send('voice:companion-open');
      setCompanionOpen(true);
      setVoiceState('listening');
    }
  };

  // ── Styles ────────────────────────────────────────────────────────────────

  const stateColors: Record<VoiceState, string> = {
    idle:       'rgba(255,255,255,0.04)',
    listening:  'rgba(59,130,246,0.18)',
    error:      'rgba(239,68,68,0.18)',
  };

  const stateBorders: Record<VoiceState, string> = {
    idle:       'rgba(255,255,255,0.07)',
    listening:  'rgba(59,130,246,0.4)',
    error:      'rgba(239,68,68,0.4)',
  };

  const stateIconColors: Record<VoiceState, string> = {
    idle:       '#6b7280',
    listening:  '#60a5fa',
    error:      '#f87171',
  };

  const title = companionOpen
    ? 'Voice companion open — click to close'
    : 'Click to open voice companion';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
      {/* Mic button */}
      <button
        title={title}
        onClick={handleClick}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: '4px',
          padding: compact ? '4px 6px' : '4px 8px',
          borderRadius: '6px',
          backgroundColor: stateColors[voiceState],
          border: `1px solid ${stateBorders[voiceState]}`,
          color: stateIconColors[voiceState],
          cursor: 'pointer',
          fontSize: '0.7rem',
          userSelect: 'none',
          transition: 'background-color 0.15s, border-color 0.15s, color 0.15s',
          outline: 'none',
          position: 'relative',
          overflow: 'hidden',
        }}
        onMouseEnter={e => {
          if (voiceState === 'idle') {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(59,130,246,0.1)';
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(59,130,246,0.25)';
            (e.currentTarget as HTMLButtonElement).style.color = '#93c5fd';
          }
        }}
        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
          if (voiceState === 'idle') {
            e.currentTarget.style.backgroundColor = stateColors.idle;
            e.currentTarget.style.borderColor = stateBorders.idle;
            e.currentTarget.style.color = stateIconColors.idle;
          }
        }}
      >
        {/* Pulse ring while companion is open */}
        {voiceState === 'listening' && (
          <span style={{
            position: 'absolute', inset: 0,
            borderRadius: '6px',
            animation: 'voice-pulse 1.4s ease-in-out infinite',
            backgroundColor: 'rgba(59,130,246,0.15)',
          }} />
        )}

        {/* Mic icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>

        {/* Label */}
        {!compact && (
          <span style={{ fontSize: '0.68rem', lineHeight: 1, fontWeight: 500 }}>
            {companionOpen ? 'on' : 'mic'}
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
