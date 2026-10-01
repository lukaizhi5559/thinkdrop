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

type VoiceState = 'idle' | 'starting' | 'listening' | 'speaking' | 'processing' | 'error' | 'sleeping' | 'talking';

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
  const [talkMode, setTalkMode] = useState(false);

  // Session + worker state events from main (relayed from the voice bridge)
  useEffect(() => {
    if (!ipcRenderer) return;
    const onSession = (data: { active: boolean; mode?: string }) => {
      setActive(!!data?.active);
      if (data?.mode) setTalkMode(data.mode === 'realtime');
      if (!data?.active) setVoiceState('idle');
    };
    const onMode = (data: { mode?: string }) => {
      if (data?.mode) setTalkMode(data.mode === 'realtime');
    };
    const onState = (data: { state: string }) => {
      const s = data?.state;
      if (s === 'starting' || s === 'listening' || s === 'speaking' || s === 'processing' || s === 'idle' || s === 'error' || s === 'ready' || s === 'sleeping' || s === 'talking') {
        setVoiceState(s === 'ready' ? 'listening' : s as VoiceState);
      }
    };
    const onError = () => setVoiceState('error');
    ipcRenderer.on('voice:session', onSession);
    ipcRenderer.on('voice:session-mode', onMode);
    ipcRenderer.on('voice:state', onState);
    ipcRenderer.on('voice:error', onError);
    return () => {
      ipcRenderer.removeAllListeners?.('voice:session');
      ipcRenderer.removeAllListeners?.('voice:session-mode');
      ipcRenderer.removeAllListeners?.('voice:state');
      ipcRenderer.removeAllListeners?.('voice:error');
    };
  }, []);

  const handleClick = () => {
    if (active) {
      // Sleeping → click wakes (don't kill the session).
      if (voiceState === 'sleeping') {
        ipcRenderer?.send('voice:session-wake');
        return;
      }
      setTalkMode(false);
      ipcRenderer?.send('voice:session-stop');
      return;
    }
    // One button: 'auto' tries S2S Talk Mode first and the voice bridge falls
    // back to the Chrome SR pipeline if the realtime call can't connect.
    // The Voice Mode setting (conversation vs pipeline) is read live so a
    // change takes effect on the very next click — VOICE_MODE env still wins.
    setVoiceState('starting');
    (async () => {
      let mode = 'auto';
      try {
        const res = await ipcRenderer?.invoke('settings:get', { key: 'voiceMode' });
        if (res?.value === 'pipeline') mode = 'pipeline';
      } catch (_) {}
      ipcRenderer?.send('voice:session-start', { mode });
    })();
  };

  // ── Styles ────────────────────────────────────────────────────────────────

  const stateColors: Record<VoiceState, string> = {
    idle:       'rgba(255,255,255,0.04)',
    starting:   'rgba(251,191,36,0.12)',
    listening:  'rgba(59,130,246,0.18)',
    speaking:   'rgba(168,85,247,0.18)',
    processing: 'rgba(251,191,36,0.15)',
    error:      'rgba(239,68,68,0.18)',
    sleeping:   'rgba(129,140,248,0.10)',
    talking:    'rgba(52,211,153,0.18)',
  };

  const stateBorders: Record<VoiceState, string> = {
    idle:       'rgba(255,255,255,0.07)',
    starting:   'rgba(251,191,36,0.3)',
    listening:  'rgba(59,130,246,0.4)',
    speaking:   'rgba(168,85,247,0.4)',
    processing: 'rgba(251,191,36,0.35)',
    error:      'rgba(239,68,68,0.4)',
    sleeping:   'rgba(129,140,248,0.25)',
    talking:    'rgba(52,211,153,0.4)',
  };

  const stateIconColors: Record<VoiceState, string> = {
    idle:       '#abafb8',
    starting:   '#fbbf24',
    listening:  '#60a5fa',
    speaking:   '#c084fc',
    processing: '#fbbf24',
    error:      '#f87171',
    sleeping:   '#818cf8',
    talking:    '#34d399',
  };

  const displayState: VoiceState = active ? voiceState : (voiceState === 'starting' ? 'starting' : 'idle');

  const title = active
    ? voiceState === 'sleeping'
      ? 'Sleeping — click to wake'
      : voiceState === 'starting'
        ? 'Starting voice…'
        : talkMode ? 'Talk Mode (S2S) active — click to hang up' : 'Voice session active — click to stop'
    : voiceState === 'starting' ? 'Starting voice…' : 'Click to start voice';

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
        {/* Pulse ring while active; faster amber pulse while starting up */}
        {(active || displayState === 'starting') && (
          <span style={{
            position: 'absolute', inset: 0,
            borderRadius: '6px',
            animation: displayState === 'starting' ? 'voice-pulse 0.7s ease-in-out infinite' : 'voice-pulse 1.4s ease-in-out infinite',
            backgroundColor: displayState === 'speaking' ? 'rgba(168,85,247,0.15)'
              : displayState === 'starting' ? 'rgba(251,191,36,0.18)'
              : 'rgba(59,130,246,0.15)',
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
            {displayState === 'starting' ? '···'
              : active ? (voiceState === 'sleeping' ? 'zzz' : talkMode ? 'talk' : 'on')
              : 'mic'}
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
