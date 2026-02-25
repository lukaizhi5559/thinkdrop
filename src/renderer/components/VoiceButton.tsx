/**
 * VoiceButton — Push-to-talk mic button + wake word indicator
 *
 * States:
 *   idle       — grey mic icon, click to activate wake-word mode
 *   listening  — blue pulsing ring, recording audio (push-to-talk held or wake word triggered)
 *   processing — spinner, audio being processed by voice-service
 *   speaking   — green wave, TTS audio playing
 *   error      — red briefly, resets to idle
 *
 * Two activation modes:
 *   1. Push-to-talk: mousedown = start recording, mouseup = send audio
 *   2. Wake word: click toggles always-on mode (voice-service handles detection)
 *
 * Audio is captured via MediaRecorder (WebM/Opus), converted to base64,
 * sent to main process via voice:audio-chunk IPC.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';
type ActivationMode = 'push-to-talk' | 'wake-word';

interface VoiceButtonProps {
  mode?: ActivationMode;
  onTranscript?: (text: string, language: string) => void;
  onResponse?: (text: string, audioBase64: string, format: string) => void;
  compact?: boolean;
}

export default function VoiceButton({ mode = 'push-to-talk', onTranscript, onResponse, compact = false }: VoiceButtonProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [activationMode, setActivationMode] = useState<ActivationMode>(mode);
  const [detectedLanguage, setDetectedLanguage] = useState<string>('');
  const [transcript, setTranscript] = useState<string>('');
  const [wakeWordActive, setWakeWordActive] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const isHoldingRef = useRef(false);
  const isRecordingRef = useRef(false); // true while MediaRecorder is active
  const playAudioRef = useRef<(b: string, f: string) => Promise<void>>(async () => {});
  const wakeWordLoopRef = useRef(false);  // true while wake word listen loop is running
  const wakeWordStreamRef = useRef<MediaStream | null>(null);

  // ── IPC listeners ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ipcRenderer) return;

    const handleVoiceStatus = (_e: any, data: { status: string }) => {
      if (data.status === 'listening') setVoiceState('listening');
      else if (data.status === 'processing') setVoiceState('processing');
      else if (data.status === 'speaking') setVoiceState('speaking');
      else if (data.status === 'idle') setVoiceState('idle');
    };

    const handleTranscript = (_e: any, data: { text: string; language: string }) => {
      setTranscript(data.text);
      setDetectedLanguage(data.language || '');
      onTranscript?.(data.text, data.language);
    };

    const handleResponse = (_e: any, data: { text: string; audioBase64: string; audioFormat: string; language: string }) => {
      console.log('[VoiceButton] voice:response received, audioFormat:', data.audioFormat, 'b64 length:', data.audioBase64?.length);
      setVoiceState('speaking');
      setDetectedLanguage(data.language || '');
      onResponse?.(data.text, data.audioBase64, data.audioFormat);
      playAudioRef.current(data.audioBase64, data.audioFormat).then(() => {
        console.log('[VoiceButton] Audio playback finished');
      }).catch((err) => {
        console.error('[VoiceButton] Audio playback error:', err);
      }).finally(() => {
        setVoiceState('idle');
        setTranscript('');
      });
    };

    const handleError = (_e: any, data: { error: string }) => {
      console.error('[VoiceButton] Error:', data.error);
      setVoiceState('error');
      setTimeout(() => setVoiceState('idle'), 1500);
    };

    ipcRenderer.on('voice:status', handleVoiceStatus);
    ipcRenderer.on('voice:transcript', handleTranscript);
    ipcRenderer.on('voice:response', handleResponse);
    ipcRenderer.on('voice:error', handleError);

    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('voice:status', handleVoiceStatus);
        ipcRenderer.removeListener('voice:transcript', handleTranscript);
        ipcRenderer.removeListener('voice:response', handleResponse);
        ipcRenderer.removeListener('voice:error', handleError);
      }
    };
  }, [onTranscript, onResponse]);

  // ── Audio recording ───────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) return; // already recording
    isRecordingRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        isRecordingRef.current = false;
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size < 1000) {
          setVoiceState('idle');
          return;
        }
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let base64 = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          base64 += btoa(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
        }
        const format = mimeType.includes('webm') ? 'webm' : 'mp4';

        setVoiceState('processing');
        ipcRenderer?.send('voice:push-to-talk-end');
        ipcRenderer?.send('voice:audio-chunk', {
          audioBase64: base64,
          format,
          pushToTalk: activationMode === 'push-to-talk',
        });
      };

      recorder.start(100);
      setVoiceState('listening');
      ipcRenderer?.send('voice:push-to-talk-start');
    } catch (err) {
      isRecordingRef.current = false;
      isHoldingRef.current = false;
      console.error('[VoiceButton] Mic access error:', err);
      setVoiceState('error');
      setTimeout(() => setVoiceState('idle'), 1500);
    }
  }, [activationMode]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    isHoldingRef.current = false;
  }, []);

  // ── Audio playback ────────────────────────────────────────────────────────

  const playAudioBase64 = useCallback(async (base64: string, format: string): Promise<void> => {
    return new Promise((resolve) => {
      try {
        const mimeType = format === 'mp3' ? 'audio/mpeg' : format === 'wav' ? 'audio/wav' : format === 'aiff' ? 'audio/aiff' : 'audio/webm';
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        audio.play().catch(() => resolve());
      } catch (_) {
        resolve();
      }
    });
  }, []);

  // ── Sync playAudio ref so useEffect always has current version ─────────────
  playAudioRef.current = playAudioBase64;

  // ── Wake word continuous listen loop ─────────────────────────────────────
  // Records 3-second clips and sends to voice-service with pushToTalk=false.
  // Voice-service runs wake word detection; if triggered it processes the full pipeline.

  const stopWakeWordLoop = useCallback(() => {
    wakeWordLoopRef.current = false;
    if (wakeWordStreamRef.current) {
      wakeWordStreamRef.current.getTracks().forEach(t => t.stop());
      wakeWordStreamRef.current = null;
    }
  }, []);

  const startWakeWordLoop = useCallback(async () => {
    if (wakeWordLoopRef.current) return;
    wakeWordLoopRef.current = true;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      wakeWordStreamRef.current = stream;
    } catch (err) {
      console.error('[VoiceButton] Wake word mic error:', err);
      wakeWordLoopRef.current = false;
      setVoiceState('error');
      setTimeout(() => setVoiceState('idle'), 1500);
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

    // Use Web Audio API to check energy — skip silent/noise-only chunks
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
    } catch (_) { /* energy check unavailable, proceed anyway */ }

    const hasSpeechEnergy = (): boolean => {
      if (!analyser) return true; // fallback: always send if no analyser
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(buf);
      // Average energy of speech-range frequencies (roughly 300Hz–3400Hz)
      // At fftSize=256 and typical 44100Hz sample rate: bin ≈ freq / (sampleRate/fftSize)
      const sampleRate = audioCtx?.sampleRate || 44100;
      const binSize = sampleRate / 256;
      const lo = Math.floor(300 / binSize);
      const hi = Math.ceil(3400 / binSize);
      let sum = 0;
      for (let i = lo; i <= hi && i < buf.length; i++) sum += buf[i];
      const avg = sum / (hi - lo + 1);
      return avg > 20; // 0-255 scale; >20 = likely speech
    };

    const recordChunk = () => {
      if (!wakeWordLoopRef.current) return;
      if (!wakeWordStreamRef.current) return;
      // Don't send while PTT is recording — avoid double-processing
      if (isRecordingRef.current) {
        setTimeout(recordChunk, 1000);
        return;
      }

      const chunks: Blob[] = [];
      let recorder: MediaRecorder;
      let peakEnergy = false;
      try {
        recorder = new MediaRecorder(wakeWordStreamRef.current, { mimeType });
      } catch (_) {
        wakeWordLoopRef.current = false;
        return;
      }

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
          if (!peakEnergy) peakEnergy = hasSpeechEnergy();
        }
      };

      recorder.onstop = async () => {
        if (!wakeWordLoopRef.current) return;
        const blob = new Blob(chunks, { type: mimeType });
        // Only send to ElevenLabs if energy suggests actual speech
        if (blob.size > 2000 && peakEnergy) {
          const arrayBuffer = await blob.arrayBuffer();
          const wbytes = new Uint8Array(arrayBuffer);
          let base64 = '';
          const CHUNK = 8192;
          for (let i = 0; i < wbytes.length; i += CHUNK) {
            base64 += btoa(String.fromCharCode(...wbytes.subarray(i, i + CHUNK)));
          }
          const format = mimeType.includes('webm') ? 'webm' : 'mp4';
          ipcRenderer?.send('voice:audio-chunk', {
            audioBase64: base64,
            format,
            pushToTalk: false,
            skipWakeWordCheck: false,
          });
        }
        // Next chunk after gap
        if (wakeWordLoopRef.current) {
          setTimeout(recordChunk, 500);
        }
      };

      recorder.start(200); // collect data every 200ms so energy check fires during recording
      setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 4000); // 4s chunks
    };

    recordChunk();
  }, []);

  // ── Wake word toggle ──────────────────────────────────────────────────────

  const toggleWakeWord = useCallback(() => {
    if (wakeWordActive) {
      setWakeWordActive(false);
      setVoiceState('idle');
      stopWakeWordLoop();
      ipcRenderer?.send('voice:stop');
    } else {
      setWakeWordActive(true);
      setVoiceState('listening');
      ipcRenderer?.send('voice:start');
      startWakeWordLoop();
    }
  }, [wakeWordActive, startWakeWordLoop, stopWakeWordLoop]);

  // ── Cleanup wake word loop on unmount ────────────────────────────────────
  useEffect(() => {
    return () => { stopWakeWordLoop(); };
  }, [stopWakeWordLoop]);

  // ── Stop wake word loop when switching to PTT mode ────────────────────────
  useEffect(() => {
    if (activationMode === 'push-to-talk') {
      stopWakeWordLoop();
      setWakeWordActive(false);
    }
  }, [activationMode, stopWakeWordLoop]);

  // ── Button interaction ────────────────────────────────────────────────────

  const handleMouseDown = (e: React.MouseEvent) => {
    if (activationMode !== 'push-to-talk') return;
    e.preventDefault();
    e.stopPropagation(); // prevent parent drag handler from firing
    if (isHoldingRef.current) return; // already recording — ignore re-fires
    isHoldingRef.current = true;
    startRecording();
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (activationMode !== 'push-to-talk') return;
    e.preventDefault();
    e.stopPropagation();
    if (isHoldingRef.current) {
      stopRecording();
    }
  };

  const handleMouseLeave = () => {
    if (activationMode === 'push-to-talk' && isHoldingRef.current) {
      stopRecording();
    }
  };

  const handleClick = () => {
    if (activationMode === 'wake-word') {
      toggleWakeWord();
    }
  };

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setActivationMode(prev => prev === 'push-to-talk' ? 'wake-word' : 'push-to-talk');
  };

  // ── Styles ────────────────────────────────────────────────────────────────

  const stateColors: Record<VoiceState, string> = {
    idle:       'rgba(255,255,255,0.04)',
    listening:  'rgba(59,130,246,0.18)',
    processing: 'rgba(168,85,247,0.15)',
    speaking:   'rgba(34,197,94,0.15)',
    error:      'rgba(239,68,68,0.18)',
  };

  const stateBorders: Record<VoiceState, string> = {
    idle:       'rgba(255,255,255,0.07)',
    listening:  'rgba(59,130,246,0.4)',
    processing: 'rgba(168,85,247,0.35)',
    speaking:   'rgba(34,197,94,0.4)',
    error:      'rgba(239,68,68,0.4)',
  };

  const stateIconColors: Record<VoiceState, string> = {
    idle:       '#6b7280',
    listening:  '#60a5fa',
    processing: '#c084fc',
    speaking:   '#4ade80',
    error:      '#f87171',
  };

  const isPTT = activationMode === 'push-to-talk';
  const isWWActive = activationMode === 'wake-word' && wakeWordActive;
  const title = isPTT
    ? 'Hold to speak (push-to-talk) · Right-click to switch to wake word mode'
    : wakeWordActive
      ? 'Wake word active — say "ThinkDrop" to speak · Right-click to switch to push-to-talk'
      : 'Click to enable wake word mode · Right-click to switch to push-to-talk';

  const langBadge = detectedLanguage && detectedLanguage !== 'en' ? detectedLanguage.toUpperCase() : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
      {/* Language badge */}
      {langBadge && (
        <span style={{
          fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.04em',
          color: '#60a5fa', backgroundColor: 'rgba(59,130,246,0.12)',
          border: '1px solid rgba(59,130,246,0.25)',
          borderRadius: '3px', padding: '1px 4px', lineHeight: 1.4,
          userSelect: 'none',
        }}>
          {langBadge}
        </span>
      )}

      {/* Transcript tooltip */}
      {transcript && voiceState !== 'idle' && (
        <div style={{
          position: 'absolute',
          bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: '6px',
          backgroundColor: 'rgba(23,23,23,0.97)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '6px',
          padding: '5px 9px',
          fontSize: '0.7rem',
          color: '#d1d5db',
          whiteSpace: 'nowrap',
          maxWidth: '280px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          pointerEvents: 'none',
          zIndex: 100,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {transcript}
        </div>
      )}

      {/* Mic button */}
      <button
        title={title}
        onMouseDown={isPTT ? handleMouseDown : undefined}
        onMouseUp={isPTT ? handleMouseUp : undefined}
        onClick={!isPTT ? handleClick : undefined}
        onContextMenu={handleRightClick}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: '4px',
          padding: compact ? '4px 6px' : '4px 8px',
          borderRadius: '6px',
          backgroundColor: stateColors[voiceState],
          border: `1px solid ${stateBorders[voiceState]}`,
          color: stateIconColors[voiceState],
          cursor: isPTT ? 'pointer' : 'pointer',
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
          if (isPTT) handleMouseLeave();
        }}
      >
        {/* Pulse ring for listening */}
        {(voiceState === 'listening' || isWWActive) && (
          <span style={{
            position: 'absolute', inset: 0,
            borderRadius: '6px',
            animation: 'voice-pulse 1.4s ease-in-out infinite',
            backgroundColor: 'rgba(59,130,246,0.15)',
          }} />
        )}

        {/* Speaking wave rings */}
        {voiceState === 'speaking' && (
          <span style={{
            position: 'absolute', inset: 0,
            borderRadius: '6px',
            animation: 'voice-speaking 0.8s ease-in-out infinite alternate',
            backgroundColor: 'rgba(34,197,94,0.12)',
          }} />
        )}

        {/* Icon */}
        {voiceState === 'processing' ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"
              strokeDasharray="20" strokeDashoffset="0">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/>
            </path>
          </svg>
        ) : voiceState === 'speaking' ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        )}

        {/* Mode label (non-compact only) */}
        {!compact && (
          <span style={{ fontSize: '0.68rem', lineHeight: 1, fontWeight: 500 }}>
            {voiceState === 'listening' && isPTT ? 'listening…' :
             voiceState === 'processing' ? '' :
             voiceState === 'speaking' ? '' :
             isPTT ? 'hold' : isWWActive ? 'on' : 'voice'}
          </span>
        )}
      </button>

      {/* CSS animations injected once */}
      <style>{`
        @keyframes voice-pulse {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.04); }
        }
        @keyframes voice-speaking {
          0% { opacity: 0.2; }
          100% { opacity: 0.55; }
        }
      `}</style>
    </div>
  );
}
