/**
 * VoiceButton — Voice control button
 *
 * States:
 *   idle       — grey mic icon
 *   listening  — blue pulsing ring, recording audio (PTT) or always-on STT active
 *   processing — spinner, audio being processed by voice-service
 *   speaking   — green wave, TTS audio playing
 *   error      — red briefly, resets to idle
 *
 * Interaction model:
 *   Click              = toggle always-on STT+TTS mode (wake-word VAD loop)
 *   Backtick keydown   = PTT start recording (while key held)
 *   Backtick keyup     = PTT stop + send audio
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
  const [activationMode, _setActivationMode] = useState<ActivationMode>(mode);
  const [detectedLanguage, setDetectedLanguage] = useState<string>('');
  const [transcript, setTranscript] = useState<string>('');
  const [wakeWordActive, setWakeWordActive] = useState(false);
  // PTT via backtick: true while key is held
  const isPTTHeldRef = useRef(false);
  // Set to true if stopRecording is called before MediaRecorder has started
  const pendingStopRef = useRef(false);

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
  const ttsCooldownUntilRef = useRef<number>(0); // epoch ms — VAD suppressed until this time after TTS ends
  const vadSendingRef = useRef(false); // true while a segment is in-flight — reset by voice:response

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
          // Post-TTS cooldown: suppress VAD for 2.5s so speaker output isn't re-captured
          ttsCooldownUntilRef.current = Date.now() + 2500;
          setVoiceState('idle');
          setTranscript('');
        }
      };
      audio.onerror = () => {
        currentAudioRef.current = null;
        audioPlayingRef.current = false;
        drainQueue();
      };
      console.log('[VoiceButton] Starting audio playback, duration estimate unknown, mimeType:', mimeType, 'b64len:', item.base64.length);
      audio.play().catch((err) => {
        console.error('[VoiceButton] audio.play() failed:', err?.name, err?.message);
        currentAudioRef.current = null;
        audioPlayingRef.current = false;
        drainQueue();
      });
    };

    const handleResponse = (_e: any, data: { text: string; audioBase64: string; audioFormat: string; language: string; lane?: string; durationEstimateMs?: number }) => {
      const lane = data.lane || 'fast';
      console.log('[VoiceButton] voice:response received, lane:', lane, 'audioFormat:', data.audioFormat, 'b64 length:', data.audioBase64?.length);
      // Pipeline complete — unlock VAD so next utterance can be captured
      vadSendingRef.current = false;
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
        // Pre-set cooldown based on known duration so VAD stays closed during playback
        if (data.durationEstimateMs) {
          ttsCooldownUntilRef.current = Date.now() + data.durationEstimateMs + 1500;
        }
        audioQueueRef.current.push({ base64: data.audioBase64, format: data.audioFormat || 'mp3', lane });
        drainQueue();
      }
    };

    const handleError = (_e: any, data: { error: string }) => {
      console.error('[VoiceButton] Error:', data.error);
      setVoiceState('error');
      setTimeout(() => setVoiceState('idle'), 1500);
    };

    // removeAllListeners before re-registering — prevents duplicate handlers from
    // React StrictMode double-mount (mount→unmount→mount creates new refs each time,
    // so removeListener by ref can't reliably clean up stale handlers).
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

  // Web Speech API removed — caused double LLM calls (ran parallel to Groq, fired
  // voice:transcript-direct which triggered a second full pipeline independently).
  // Groq Whisper via voice:audio-chunk is the single STT path.

  const _startRecording = useCallback(async () => {
    if (isRecordingRef.current) {
      console.log('[VoiceButton] startRecording: already recording, ignoring');
      return;
    }
    isRecordingRef.current = true;
    // Capture PTT flag now — isPTTHeldRef will be false by the time onstop fires
    const recordingIsPTT = isPTTHeldRef.current || (activationModeRef.current === 'push-to-talk');
    console.log('[VoiceButton] startRecording: requesting mic... isPTT:', recordingIsPTT);

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
        pendingStopRef.current = false;
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
          streamRef.current = null;
        }
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        console.log('[VoiceButton] recorder.onstop: blob size', blob.size);
        if (blob.size < 1000) {
          console.log('[VoiceButton] blob too small, discarding');
          setVoiceState('idle');
          return;
        }

        setVoiceState('processing');
        ipcRenderer?.send('voice:push-to-talk-end');

        // Single STT path: Groq Whisper via voice:audio-chunk
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(blob);
        });
        const format = mimeType.includes('webm') ? 'webm' : 'mp4';
        console.log('[VoiceButton] voice:audio-chunk sending, b64 len:', base64?.length, 'format:', format);
        ipcRenderer?.send('voice:audio-chunk', {
          audioBase64: base64,
          format,
          pushToTalk: recordingIsPTT,
        });
      };

      recorder.start(100);
      console.log('[VoiceButton] recorder started, state:', recorder.state);
      setVoiceState('listening');
      ipcRenderer?.send('voice:push-to-talk-start');

      // If stopRecording was called before the recorder was ready, honour it now.
      // Wait at least 300ms so we capture meaningful audio before stopping.
      if (pendingStopRef.current) {
        console.log('[VoiceButton] pendingStop — stopping recorder after minimum capture window');
        pendingStopRef.current = false;
        setTimeout(() => {
          if (mediaRecorderRef.current?.state === 'recording') {
            try { mediaRecorderRef.current.requestData(); } catch (_) {}
            setTimeout(() => {
              if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
            }, 120);
          }
        }, 300);
        isHoldingRef.current = false;
        return;
      }

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
    const recorderState = mediaRecorderRef.current?.state;
    console.log('[VoiceButton] stopRecording, recorder state:', recorderState, 'isRecording:', isRecordingRef.current);
    if (mediaRecorderRef.current && recorderState === 'recording') {
      // Flush any buffered audio before stopping so we don't lose the last chunk
      try { mediaRecorderRef.current.requestData(); } catch (_) {}
      // Small delay to let requestData() emit its ondataavailable before stop fires
      setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, 120);
    } else if (isRecordingRef.current) {
      // startRecording is still awaiting getUserMedia — flag a pending stop
      console.log('[VoiceButton] stopRecording: recorder not ready yet — setting pendingStop');
      pendingStopRef.current = true;
    } else {
      // nothing started at all
      isRecordingRef.current = false;
    }
    isHoldingRef.current = false;
  }, []);

  // Backtick PTT is handled by StandalonePromptCapture (speech-to-textarea flow).

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
    const VAD_SILENCE_MS = 2200;       // ms of silence before sending — 2200ms allows natural mid-sentence breathing pauses
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
    // vadSending is vadSendingRef.current — promoted to ref so handleResponse can reset it

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
      if (audioPlayingRef.current || Date.now() < ttsCooldownUntilRef.current) {
        // TTS is playing or in post-TTS cooldown.
        // Allow interrupt: if user speaks loudly (2.5x above threshold), stop TTS and start recording.
        const rmsNow = getRMS();
        const isInterrupt = audioPlayingRef.current && rmsNow > VAD_SPEECH_THRESHOLD * 2.5;
        if (isInterrupt && !isSpeaking && !vadSendingRef.current) {
          console.log('[VoiceButton] VAD: interrupt detected — stopping TTS', { rms: rmsNow.toFixed(1) });
          // Stop TTS immediately
          if (currentAudioRef.current) {
            currentAudioRef.current.pause();
            currentAudioRef.current.src = '';
            currentAudioRef.current = null;
          }
          audioQueueRef.current = [];
          audioPlayingRef.current = false;
          ttsCooldownUntilRef.current = 0; // clear cooldown so VAD opens immediately
          // fall through to normal recording logic below
        } else {
          if (isSpeaking && recorder?.state === 'recording') {
            recorder.stop();
            isSpeaking = false;
            vadSendingRef.current = false;
          }
          // Reset baseline when cooldown expires so ambient noise recalibrates cleanly
          if (!audioPlayingRef.current && Date.now() >= ttsCooldownUntilRef.current) baseline = 0;
          setTimeout(vadTick, 200);
          return;
        }
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
        if (!isSpeaking && !vadSendingRef.current) {
          // Speech onset — start recording (skip if previous segment still processing)
          isSpeaking = true;
          speechStart = now;
          vadSendingRef.current = true;
          recordingChunks = [];
          try {
            recorder = new MediaRecorder(stream, { mimeType });
            recorder.ondataavailable = (e) => { if (e.data.size > 0) recordingChunks.push(e.data); };
            recorder.onstop = async () => {
              if (!wakeWordLoopRef.current) return;
              const duration = Date.now() - speechStart;
              if (duration < VAD_MIN_SPEECH_MS) {
                console.log('[VoiceButton] VAD: segment too short, skipping');
                vadSendingRef.current = false;
                return;
              }
              const blob = new Blob(recordingChunks, { type: mimeType });
              if (blob.size < 4000) { vadSendingRef.current = false; return; }
              // Use FileReader for correct single-pass base64 — chunked btoa breaks at padding boundaries
              const base64 = await new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                reader.readAsDataURL(blob);
              });
              const format = mimeType.includes('webm') ? 'webm' : 'mp4';
              // Short-segment filter: duration proxy ~130 wpm → 1 word ≈ 460ms.
              // - < 300ms (< 1 word): always skip — pure noise
              // - 300–900ms: send as potential control command ("stop", "go", "cancel", "yes", "no")
              // - 900–1380ms: skip — too long for a control word, too short for a real sentence (mid-sentence noise)
              // - > 1380ms (3+ words): always send
              const estimatedWords = Math.round(duration / 460);
              if (estimatedWords < 1) {
                vadSendingRef.current = false;
                return;
              }
              if (estimatedWords < 3 && duration > 900) {
                console.log('[VoiceButton] VAD: borderline segment, skipping', { ms: duration, estimatedWords });
                vadSendingRef.current = false;
                return;
              }
              console.log('[VoiceButton] VAD: sending speech segment', { ms: duration, bytes: blob.size, estimatedWords });
              ipcRenderer?.send('voice:audio-chunk', {
                audioBase64: base64,
                format,
                pushToTalk: false,
                skipWakeWordCheck: true,  // user clicked mic on — the click IS the wake signal
              });
              // vadSendingRef.current stays true until voice:response arrives (pipeline done)
              // This prevents double-sends from VAD re-triggering on the tail of the same utterance.
              // Safety fallback: if pipeline crashes and voice:response never comes, unlock after 15s
              setTimeout(() => { vadSendingRef.current = false; }, 15000);
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

  // Backtick PTT is handled globally by main.js (globalShortcut) via voice:ptt-start/stop IPC.
  // No renderer-side keydown listener needed — avoids double-firing when window is focused.

  // ── Button interaction: click = toggle always-on STT/TTS ──────────────────
  const handleClick = () => toggleWakeWord();

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
  const isWWActive = wakeWordActive;
  const title = wakeWordActive
    ? 'Always-on STT active — click to deactivate · Hold ` (backtick) for push-to-talk'
    : 'Click to activate always-on STT/TTS · Hold ` for push-to-talk';

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
        onClick={handleClick}
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
            {voiceState === 'listening' ? (isPTTHeldRef.current ? 'listening…' : 'on') :
             voiceState === 'processing' ? '' :
             voiceState === 'speaking' ? '' :
             isWWActive ? 'on' : 'mic'}
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
