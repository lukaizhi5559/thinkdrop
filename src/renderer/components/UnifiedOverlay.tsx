import { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import { flushSync } from 'react-dom';
const ipcRenderer = (window as any).electron?.ipcRenderer;
import { playThinkDropSound, playDropSound } from '../utils/thinkDropSound';
import {
  TabBar,
  QueueTab,
  CronTab,
  SkillsTab,
  ConnectionsTab,
  StoreTab,
  type TabId,
} from './TabComponents';
import VoiceButton from './VoiceButton';
import AutomationProgress from './AutomationProgress';
import { RichContentRenderer } from './rich-content';
import SkillBuildProgress from './SkillBuildProgress';
import { SlideoutDrawer } from './SlideoutDrawer';
import { SettingsTab } from './SettingsTab';

// --- Types (imported from TabComponents for compatibility) ---
import type { QueueItem, CronItem, SkillItem, ConnectionItem } from './TabComponents';

interface PromptQueueItem {
  id: string;
  message: string;
  status: 'running' | 'done' | 'error';
  responseLanguage?: string | null;
}

interface SkillBuildState {
  step: 'fetching' | 'building' | 'validating' | 'fixing' | 'installing' | 'done' | 'error' | 'asking';
  skillName?: string;
  code?: string;
  error?: string;
  language?: string;
  confirmMessage?: string;
}

interface BridgeStatus {
  state: 'idle' | 'watching' | 'stopped';
  cronStatus?: 'running' | 'done' | 'failed';
  cronSkillName?: string;
}

interface SearchSource {
  url: string;
  hostname: string;
  title?: string;
}

interface ActionChip {
  label: string;
  action: string;
  args?: Record<string, unknown>;
}

// --- Components ---
export function UnifiedOverlay() {
  // --- Tab State ---
  const [activeTab, setActiveTab] = useState<TabId | 'settings'>('results');
  const [isSlideoutOpen, setIsSlideoutOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [unreadTabs, setUnreadTabs] = useState<Set<TabId>>(new Set());

  // --- Prompt Input State ---
  const [promptText, setPromptText] = useState('');
  const [highlights, setHighlights] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  // Skill panel removed - now in slideout
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // --- Results State ---
  const [streamingResponse, setStreamingResponse] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isAutomationMode, setIsAutomationMode] = useState(false);
  const [streamingStartedRef, setStreamingStartedRef] = useState(false);
  const [actionChips, setActionChips] = useState<ActionChip[]>([]);
  const [searchSources, setSearchSources] = useState<SearchSource[]>([]);
  const [showSourcesPanel, setShowSourcesPanel] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<{
    tool: string;
    installCmd: string;
    reason: string;
    source?: string;
    toolDescription?: string;
  } | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [isDropping, setIsDropping] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  
  // Force update mechanism to ensure UI refreshes during streaming
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  // --- Gather Context State (like StandalonePromptCapture) ---
  const [gatherPending, setGatherPending] = useState(false);
  const [gatherQuestion, setGatherQuestion] = useState<string | null>(null);
  const [isGlowActive, setIsGlowActive] = useState(false);
  // Synthesis/streaming response block is collapsed by default; user can expand
  const [isSynthesisCollapsed, setIsSynthesisCollapsed] = useState(true);

  // --- Queue/Cron/Skills/Connections State ---
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [cronItems, setCronItems] = useState<CronItem[]>([]);
  const [skillItems, setSkillItems] = useState<SkillItem[]>([]);
  const [connectionItems, setConnectionItems] = useState<ConnectionItem[]>([]);
  const [promptQueueItems, setPromptQueueItems] = useState<PromptQueueItem[]>([]);
  const [restartAlert, setRestartAlert] = useState<{ items: PromptQueueItem[] } | null>(null);

  // --- Skill Build State ---
  const [skillBuild, setSkillBuild] = useState<SkillBuildState | null>(null);
  const pendingInstallRef = useRef<((confirmed: boolean) => void) | null>(null);

  // --- UI State ---
  const [schedulePending, setSchedulePending] = useState<{ id: string; label: string; targetTime: string } | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [, setPromptTextHeader] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollBottomRef = useRef<HTMLDivElement>(null);

  // --- Glow Timer Ref ---
  const glowOffTimerRef = useRef<NodeJS.Timeout | null>(null);

  // --- Install Output Scroll Ref ---
  const installOutputRef = useRef<HTMLDivElement>(null);

  // --- Drop Sound Ref ---
  const hasDroppedRef = useRef(false);

  // --- Stream completion tracker ---
  // Flips to true when a 'done' message arrives. On the first chunk of the NEXT
  // stream we detect this and clear streamingResponse before appending, preventing
  // old content from being prepended to the new answer (the race-condition double).
  const streamCompletedRef = useRef(false);

  // --- IPC listener registration guard (prevents double-registration under React StrictMode) ---
  const ipcListenersRegistered = useRef(false);

  // --- Stable token for token-based IPC deduplication ---
  // Stable across renders; preload uses it to ensure exactly one listener per channel.
  const listenerToken = useRef('unified-overlay');

  // --- Dragging State ---
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);   // Synchronous — safe to read inside ResizeObserver/setTimeout closures
  const isResizingRef = useRef(false);   // True while native window resize handle is active
  const resizeDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const dragOffsetX = useRef(0);
  const dragOffsetY = useRef(0);

  // Suppress all resize IPC while user is dragging or using the native resize handle
  const shouldSuppressResize = () => isDraggingRef.current || isResizingRef.current;

  // --- Width Toggle with Original Size Memory ---
  const originalWidthRef = useRef(400);
  const originalHeightRef = useRef(300);

  const toggleWidth = useCallback(() => {
    const newExpanded = !isExpanded;
    console.log('[Width Toggle] Toggling to:', newExpanded ? 'expanded (900px)' : 'compact (original)');
    setIsExpanded(newExpanded);
    
    if (newExpanded) {
      // Expanding: store current dimensions first, then expand
      const currentWidth = 400;
      const currentHeight = 300;
      originalWidthRef.current = currentWidth;
      originalHeightRef.current = currentHeight;
      ipcRenderer?.send('window:smart-resize', { width: 900, height: 800, animate: true, keepPosition: true });
    } else {
      // Collapsing: restore original dimensions, keep current position
      ipcRenderer?.send('window:smart-resize', { 
        width: originalWidthRef.current, 
        height: originalHeightRef.current, 
        animate: true,
        keepPosition: true,
      });
    }
    console.log('[Width Toggle] Sent IPC window:smart-resize');
  }, [isExpanded]);

  // --- Tab Switching ---
  const handleTabSelect = useCallback((tab: TabId | 'settings') => {
    setActiveTab(tab);
    setUnreadTabs(prev => {
      const next = new Set(prev);
      next.delete(tab as TabId);
      return next;
    });

    // Request data for certain tabs
    if (tab === 'skills') {
      ipcRenderer?.send('skills:list');
    } else if (tab === 'connections') {
      ipcRenderer?.send('connections:list');
    } else if (tab === 'cron') {
      ipcRenderer?.send('cron:list');
    }
  }, []);

  // --- Slideout Navigation ---
  const handleSlideoutNavigate = useCallback((tab: TabId | 'settings') => {
    setActiveTab(tab);
    setIsSlideoutOpen(false);
    setUnreadTabs(prev => {
      const next = new Set(prev);
      next.delete(tab as TabId);
      return next;
    });

    if (tab === 'skills') {
      ipcRenderer?.send('skills:list');
    } else if (tab === 'connections') {
      ipcRenderer?.send('connections:list');
    } else if (tab === 'cron') {
      ipcRenderer?.send('cron:list');
    }
  }, []);

  // --- Prompt Input Functions ---
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPromptText(e.target.value);
    // Auto-resize
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    console.log('🚀 [UNIFIED] handleSubmit called');
    
    // IMMEDIATE FEEDBACK: Clear input right away so user sees prompt disappear
    const finalPromptText = promptText; // Save before clearing
    const finalHighlights = [...highlights]; // Save before clearing
    const wasGatherPending = gatherPending; // Capture BEFORE we reset state
    
    // Use flushSync to force immediate UI updates (prevents 500ms delay)
    // ALL state resets must be inside flushSync to ensure synchronous DOM updates
    flushSync(() => {
      setPromptText('');
      setHighlights([]);
      setStreamingResponse('');
      setSearchSources([]);
      setIsStreaming(false);
      setIsThinking(true); // Start thinking immediately
      setIsAutomationMode(false); // CRITICAL: Must be inside flushSync to clear old automation UI
      setInstallPrompt(null);
      setActionChips([]);
      setInstallOutput([]);
      setGatherPending(false); // Reset gather state too
      setGatherQuestion(null);
      setStreamingStartedRef(false); // Reset streaming started flag
    });
    
    // Refs must be reset outside flushSync but immediately after
    hasDroppedRef.current = false;
    
    if (!finalPromptText.trim() && finalHighlights.length === 0) {
      console.log('⚠️ [UNIFIED] No text or highlights, skipping submit');
      setIsThinking(false);
      return;
    }
    if (isSubmitting) {
      setIsThinking(false);
      return;
    }
    
    // Handle gather flow - just send answer (state already reset above)
    if (wasGatherPending) {
      console.log('📋 [UNIFIED] gather:pending was active — routing to gather:answer');
      ipcRenderer?.send('gather:answer', { answer: finalPromptText.trim() });
      return; // Return after sending gather answer (state is already reset)
    }

    playThinkDropSound();
    setIsSubmitting(true);

    let finalPrompt = '';
    
    if (finalHighlights.length > 0) {
      finalPrompt = finalHighlights.map(h =>
        (h.startsWith('[File:') || h.startsWith('[Folder:')) ? h : `[Highlighted: ${h}]`
      ).join('\n') + '\n\n';
    }
    
    finalPrompt += finalPromptText;
    
    const MAX_MESSAGE_LENGTH = 50000;
    if (finalPrompt.trim().length > MAX_MESSAGE_LENGTH) {
      console.error(`❌ [UNIFIED] Message too long: ${finalPrompt.length} chars`);
      
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
      setIsSubmitting(false);
      return;
    }
    
    console.log('📤 [UNIFIED] Final prompt to send:', finalPrompt.trim());
    console.log('🔍 [UNIFIED] ipcRenderer available?', !!ipcRenderer);

    // Send to main process - match StandalonePromptCapture exactly
    ipcRenderer?.send('prompt-queue:submit', {
      prompt: finalPrompt.trim(),
      selectedText: finalHighlights.join('\n'),
    });
    console.log('✅ [UNIFIED] Prompt enqueued');

    setIsSubmitting(false);
  };

  const handleHighlightRemove = (index: number) => {
    setHighlights(prev => prev.filter((_, i) => i !== index));
  };

  // --- Drag and Drop ---
  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      setIsDropping(true);
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDropping(false);
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDropping(false);
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    console.log('[File Drop] Dropped files:', files.map(f => ({ name: f.name, type: f.type, path: (f as any).path })));
    if (files.length > 0) {
      // Process files directly (like StandalonePromptCapture)
      files.forEach((file) => {
        const filePath = (file as any).path;
        const isDir = file.type === '' && !file.name.includes('.'); // Heuristic for directories
        const itemText = isDir
          ? `[Folder: ${filePath}]`
          : `[File: ${filePath}]`;
        if (!highlights.includes(itemText)) {
          setHighlights((prev) => [...prev, itemText]);
        }
      });
    }
  };

  // --- Paste Handling ---
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const hasFiles = items.some(item => item.kind === 'file');

    if (hasFiles) {
      e.preventDefault();
      const files: File[] = [];
      items.forEach(item => {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      });

      if (files.length > 0) {
        // Process files directly (like StandalonePromptCapture)
        files.forEach((file) => {
          const filePath = (file as any).path || file.name;
          const isDir = file.type === '' && !file.name.includes('.');
          const itemText = isDir
            ? `[Folder: ${filePath}]`
            : `[File: ${filePath}]`;
          if (!highlights.find(h => h.includes(filePath))) {
            setHighlights((prev) => [...prev, itemText]);
          }
        });
      }
    }
    // Text paste is handled naturally by textarea
  };

  // --- Voice Recording ---
  const toggleRecording = () => {
    if (isRecording) {
      ipcRenderer?.send('voice:stop-recording');
    } else {
      ipcRenderer?.send('voice:start-recording');
    }
  };

  // --- File Attach ---
  const handleAttachClick = () => {
    ipcRenderer?.send('dialog:open-file');
  };

  // --- Window Controls ---
  const handleClose = () => {
    ipcRenderer?.send('window:hide');
  };

  // --- Copy Response ---
  const handleCopy = () => {
    if (streamingResponse) {
      navigator.clipboard.writeText(streamingResponse);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  // --- Native window resize listener — suppress resize IPC while user drags the window edge ---
  useEffect(() => {
    const handleWindowResize = () => {
      isResizingRef.current = true;
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      resizeDebounceRef.current = setTimeout(() => {
        isResizingRef.current = false;
      }, 300);
    };
    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
    };
  }, []);

  // --- Drag to Move Window ---
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left mouse
    if (!ipcRenderer) return;
    
    isDraggingRef.current = true; // Set ref synchronously — readable in any closure immediately
    setIsDragging(true);
    const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffsetX.current = e.clientX - bounds.left;
    dragOffsetY.current = e.clientY - bounds.top;
    console.log('[Drag] Mouse down - starting drag');
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!ipcRenderer) return;
      const newX = Math.round(e.screenX - dragOffsetX.current);
      const newY = Math.round(e.screenY - dragOffsetY.current);
      if (!Number.isFinite(newX) || !Number.isFinite(newY)) return;
      ipcRenderer.send('window:move', { x: newX, y: newY });
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false; // Clear ref synchronously
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // --- IPC Event Listeners ---
  useEffect(() => {
    if (!ipcRenderer) return;

    // Guard against React StrictMode double-invoke: register listeners only once.
    // NOTE: Do NOT use removeAllListeners here — it strips listeners from sibling
    // components (e.g. AutomationProgress) that share the same ipcRenderer instance.
    if (ipcListenersRegistered.current) return;
    ipcListenersRegistered.current = true;

    // --- Results / Streaming ---
    const handleWsMessage = (_e: any, message: { type: string; text?: string; lane?: string; payload?: any }) => {
      if (!message) return;
      const preview = message.text ? `"${message.text.substring(0, 50)}${message.text.length > 50 ? '...' : ''}"` : '(no text)';
      console.log(`[UNIFIED:DIAG] msg.type=${message.type} lane=${message.lane} preview=${preview} curRespLen=${streamingResponse.length}`);
      console.log('📨 [UNIFIED] WebSocket message received:', message.type, preview, 'lane:', message.lane, 'full message:', message);

      if (message.type === 'chunk' || message.type === 'llm_stream_chunk') {
        console.log('💬 [UNIFIED] Received chunk, length:', message.text?.length || 0);
        setIsThinking(false);
        setIsStreaming(true);
        // Force re-render to immediately show response and hide Thinking...
        forceUpdate();
        if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
        setIsGlowActive(true);

        // Defensive: reset automation mode if we're receiving regular content (not automation)
        // This catches cases where a new non-automation prompt starts but automation UI persists
        if (isAutomationMode && !message.lane?.includes('automation') && !streamingResponse) {
          console.log('🔄 [UNIFIED] First chunk on new prompt - resetting automation mode');
          setIsAutomationMode(false);
          setActionChips([]);
          setInstallPrompt(null);
        }

        // Play drop sound once when streaming starts (skip for fast lane)
        if (!hasDroppedRef.current && message.lane !== 'fast') {
          hasDroppedRef.current = true;
          playDropSound();
          setIsDropping(true);
          setTimeout(() => setIsDropping(false), 600);
        }

        // Detect new stream starting after previous completed. Capture and reset the
        // flag synchronously so subsequent chunks in the same batch don't re-clear.
        const isNewStream = streamCompletedRef.current;
        if (isNewStream) {
          streamCompletedRef.current = false;
          console.log('🔄 [UNIFIED] New stream started after completion — will clear previous response');
        }

        const msgText = message?.text || message.payload?.text || '';
        if (msgText.startsWith('\x00SOURCES\x00')) {
          try {
            const sources = JSON.parse(msgText.slice('\x00SOURCES\x00'.length));
            if (Array.isArray(sources)) setSearchSources(sources);
          } catch (_) {}
          return;
        } else if (msgText.startsWith('\x00REPLACE\x00')) {
          const newText = msgText.slice('\x00REPLACE\x00'.length);
          console.log('🔄 [UNIFIED] Replacing text, new length:', newText.length);
          setStreamingResponse(newText);
        } else {
          console.log('➕ [UNIFIED] Appending text, length:', msgText.length);
          setStreamingResponse(prev => {
            // If this is the first chunk of a new stream, discard prev (old answer) atomically.
            const base = isNewStream ? '' : prev;
            const combined = base + msgText;
            console.log('📝 [UNIFIED] Combined length:', combined.length, isNewStream ? '(new stream — cleared prev)' : '');
            return combined;
          });
          // Force immediate re-render to ensure response shows
          forceUpdate();
        }
      } else if (message.type === 'done' || message.type === 'llm_stream_end') {
        setIsStreaming(false);
        setIsThinking(false);
        streamCompletedRef.current = true;
        console.log('✅ [UNIFIED] Streaming complete, final streamingResponse length:', streamingResponse.length);
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 300);
      } else if (message.type === 'ready') {
        console.log('✅ [UNIFIED] VS Code extension ready');
      }
    };

    const handleClear = () => {
      setStreamingResponse('');
      setSearchSources([]);
      setIsGlowActive(false);
      setIsThinking(false);
      setIsStreaming(false);
      setIsAutomationMode(false);
      setInstallPrompt(null);
      setActionChips([]);
      setInstallOutput([]);
      setIsSynthesisCollapsed(true); // Reset synthesis collapsed state
      setGatherPending(false); // Reset gather state
      setGatherQuestion(null);
      setStreamingStartedRef(false); // Reset streaming started flag
      hasDroppedRef.current = false;
      streamCompletedRef.current = false;
      forceUpdate(); // Force immediate re-render
    };

    const handleSetPrompt = (_e: any, text: string) => {
      // Reset all state for new prompt (mirroring ResultsWindow.tsx behavior)
      setPromptText(text);
      setStreamingResponse('');
      setSearchSources([]);
      setShowSourcesPanel(false);
      setIsStreaming(false);
      setIsThinking(true);
      setIsAutomationMode(false); // AutomationProgress will self-activate on 'planning' event
      setInstallPrompt(null);
      setActionChips([]);
      setInstallOutput([]);
      setIsSynthesisCollapsed(true); // Reset synthesis collapsed state
      setGatherPending(false); // Reset gather state
      setGatherQuestion(null);
      setStreamingStartedRef(false); // Reset streaming started flag
      if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
      setIsGlowActive(true);
      hasDroppedRef.current = false;
      streamCompletedRef.current = false;
      forceUpdate(); // Force immediate re-render
    };

    // When the window is re-shown, force a resize measurement
    const handleWindowShow = () => {
      console.log('📐 [UNIFIED] Window shown - triggering content resize');
      if (contentRef.current && ipcRenderer && !shouldSuppressResize()) {
        const h = contentRef.current.scrollHeight;
        const headerHeight = 52, padding = 32, minH = 350, maxH = 900;
        const total = Math.min(Math.max(h + headerHeight + padding, minH), maxH);
        ipcRenderer.send('unified:resize-window', { height: Math.round(total) });
      }
    };

    // --- Automation Progress ---
    const markUnreadTab = (tab: TabId) => {
      setUnreadTabs(prev => {
        const next = new Set(prev);
        next.add(tab);
        return next;
      });
    };

    const handleAutomationProgress = (_event: any, data: any) => {
      if (data?.type === 'planning') {
        setIsThinking(false);
        setIsAutomationMode(true);
        setActiveTab('results');
        setInstallPrompt(null);
        setActionChips([]);
        if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
        setIsGlowActive(true);
      } else if (data?.type === 'plan:generated' || data?.type === 'plan:found_existing') {
        setIsThinking(false);
        setIsAutomationMode(true);
        setInstallPrompt(null);
        setActionChips([]);
        if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
        setIsGlowActive(true);
      } else if (data?.type === 'needs_install') {
        setInstallPrompt({
          tool: data.tool,
          installCmd: data.installCmd,
          reason: data.reason,
          source: data.source || 'brew',
          toolDescription: data.toolDescription || undefined,
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
        setIsInstalling(false);
        setInstallPrompt(null);
        setInstallOutput([]);
      } else if (data?.type === 'step_failed' && data?.skill === 'needs_install') {
        setIsInstalling(false);
        setInstallPrompt(null);
        setInstallOutput([]);
      } else if (data?.type === 'ask_user') {
        setIsInstalling(false);
        setInstallPrompt(null);
      } else if (data?.type === 'skill_setup_complete') {
        setIsThinking(false);
        setIsStreaming(false);
        setInstallPrompt(null);
        setIsInstalling(false);
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 400);
        ipcRenderer.send('skills:refresh');
        setTimeout(() => {
          setActiveTab('skills');
          markUnreadTab('skills');
        }, 600);
      } else if (data?.type === 'all_done') {
        markUnreadTab('results');
        setIsThinking(false);
        setIsStreaming(false);
        setInstallPrompt(null);
        setIsInstalling(false);
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 400);
      }
    };

    // --- Install Confirmation Click Handler (button → main) ---
    const sendInstallConfirm = (confirmed: boolean) => {
      if (confirmed) {
        setIsInstalling(true);
        setInstallOutput([]);
      }
      setInstallPrompt(null);
      if (ipcRenderer) {
        ipcRenderer.send('install:confirm', { confirmed });
      }
    };
    (window as any).__unifiedInstallConfirm = sendInstallConfirm;

    // --- Queue ---
    const handleQueueUpdate = (_e: any, items: QueueItem[]) => {
      setQueueItems(items);
      if (items.some(i => i.status === 'building' || i.status === 'planning')) {
        setUnreadTabs(prev => new Set(prev).add('queue'));
      }
    };

    const handleQueueItemDone = (_e: any, data: { id: string; result?: string; error?: string }) => {
      setQueueItems(prev => prev.map(item =>
        item.id === data.id
          ? { ...item, status: data.error ? 'error' : 'done', result: data.result, error: data.error }
          : item
      ));
    };

    // --- Cron ---
    const handleCronList = (_e: any, items: CronItem[]) => {
      setCronItems(items);
    };

    const handleCronUpdate = (_e: any, item: CronItem) => {
      setCronItems(prev => {
        const exists = prev.find(i => i.id === item.id);
        if (exists) {
          return prev.map(i => i.id === item.id ? item : i);
        }
        return [...prev, item];
      });
    };

    // --- Skills ---
    const handleSkillsList = (_e: any, items: SkillItem[]) => {
      setSkillItems(items);
    };

    // --- Connections ---
    const handleConnectionsList = (_e: any, items: ConnectionItem[]) => {
      setConnectionItems(items);
    };

    // --- Prompt Queue ---
    const handlePromptQueueUpdate = (_e: any, items: PromptQueueItem[]) => {
      setPromptQueueItems(items);
    };

    const handleRestartAlert = (_e: any, data: { items: PromptQueueItem[] }) => {
      setRestartAlert(data);
    };

    // --- Highlights ---
    const handleHighlightsUpdate = (_e: any, newHighlights: string[]) => {
      setHighlights(prev => {
        const combined = [...prev, ...newHighlights];
        // Remove duplicates
        return combined.filter((h, i) => combined.indexOf(h) === i);
      });
    };

    const handleHighlightsAvailable = (_e: any, available: boolean) => {
      if (available) {
        ipcRenderer?.send('highlights:confirm');
      }
    };

    const handleHighlightsConfirmed = (_e: any, data: { highlights: string[]; sourceApp?: string }) => {
      setHighlights(prev => {
        const combined = [...prev, ...data.highlights];
        return combined.filter((h, i) => combined.indexOf(h) === i);
      });
    };

    // --- Voice ---
    const handleVoiceInject = (_e: any, data: { message: string }) => {
      setPromptText(data.message);
    };

    const handleVoiceResponse = () => {
      // Voice response handled - could show in UI if needed
    };

    const handleVoiceRecordingStarted = () => {
      setIsRecording(true);
    };

    const handleVoiceRecordingStopped = () => {
      setIsRecording(false);
    };

    // --- File Drop Response ---
    const handleFileDropResult = (_e: any, data: { highlights: string[] }) => {
      console.log('[File Drop] Received result:', data);
      if (data.highlights) {
        setHighlights(prev => {
          const combined = [...prev, ...data.highlights];
          return combined.filter((h, i) => combined.indexOf(h) === i);
        });
      }
    };

    // --- Skill Build ---
    const handleSkillBuildProgress = (_e: any, newState: SkillBuildState) => {
      setSkillBuild(newState);
    };

    const handleInstallConfirm = (_e: any, result: { confirmed: boolean }) => {
      if (pendingInstallRef.current) {
        pendingInstallRef.current(result.confirmed);
        pendingInstallRef.current = null;
      }
    };

    // --- Schedule ---
    const handleSchedulePending = (_e: any, pending: { id: string; label: string; targetTime: string }) => {
      setSchedulePending(pending);
    };

    // --- Bridge Status ---
    const handleBridgeStatus = (_e: any, status: BridgeStatus) => {
      setBridgeStatus(status);
    };

    // --- Scan Progress ---
    const handleScanProgress = () => {};

    // --- Action Chips ---
    const handleActionChips = (_e: any, chips: ActionChip[]) => {
      console.log(' [UNIFIED] Received action chips:', chips);
      setActionChips(chips);
    };

    // --- Gather Context Handler (like StandalonePromptCapture) ---
    const handleGatherPending = (_event: any, { active, question }: { active: boolean; question?: string | null }) => {
      console.log('[UNIFIED] Gather pending:', active, question);
      setGatherPending(active);
      setGatherQuestion(active && question ? question : null);
    };

    // --- Queue Enqueued Handler ---
    const handleQueueEnqueued = () => {
      console.log('[UNIFIED] Queue enqueued - clearing previous response');
      setStreamingResponse('');
      setIsAutomationMode(false);
      setIsSynthesisCollapsed(true);
      setActionChips([]);
      setInstallPrompt(null);
      setGatherPending(false);
      setGatherQuestion(null);
      setStreamingStartedRef(false); // Reset streaming started flag
      hasDroppedRef.current = false; // Reset drop sound flag
      forceUpdate(); // Force immediate re-render
    };

    // --- Search Sources ---
    const handleSearchSources = (_e: any, sources: SearchSource[]) => {
      setSearchSources(sources);
    };

    // Register listeners
    const token = listenerToken.current;
    ipcRenderer.on('ws-bridge:message', handleWsMessage, token);
    ipcRenderer.on('results-window:set-prompt', handleSetPrompt, token);
    ipcRenderer.on('results-window:clear', handleClear, token);
    ipcRenderer.on('automation:progress', handleAutomationProgress, token);
    ipcRenderer.on('is-streaming', (_e: any, data: { isStreaming: boolean }) => {
      setIsStreaming(data.isStreaming);
      if (data.isStreaming) {
        setActiveTab('results');
        setUnreadTabs(prev => ({ ...prev, results: false }));
      }
    });
    ipcRenderer.on('queue:update', handleQueueUpdate);
    ipcRenderer.on('queue:item-done', handleQueueItemDone);
    ipcRenderer.on('cron:list', handleCronList);
    ipcRenderer.on('cron:update', handleCronUpdate);
    ipcRenderer.on('skills:list', handleSkillsList);
    ipcRenderer.on('connections:list', handleConnectionsList);
    ipcRenderer.on('prompt-queue:update', handlePromptQueueUpdate);
    ipcRenderer.on('prompt-queue:restart-alert', handleRestartAlert);
    ipcRenderer.on('highlights:update', handleHighlightsUpdate);
    ipcRenderer.on('highlights:available', handleHighlightsAvailable);
    ipcRenderer.on('highlights:confirmed', handleHighlightsConfirmed);
    ipcRenderer.on('voice:inject-prompt', handleVoiceInject);
    ipcRenderer.on('voice:response', handleVoiceResponse);
    ipcRenderer.on('voice:recording-started', handleVoiceRecordingStarted);
    ipcRenderer.on('voice:recording-stopped', handleVoiceRecordingStopped);
    ipcRenderer.on('file-drop:result', handleFileDropResult);
    ipcRenderer.on('skill-build:progress', handleSkillBuildProgress);
    ipcRenderer.on('install:confirm', handleInstallConfirm);
    ipcRenderer.on('schedule:pending', handleSchedulePending);
    ipcRenderer.on('bridge:status', handleBridgeStatus);
    ipcRenderer.on('scan:progress', handleScanProgress);
    ipcRenderer.on('action-chips', handleActionChips);
    ipcRenderer.on('search:sources', handleSearchSources);
    ipcRenderer.on('window:show', handleWindowShow);
    ipcRenderer.on('gather:pending', handleGatherPending);
    ipcRenderer.on('queue:enqueued', handleQueueEnqueued);

    // Request initial data
    ipcRenderer.send('queue:list');
    ipcRenderer.send('cron:list');
    ipcRenderer.send('skills:list');
    ipcRenderer.send('connections:list');

    return () => {
      ipcListenersRegistered.current = false;
      const token = listenerToken.current;
      ipcRenderer.removeListenerByToken('ws-bridge:message', token);
      ipcRenderer.removeListenerByToken('results-window:set-prompt', token);
      ipcRenderer.removeListenerByToken('results-window:clear', token);
      ipcRenderer.removeListenerByToken('automation:progress', token);
      ipcRenderer.removeListener('is-streaming');
      ipcRenderer.removeListener('queue:update', handleQueueUpdate);
      ipcRenderer.removeListener('queue:item-done', handleQueueItemDone);
      ipcRenderer.removeListener('cron:list', handleCronList);
      ipcRenderer.removeListener('cron:update', handleCronUpdate);
      ipcRenderer.removeListener('skills:list', handleSkillsList);
      ipcRenderer.removeListener('connections:list', handleConnectionsList);
      ipcRenderer.removeListener('prompt-queue:update', handlePromptQueueUpdate);
      ipcRenderer.removeListener('prompt-queue:restart-alert', handleRestartAlert);
      ipcRenderer.removeListener('highlights:update', handleHighlightsUpdate);
      ipcRenderer.removeListener('highlights:available', handleHighlightsAvailable);
      ipcRenderer.removeListener('highlights:confirmed', handleHighlightsConfirmed);
      ipcRenderer.removeListener('voice:inject-prompt', handleVoiceInject);
      ipcRenderer.removeListener('voice:response', handleVoiceResponse);
      ipcRenderer.removeListener('voice:recording-started', handleVoiceRecordingStarted);
      ipcRenderer.removeListener('voice:recording-stopped', handleVoiceRecordingStopped);
      ipcRenderer.removeListener('file-drop:result', handleFileDropResult);
      ipcRenderer.removeListener('skill-build:progress', handleSkillBuildProgress);
      ipcRenderer.removeListener('install:confirm', handleInstallConfirm);
      ipcRenderer.removeListener('schedule:pending', handleSchedulePending);
      ipcRenderer.removeListener('bridge:status', handleBridgeStatus);
      ipcRenderer.removeListener('scan:progress', handleScanProgress);
      ipcRenderer.removeListener('action-chips', handleActionChips);
      ipcRenderer.removeListener('search:sources', handleSearchSources);
      ipcRenderer.removeListener('window:show', handleWindowShow);
      ipcRenderer.removeListener('gather:pending', handleGatherPending);
      ipcRenderer.removeListener('queue:enqueued', handleQueueEnqueued);
    };
  }, []);

  // --- Auto-scroll during streaming ---
  useEffect(() => {
    if (isStreaming && scrollBottomRef.current) {
      scrollBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamingResponse, isStreaming]);

  // Window height is driven by AutomationProgress's onHeightChange callback (Fix in AutomationProgress.tsx)
  // which measures the component's own root div — outside the clipped layout chain.

  // --- Resize window when Summary block is toggled (sibling of AutomationProgress, not observed) ---
  useEffect(() => {
    if (!ipcRenderer) return;
    const t = setTimeout(() => {
      if (shouldSuppressResize()) return; // Don't resize while user is dragging or resizing the panel
      const h = contentRef.current?.scrollHeight || 0;
      const HEADER = 105;
      const INPUT_AREA = 100;
      const PADDING = 20;
      const total = Math.min(Math.max(h + HEADER + INPUT_AREA + PADDING, 400), 900);
      ipcRenderer.send('unified:resize-window', { height: Math.round(total) });
    }, 120);
    return () => clearTimeout(t);
  }, [isSynthesisCollapsed]);

  // --- Resize window as streaming response content grows (non-automation intents) ---
  // AutomationProgress's onHeightChange handles command_automate via ResizeObserver.
  // For general_knowledge / question / memory_retrieve etc the response renders into
  // contentRef directly — nothing else triggers a resize IPC as the text grows.
  useEffect(() => {
    if (!ipcRenderer) return;
    if (isAutomationMode) return; // automation mode has its own resize path
    if (shouldSuppressResize()) return;
    if (!streamingResponse && !isThinking) return; // nothing visible yet

    const h = contentRef.current?.scrollHeight || 0;
    const HEADER = 105;
    const INPUT_AREA = 100;
    const PADDING = 32;
    const total = Math.min(Math.max(h + HEADER + INPUT_AREA + PADDING, 400), 900);
    ipcRenderer.send('unified:resize-window', { height: Math.round(total) });
  }, [streamingResponse, isThinking, isAutomationMode]);

  // --- Render Helpers ---
  const renderHighlightChips = () => {
    if (highlights.length === 0) return null;

    return (
      <div className="flex flex-wrap gap-2 mb-2">
        {highlights.map((highlight, index) => {
          const isFolder = highlight.includes('[Folder:');
          const isFile = highlight.includes('[File:');
          const bgColor = isFolder ? 'rgba(74, 222, 128, 0.15)' : isFile ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.1)';
          const borderColor = isFolder ? 'rgba(74, 222, 128, 0.3)' : isFile ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.2)';
          const textColor = isFolder ? '#4ade80' : isFile ? '#93c5fd' : '#e5e7eb';

          return (
            <div
              key={index}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs"
              style={{
                backgroundColor: bgColor,
                border: `1px solid ${borderColor}`,
                color: textColor,
              }}
            >
              {isFolder && <span>📁</span>}
              {isFile && <span>📄</span>}
              <span className="truncate max-w-[150px]">{highlight}</span>
              <button
                onClick={() => handleHighlightRemove(index)}
                className="ml-1 hover:opacity-70"
                style={{ color: textColor }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  // --- Action Chip Click ---
  const handleActionChip = (chip: ActionChip) => {
    setActionChips([]);
    if (ipcRenderer) {
      const chipText = typeof chip === 'string' ? chip : (chip as any).label || String(chip);
      ipcRenderer.send('prompt-queue:submit', { prompt: chipText, selectedText: '' });
    }
  };

  // --- Install Confirm Click (button → main) ---
  const handleInstallButtonClick = (confirmed: boolean) => {
    const fn = (window as any).__unifiedInstallConfirm;
    if (typeof fn === 'function') fn(confirmed);
  };

  // --- Install Card ---
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
                onClick={() => handleInstallButtonClick(true)}
                style={{ padding: '5px 14px', borderRadius: 6, backgroundColor: 'rgba(59,130,246,0.2)', border: '1px solid rgba(59,130,246,0.4)', color: '#93c5fd', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
              >
                Install
              </button>
              <button
                onClick={() => handleInstallButtonClick(false)}
                style={{ padding: '5px 14px', borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: '#6b7280', fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer' }}
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // --- Source Pill ---
  const renderSourcePill = () => {
    if (!searchSources.length) return null;
    const visible = searchSources.slice(0, 4);
    const OVERLAP = 10;
    const CIRCLE = 22;
    return (
      <div style={{ position: 'relative', marginBottom: 10 }}>
        <button
          onClick={() => setShowSourcesPanel(prev => !prev)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', userSelect: 'none' }}
        >
          <div style={{ position: 'relative', width: CIRCLE + (visible.length - 1) * (CIRCLE - OVERLAP), height: CIRCLE, flexShrink: 0 }}>
            {visible.map((src, i) => (
              <div
                key={src.url}
                style={{ position: 'absolute', left: i * (CIRCLE - OVERLAP), top: 0, width: CIRCLE, height: CIRCLE, borderRadius: '50%', overflow: 'hidden', border: '1.5px solid rgba(255,255,255,0.12)', backgroundColor: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: visible.length - i, flexShrink: 0 }}
              >
                <img
                  src={`https://www.google.com/s2/favicons?domain=${src.hostname}&sz=32`}
                  alt={src.hostname}
                  width={14}
                  height={14}
                  style={{ borderRadius: 2 }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                    const p = e.currentTarget.parentElement as HTMLElement;
                    p.style.fontSize = '8px';
                    p.style.color = '#9ca3af';
                    p.style.fontWeight = '700';
                    p.textContent = src.hostname.charAt(0).toUpperCase();
                  }}
                />
              </div>
            ))}
          </div>
          <span style={{ color: '#9ca3af', fontSize: '0.7rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3 }}>
            {searchSources.length} {searchSources.length === 1 ? 'site' : 'sites'}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#6b7280', transform: showSourcesPanel ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </button>
        {showSourcesPanel && (
          <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50, width: 280, maxHeight: 320, overflowY: 'auto', backgroundColor: '#1c1c1e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', padding: '6px 0' }}>
            <div style={{ padding: '6px 12px 4px', fontSize: '0.65rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sources</div>
            {searchSources.map((src, i) => (
              <div
                key={src.url + i}
                onClick={() => ipcRenderer?.send('shell:open-url', src.url)}
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: '#2a2a2c', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <img src={`https://www.google.com/s2/favicons?domain=${src.hostname}&sz=32`} alt="" width={12} height={12} style={{ borderRadius: 2 }} />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 500, color: '#e5e7eb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {src.title || src.hostname}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {src.hostname}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // --- Action Chips ---
  const renderActionChips = () => {
    if (!actionChips.length || isStreaming || isThinking || isAutomationMode) return null;
    return (
      <div className="flex flex-wrap gap-2" style={{ marginTop: 10 }}>
        {actionChips.map((chip, i) => {
          const label = typeof chip === 'string' ? chip : (chip as any).label || String(chip);
          return (
            <button
              key={i}
              onClick={() => handleActionChip(chip)}
              style={{ padding: '4px 12px', borderRadius: 20, backgroundColor: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#93c5fd', fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {label}
            </button>
          );
        })}
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

    if (!streamingResponse && !installPrompt && !isInstalling && !actionChips.length) return null;

    // In automation mode the streamingResponse is the synthesize output — show it collapsible.
    // Outside automation mode (plain LLM answer) always show it expanded.
    const showCollapsible = isAutomationMode && !!streamingResponse;
    // Always respect user's collapsed preference — no auto-expand
    const synthesisExpanded = !isSynthesisCollapsed;
    // Approximate token count (1 token ≈ 4 chars) for the header badge
    const synthTokenCount = streamingResponse ? Math.ceil(streamingResponse.length / 4) : 0;

    return (
      <div className={`space-y-4${isDropping ? ' drop-animate' : ''}`}>
        {renderInstallCard()}
        {searchSources.length > 0 && renderSourcePill()}
        {streamingResponse && !showCollapsible && !isAutomationMode && (
          <div className="relative" style={{ overflowX: 'hidden', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
            <RichContentRenderer
              content={streamingResponse}
              animated={!isStreaming}
              className="text-sm"
            />
            {isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-1" />
            )}
          </div>
        )}

        {showCollapsible && (
          <div className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)', marginTop: '5px', minWidth: 0 }}>
            {/* Collapsible header */}
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium"
              style={{
                backgroundColor: 'rgba(59,130,246,0.08)',
                color: '#93c5fd',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setIsSynthesisCollapsed(prev => !prev)}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.14)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.08)')}
            >
              <div className="flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                </svg>
                <span>Summary</span>
                {isStreaming && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse ml-1" />}
                {synthTokenCount > 0 && (
                  <span style={{ fontSize: '0.65rem', color: 'rgba(147,197,253,0.6)', marginLeft: '4px', fontWeight: 400 }}>
                    {synthTokenCount > 999 ? `${(synthTokenCount / 1000).toFixed(1)}k` : synthTokenCount} tokens
                  </span>
                )}
              </div>
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: synthesisExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Collapsible body */}
            {synthesisExpanded && (
              <div className="px-3 py-2.5 relative" style={{ backgroundColor: 'rgba(0,0,0,0.25)', overflowX: 'hidden', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
                <RichContentRenderer
                  content={streamingResponse}
                  animated={!isStreaming}
                  className="text-sm"
                />
                {isStreaming && (
                  <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-1" />
                )}
              </div>
            )}
          </div>
        )}

        {renderActionChips()}
      </div>
    );
  };

  return (
    <div
      className="w-full h-full flex flex-col"
      style={{ position: 'relative' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Glow effect for automation mode */}
      <style>{`
        @keyframes prompt-border-sweep {
          to { --prompt-angle: 360deg; }
        }
        @property --prompt-angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }
        @keyframes think-breathe {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
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
          z-index: 10;
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
        .drag-glow-ring {
          position: absolute;
          inset: -1px;
          border-radius: 13px;
          padding: 2px;
          background: conic-gradient(from var(--prompt-angle), transparent 60%, #3b82f6 75%, #60a5fa 85%, #3b82f6 95%, transparent);
          animation: prompt-border-sweep 1.5s linear infinite;
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          pointer-events: none;
          z-index: 10;
          opacity: 0;
          transition: opacity 0.3s ease;
        }
        .drag-glow-ring.active {
          opacity: 1;
        }
      `}</style>
      <div className={`drag-glow-ring${isDragOver ? ' active' : ''}`} />
      <div className={`prompt-glow-ring${isGlowActive ? ' active' : isThinking ? ' thinking' : ''}`} />

      {/* Main Container */}
      <div
        className="w-full h-full flex flex-col"
        style={{
          backgroundColor: 'rgba(23, 23, 23, 0.95)',
          borderRadius: '11px',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Header - Two Row Layout */}
        <div
          className="flex flex-col"
          onMouseDown={handleMouseDown}
          style={{
            flexShrink: 0,
            cursor: isDragging ? 'grabbing' : 'grab',
            userSelect: 'none',
          }}
        >
          {/* Row 1: Hamburger + Action Buttons */}
          <div className="flex items-center justify-between px-4 py-2">
            {/* Left: Hamburger Menu */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsSlideoutOpen(prev => !prev);
              }}
              className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-white/10 transition-colors"
              style={{ color: '#9ca3af' }}
              title="Menu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>

            {/* Right: Action Buttons */}
            <div className="flex items-center gap-2">
            {/* Width Toggle */}
            <button
              onClick={toggleWidth}
              className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-700 transition-colors"
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                color: '#9ca3af',
              }}
              title={isExpanded ? 'Collapse' : 'Expand'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {isExpanded ? (
                  <>
                    <polyline points="4 14 10 14 10 20" />
                    <polyline points="20 10 14 10 14 4" />
                    <line x1="14" y1="10" x2="21" y2="3" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </>
                ) : (
                  <>
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </>
                )}
              </svg>
            </button>

            {/* Copy Button */}
            {streamingResponse && (
              <button
                onClick={handleCopy}
                className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-700 transition-colors"
                style={{
                  backgroundColor: isCopied ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  color: isCopied ? '#22c55e' : '#9ca3af',
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

            {/* Cancel Button (automation mode) */}
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
                }}
                title="Cancel automation"
              >
                Cancel
              </button>
            )}

            {/* Close Button */}
            <button
              onClick={handleClose}
              className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-700 transition-colors"
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                color: '#9ca3af',
              }}
              title="Close (ESC)"
            >
              ×
            </button>
          </div>
          </div>

          {/* Row 2: TabBar */}
          <div style={{ flexShrink: 0 }}>
            <TabBar
              active={activeTab === 'settings' ? 'results' : activeTab}
              onSelect={(tab) => handleTabSelect(tab as TabId | 'settings')}
              queueCount={queueItems.filter(i => i.status !== 'done').length + promptQueueItems.length}
              cronCount={cronItems.filter(i => i.status === 'active').length}
              unreadTabs={unreadTabs}
            />
          </div>
        </div>

        {/* Slideout Drawer */}
        <SlideoutDrawer
          isOpen={isSlideoutOpen}
          onClose={() => setIsSlideoutOpen(false)}
          onNavigate={handleSlideoutNavigate}
          activeTab={activeTab}
        />

        {/* Main Content Area - constrained for scroll */}
        <div className="flex-1 overflow-hidden relative">
          {/* Results Tab */}
          {activeTab === 'results' && (
            <div ref={scrollContainerRef} className="h-full overflow-y-auto overflow-x-hidden p-4">
              <div ref={contentRef}>
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
                          <strong style={{ color: '#e5e7eb' }}>{schedulePending.label}</strong> will run automatically at <strong style={{ color: '#a78bfa' }}>{schedulePending.targetTime}</strong>
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

                {bridgeStatus && bridgeStatus.state !== 'stopped' && (
                  <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5, opacity: bridgeStatus.cronStatus === 'running' ? 1 : (bridgeStatus.cronStatus ? 0.85 : 0.45) }}>
                    <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, backgroundColor: bridgeStatus.cronStatus === 'running' ? '#3b82f6' : bridgeStatus.cronStatus === 'failed' ? '#ef4444' : bridgeStatus.cronStatus === 'done' ? '#22c55e' : '#10b981', animation: bridgeStatus.cronStatus === 'running' ? 'pulse 1.5s ease-in-out infinite' : 'none' }} />
                    <span style={{ color: '#6b7280', fontSize: '0.65rem' }}>Bridge watching</span>
                  </div>
                )}

                <AutomationProgress
                  onHeightChange={(automationH: number) => {
                    if (shouldSuppressResize()) return; // Don't resize while user is dragging or resizing the panel
                    const HEADER = 105;
                    const INPUT_AREA = 100;
                    const PADDING = 48;
                    const minH = 400;
                    const maxH = 900;
                    const total = Math.min(Math.max(automationH + HEADER + INPUT_AREA + PADDING, minH), maxH);
                    const currentWidth = isExpanded ? 900 : 400;
                    ipcRenderer?.send('window:smart-resize', { width: currentWidth, height: total });
                  }}
                  onActiveChange={(active) => {
                    if (streamingStartedRef && active) return;
                    setIsAutomationMode(active);
                    setIsGlowActive(active);
                  }}
                />

                {skillBuild && (
                  <SkillBuildProgress
                    state={{
                      phase: skillBuild.step || 'idle',
                      skillName: skillBuild.skillName || '',
                      skillDisplayName: skillBuild.skillName || '',
                      category: 'general',
                      round: 0,
                      maxRounds: 3,
                      rounds: [],
                      question: skillBuild.confirmMessage,
                      error: skillBuild.error,
                    }}
                    onAnswer={() => {}}
                    onCancel={() => {}}
                    onOpenUrl={() => {}}
                  />
                )}

                {renderResults()}
                <div ref={scrollBottomRef} />
              </div>
            </div>
          )}

          {/* Queue Tab */}
          {activeTab === 'queue' && (
            <div className="h-full overflow-y-auto overflow-x-hidden p-4 flex flex-col gap-2">
              {restartAlert && (
                <div style={{ borderRadius: 9, padding: '10px 14px', backgroundColor: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.3)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span style={{ color: '#fbbf24', fontSize: '0.72rem', fontWeight: 600 }}>
                      {restartAlert.items.length} unfinished prompt{restartAlert.items.length > 1 ? 's' : ''} from last session
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => { ipcRenderer?.send('prompt-queue:resume-pending'); setRestartAlert(null); }}
                      style={{ padding: '3px 12px', borderRadius: 5, fontSize: '0.68rem', cursor: 'pointer', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#4ade80', fontWeight: 500 }}
                    >Resume</button>
                    <button
                      onClick={() => ipcRenderer?.send('prompt-queue:dismiss-alert')}
                      style={{ padding: '3px 12px', borderRadius: 5, fontSize: '0.68rem', cursor: 'pointer', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontWeight: 500 }}
                    >Discard</button>
                  </div>
                </div>
              )}

              {promptQueueItems.map(item => (
                <div key={item.id} className="p-3 rounded-lg border" style={{ backgroundColor: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.1)' }}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-300 truncate flex-1">{item.message}</span>
                    <span className={`text-xs px-2 py-1 rounded ${item.status === 'running' ? 'bg-blue-500/20 text-blue-400' : item.status === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'}`}>
                      {item.status}
                    </span>
                  </div>
                </div>
              ))}

              <QueueTab
                items={queueItems}
                onRerun={(item) => ipcRenderer?.send('queue:rerun', { id: item.id })}
                onCancel={(item) => ipcRenderer?.send('queue:cancel', { id: item.id })}
              />
            </div>
          )}

          {/* Cron Tab */}
          {activeTab === 'cron' && (
            <div className="h-full overflow-y-auto overflow-x-hidden p-4">
              <CronTab
                items={cronItems}
                onToggle={(item) => ipcRenderer?.send('cron:toggle', { id: item.id })}
                onDelete={(item) => ipcRenderer?.send('cron:delete', { id: item.id })}
                onRerun={(item) => ipcRenderer?.send('cron:run-now', { id: item.id })}
              />
            </div>
          )}

          {/* Agents Tab - Blank for now */}
          {activeTab === 'agents' && (
            <div className="h-full overflow-y-auto overflow-x-hidden p-4 flex items-center justify-center">
              <div className="text-center">
                <div style={{ fontSize: '2rem', marginBottom: '12px' }}>🤖</div>
                <div style={{ color: '#6b7280', fontSize: '0.9rem' }}>Agents coming soon...</div>
              </div>
            </div>
          )}

          {/* Skills Tab */}
          {activeTab === 'skills' && (
            <div className="h-full overflow-y-auto overflow-x-hidden p-4">
              <SkillsTab
                items={skillItems}
                onSaveSecret={(skillName, key, value) => ipcRenderer?.send('skills:save-secret', { skillName, key, value })}
                onOpenCode={(filePath) => ipcRenderer?.send('skills:open-code', { filePath })}
                onUploadSkill={() => ipcRenderer?.send('skills:upload')}
                onOAuthConnect={(skillName, provider, tokenKey, scopes) => ipcRenderer?.send('skills:oauth-connect', { skillName, provider, tokenKey, scopes })}
                onScopesChange={(skillName, provider, scopes) => ipcRenderer?.send('skills:update-oauth-scopes', { skillName, provider, scopes })}
                onRepairOAuth={(skillName) => ipcRenderer?.send('skills:repair-oauth', { skillName })}
                onDelete={(skillName) => ipcRenderer?.send('skills:delete', { skillName })}
              />
            </div>
          )}

          {/* Connections Tab */}
          {activeTab === 'connections' && (
            <div className="h-full overflow-y-auto overflow-x-hidden p-4">
              <ConnectionsTab
                items={connectionItems}
                onConnect={(provider, tokenKey, scopes) => ipcRenderer?.send('connections:connect', { provider, tokenKey, scopes })}
                onDisconnect={(provider, tokenKey) => ipcRenderer?.send('connections:disconnect', { provider, tokenKey })}
                onRefresh={() => ipcRenderer?.send('connections:list')}
              />
            </div>
          )}

          {/* Store Tab */}
          {activeTab === 'store' && (
            <div className="h-full overflow-y-auto overflow-x-hidden p-4">
              <StoreTab onBuildSkill={() => setActiveTab('results')} />
            </div>
          )}

          {/* Settings Tab */}
          {activeTab === 'settings' && (
            <div className="h-full overflow-y-auto overflow-x-hidden p-4">
              <SettingsTab />
            </div>
          )}
        </div>

        {/* Bottom Input Bar */}
        <div
          className="border-t p-4"
          style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}
        >
          {/* Highlights */}
          {renderHighlightChips()}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={promptText}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            onPaste={handlePaste}
            placeholder={gatherPending && gatherQuestion ? gatherQuestion : "Ask or Drag-Drop anything here"}
            className="w-full bg-transparent text-white placeholder-gray-500 resize-none outline-none text-sm mb-3"
            style={{ minHeight: '24px', maxHeight: '200px' }}
            rows={1}
          />

          {/* Action Buttons */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* Mic Button */}
              <VoiceButton compact={true} />

              {/* Attach Button */}
              <button
                onClick={handleAttachClick}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10 transition-all"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
            </div>

            {/* Submit Button - Matching StandalonePromptCapture style */}
            <div
              style={{
                width: '24px',
                height: '24px',
                borderRadius: '4px',
                backgroundColor: isSubmitting
                  ? 'rgba(255, 255, 255, 0.07)'
                  : (promptText.trim() || highlights.length > 0) ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                border: '1px solid',
                borderColor: isSubmitting
                  ? 'rgba(255, 255, 255, 0.15)'
                  : (promptText.trim() || highlights.length > 0) ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                flexShrink: 0,
                marginTop: '2px',
                cursor: (isSubmitting || promptText.trim() || highlights.length > 0) ? 'pointer' : 'default',
                transition: 'background-color 0.15s, border-color 0.15s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title={isSubmitting ? 'Cancel' : 'Send'}
              onClick={isSubmitting ? () => ipcRenderer?.send('automation:cancel') : (promptText.trim() || highlights.length > 0) ? handleSubmit : undefined}
            >
              {isSubmitting ? (
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
    </div>
  );
}
