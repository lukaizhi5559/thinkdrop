import React, { useState, useEffect, useRef, useCallback } from 'react';
import VoiceButton from './VoiceButton';
import { playThinkDropSound } from '../utils/thinkDropSound';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface InstalledSkill {
  name: string;
  description: string;
  path: string;
}

export default function StandalonePromptCapture() {
  const [promptText, setPromptText] = useState('');
  const [highlights, setHighlights] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [isProcessing, setIsProcessing] = useState(false);

  // PTT speech-to-textarea state
  const [isPTTActive, setIsPTTActive] = useState(false);
  const pttHeldRef = useRef(false);
  const pttStopRequestedRef = useRef(false);
  const pttMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const pttAudioChunksRef = useRef<Blob[]>([]);
  const pttStreamRef = useRef<MediaStream | null>(null);

  // gatherContext intercept — when true, submit routes to gather:answer instead of stategraph:process
  const [gatherPending, setGatherPending] = useState(false);

  // Skills Manager state
  const [showSkillsPanel, setShowSkillsPanel] = useState(false);
  const skillsTab = 'shortcuts' as const;
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [deletingSkill, setDeletingSkill] = useState<string | null>(null);
  const [confirmDeleteSkill, setConfirmDeleteSkill] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleAddHighlight = (_event: any, text: string) => {
    console.log('📥 [STANDALONE_PROMPT] Received highlight:', text);
    
    setHighlights(prev => {
      if (prev.includes(text)) {
        console.log('⏭️ [STANDALONE_PROMPT] Duplicate highlight ignored');
        return prev;
      }
      
      setTimeout(() => requestWindowResize(), 100);
      return [...prev, text];
    });
  };

  useEffect(() => {
    if (!ipcRenderer) return;

    const handleShow = (_event: any, data: { position?: { x: number; y: number } }) => {
      console.log('📥 [STANDALONE_PROMPT] Window shown at position:', data?.position);
      
      setHighlights([]);
      setPromptText('');
      
      setTimeout(() => {
        textareaRef.current?.focus();
        console.log('✅ [STANDALONE_PROMPT] Textarea focused');
      }, 300);
    };

    const handleProgress = (_event: any, data: any) => {
      if (data?.type === 'all_done') setIsProcessing(false);
    };

    const handleBridgeMessage = (_event: any, msg: any) => {
      if (msg?.type === 'done' || msg?.type === 'llm_stream_end') setIsProcessing(false);
    };

    // Voice inject: clear textarea + show processing ring. Do NOT populate the text input.
    const handleVoiceInjectPrompt = (_event: any) => {
      playThinkDropSound();
      setPromptText('');
      setHighlights([]);
      setIsProcessing(true);
    };

    // Voice done (response received): stop processing ring
    const handleVoiceResponse = () => {
      setIsProcessing(false);
    };

    const handleSkillListResponse = (_event: any, { skills: list }: { skills: InstalledSkill[] }) => {
      setSkills(list || []);
      setSkillsLoading(false);
    };

    const handleSkillDeleteResponse = (_event: any, { ok, name, error }: { ok: boolean; name?: string; error?: string }) => {
      setDeletingSkill(null);
      if (ok && name) {
        setSkills(prev => prev.filter(s => s.name !== name));
        setDeleteError(null);
      } else {
        setDeleteError(error || 'Delete failed');
      }
    };

    // needs_skill auto-trigger: skill:store-trigger is now handled by ResultsWindow
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const handleSkillStoreTrigger = (_event: any, _data: any) => {};

    // gatherContext active: route submit to gather:answer instead of stategraph:process
    const handleGatherPending = (_event: any, { active }: { active: boolean }) => {
      setGatherPending(active);
    };

    // command_automate queued: task is now running in background — return to normal
    const handleQueueStarted = () => {
      setIsProcessing(false);
    };

    ipcRenderer.on('prompt-capture:show', handleShow);
    ipcRenderer.on('prompt-capture:add-highlight', handleAddHighlight);
    ipcRenderer.on('automation:progress', handleProgress);
    ipcRenderer.on('ws-bridge:message', handleBridgeMessage);
    ipcRenderer.on('voice:inject-prompt', handleVoiceInjectPrompt);
    ipcRenderer.on('voice:response', handleVoiceResponse);
    ipcRenderer.on('skill:list-response', handleSkillListResponse);
    ipcRenderer.on('skill:delete-response', handleSkillDeleteResponse);
    ipcRenderer.on('skill:store-trigger', handleSkillStoreTrigger);
    ipcRenderer.on('queue:started', handleQueueStarted);
    ipcRenderer.on('gather:pending', handleGatherPending);

    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('prompt-capture:show', handleShow);
        ipcRenderer.removeListener('prompt-capture:add-highlight', handleAddHighlight);
        ipcRenderer.removeListener('automation:progress', handleProgress);
        ipcRenderer.removeListener('ws-bridge:message', handleBridgeMessage);
        ipcRenderer.removeListener('voice:inject-prompt', handleVoiceInjectPrompt);
        ipcRenderer.removeListener('voice:response', handleVoiceResponse);
        ipcRenderer.removeListener('skill:list-response', handleSkillListResponse);
        ipcRenderer.removeListener('skill:delete-response', handleSkillDeleteResponse);
        ipcRenderer.removeListener('skill:store-trigger', handleSkillStoreTrigger);
        ipcRenderer.removeListener('queue:started', handleQueueStarted);
        ipcRenderer.removeListener('gather:pending', handleGatherPending);
      }
    };
  }, []);

  const loadSkills = useCallback(() => {
    if (!ipcRenderer) return;
    setSkillsLoading(true);
    setDeleteError(null);
    ipcRenderer.send('skill:list');
  }, []);

  const handleDeleteSkill = useCallback((name: string) => {
    if (!ipcRenderer || deletingSkill) return;
    setDeletingSkill(name);
    setDeleteError(null);
    ipcRenderer.send('skill:delete', { name });
  }, [deletingSkill]);

  const toggleSkillsPanel = useCallback(() => {
    setShowSkillsPanel(prev => {
      const next = !prev;
      if (next) loadSkills();
      else setDeleteError(null);
      return next;
    });
    setTimeout(() => requestWindowResize(), 120);
  }, [loadSkills]);

  useEffect(() => {
    requestWindowResize();
  }, [highlights, promptText, showSkillsPanel, skillsTab]);

  // Stable ref to submit function so the PTT closure can call it after release
  const submitPTTRef = useRef<(text: string, responseLanguage?: string | null) => void>(() => {});

  // ── Prime mic permission on mount so enumerateDevices() returns labels ──────
  // Without this, device labels are empty until after the first getUserMedia call,
  // meaning the built-in mic preference logic won't work on the first PTT press.
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(s => s.getTracks().forEach(t => t.stop()))
      .catch(() => {});
  }, []);

  // ── Backtick PTT: record mic → Whisper STT → put text in textarea → submit ──
  useEffect(() => {
    const doStop = (recorder: MediaRecorder) => {
      recorder.onstop = async () => {
        // Stop mic tracks
        pttStreamRef.current?.getTracks().forEach(t => t.stop());
        pttStreamRef.current = null;
        pttMediaRecorderRef.current = null;

        const chunks = pttAudioChunksRef.current;
        pttAudioChunksRef.current = [];
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type: mimeType });
        console.log('[PTT] Recording stopped, blob size:', blob.size);

        if (blob.size < 1000) {
          setPromptText('');
          return;
        }

        setPromptText('⏳ Transcribing…');

        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(blob);
        });

        const format = mimeType.includes('webm') ? 'webm' : 'mp4';
        ipcRenderer?.send('voice:audio-chunk', {
          audioBase64: base64,
          format,
          pushToTalk: true,
          pttTextOnly: true,
        });
      };

      try { recorder.stop(); } catch (_) {}
    };

    const startPTT = async () => {
      if (pttHeldRef.current) return;
      pttHeldRef.current = true;
      pttStopRequestedRef.current = false;
      pttAudioChunksRef.current = [];
      setIsPTTActive(true);
      setPromptText('Listening…');

      try {
        // Prefer built-in internal mic over Bluetooth (AirPods etc.)
        // AirPod mic uses BT SCO (~8-16kHz) which degrades Whisper accuracy.
        const stream = await (async () => {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');
            const builtIn = audioInputs.find(d =>
              /built.?in|internal|macbook|imic/i.test(d.label)
            );
            const constraints: MediaStreamConstraints = {
              audio: {
                deviceId: builtIn ? { ideal: builtIn.deviceId } : undefined,
                sampleRate: { ideal: 16000 },
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              }
            };
            return await navigator.mediaDevices.getUserMedia(constraints);
          } catch {
            return await navigator.mediaDevices.getUserMedia({ audio: true });
          }
        })();
        pttStreamRef.current = stream;

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm')
            ? 'audio/webm'
            : 'audio/mp4';

        const recorder = new MediaRecorder(stream, { mimeType });
        pttMediaRecorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) pttAudioChunksRef.current.push(e.data);
        };

        recorder.start();
        console.log('[PTT] Recording started');

        // Handle race: key released before getUserMedia resolved
        if (pttStopRequestedRef.current) {
          console.log('[PTT] Stop was requested before recorder ready — stopping now');
          doStop(recorder);
        }
      } catch (err) {
        console.error('[PTT] Failed to start recording:', err);
        pttHeldRef.current = false;
        pttStopRequestedRef.current = false;
        setIsPTTActive(false);
        setPromptText('');
      }
    };

    const stopPTT = () => {
      if (!pttHeldRef.current) return;
      pttHeldRef.current = false;
      pttStopRequestedRef.current = true;
      setIsPTTActive(false);

      const recorder = pttMediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        console.log('[PTT] Recorder not ready yet — flagged for stop after start');
        return;
      }

      doStop(recorder);
    };

    // Keyboard listeners (when window has focus)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '`' || e.repeat) return;
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT') return;
      e.preventDefault();
      startPTT();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== '`') return;
      e.preventDefault();
      stopPTT();
    };

    // IPC: transcript comes back from main.js after Whisper STT
    const handleTranscript = (_evt: any, { transcript, detectedLanguage, wasTranslated }: { transcript: string; detectedLanguage?: string; wasTranslated?: boolean }) => {
      console.log('[PTT] Transcript received:', transcript, detectedLanguage ? `(lang: ${detectedLanguage})` : '');
      if (transcript?.trim()) {
        playThinkDropSound();
        setPromptText(transcript.trim());
        const lang = (wasTranslated && detectedLanguage && detectedLanguage !== 'en') ? detectedLanguage : null;
        setTimeout(() => submitPTTRef.current(transcript.trim(), lang), 80);
      } else {
        setPromptText('');
      }
    };

    // IPC listeners (globalShortcut toggle fires when window is not focused)
    const handleIPCStart = () => startPTT();
    const handleIPCStop = () => stopPTT();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    ipcRenderer?.removeAllListeners?.('voice:ptt-start');
    ipcRenderer?.removeAllListeners?.('voice:ptt-stop');
    ipcRenderer?.removeAllListeners?.('ptt:transcript');
    ipcRenderer?.on('voice:ptt-start', handleIPCStart);
    ipcRenderer?.on('voice:ptt-stop', handleIPCStop);
    ipcRenderer?.on('ptt:transcript', handleTranscript);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      ipcRenderer?.removeListener?.('voice:ptt-start', handleIPCStart);
      ipcRenderer?.removeListener?.('voice:ptt-stop', handleIPCStop);
      ipcRenderer?.removeListener?.('ptt:transcript', handleTranscript);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async () => {
    console.log('🚀 [STANDALONE_PROMPT] handleSubmit called');
    
    if (!promptText.trim() && highlights.length === 0) {
      console.log('⚠️ [STANDALONE_PROMPT] No text or highlights, skipping submit');
      return;
    }

    playThinkDropSound();
    
    let finalPrompt = '';
    
    if (highlights.length > 0) {
      finalPrompt = highlights.map(h =>
        (h.startsWith('[File:') || h.startsWith('[Folder:')) ? h : `[Highlighted: ${h}]`
      ).join('\n') + '\n\n';
    }
    
    finalPrompt += promptText;
    
    const MAX_MESSAGE_LENGTH = 50000;
    if (finalPrompt.trim().length > MAX_MESSAGE_LENGTH) {
      console.error(`❌ [STANDALONE_PROMPT] Message too long: ${finalPrompt.length} chars`);
      
      const errorMessage = 
        `⚠️ Message Too Long\n\n` +
        `Your message is ${finalPrompt.length.toLocaleString()} characters, but the limit is ${MAX_MESSAGE_LENGTH.toLocaleString()}.\n\n` +
        `Please try:\n` +
        `• Remove some highlight tags by clicking the × button\n` +
        `• Highlight a smaller section of code\n` +
        `• Break your question into multiple parts`;
      
      if (ipcRenderer) {
        ipcRenderer.send('results-window:show-error', errorMessage);
      }
      return;
    }
    
    console.log('📤 [STANDALONE_PROMPT] Final prompt to send:', finalPrompt.trim());
    console.log('🔍 [STANDALONE_PROMPT] ipcRenderer available?', !!ipcRenderer);
    
    if (ipcRenderer) {
      if (gatherPending) {
        // gatherContext is waiting for an answer — route directly to gather:answer
        console.log('📋 [STANDALONE_PROMPT] gather:pending active — routing to gather:answer');
        ipcRenderer.send('gather:answer', { answer: finalPrompt.trim() });
        setGatherPending(false);
      } else {
        // Route through the serial prompt queue (printer-queue model)
        // Submit is always unblocked — queue handles serialization
        console.log('🧠 [STANDALONE_PROMPT] Enqueuing prompt via prompt-queue:submit');
        ipcRenderer.send('prompt-queue:submit', {
          prompt: finalPrompt.trim(),
          selectedText: highlights.join('\n'),
        });
        console.log('✅ [STANDALONE_PROMPT] Prompt enqueued');
      }
    } else {
      console.error('❌ [STANDALONE_PROMPT] ipcRenderer is not available!');
    }
    
    setPromptText('');
    setHighlights([]);
    console.log('✅ [STANDALONE_PROMPT] Submit complete, waiting for results');
  };

  // PTT is STT-only: submits the spoken text as a regular prompt via stategraph:process.
  // No TTS — response appears in the results window as text, same as typing and pressing Enter.
  submitPTTRef.current = (text: string, responseLanguage: string | null = null) => {
    if (!text.trim()) return;
    console.log('[PTT] Submitting via prompt-queue:submit:', text, responseLanguage ? `(respond in: ${responseLanguage})` : '');
    let finalPrompt = '';
    if (highlights.length > 0) finalPrompt = highlights.map((h: string) =>
      (h.startsWith('[File:') || h.startsWith('[Folder:')) ? h : `[Highlighted: ${h}]`
    ).join('\n') + '\n\n';
    finalPrompt += text.trim();
    ipcRenderer?.send('prompt-queue:submit', { prompt: finalPrompt, selectedText: highlights.join('\n'), responseLanguage });
    setPromptText('');
    setHighlights([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      if (ipcRenderer) {
        ipcRenderer.send('prompt-capture:hide');
      }
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPromptText(e.target.value);
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
    
    requestWindowResize();
  };
  
  const removeHighlight = (index: number) => {
    setHighlights(prev => prev.filter((_, i) => i !== index));
    setTimeout(() => requestWindowResize(), 100);
  };
  
  const requestWindowResize = () => {
    if (!ipcRenderer || !containerRef.current) return;
    
    setTimeout(() => {
      if (!containerRef.current) return;
      
      const rect = containerRef.current.getBoundingClientRect();
      const contentHeight = Math.ceil(rect.height);
      const contentWidth = Math.ceil(rect.width);
      
      const panelOpen = showSkillsPanel;
      const maxH = panelOpen ? 740 : 600;
      const maxW = panelOpen ? 700 : 600;
      const targetHeight = Math.min(Math.max(contentHeight, 120), maxH);
      const targetWidth = Math.min(Math.max(contentWidth, 400), maxW);
      
      console.log(`📐 [STANDALONE_PROMPT] Requesting resize to ${targetWidth}x${targetHeight}`);
      ipcRenderer.send('prompt-capture:resize', { width: targetWidth, height: targetHeight });
    }, 50);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!ipcRenderer) return;
    
    setIsDragging(true);
    const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top
    };
    console.log('🖱️ [STANDALONE_PROMPT] Drag started');
  };

  useEffect(() => {
    if (!isDragging || !ipcRenderer) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newX = Math.round(e.screenX - dragOffset.current.x);
      const newY = Math.round(e.screenY - dragOffset.current.y);
      if (!Number.isFinite(newX) || !Number.isFinite(newY)) return;
      ipcRenderer.send('prompt-capture:move', { x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      console.log('🖱️ [STANDALONE_PROMPT] Drag ended');
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    files.forEach(file => {
      const path = (file as any).path as string | undefined;
      if (!path) return;
      // Folders dropped from Finder have size 0 and no lastModified in some cases,
      // but the most reliable signal in Electron is file.size === 0 AND no extension.
      const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(path.split('/').pop() || '');
      const isFolder = (file.size === 0 && !hasExtension) || file.type === '';
      if (isFolder) {
        handleAddHighlight(null, `[Folder: ${path}]`);
      } else {
        handleAddHighlight(null, `[File: ${path}]`);
      }
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  return (
    <div className="w-full h-full flex items-center justify-center">
      <style>{`
        @keyframes prompt-border-sweep {
          0%   { --prompt-angle: 0deg; }
          100% { --prompt-angle: 360deg; }
        }
        @property --prompt-angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }
        @keyframes think-breathe {
          0%, 100% { opacity: 0.55; }
          50%       { opacity: 1; }
        }
        .prompt-glow-ring {
          position: absolute;
          inset: -1px;
          border-radius: 13px;
          padding: 1.5px;
          background: conic-gradient(from var(--prompt-angle), transparent 65%, #3b82f6 82%, #60a5fa 88%, #3b82f6 94%, transparent);
          animation: prompt-border-sweep 2.4s linear infinite;
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          pointer-events: none;
          z-index: 20;
          opacity: 0;
          transition: opacity 0.4s ease;
        }
        .prompt-glow-ring.active {
          opacity: 1;
        }
        .prompt-glow-ring.ptt {
          background: conic-gradient(from var(--prompt-angle), transparent 60%, #10b981 78%, #34d399 86%, #10b981 93%, transparent);
          animation: prompt-border-sweep 1.4s linear infinite;
          opacity: 1;
        }
        .prompt-glow-ring.thinking {
          background: conic-gradient(from var(--prompt-angle), transparent 40%, #6366f1 65%, #a78bfa 78%, #818cf8 88%, #6366f1 95%, transparent);
          animation: prompt-border-sweep 3.2s linear infinite, think-breathe 1.6s ease-in-out infinite;
          opacity: 1;
        }
        .prompt-glow-ring.gathering {
          background: conic-gradient(from var(--prompt-angle), transparent 60%, #f59e0b 78%, #fbbf24 86%, #f59e0b 93%, transparent);
          animation: prompt-border-sweep 1.8s linear infinite;
          opacity: 1;
        }
      `}</style>
      <div style={{ position: 'relative' }}>
        <div className={`prompt-glow-ring${isPTTActive ? ' ptt' : gatherPending ? ' gathering' : isProcessing ? ' thinking' : ''}`} />
        <div
          ref={containerRef}
          className="rounded-xl shadow-2xl backdrop-blur-md"
          onDrop={handleFileDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          style={{
            backgroundColor: 'rgba(23, 23, 23, 0.95)',
            border: isDragOver ? '1px solid rgba(59, 130, 246, 0.6)' : gatherPending ? '1px solid rgba(245, 158, 11, 0.4)' : '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: isDragOver ? '0 0 0 2px rgba(59, 130, 246, 0.2)' : gatherPending ? '0 0 0 2px rgba(245, 158, 11, 0.1)' : undefined,
            minWidth: '400px',
            maxWidth: '600px',
            maxHeight: '600px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            position: 'relative',
            zIndex: 1,
          }}
        >
        <div
          onMouseDown={handleMouseDown}
          className="px-4 py-2 pt-2 border-b flex items-center justify-between"
          style={{
            borderColor: 'rgba(255, 255, 255, 0.08)',
            cursor: isDragging ? 'grabbing' : 'grab',
            userSelect: 'none',
            flex: '0 0 auto',
            position: 'sticky',
            top: 0,
            backgroundColor: 'rgba(23, 23, 23, 0.95)',
            zIndex: 10,
          }}
        >
          <div style={{ display: 'flex', gap: '4px' }}>
            <div style={{ width: '3px', height: '3px', borderRadius: '50%', backgroundColor: 'rgba(255, 255, 255, 0.3)' }} />
            <div style={{ width: '3px', height: '3px', borderRadius: '50%', backgroundColor: 'rgba(255, 255, 255, 0.3)' }} />
            <div style={{ width: '3px', height: '3px', borderRadius: '50%', backgroundColor: 'rgba(255, 255, 255, 0.3)' }} />
          </div>
        </div>
        <div style={{ flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden' }}>
          <div className="p-4">
            {highlights.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                {highlights.map((highlight, index) => {
                  // Detect tag type for icon + label
                  const fileMatch = highlight.match(/^\[File:\s*(.+)\]$/);
                  const folderMatch = highlight.match(/^\[Folder:\s*(.+)\]$/);
                  const isFile = !!fileMatch;
                  const isFolder = !!folderMatch;
                  const isApp = highlight.match(/^\[File:.*\.app\]$/);

                  let label: string;
                  let chipColor: string;
                  let borderColor: string;
                  let icon: React.ReactNode;

                  if (isFolder) {
                    const fullPath = folderMatch![1].trim();
                    const folderName = fullPath.split('/').pop() || fullPath;
                    label = folderName;
                    chipColor = 'rgba(251, 191, 36, 0.12)';
                    borderColor = 'rgba(251, 191, 36, 0.35)';
                    icon = (
                      // Folder icon
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    );
                  } else if (isFile) {
                    const fullPath = fileMatch![1].trim();
                    const fileName = fullPath.split('/').pop() || fullPath;
                    label = fileName;
                    chipColor = isApp ? 'rgba(139, 92, 246, 0.15)' : 'rgba(59, 130, 246, 0.15)';
                    borderColor = isApp ? 'rgba(139, 92, 246, 0.35)' : 'rgba(59, 130, 246, 0.3)';
                    icon = isApp ? (
                      // App icon
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="3" />
                        <path d="M9 9h6M9 12h6M9 15h4" />
                      </svg>
                    ) : (
                      // File icon
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    );
                  } else {
                    // Text highlight — show first ~24 chars
                    const words = highlight.replace(/\s+/g, ' ').trim();
                    label = words.length > 24 ? words.slice(0, 24) + '…' : words;
                    chipColor = 'rgba(16, 185, 129, 0.12)';
                    borderColor = 'rgba(16, 185, 129, 0.3)';
                    icon = (
                      // Quote/text icon
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
                        <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
                      </svg>
                    );
                  }

                  const iconColor = isFolder ? '#fbbf24' : isApp ? '#c4b5fd' : isFile ? '#93c5fd' : '#6ee7b7';

                  return (
                    <div
                      key={index}
                      title={highlight}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '3px 7px',
                        backgroundColor: chipColor,
                        border: `1px solid ${borderColor}`,
                        borderRadius: '6px',
                        fontSize: '0.72rem',
                        color: iconColor,
                        maxWidth: '180px',
                      }}
                    >
                      <span style={{ flexShrink: 0, opacity: 0.85 }}>{icon}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {label}
                      </span>
                      <button
                        onClick={() => removeHighlight(index)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          width: '13px',
                          height: '13px',
                          padding: 0,
                          border: 'none',
                          backgroundColor: 'transparent',
                          color: iconColor,
                          cursor: 'pointer',
                          fontSize: '13px',
                          lineHeight: 1,
                          opacity: 0.7,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                        onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <textarea
                ref={textareaRef}
                value={promptText}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                onFocus={() => ipcRenderer?.send('ptt:input-focus')}
                onBlur={() => ipcRenderer?.send('ptt:input-blur')}
                placeholder={gatherPending ? 'Type your answer here and press Enter…' : 'Ask anything'}
                className="text-sm whitespace-pre-wrap break-words resize-none focus:outline-none"
                style={{
                  color: '#e5e7eb',
                  backgroundColor: 'transparent',
                  border: 'none',
                  outline: 'none',
                  boxShadow: 'none',
                  minHeight: '25px',
                  maxHeight: '400px',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  flex: 1,
                  padding: '5px',
                  margin: 0,
                }}
                rows={1}
                autoFocus
              />
              
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '24px',
                  height: '24px',
                  borderRadius: '4px',
                  backgroundColor: isProcessing
                    ? 'rgba(255, 255, 255, 0.07)'
                    : (promptText.trim() || highlights.length > 0) ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid',
                  borderColor: isProcessing
                    ? 'rgba(255, 255, 255, 0.15)'
                    : (promptText.trim() || highlights.length > 0) ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                  flexShrink: 0,
                  marginTop: '2px',
                  cursor: (isProcessing || promptText.trim() || highlights.length > 0) ? 'pointer' : 'default',
                  transition: 'background-color 0.15s, border-color 0.15s',
                }}
                title={isProcessing ? 'Cancel' : 'Send'}
                onClick={isProcessing ? () => ipcRenderer?.send('automation:cancel') : (promptText.trim() || highlights.length > 0) ? handleSubmit : undefined}
              >
                {isProcessing ? (
                  /* Stop square — like ChatGPT/Windsurf cancel */
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="#9ca3af">
                    <rect x="0" y="0" width="10" height="10" rx="2" />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={(promptText.trim() || highlights.length > 0) ? '#60a5fa' : '#6b7280'}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 10l-5 5 5 5" />
                    <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                  </svg>
                )}
              </div>
            </div>
          </div>
        </div>
        
        <div
          style={{
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            position: 'sticky',
            bottom: 0,
            backgroundColor: 'rgba(23, 23, 23, 0.95)',
            zIndex: 10,
          }}
        >
          {/* Voice button — flush left */}
          <VoiceButton mode="push-to-talk" compact={false} />

          {/* File picker button — click to open native file dialog */}
          <button
            title="Click to select a file or folder to tag as context. You can also drag files directly onto this window."
            onClick={() => ipcRenderer?.send('prompt-capture:pick-file')}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '4px 8px', borderRadius: '6px',
              backgroundColor: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              color: '#9ca3af', cursor: 'pointer', fontSize: '0.7rem',
              userSelect: 'none',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(59,130,246,0.12)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(59,130,246,0.3)';
              (e.currentTarget as HTMLButtonElement).style.color = '#93c5fd';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.04)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.07)';
              (e.currentTarget as HTMLButtonElement).style.color = '#9ca3af';
            }}
          >
            {/* Folder open icon */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Attach file</span>
          </button>

          {/* Skills Manager gear button — flush right */}
          <button
            title="Manage installed skills"
            onClick={toggleSkillsPanel}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', 
              width: '26px', height: '26px', borderRadius: '6px',
              backgroundColor: showSkillsPanel ? 'rgba(139,92,246,0.18)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${showSkillsPanel ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.07)'}`,
              color: showSkillsPanel ? '#c4b5fd' : '#9ca3af',
              cursor: 'pointer', flexShrink: 0, marginLeft: 'auto',
            }}
            onMouseEnter={e => {
              if (!showSkillsPanel) {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(139,92,246,0.12)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(139,92,246,0.3)';
                (e.currentTarget as HTMLButtonElement).style.color = '#c4b5fd';
              }
            }}
            onMouseLeave={e => {
              if (!showSkillsPanel) {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.04)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.07)';
                (e.currentTarget as HTMLButtonElement).style.color = '#9ca3af';
              }
            }}
          >
            {/* Gear icon */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>

        </div>

        {/* ── Skills Manager Panel ──────────────────────────────────────── */}
        {showSkillsPanel && (
          <div style={{
            borderTop: '1px solid rgba(139,92,246,0.2)',
            backgroundColor: 'rgba(18,18,22,0.98)',
            padding: '10px 12px',
          }}>
            {/* Settings header */}
            <div style={{ fontSize: '0.6rem', color: '#6b7280', marginBottom: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}
            >
              Settings
            </div>

            {/* Shortcuts tab */}
            {skillsTab === 'shortcuts' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {([
                  {
                    keys: [
                      { content: <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="5,1 9,6 7,6 7,9 3,9 3,6 1,6"/></svg> },
                      { content: <span style={{ fontSize: '0.6rem', fontWeight: 600 }}>Ctrl/⌘</span> },
                      { content: <span style={{ fontSize: '0.68rem', fontWeight: 600 }}>C</span> },
                    ],
                    label: 'Tag selection as context',
                    desc: 'Copy text or a file path first, then trigger to attach it as context.',
                  },
                  {
                    keys: [
                      { content: <span style={{ fontSize: '0.68rem', fontWeight: 600 }}>`</span> },
                    ],
                    label: 'Toggle voice input',
                    desc: 'Hold backtick to record voice. Release to transcribe and fill the prompt.',
                  },
                  {
                    keys: [
                      { content: <span style={{ fontSize: '0.68rem', fontWeight: 600 }}>Enter</span> },
                    ],
                    label: 'Submit prompt',
                    desc: 'Send the current prompt to ThinkDrop. Use Shift+Enter for a newline.',
                  },
                  {
                    keys: [
                      { content: <span style={{ fontSize: '0.68rem', fontWeight: 600 }}>Esc</span> },
                    ],
                    label: 'Hide window',
                    desc: 'Dismiss the prompt capture window without submitting.',
                  },
                  {
                    keys: [
                      { content: <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="5,1 9,6 7,6 7,9 3,9 3,6 1,6"/></svg> },
                      { content: <span style={{ fontSize: '0.6rem', fontWeight: 600 }}>Ctrl/⌘</span> },
                      { content: <span style={{ fontSize: '0.68rem', fontWeight: 600 }}>T</span> },
                    ],
                    label: 'Show / hide ThinkDrop',
                    desc: 'Global hotkey to bring the prompt window into focus from anywhere.',
                  },
                ]).map(({ keys, label, desc }, idx) => (
                  <div key={idx} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '7px 9px', borderRadius: 8,
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}>
                    {/* Key badges */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, marginTop: 1 }}>
                      {keys.map((k, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            minWidth: '20px', height: '18px', padding: '0 5px', borderRadius: 4,
                            backgroundColor: 'rgba(255,255,255,0.08)', color: '#c9d1d9',
                            fontSize: '0.68rem',
                          }}>
                            {k.content}
                          </span>
                          {i < keys.length - 1 && (
                            <span style={{ color: '#4b5563', fontSize: '0.6rem' }}>+</span>
                          )}
                        </span>
                      ))}
                    </div>
                    {/* Description */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#c4b5fd', fontSize: '0.7rem', fontWeight: 600, marginBottom: 2 }}>{label}</div>
                      <div style={{ color: '#6b7280', fontSize: '0.64rem', lineHeight: 1.4 }}>{desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Installed tab — moved to ResultsWindow Skills tab */}
            {false && (<div>

            {deleteError && (
              <div style={{ color: '#f87171', fontSize: '0.7rem', marginBottom: 6, padding: '4px 8px', borderRadius: 5, backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                {deleteError}
              </div>
            )}

            {skillsLoading ? (
              <div style={{ color: '#6b7280', fontSize: '0.72rem', padding: '6px 0' }}>Loading…</div>
            ) : skills.length === 0 ? (
              <div style={{ color: '#4b5563', fontSize: '0.72rem', padding: '6px 0' }}>No installed skills found in ~/.thinkdrop/skills/</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {skills.map(skill => (
                  <div
                    key={skill.name}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      padding: '5px 8px', borderRadius: '7px',
                      backgroundColor: deletingSkill === skill.name ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${deletingSkill === skill.name ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.06)'}`,
                      transition: 'background-color 0.15s, border-color 0.15s',
                    }}
                  >
                    {/* Skill icon */}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
                      <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                    </svg>
                    {/* Name + description */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span
                        title={`Open ${skill.path} in Finder`}
                        onClick={() => ipcRenderer?.send('shell:open-path', skill.path)}
                        style={{
                          color: '#c4b5fd', fontSize: '0.75rem', fontWeight: 500,
                          fontFamily: 'ui-monospace, monospace', cursor: 'pointer',
                          textDecoration: 'underline', textDecorationColor: 'rgba(196,181,253,0.35)',
                          textUnderlineOffset: '2px',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#ddd6fe')}
                        onMouseLeave={e => (e.currentTarget.style.color = '#c4b5fd')}
                      >
                        {skill.name}
                      </span>
                      {skill.description && (
                        <span style={{ color: '#6b7280', fontSize: '0.68rem', marginLeft: 6 }}>
                          — {skill.description.length > 48 ? skill.description.slice(0, 48) + '…' : skill.description}
                        </span>
                      )}
                    </div>
                    {/* Delete: trash → confirm (check/x) → deleting spinner */}
                    {confirmDeleteSkill === skill.name ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
                        {/* Confirm ✓ */}
                        <button
                          title="Yes, delete"
                          onClick={() => { setConfirmDeleteSkill(null); handleDeleteSkill(skill.name); }}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: '22px', height: '22px', background: 'none',
                            border: '1px solid rgba(239,68,68,0.4)', borderRadius: '5px',
                            cursor: 'pointer', color: '#f87171',
                          }}
                          onMouseEnter={e => {
                            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(239,68,68,0.15)';
                          }}
                          onMouseLeave={e => {
                            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        </button>
                        {/* Cancel ✕ */}
                        <button
                          title="Cancel"
                          onClick={() => setConfirmDeleteSkill(null)}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: '22px', height: '22px', background: 'none',
                            border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px',
                            cursor: 'pointer', color: '#6b7280',
                          }}
                          onMouseEnter={e => {
                            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.07)';
                            (e.currentTarget as HTMLButtonElement).style.color = '#9ca3af';
                          }}
                          onMouseLeave={e => {
                            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                            (e.currentTarget as HTMLButtonElement).style.color = '#6b7280';
                          }}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                          </svg>
                        </button>
                      </div>
                    ) : deletingSkill === skill.name ? (
                      /* Spinner while deleting */
                      <div style={{ width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#f87171' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
                            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/>
                          </path>
                        </svg>
                      </div>
                    ) : (
                      /* Trash icon — first click shows confirm */
                      <button
                        title={`Remove ${skill.name}`}
                        onClick={() => setConfirmDeleteSkill(skill.name)}
                        disabled={!!deletingSkill}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          width: '22px', height: '22px', flexShrink: 0,
                          background: 'none', border: '1px solid transparent',
                          borderRadius: '5px', cursor: deletingSkill ? 'not-allowed' : 'pointer',
                          color: '#4b5563',
                          opacity: deletingSkill ? 0.35 : 1,
                          transition: 'color 0.12s, border-color 0.12s, background-color 0.12s',
                        }}
                        onMouseEnter={e => {
                          if (!deletingSkill) {
                            (e.currentTarget as HTMLButtonElement).style.color = '#f87171';
                            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(239,68,68,0.35)';
                            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(239,68,68,0.1)';
                          }
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLButtonElement).style.color = '#4b5563';
                          (e.currentTarget as HTMLButtonElement).style.borderColor = 'transparent';
                          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/>
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                          <path d="M10 11v6"/><path d="M14 11v6"/>
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
            )}
          </div>
        )}

        </div>
      </div>
    </div>
  );
}
