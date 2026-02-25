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
  const wakeWordLoopRef = useRef(false);  // true while wake word listen loop is running

  // TTS audio queue — ensures clips play serially, stategraph lane preempts fast lane
  type AudioQueueItem = { base64: string; format: string; lane: string };
  const audioQueueRef = useRef<AudioQueueItem[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioPlayingRef = useRef(false);
  const wakeWordStreamRef = useRef<MediaStream | null>(null);
  const wakeWordAudioCtxRef = useRef<AudioContext | null>(null);

  // Keep latest callbacks in refs so IPC handlers never go stale without re-registering
  const onTranscriptRef = useRef(onTranscript);
  const onResponseRef = useRef(onResponse);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onResponseRef.current = onResponse; }, [onResponse]);

  // ── IPC listeners ─────────────────────────────────────────────────────────
  // Registered once on mount, cleaned up on unmount. Uses refs for callbacks
  // so they never go stale. Avoids duplicate registration from React StrictMode.
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
      onTranscriptRef.current?.(data.text, data.language);
    };

    const drainQueue = () => {
      if (audioPlayingRef.current || audioQueueRef.current.length === 0) return;
      const item = audioQueueRef.current.shift()!;
      audioPlayingRef.current = true;
      setVoiceState('speaking');
      const mimeType = item.format === 'mp3' ? 'audio/mpeg' : item.format === 'wav' ? 'audio/wav' : 'audio/webm';
      const audio = new Audio(`data:${mimeType};base64,${item.base64}`);
      currentAudioRef.current = audio;
      audio.onended = () => {
        currentAudioRef.current = null;
        audioPlayingRef.current = false;
        if (audioQueueRef.current.length > 0) {
          drainQueue();
        } else {
          setVoiceState('idle');
          setTranscript('');
        }
      };
      audio.onerror = () => {
        currentAudioRef.current = null;
        audioPlayingRef.current = false;
        drainQueue();
      };
      audio.play().catch(() => {
        currentAudioRef.current = null;
        audioPlayingRef.current = false;
        drainQueue();
      });
    };

    const handleResponse = (_e: any, data: { text: string; audioBase64: string; audioFormat: string; language: string; lane?: string }) => {
      const lane = data.lane || 'fast';
      console.log('[VoiceButton] voice:response received, lane:', lane, 'audioFormat:', data.audioFormat, 'b64 length:', data.audioBase64?.length);
      setDetectedLanguage(data.language || '');
      onResponseRef.current?.(data.text, data.audioBase64, data.audioFormat);

      if (lane === 'stategraph') {
        // Stategraph is authoritative — stop current audio, clear fast-lane queue, play immediately
        if (currentAudioRef.current) {
          currentAudioRef.current.pause();
          currentAudioRef.current.src = '';
          currentAudioRef.current = null;
        }
        audioQueueRef.current = [];
        audioPlayingRef.current = false;
      }

      if (data.audioBase64) {
        audioQueueRef.current.push({ base64: data.audioBase64, format: data.audioFormat || 'mp3', lane });
        drainQueue();
      }
    };

    const handleError = (_e: any, data: { error: string }) => {
      console.error('[VoiceButton] Error:', data.error);
      setVoiceState('error');
      setTimeout(() => setVoiceState('idle'), 1500);
    };

    // Clear any previously registered listeners before adding new ones
    ipcRenderer.removeAllListeners?.('voice:status');
    ipcRenderer.removeAllListeners?.('voice:transcript');
    ipcRenderer.removeAllListeners?.('voice:response');
    ipcRenderer.removeAllListeners?.('voice:error');

    ipcRenderer.on('voice:status', handleVoiceStatus);
    ipcRenderer.on('voice:transcript', handleTranscript);
    ipcRenderer.on('voice:response', handleResponse);
    ipcRenderer.on('voice:error', handleError);

    return () => {
      ipcRenderer.removeAllListeners?.('voice:status');
      ipcRenderer.removeAllListeners?.('voice:transcript');
      ipcRenderer.removeAllListeners?.('voice:response');
      ipcRenderer.removeAllListeners?.('voice:error');
    };
  }, []); // empty deps — registered once, callbacks via refs

  // ── Mic stream with WebRTC audio constraints ─────────────────────────────
  // getUserMedia with echoCancellation+noiseSuppression invokes the same WebRTC
  // audio processing stack at the OS level — this IS the WebRTC noise pipeline.
  const getWebRTCProcessedStream = async (): Promise<MediaStream> => {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: { ideal: 16000 },
      }
    });
  };

  // ── Audio recording ───────────────────────────────────────────────────────

  const activationModeRef = useRef<ActivationMode>(activationMode);
  useEffect(() => { activationModeRef.current = activationMode; }, [activationMode]);

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) {
      console.log('[VoiceButton] startRecording: already recording, ignoring');
      return;
    }
    isRecordingRef.current = true;
    console.log('[VoiceButton] startRecording: requesting mic...');

    try {
      const stream = await getWebRTCProcessedStream();
      streamRef.current = stream;
      audioChunksRef.current = [];
      const tracks = stream.getAudioTracks();
      console.log('[VoiceButton] mic stream tracks:', tracks.length, tracks.map(t => `${t.label} enabled=${t.enabled} muted=${t.muted} readyState=${t.readyState}`));

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
        console.log('[VoiceButton] recorder.onstop: blob size', blob.size);
        if (blob.size < 4000) {
          setVoiceState('idle');
          return;
        }
        // Use FileReader for correct single-pass base64 — chunked btoa breaks at padding boundaries
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.split(',')[1]); // strip "data:audio/webm;base64," prefix
          };
          reader.readAsDataURL(blob);
        });
        const format = mimeType.includes('webm') ? 'webm' : 'mp4';

        setVoiceState('processing');
        ipcRenderer?.send('voice:push-to-talk-end');
        ipcRenderer?.send('voice:audio-chunk', {
          audioBase64: base64,
          format,
          pushToTalk: activationModeRef.current === 'push-to-talk',
        });
      };

      recorder.start(100);
      console.log('[VoiceButton] recorder started, state:', recorder.state);
      setVoiceState('listening');
      ipcRenderer?.send('voice:push-to-talk-start');

      // Auto-stop after 15s max to prevent huge recordings
      setTimeout(() => {
        if (isRecordingRef.current && mediaRecorderRef.current?.state === 'recording') {
          console.log('[VoiceButton] Max PTT duration reached — auto-stopping');
          stopRecording();
        }
      }, 15000);
    } catch (err) {
      isRecordingRef.current = false;
      isHoldingRef.current = false;
      console.error('[VoiceButton] Mic access error:', err);
      setVoiceState('error');
      setTimeout(() => setVoiceState('idle'), 1500);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stopRecording = useCallback(() => {
    console.log('[VoiceButton] stopRecording, recorder state:', mediaRecorderRef.current?.state, 'isRecording:', isRecordingRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop(); // onstop will set isRecordingRef=false
    } else {
      isRecordingRef.current = false; // recorder never started — reset manually
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    isHoldingRef.current = false;
  }, []);

  // ── Wake word continuous listen loop ─────────────────────────────────────
  // Records 3-second clips and sends to voice-service with pushToTalk=false.
  // Voice-service runs wake word detection; if triggered it processes the full pipeline.

  const stopWakeWordLoop = useCallback(() => {
    wakeWordLoopRef.current = false;
    if (wakeWordStreamRef.current) {
      wakeWordStreamRef.current.getTracks().forEach(t => t.stop());
      wakeWordStreamRef.current = null;
    }
    if (wakeWordAudioCtxRef.current) {
      wakeWordAudioCtxRef.current.close().catch(() => {});
      wakeWordAudioCtxRef.current = null;
    }
  }, []);

  const startWakeWordLoop = useCallback(async () => {
    if (wakeWordLoopRef.current) return;
    wakeWordLoopRef.current = true;

    let stream: MediaStream;
    try {
      stream = await getWebRTCProcessedStream();
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

    // ── VAD via Web Audio API ─────────────────────────────────────────────
    // Same approach ElevenLabs uses: monitor RMS energy, gate recording on speech
    const audioCtx = new AudioContext();
    wakeWordAudioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    const VAD_SPEECH_THRESHOLD = 28;   // RMS 0-255: absolute floor
    const VAD_DELTA_MULTIPLIER = 1.8;  // must be 1.8x above rolling baseline to trigger
    const VAD_SILENCE_MS = 1500;       // ms of silence before sending
    const VAD_MIN_SPEECH_MS = 300;     // ignore clips shorter than this
    const VAD_MAX_SPEECH_MS = 12000;   // max utterance before force-send

    const getRMS = (): number => {
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return Math.sqrt(sum / buf.length);
    };

    // Rolling baseline: tracks ambient noise level so we detect SPIKES not sustained noise
    let baseline = 0;
    const BASELINE_ALPHA = 0.02; // slow adaptation — background music settles into baseline

    let recorder: MediaRecorder | null = null;
    let recordingChunks: Blob[] = [];
    let speechStart = 0;
    let lastSpeechMs = 0;
    let isSpeaking = false;

    const sendSegment = async () => {
      if (!recorder || recorder.state !== 'recording') return;
      recorder.stop();
      // onstop handles sending
    };

    const vadTick = () => {
      if (!wakeWordLoopRef.current) {
        if (recorder?.state === 'recording') recorder.stop();
        return; // audioCtx closed by stopWakeWordLoop
      }
      if (isRecordingRef.current) {
        // PTT active — pause VAD
        setTimeout(vadTick, 500);
        return;
      }

      const rms = getRMS();
      const now = Date.now();

      // Update rolling baseline only when not speaking (so voice doesn't pollute baseline)
      if (!isSpeaking) {
        baseline = baseline === 0 ? rms : baseline * (1 - BASELINE_ALPHA) + rms * BASELINE_ALPHA;
      }

      // Trigger: RMS must clear absolute floor AND be a significant spike over baseline
      const isSpeech = rms > VAD_SPEECH_THRESHOLD && rms > baseline * VAD_DELTA_MULTIPLIER;

      // Debug: log RMS/baseline every 2s so user can tune threshold in devtools
      if (Math.round(now / 2000) !== Math.round((now - 80) / 2000)) {
        console.log(`[VAD] rms=${rms.toFixed(1)} baseline=${baseline.toFixed(1)} threshold=${VAD_SPEECH_THRESHOLD} trigger=${isSpeaking ? 'SPEAKING' : isSpeech ? 'TRIGGER' : 'quiet'}`);
      }

      if (isSpeech) {
        lastSpeechMs = now;
        if (!isSpeaking) {
          // Speech onset — start recording
          isSpeaking = true;
          speechStart = now;
          recordingChunks = [];
          try {
            recorder = new MediaRecorder(stream, { mimeType });
            recorder.ondataavailable = (e) => { if (e.data.size > 0) recordingChunks.push(e.data); };
            recorder.onstop = async () => {
              if (!wakeWordLoopRef.current) return;
              const duration = Date.now() - speechStart;
              if (duration < VAD_MIN_SPEECH_MS) {
                console.log('[VoiceButton] VAD: segment too short, skipping');
                return;
              }
              const blob = new Blob(recordingChunks, { type: mimeType });
              if (blob.size < 4000) return;
              // Use FileReader for correct single-pass base64 — chunked btoa breaks at padding boundaries
              const base64 = await new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                reader.readAsDataURL(blob);
              });
              const format = mimeType.includes('webm') ? 'webm' : 'mp4';
              console.log('[VoiceButton] VAD: sending speech segment', { ms: duration, bytes: blob.size });
              ipcRenderer?.send('voice:audio-chunk', {
                audioBase64: base64,
                format,
                pushToTalk: false,
                skipWakeWordCheck: false,
              });
            };
            recorder.start(100);
            console.log('[VoiceButton] VAD: speech detected, recording...');
          } catch (_) { isSpeaking = false; }
        } else if (now - speechStart > VAD_MAX_SPEECH_MS) {
          // Force-send after max duration
          isSpeaking = false;
          sendSegment();
        }
      } else if (isSpeaking && now - lastSpeechMs > VAD_SILENCE_MS) {
        // Silence after speech — send segment
        isSpeaking = false;
        console.log('[VoiceButton] VAD: silence detected, sending segment');
        sendSegment();
      }

      setTimeout(vadTick, 80); // poll every 80ms
    };

    vadTick();
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

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (activationMode !== 'push-to-talk') return;
    e.preventDefault();
    e.stopPropagation();
    if (isHoldingRef.current) return;
    // Capture pointer on the button — keeps pointerup firing on this element
    // even if the mouse moves off it (e.g. during Electron window drag).
    (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
    isHoldingRef.current = true;
    startRecording();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (activationMode !== 'push-to-talk') return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLButtonElement).releasePointerCapture(e.pointerId);
    if (isHoldingRef.current) {
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
        onPointerDown={isPTT ? handlePointerDown : undefined}
        onPointerUp={isPTT ? handlePointerUp : undefined}
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
