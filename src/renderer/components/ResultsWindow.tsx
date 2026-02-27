import React, { useEffect, useState, useRef } from 'react';
import { RichContentRenderer } from './rich-content';
import AutomationProgress from './AutomationProgress';
import { playDropSound } from '../utils/thinkDropSound';

const ipcRenderer = (window as any).electron?.ipcRenderer;

export default function ResultsWindow() {
  console.log('🎨 [RESULTS_WINDOW] Component rendering');
  
  const [promptText, setPromptText] = useState<string>('');
  const contentRef = useRef<HTMLDivElement>(null);
  
  const [streamingResponse, setStreamingResponse] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);

  // Automation mode: tracked inside AutomationProgress itself
  const [isAutomationMode, setIsAutomationMode] = useState(false);
  // Ref to prevent AutomationProgress from re-enabling automation mode once streaming starts
  const streamingStartedRef = useRef(false);
  
  const [isGlowActive, setIsGlowActive] = useState(false);
  const glowOffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [showTrigger, setShowTrigger] = useState(0);
  const [isDropping, setIsDropping] = useState(false);
  const hasDroppedRef = useRef(false);

  // Bridge listener status — shown as a persistent footer when watching, swaps to executing during auto-tasks
  const [bridgeStatus, setBridgeStatus] = useState<{
    state: 'watching' | 'executing' | 'stopped';
    bridgeFile?: string;
    summary?: string;
  } | null>(null);

  // Pending schedule notification (app was opened and a launchd schedule is registered)
  const [schedulePending, setSchedulePending] = useState<{
    id: string;
    label: string;
    targetTime: string;
    prompt: string;
  } | null>(null);

  // Install confirmation card state
  const [installPrompt, setInstallPrompt] = useState<{
    tool: string;
    installCmd: string;
    reason: string;
    source: string;
    toolDescription: string | null;
  } | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const installOutputRef = useRef<HTMLDivElement>(null);

  // Action chips: quick follow-up prompts shown after a response
  const [actionChips, setActionChips] = useState<string[]>([]);
  const scrollBottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when install card appears
  useEffect(() => {
    if (installPrompt) {
      setTimeout(() => {
        scrollBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }, 50);
    }
  }, [installPrompt]);

  useEffect(() => {
    if (!ipcRenderer) return;

    console.log('🔄 [RESULTS_WINDOW] Setting up VS Code Bridge IPC listeners');

    const handleBridgeConnected = () => {
      console.log('✅ [RESULTS_WINDOW] VS Code Bridge connected');
    };

    const handleBridgeDisconnected = () => {
      console.log('🔌 [RESULTS_WINDOW] VS Code Bridge disconnected');
    };

    const handleBridgeMessage = (_event: any, message: any) => {
      console.log('📨 [RESULTS_WINDOW] Bridge message:', message.type);
      
      // if (message.type === 'llm_stream_start') {
      //   setIsThinking(true);
      //   setIsStreaming(false);
      //   setStreamingResponse('');
      // }

      if (message.type === 'chunk' || message.type === 'llm_stream_chunk') {
        console.log('💬 [RESULTS_WINDOW] Stream token:', message);
        setIsThinking(false);
        setIsStreaming(true);
        if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
        setIsGlowActive(true);
        // Mark streaming started — keeps AutomationProgress visible (steps stay shown above)
        streamingStartedRef.current = true;
        // Drop sound + animation: stategraph lane or direct LLM stream (no lane = keyboard/backtick).
        // Fast lane voice replies are silent — the answer pops up instantly without a sound cue.
        if (!hasDroppedRef.current && message.lane !== 'fast') {
          hasDroppedRef.current = true;
          playDropSound();
          setIsDropping(true);
          setTimeout(() => setIsDropping(false), 600);
        }

        const msgText = message?.text || message.payload?.text || '';
        if (msgText.startsWith('\x00REPLACE\x00')) {
          setStreamingResponse(msgText.slice('\x00REPLACE\x00'.length));
        } else {
          setStreamingResponse(prev => prev + msgText);
        }
      } else if (message.type === 'done' || message.type === 'llm_stream_end') {
        setIsStreaming(false);
        setIsThinking(false);
        console.log('✅ [RESULTS_WINDOW] Streaming complete');
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 300);
      } else if (message.type === 'ready') {
        console.log('✅ [RESULTS_WINDOW] VS Code extension ready');
      }
    };

    const handleBridgeError = (_event: any, error: string) => {
      console.error('❌ [RESULTS_WINDOW] Bridge error:', error);
      setIsThinking(false);
      setIsStreaming(false);
      setStreamingResponse(`❌ Error: ${error}`);
    };

    // Remove any stale listeners before adding new ones (handles React StrictMode double-invoke)
    ipcRenderer.removeAllListeners('ws-bridge:connected');
    ipcRenderer.removeAllListeners('ws-bridge:disconnected');
    ipcRenderer.removeAllListeners('ws-bridge:message');
    ipcRenderer.removeAllListeners('ws-bridge:error');

    ipcRenderer.on('ws-bridge:connected', handleBridgeConnected);
    ipcRenderer.on('ws-bridge:disconnected', handleBridgeDisconnected);
    ipcRenderer.on('ws-bridge:message', handleBridgeMessage);
    ipcRenderer.on('ws-bridge:error', handleBridgeError);

    // Request connection on mount
    ipcRenderer.send('ws-bridge:connect');

    return () => {
      ipcRenderer.removeAllListeners('ws-bridge:connected');
      ipcRenderer.removeAllListeners('ws-bridge:disconnected');
      ipcRenderer.removeAllListeners('ws-bridge:message');
      ipcRenderer.removeAllListeners('ws-bridge:error');
    };
  }, []);

  useEffect(() => {
    if (!ipcRenderer) return;

    const handleDisplayError = (_event: any, errorMessage: string) => {
      console.log('⚠️ [RESULTS_WINDOW] Displaying error message:', errorMessage);
      setIsThinking(false);
      setIsStreaming(false);
      setStreamingResponse(errorMessage);
    };

    const handlePromptText = async (_event: any, text: string) => {
      console.log('📝 [RESULTS_WINDOW] Received prompt text:', text);
      
      if (!text || text.trim().length === 0) {
        console.warn('⚠️ [RESULTS_WINDOW] Empty message ignored');
        return;
      }
      
      // Reset all state for new prompt
      streamingStartedRef.current = false;
      hasDroppedRef.current = false;
      setInstallOutput([]);
      setPromptText(text);
      setStreamingResponse('');
      setIsStreaming(false);
      setIsThinking(true);
      setIsAutomationMode(false); // AutomationProgress will self-activate on 'planning' event
      if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
      setIsGlowActive(true);
      
      console.log('✅ [RESULTS_WINDOW] Ready to receive response for:', text.substring(0, 50));
    };

    // When the window is re-shown, bump showTrigger to re-measure content height
    const handleWindowShow = () => {
      console.log('📐 [RESULTS_WINDOW] Window shown - triggering content resize');
      setShowTrigger(prev => prev + 1);
    };

    const handleAutomationProgress = (_event: any, data: any) => {
      if (data?.type === 'planning') {
        // Automation started — clear the thinking spinner (AutomationProgress takes over)
        setIsThinking(false);
        setIsAutomationMode(true);
        setInstallPrompt(null);
        setActionChips([]);
        if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
        setIsGlowActive(true);
      } else if (data?.type === 'needs_install') {
        // Pause plan — show install confirmation card
        setInstallPrompt({
          tool: data.tool,
          installCmd: data.installCmd,
          reason: data.reason,
          source: data.source || 'brew',
          toolDescription: data.toolDescription || null,
        });
        setIsInstalling(false);
        if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
        setIsGlowActive(true);
      } else if (data?.type === 'install_output') {
        setInstallOutput(prev => {
          const next = [...prev, data.line];
          return next.length > 200 ? next.slice(-200) : next;
        });
        setTimeout(() => installOutputRef.current?.scrollTo({ top: installOutputRef.current.scrollHeight, behavior: 'smooth' }), 30);
      } else if (data?.type === 'step_done' && data?.skill === 'needs_install') {
        // Install completed (success or fail) — clear the installing spinner
        setIsInstalling(false);
        setInstallPrompt(null);
        setInstallOutput([]);
      } else if (data?.type === 'step_failed' && data?.skill === 'needs_install') {
        // Install failed — clear spinner too
        setIsInstalling(false);
        setInstallPrompt(null);
        setInstallOutput([]);
      } else if (data?.type === 'ask_user') {
        // ASK_USER pause — clear install spinner if still showing
        setIsInstalling(false);
        setInstallPrompt(null);
      } else if (data?.type === 'all_done') {
        // Automation finished — keep isAutomationMode true so AutomationProgress stays visible
        // and 'Waiting for response...' placeholder doesn't flash. Resets on next planning event.
        setIsThinking(false);
        setIsStreaming(false);
        setInstallPrompt(null);
        setIsInstalling(false);
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 400);
      }
    };

    const handleSchedulePending = (_event: any, data: any) => {
      setSchedulePending({ id: data.id, label: data.label, targetTime: data.targetTime, prompt: data.prompt || '' });
    };

    const handleBridgeStatus = (_event: any, data: any) => {
      setBridgeStatus({ state: data.state, bridgeFile: data.bridgeFile, summary: data.summary });
    };

    ipcRenderer.on('results-window:display-error', handleDisplayError);
    ipcRenderer.on('results-window:set-prompt', handlePromptText);
    ipcRenderer.on('results-window:show', handleWindowShow);
    ipcRenderer.on('automation:progress', handleAutomationProgress);
    ipcRenderer.on('schedule:pending', handleSchedulePending);
    ipcRenderer.on('bridge:status', handleBridgeStatus);
  
    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('results-window:display-error', handleDisplayError);
        ipcRenderer.removeListener('results-window:set-prompt', handlePromptText);
        ipcRenderer.removeListener('results-window:show', handleWindowShow);
        ipcRenderer.removeListener('automation:progress', handleAutomationProgress);
        ipcRenderer.removeListener('schedule:pending', handleSchedulePending);
        ipcRenderer.removeListener('bridge:status', handleBridgeStatus);
      }
    };
  }, []);

  // Dynamically resize window based on content at all times
  useEffect(() => {
    if (!contentRef.current || !ipcRenderer) return;

    const resizeForContent = () => {
      const headerHeight = 52;
      const padding = 32;
      const minHeight = 100;
      const maxHeight = 800;

      const contentHeight = contentRef.current?.scrollHeight || 0;
      const totalHeight = Math.min(Math.max(contentHeight + headerHeight + padding, minHeight), maxHeight);

      console.log('📏 [RESULTS_WINDOW] Content resize:', { height: totalHeight, contentHeight });
      // Ensure integers for Electron
      const width = 400;
      const height = Math.round(totalHeight);
      ipcRenderer.send('results-window:resize', { width, height });
    };

    const rafId = requestAnimationFrame(resizeForContent);

    return () => cancelAnimationFrame(rafId);
  }, [streamingResponse, isStreaming, promptText, isThinking, showTrigger]);

  // Auto-scroll to bottom only when new streaming content arrives (not on expand/collapse)
  useEffect(() => {
    if (streamingResponse) {
      scrollBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [streamingResponse]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        console.log('⌨️  [RESULTS_WINDOW] ESC pressed - closing results window');
        if (ipcRenderer) {
          ipcRenderer.send('results-window:close');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleClose = () => {
    console.log('❌ [RESULTS_WINDOW] Close button clicked');
    if (ipcRenderer) {
      ipcRenderer.send('results-window:close');
    }
  };

  const handleInstallConfirm = (confirmed: boolean) => {
    if (confirmed) { setIsInstalling(true); setInstallOutput([]); }
    setInstallPrompt(null);
    if (ipcRenderer) {
      console.log(`[ResultsWindow] install:confirm → confirmed=${confirmed}`);
      ipcRenderer.send('install:confirm', { confirmed });
    }
  };

  const handleActionChip = (chip: string) => {
    setActionChips([]);
    if (ipcRenderer) {
      ipcRenderer.send('stategraph:process', { prompt: chip, selectedText: '' });
    }
  };

  const handleCopy = async () => {
    const contentToCopy = streamingResponse;
    if (!contentToCopy) return;
    
    try {
      await navigator.clipboard.writeText(contentToCopy);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
      console.log('✅ [RESULTS_WINDOW] Content copied to clipboard');
    } catch (error) {
      console.error('❌ [RESULTS_WINDOW] Failed to copy:', error);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    
    setIsDragging(true);
    const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top
    };
    
    console.log('🖱️ [RESULTS_WINDOW] Drag started');
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!ipcRenderer) return;
      
      const newX = e.screenX - dragOffset.current.x;
      const newY = e.screenY - dragOffset.current.y;
      
      ipcRenderer.send('results-window:move', { x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      console.log('🖱️ [RESULTS_WINDOW] Drag ended');
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const renderPromptHeader = (text: string) => {
    // Split into tag tokens and plain text
    const parts: React.ReactNode[] = [];
    // Match [Highlighted: ...] wrapping a [File: ...] tag, plain [File: ...], or plain text
    const tagRegex = /\[Highlighted:\s*(\[File:\s*([^\]]+)\])\]|\[File:\s*([^\]]+)\]|\[Highlighted:\s*([^\]]+)\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    while ((match = tagRegex.exec(text)) !== null) {
      // Plain text before this match
      if (match.index > lastIndex) {
        const plain = text.slice(lastIndex, match.index).trim();
        if (plain) {
          parts.push(
            <span key={key++} className="text-sm font-medium truncate" style={{ color: '#e5e7eb', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
              {plain}
            </span>
          );
        }
      }

      // [Highlighted: [File: /path]] or [File: /path]
      const filePath = match[2] || match[3];
      // [Highlighted: some text]
      const highlightText = match[4];

      if (filePath) {
        const trimmed = filePath.trim();
        const isApp = /\.app$/i.test(trimmed);
        const fileName = trimmed.split('/').pop() || trimmed;
        const chipColor = isApp ? 'rgba(139,92,246,0.15)' : 'rgba(59,130,246,0.15)';
        const borderColor = isApp ? 'rgba(139,92,246,0.35)' : 'rgba(59,130,246,0.3)';
        const iconColor = isApp ? '#c4b5fd' : '#93c5fd';
        parts.push(
          <span key={key++} title={trimmed} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 5, backgroundColor: chipColor, border: `1px solid ${borderColor}`, color: iconColor, fontSize: '0.7rem', maxWidth: 160, overflow: 'hidden' }}>
            {isApp ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 9h6M9 12h6M9 15h4"/>
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
          </span>
        );
      } else if (highlightText) {
        const trimmed = highlightText.trim();
        const label = trimmed.length > 22 ? trimmed.slice(0, 22) + '…' : trimmed;
        parts.push(
          <span key={key++} title={trimmed} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 5, backgroundColor: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', color: '#6ee7b7', fontSize: '0.7rem', maxWidth: 160, overflow: 'hidden' }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>
            </svg>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          </span>
        );
      }

      lastIndex = match.index + match[0].length;
    }

    // Remaining plain text (the actual user question)
    if (lastIndex < text.length) {
      const plain = text.slice(lastIndex).trim();
      if (plain) {
        parts.push(
          <span key={key++} className="text-sm font-medium" style={{ color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200, display: 'inline-block' }}>
            {plain}
          </span>
        );
      }
    }

    return parts.length > 0 ? parts : <span className="text-sm font-medium" style={{ color: '#e5e7eb' }}>Results</span>;
  };

  const openFilePath = (filePath: string) => {
    if (ipcRenderer) {
      ipcRenderer.send('shell:open-path', filePath);
    }
  };

  // Pre-process text: wrap absolute file paths in markdown link syntax so RichContentRenderer
  // renders them as clickable links. Matches /Users/..., /home/..., /tmp/..., ~/... paths.
  const injectFileLinks = (text: string): string => {
    // Match absolute paths not already inside markdown link syntax [...](...) or code blocks
    // Regex: path starts with / or ~/, followed by non-whitespace, non-quote chars
    const filePathRegex = /(?<!\[)(?<!\()(?<![`'"])(\/(?:Users|home|tmp|var|etc|opt|Applications)[^\s`'"\)\]]+|~\/[^\s`'"\)\]]+)/g;
    return text.replace(filePathRegex, (match) => {
      const fileName = match.split('/').pop() || match;
      return `[${fileName}](file://${match})`;
    });
  };

  const renderInstallCard = () => {
    if (!installPrompt && !isInstalling) return null;

    if (isInstalling) {
      return (
        <div style={{ margin: '8px 0', borderRadius: 10, backgroundColor: 'rgba(15,15,15,0.95)', border: '1px solid rgba(59,130,246,0.3)', overflow: 'hidden' }}>
          <div className="flex items-center gap-2" style={{ padding: '8px 12px', borderBottom: '1px solid rgba(59,130,246,0.15)', backgroundColor: 'rgba(59,130,246,0.08)' }}>
            <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
            <span style={{ color: '#93c5fd', fontSize: '0.78rem', fontWeight: 600 }}>Installing...</span>
            <span style={{ color: '#4b5563', fontSize: '0.7rem', marginLeft: 'auto', fontFamily: 'monospace' }}>{installOutput.length} lines</span>
          </div>
          <div
            ref={installOutputRef}
            style={{ maxHeight: 180, overflowY: 'auto', padding: '8px 12px', fontFamily: 'ui-monospace, monospace', fontSize: '0.68rem', lineHeight: 1.55, color: '#86efac', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          >
            {installOutput.length === 0 ? (
              <span style={{ color: '#4b5563' }}>Waiting for output...</span>
            ) : (
              installOutput.map((line, i) => (
                <div key={i} style={{ color: line.toLowerCase().includes('error') || line.toLowerCase().includes('failed') ? '#f87171' : line.toLowerCase().includes('warn') ? '#fbbf24' : '#86efac' }}>{line}</div>
              ))
            )}
          </div>
        </div>
      );
    }

    if (!installPrompt) return null;
    const { tool, installCmd, reason, source, toolDescription } = installPrompt;
    const sourceLabel = source === 'brew' ? 'Homebrew' : source === 'npm' ? 'npm' : source === 'pip' ? 'pip' : source;
    const sourceBadgeColor = source === 'brew' ? 'rgba(251,146,60,0.15)' : 'rgba(59,130,246,0.15)';
    const sourceBorderColor = source === 'brew' ? 'rgba(251,146,60,0.35)' : 'rgba(59,130,246,0.3)';
    const sourceTextColor = source === 'brew' ? '#fdba74' : '#93c5fd';

    return (
      <div style={{ margin: '8px 0', padding: '14px', borderRadius: 10, backgroundColor: 'rgba(23,23,23,0.9)', border: '1px solid rgba(255,255,255,0.12)' }}>
        <div className="flex items-start gap-3">
          <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(251,146,60,0.12)', border: '1px solid rgba(251,146,60,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fdba74" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 4 }}>
              <span style={{ color: '#f3f4f6', fontSize: '0.82rem', fontWeight: 600 }}>Install {tool}?</span>
              <span style={{ padding: '1px 6px', borderRadius: 4, backgroundColor: sourceBadgeColor, border: `1px solid ${sourceBorderColor}`, color: sourceTextColor, fontSize: '0.68rem', fontWeight: 500 }}>{sourceLabel}</span>
            </div>
            <p style={{ color: '#9ca3af', fontSize: '0.75rem', margin: '0 0 6px', lineHeight: 1.4 }}>{reason}</p>
            {toolDescription && (
              <p style={{ color: '#6b7280', fontSize: '0.72rem', margin: '0 0 8px', lineHeight: 1.4 }}>{toolDescription}</p>
            )}
            <code style={{ display: 'block', padding: '4px 8px', borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.3)', color: '#86efac', fontSize: '0.7rem', fontFamily: 'monospace', marginBottom: 10, wordBreak: 'break-all' }}>{installCmd}</code>
            <div className="flex gap-2">
              <button
                onClick={() => handleInstallConfirm(true)}
                style={{ padding: '5px 14px', borderRadius: 6, backgroundColor: 'rgba(59,130,246,0.2)', border: '1px solid rgba(59,130,246,0.4)', color: '#93c5fd', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.35)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.2)')}
              >
                Install
              </button>
              <button
                onClick={() => handleInstallConfirm(false)}
                style={{ padding: '5px 14px', borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: '#6b7280', fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer', transition: 'all 0.15s' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.1)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)')}
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderActionChips = () => {
    if (!actionChips.length || isStreaming || isThinking || isAutomationMode) return null;
    return (
      <div className="flex flex-wrap gap-2" style={{ marginTop: 10 }}>
        {actionChips.map((chip, i) => (
          <button
            key={i}
            onClick={() => handleActionChip(chip)}
            style={{ padding: '4px 12px', borderRadius: 20, backgroundColor: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#93c5fd', fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.22)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.1)')}
          >
            {chip}
          </button>
        ))}
      </div>
    );
  };

  const renderResults = () => {
    // In automation mode, only render if there's streaming content (synthesis answer below steps)
    if (isAutomationMode && !streamingResponse && !installPrompt && !isInstalling) return null;

    if (isThinking) {
      return (
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: '0ms' }} />
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: '150ms' }} />
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="text-gray-400 text-sm">Thinking...</span>
        </div>
      );
    }

    return (
      <div className={`space-y-4${isDropping ? ' drop-animate' : ''}`}>
        {streamingResponse && (
          <div className="relative">
            <RichContentRenderer 
              content={injectFileLinks(streamingResponse)}
              animated={!isStreaming}
              className="text-sm"
              onFileLinkClick={openFilePath}
            />
            {isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-1" />
            )}
          </div>
        )}

        {renderInstallCard()}
        {renderActionChips()}

      </div>
    );
  };

  const isActive = isGlowActive;

  return (
    <div className="w-full h-full flex flex-col" style={{ position: 'relative' }}>
      <style>{`
        @keyframes border-sweep {
          0%   { --angle: 0deg; }
          100% { --angle: 360deg; }
        }
        @property --angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }
        @keyframes drop-in {
          0%   { transform: translateY(-8px) scaleY(0.97); }
          55%  { transform: translateY(3px) scaleY(1.01); }
          75%  { transform: translateY(-1px) scaleY(0.998); }
          100% { transform: translateY(0) scaleY(1); }
        }
        .drop-animate {
          animation: drop-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) forwards;
          transform-origin: top center;
        }
        .results-glow-ring {
          position: absolute;
          inset: -1px;
          border-radius: 12px;
          padding: 1.5px;
          background: conic-gradient(from var(--angle), transparent 70%, #3b82f6 85%, #60a5fa 90%, #3b82f6 95%, transparent);
          animation: border-sweep 2s linear infinite;
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          pointer-events: none;
          z-index: 10;
          opacity: 0;
          transition: opacity 0.4s ease;
        }
        .results-glow-ring.active {
          opacity: 1;
        }
      `}</style>
      <div className={`results-glow-ring${isActive ? ' active' : ''}`} />
      <div 
        className="w-full h-full flex flex-col"
        style={{
          backgroundColor: 'rgba(23, 23, 23, 0.95)',
          borderRadius: '11px',
          overflow: 'hidden',
        }}
      >
      <div 
        className="flex items-center justify-between px-4 py-3 border-b"
        onMouseDown={handleMouseDown}
        style={{
          borderColor: 'rgba(255, 255, 255, 0.1)',
          flexShrink: 0,
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
      >
        <div 
          className="flex-1 mr-2 flex flex-wrap items-center gap-1 min-w-0"
          title={promptText}
        >
          {promptText ? renderPromptHeader(promptText) : <span className="text-sm font-medium" style={{ color: '#e5e7eb' }}>Results</span>}
        </div>
        <div className="flex items-center gap-2">
          {isAutomationMode && (
            <button
              onClick={() => ipcRenderer?.send('automation:cancel')}
              style={{
                padding: '2px 8px',
                borderRadius: 5,
                backgroundColor: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.3)',
                color: '#f87171',
                fontSize: '0.7rem',
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0,
                lineHeight: 1.6,
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.25)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.12)')}
              title="Cancel automation"
            >
              Cancel
            </button>
          )}
          {streamingResponse && (
            <button
              onClick={handleCopy}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700 transition-colors flex-shrink-0"
              style={{
                backgroundColor: isCopied ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                color: isCopied ? '#22c55e' : '#9ca3af',
                fontSize: '12px',
                cursor: 'pointer',
              }}
              title={isCopied ? 'Copied!' : 'Copy response'}
            >
              {isCopied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              )}
            </button>
          )}
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-700 transition-colors flex-shrink-0"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              color: '#9ca3af',
              fontSize: '14px',
              cursor: 'pointer',
            }}
            title="Close (ESC)"
          >
            ×
          </button>
        </div>
      </div>
      
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div ref={contentRef}>
          {/* Pending schedule notification — shown when app opens with a launchd task registered */}
          {schedulePending && (
            <div style={{ marginBottom: 12, padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.3)' }}>
              <div className="flex items-start gap-3">
                <div style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div style={{ color: '#c4b5fd', fontSize: '0.8rem', fontWeight: 600, marginBottom: 2 }}>
                    Scheduled task queued
                  </div>
                  <div style={{ color: '#9ca3af', fontSize: '0.72rem', marginBottom: 8, lineHeight: 1.4 }}>
                    <strong style={{ color: '#e5e7eb' }}>{schedulePending.label}</strong> will run automatically at <strong style={{ color: '#a78bfa' }}>{schedulePending.targetTime}</strong> via macOS launchd — even if this app is closed.
                  </div>
                  <button
                    onClick={() => {
                      ipcRenderer?.send('schedule:dismiss', { id: schedulePending.id });
                      setSchedulePending(null);
                    }}
                    style={{ padding: '3px 10px', borderRadius: 5, backgroundColor: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.3)', color: '#a78bfa', fontSize: '0.72rem', cursor: 'pointer' }}
                  >
                    Got it
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bridge listener status banner — collapsed pill when watching, full banner when executing */}
          {bridgeStatus && bridgeStatus.state !== 'stopped' && (
            bridgeStatus.state === 'executing' ? (
              <div style={{
                marginBottom: 10,
                padding: '7px 10px',
                borderRadius: 8,
                backgroundColor: 'rgba(59,130,246,0.08)',
                border: '1px solid rgba(59,130,246,0.25)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: '#3b82f6', flexShrink: 0, animation: 'pulse 1.5s ease-in-out infinite' }} />
                <span style={{ color: '#93c5fd', fontSize: '0.7rem', fontWeight: 500 }}>
                  Bridge executing: <span style={{ color: '#e5e7eb', fontWeight: 400 }}>{bridgeStatus.summary || 'running task...'}</span>
                </span>
              </div>
            ) : (
              <div style={{
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                opacity: 0.45,
              }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: '#10b981', flexShrink: 0 }} />
                <span style={{ color: '#6b7280', fontSize: '0.65rem' }}>Bridge watching</span>
              </div>
            )
          )}

          {/* AutomationProgress is always mounted so its IPC listener is pre-registered */}
          <AutomationProgress
            onHeightChange={() => setShowTrigger(prev => prev + 1)}
            onActiveChange={(active) => {
              // Once streaming has started, don't let AutomationProgress re-enable automation mode
              if (streamingStartedRef.current && active) return;
              setIsAutomationMode(active);
            }}
          />
          {renderResults()}
          <div ref={scrollBottomRef} />
        </div>
      </div>
      </div>
    </div>
  );
}
