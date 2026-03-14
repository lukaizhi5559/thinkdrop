import React, { useEffect, useState, useRef } from 'react';
import { RichContentRenderer } from './rich-content';
import AutomationProgress from './AutomationProgress';
import SkillBuildProgress, { SkillBuildState, BuildPhase } from './SkillBuildProgress';
import { playDropSound } from '../utils/thinkDropSound';
import { TabBar, QueueTab, CronTab, SkillsTab, StoreTab, ConnectionsTab, PromptQueueSection } from './TabComponents';
import type { TabId, QueueItem, CronItem, SkillItem, PromptQueueItem, ConnectionItem } from './TabComponents';

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
  // Set when queue:enqueued fires — suppresses automation:progress so Results tab stays clean
  const isQueuedTaskRef = useRef(false);
  
  const [isGlowActive, setIsGlowActive] = useState(false);
  const glowOffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [showTrigger, setShowTrigger] = useState(0);
  const [isDropping, setIsDropping] = useState(false);
  const hasDroppedRef = useRef(false);
  // Synthesis/streaming response block is collapsed by default; user can expand
  const [isSynthesisCollapsed, setIsSynthesisCollapsed] = useState(true);

  // Web search sources — populated via \x00SOURCES\x00 sentinel from answer.js
  const [searchSources, setSearchSources] = useState<{ url: string; title: string; hostname: string }[]>([]);
  const [showSourcesPanel, setShowSourcesPanel] = useState(false);

  // ── Tab state ────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>('results');
  const activeTabRef = useRef<TabId>('results');
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [cronItems, setCronItems] = useState<CronItem[]>([]);
  const [skillItems, setSkillItems] = useState<SkillItem[]>([]);
  const [skillStoreSearch, setSkillStoreSearch] = useState<string>('');
  const [connectionItems, setConnectionItems] = useState<ConnectionItem[]>([]);
  // Unread badge: set when activity fires in a non-active tab, cleared on tab switch
  const [unreadTabs, setUnreadTabs] = useState<Set<TabId>>(new Set());

  // ── Prompt Queue (serial stategraph runner) ──────────────────────────────
  // Items here are pending/running prompts waiting for stategraph execution
  const [promptQueueItems, setPromptQueueItems] = useState<PromptQueueItem[]>([]);
  // Restart alert: shown when app restarts with unfinished prompts from last session
  const [restartAlert, setRestartAlert] = useState<{ items: PromptQueueItem[]; countdownSec: number } | null>(null);
  const restartCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleTabSelect = (tab: TabId) => {
    activeTabRef.current = tab;
    setActiveTab(tab);
    setUnreadTabs(prev => { const next = new Set(prev); next.delete(tab); return next; });
    if (tab === 'skills') {
      ipcRenderer?.send('skills:list');
    }
    if (tab === 'cron') {
      ipcRenderer?.send('cron:list');
    }
    if (tab === 'connections') {
      ipcRenderer?.send('connections:list');
    }
    if (tab === 'store') {
      setSkillStoreSearch('');
    }
  };

  const markUnread = (tab: TabId) => {
    if (activeTabRef.current !== tab) {
      setUnreadTabs(prev => new Set(prev).add(tab));
    }
  };

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

  // Skill build pipeline state
  const [skillBuild, setSkillBuild] = useState<SkillBuildState | null>(null);
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
        if (msgText.startsWith('\x00SOURCES\x00')) {
          try {
            const sources = JSON.parse(msgText.slice('\x00SOURCES\x00'.length));
            if (Array.isArray(sources)) setSearchSources(sources);
          } catch (_) {}
          return; // don't append to response text
        } else if (msgText.startsWith('\x00REPLACE\x00')) {
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
      isQueuedTaskRef.current = false;
      setInstallOutput([]);
      setPromptText(text);
      setStreamingResponse('');
      setSearchSources([]);
      setShowSourcesPanel(false);
      setIsStreaming(false);
      setIsThinking(true);
      setIsSynthesisCollapsed(true);
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
      // Suppress automation progress display for queued tasks — Queue tab handles it.
      // EXCEPTION: gather_* events (credential/question prompts) must ALWAYS pass through
      // so the user sees the credential input UI even when a task is running from the queue.
      const isGatherEvent = typeof data?.type === 'string' && data.type.startsWith('gather_');
      if (isQueuedTaskRef.current && !isGatherEvent) {
        if (data?.type === 'all_done') {
          isQueuedTaskRef.current = false;
        }
        return;
      }
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
      } else if (data?.type === 'skill_setup_complete') {
        // Skill was just built (build-only flow) — switch to Skills tab so user
        // sees the new skill card with credential fields right away.
        setIsThinking(false);
        setIsStreaming(false);
        setInstallPrompt(null);
        setIsInstalling(false);
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 400);
        // Refresh skills list then open Skills tab
        ipcRenderer.send('skills:refresh');
        setTimeout(() => {
          activeTabRef.current = 'skills';
          setActiveTab('skills');
          markUnread('skills');
        }, 600);
      } else if (data?.type === 'all_done') {
        // Automation finished — keep isAutomationMode true so AutomationProgress stays visible
        // and 'Waiting for response...' placeholder doesn't flash. Resets on next planning event.
        markUnread('results');
        setIsThinking(false);
        setIsStreaming(false);
        setInstallPrompt(null);
        setIsInstalling(false);
        // Keep synthesis block collapsed — user can open it if they choose
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 400);
      } else if (data?.type === 'skill_build_phase') {
        // Skill build pipeline progress — update SkillBuildProgress state
        setSkillBuild(prev => {
          const base: SkillBuildState = prev || {
            phase: 'idle',
            skillName: data.skillName || '',
            skillDisplayName: data.skillName || '',
            category: data.category || '',
            round: data.round || 1,
            maxRounds: 4,
            rounds: [],
          };
          return { ...base, phase: data.phase as BuildPhase, round: data.round ?? base.round };
        });
        setIsGlowActive(true);
      } else if (data?.type === 'skill_validate_result') {
        setSkillBuild(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            phase: data.verdict === 'PASS' ? 'installing' : 'fixing',
            rounds: [...prev.rounds, { round: data.round, issues: data.issues || [], fixed: data.verdict === 'PASS' }],
          };
        });
      } else if (data?.type === 'skill_build_done') {
        setSkillBuild(prev => prev ? { ...prev, phase: data.ok ? 'done' : 'error', error: data.error, installedPath: data.installedPath } : prev);
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 1000);
      } else if (data?.type === 'skill_build_draft') {
        setSkillBuild(prev => prev ? { ...prev, draft: data.draft } : prev);
      } else if (data?.type === 'skill_smoke_test') {
        setSkillBuild(prev => prev ? { ...prev, smokeTest: { ok: data.ok, output: data.output, error: data.error } } : prev);
      }
    };

    const handleSchedulePending = (_event: any, data: any) => {
      setSchedulePending({ id: data.id, label: data.label, targetTime: data.targetTime, prompt: data.prompt || '' });
    };

    const handleQueueUpdate = (_event: any, items: QueueItem[]) => {
      setQueueItems(prev => {
        // Mark queue tab unread if a status changed while it's not active
        const prevMap = new Map(prev.map(i => [i.id, i.status]));
        const hasNew = items.some(i => prevMap.get(i.id) !== i.status || !prevMap.has(i.id));
        if (hasNew) markUnread('queue');
        return items;
      });
    };

    const handlePromptQueueUpdate = (_event: any, items: PromptQueueItem[]) => {
      setPromptQueueItems(items);
      if (items.length > 0) markUnread('queue');
    };

    const handleRestartAlert = (_event: any, { items, countdownMs }: { items: PromptQueueItem[]; countdownMs: number }) => {
      const totalSec = Math.ceil(countdownMs / 1000);
      setRestartAlert({ items, countdownSec: totalSec });
      // Auto-switch to Queue tab so user sees the alert
      activeTabRef.current = 'queue';
      setActiveTab('queue');
      // Tick down every second
      if (restartCountdownRef.current) clearInterval(restartCountdownRef.current);
      restartCountdownRef.current = setInterval(() => {
        setRestartAlert(prev => {
          if (!prev) { clearInterval(restartCountdownRef.current!); return null; }
          const next = prev.countdownSec - 1;
          if (next <= 0) {
            clearInterval(restartCountdownRef.current!);
            return null;
          }
          return { ...prev, countdownSec: next };
        });
      }, 1000);
    };

    const handleRestartCancel = () => {
      setRestartAlert(null);
      if (restartCountdownRef.current) clearInterval(restartCountdownRef.current);
    };

    const handleCronUpdate = (_event: any, items: CronItem[]) => {
      setCronItems(prev => {
        const prevMap = new Map(prev.map(i => [i.id, i.status]));
        const hasNew = items.some(i => prevMap.get(i.id) !== i.status || !prevMap.has(i.id));
        if (hasNew) markUnread('cron');
        return items;
      });
    };

    // command_automate was queued — stop thinking spinner, switch to Queue tab so user
    // sees the live progress there and can keep using Results for other prompts.
    const handleQueueEnqueued = () => {
      isQueuedTaskRef.current = true;
      setIsThinking(false);
      setIsStreaming(false);
      setIsAutomationMode(false);
      setPromptText('');
      setStreamingResponse('');
      if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
      setIsGlowActive(false);
      handleTabSelect('queue');
    };

    const handleBridgeStatus = (_event: any, data: any) => {
      setBridgeStatus({ state: data.state, bridgeFile: data.bridgeFile, summary: data.summary });
    };

    // skill:build-asking — installSkill paused for secret; update SkillBuildProgress to 'asking' phase
    const handleSkillBuildAsking = (_event: any, { question, keyLabel, serviceContext, options, autoSetupFailed, scannedFields }: { name: string; question: string; keyLabel?: string; serviceContext?: string; options: string[]; autoSetupFailed?: boolean; scannedFields?: any[] }) => {
      setSkillBuild(prev => prev ? { ...prev, phase: 'asking', question, keyLabel: keyLabel || undefined, serviceContext: serviceContext || undefined, options: options || [], autoSetupFailed: autoSetupFailed || false, scannedFields: scannedFields || null } : prev);
      setIsGlowActive(true);
    };

    // skill:build-done — mark SkillBuildProgress done or error
    const handleSkillBuildDone = (_event: any, { ok, installedPath, error }: { ok: boolean; installedPath?: string; error?: string }) => {
      setSkillBuild(prev => prev ? { ...prev, phase: ok ? 'done' : 'error', installedPath, error } : prev);
      if (ok) setTimeout(() => setIsGlowActive(false), 1000);
    };

    // skills:update — sent by main.js in response to skills:list or after a new skill is installed
    const handleSkillsUpdate = (_event: any, items: SkillItem[]) => {
      setSkillItems(items || []);
    };

    // connections:update — sent by main.js in response to connections:list or after connect/disconnect
    const handleConnectionsUpdate = (_event: any, items: ConnectionItem[]) => {
      setConnectionItems(items || []);
    };

    // skill:store-trigger — sent when ThinkDrop auto-routes to skill store (e.g. needs_skill)
    const handleSkillStoreTrigger = (_event: any, { capability }: { capability: string; suggestion: string }) => {
      const query = capability ? capability.replace(/[^a-zA-Z0-9 ]/g, ' ').trim() : '';
      setSkillStoreSearch(query);
      activeTabRef.current = 'store';
      setActiveTab('store');
      setUnreadTabs(prev => { const next = new Set(prev); next.delete('store'); return next; });
    };

    ipcRenderer.on('results-window:display-error', handleDisplayError);
    ipcRenderer.on('results-window:set-prompt', handlePromptText);
    ipcRenderer.on('results-window:show', handleWindowShow);
    ipcRenderer.on('automation:progress', handleAutomationProgress);
    ipcRenderer.on('schedule:pending', handleSchedulePending);
    ipcRenderer.on('bridge:status', handleBridgeStatus);
    ipcRenderer.on('skill:build-asking', handleSkillBuildAsking);
    ipcRenderer.on('skill:build-done', handleSkillBuildDone);
    ipcRenderer.on('queue:update', handleQueueUpdate);
    ipcRenderer.on('cron:update', handleCronUpdate);
    ipcRenderer.on('queue:enqueued', handleQueueEnqueued);
    ipcRenderer.on('skills:update', handleSkillsUpdate);
    ipcRenderer.on('connections:update', handleConnectionsUpdate);
    ipcRenderer.on('skill:store-trigger', handleSkillStoreTrigger);
    ipcRenderer.on('prompt-queue:update', handlePromptQueueUpdate);
    ipcRenderer.on('prompt-queue:restart-alert', handleRestartAlert);
    ipcRenderer.on('prompt-queue:restart-cancel', handleRestartCancel);
  
    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('results-window:display-error', handleDisplayError);
        ipcRenderer.removeListener('results-window:set-prompt', handlePromptText);
        ipcRenderer.removeListener('results-window:show', handleWindowShow);
        ipcRenderer.removeListener('automation:progress', handleAutomationProgress);
        ipcRenderer.removeListener('schedule:pending', handleSchedulePending);
        ipcRenderer.removeListener('bridge:status', handleBridgeStatus);
        ipcRenderer.removeListener('skill:build-asking', handleSkillBuildAsking);
        ipcRenderer.removeListener('skill:build-done', handleSkillBuildDone);
        ipcRenderer.removeListener('queue:update', handleQueueUpdate);
        ipcRenderer.removeListener('cron:update', handleCronUpdate);
        ipcRenderer.removeListener('queue:enqueued', handleQueueEnqueued);
        ipcRenderer.removeListener('skills:update', handleSkillsUpdate);
        ipcRenderer.removeListener('connections:update', handleConnectionsUpdate);
        ipcRenderer.removeListener('skill:store-trigger', handleSkillStoreTrigger);
        ipcRenderer.removeListener('prompt-queue:update', handlePromptQueueUpdate);
        ipcRenderer.removeListener('prompt-queue:restart-alert', handleRestartAlert);
        ipcRenderer.removeListener('prompt-queue:restart-cancel', handleRestartCancel);
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
      ipcRenderer.send('prompt-queue:submit', { prompt: chip, selectedText: '' });
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

    // Perplexity-style source favicon pill + dropdown panel
    const renderSourcePill = () => {
      if (!searchSources.length) return null;
      const visible = searchSources.slice(0, 4);
      const OVERLAP = 10;
      const CIRCLE = 22;
      return (
        <div style={{ position: 'relative', marginBottom: 10 }}>
          {/* Clickable pill row */}
          <button
            onClick={() => setShowSourcesPanel(prev => !prev)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            {/* Overlapping favicon circles */}
            <div style={{ position: 'relative', width: CIRCLE + (visible.length - 1) * (CIRCLE - OVERLAP), height: CIRCLE, flexShrink: 0 }}>
              {visible.map((src, i) => (
                <div
                  key={src.url}
                  style={{
                    position: 'absolute',
                    left: i * (CIRCLE - OVERLAP),
                    top: 0,
                    width: CIRCLE,
                    height: CIRCLE,
                    borderRadius: '50%',
                    overflow: 'hidden',
                    border: '1.5px solid rgba(255,255,255,0.12)',
                    backgroundColor: '#1a1a1a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: visible.length - i,
                    flexShrink: 0,
                  }}
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
            {/* Count + chevron */}
            <span style={{ color: '#9ca3af', fontSize: '0.7rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3 }}>
              {searchSources.length} {searchSources.length === 1 ? 'site' : 'sites'}
              <svg
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ color: '#6b7280', transform: showSourcesPanel ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </button>

          {/* Dropdown sources panel */}
          {showSourcesPanel && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: 0,
                zIndex: 50,
                width: 280,
                maxHeight: 320,
                overflowY: 'auto',
                backgroundColor: '#1c1c1e',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                padding: '6px 0',
              }}
            >
              <div style={{ padding: '6px 12px 4px', fontSize: '0.65rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Sources
              </div>
              {searchSources.map((src, i) => (
                <div
                  key={src.url + i}
                  onClick={() => ipcRenderer?.send('shell:open-url', src.url)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '7px 12px',
                    textDecoration: 'none',
                    borderRadius: 0,
                    transition: 'background 0.1s',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  {/* Favicon */}
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%',
                    backgroundColor: '#2a2a2c',
                    border: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${src.hostname}&sz=32`}
                      alt=""
                      width={12}
                      height={12}
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
                  {/* Text */}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: '0.72rem', fontWeight: 500, color: '#e5e7eb',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {src.title || src.hostname}
                    </div>
                    <div style={{
                      fontSize: '0.62rem', color: '#6b7280',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {src.hostname}
                    </div>
                  </div>
                  {/* External link icon */}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                    <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    };

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

    // In automation mode the streamingResponse is the synthesize output — show it collapsible.
    // Outside automation mode (plain LLM answer) always show it expanded.
    const showCollapsible = isAutomationMode && !!streamingResponse;
    // Always respect user's collapsed preference — no auto-expand
    const synthesisExpanded = !isSynthesisCollapsed;
    // Approximate token count (1 token ≈ 4 chars) for the header badge
    const synthTokenCount = streamingResponse ? Math.ceil(streamingResponse.length / 4) : 0;

    return (
      <div className={`space-y-4${isDropping ? ' drop-animate' : ''}`}>
        {renderSourcePill()}
        {streamingResponse && !showCollapsible && (
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

        {showCollapsible && (
          <div className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)', marginTop: '5px' }}>
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
              <div className="px-3 py-2.5 relative" style={{ backgroundColor: 'rgba(0,0,0,0.25)' }}>
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
        @keyframes spin {
          to { transform: rotate(360deg); }
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
      
      {/* ── Tab bar ─────────────────────────────────────────────────────────── */}
      <TabBar
        active={activeTab}
        onSelect={handleTabSelect}
        queueCount={queueItems.filter(i => i.status !== 'done').length + promptQueueItems.length}
        cronCount={cronItems.filter(i => i.status === 'active').length}
        unreadTabs={unreadTabs}
      />

      {/* ── Queue tab — always mounted, hidden when inactive ────────────────── */}
      <div
        className="overflow-y-auto overflow-x-hidden p-4"
        style={{ display: activeTab === 'queue' ? 'flex' : 'none', flex: 1, flexDirection: 'column', gap: 8 }}
      >
        {restartAlert && (
          <div style={{
            borderRadius: 9, padding: '10px 14px',
            backgroundColor: 'rgba(245,158,11,0.07)',
            border: '1px solid rgba(245,158,11,0.3)',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span style={{ color: '#fbbf24', fontSize: '0.72rem', fontWeight: 600 }}>
                {restartAlert.items.length} unfinished prompt{restartAlert.items.length > 1 ? 's' : ''} from last session
              </span>
              <span style={{
                marginLeft: 'auto', fontSize: '0.68rem', fontWeight: 700,
                color: '#f59e0b', fontFamily: 'ui-monospace,monospace',
                background: 'rgba(245,158,11,0.15)', padding: '1px 6px', borderRadius: 4,
              }}>
                {restartAlert.countdownSec}s
              </span>
            </div>
            <p style={{ color: '#9ca3af', fontSize: '0.68rem', margin: 0, lineHeight: 1.4 }}>
              Will auto-trigger in {restartAlert.countdownSec} second{restartAlert.countdownSec !== 1 ? 's' : ''}. Cancel to discard.
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => ipcRenderer?.send('prompt-queue:dismiss-alert')}
                style={{ padding: '3px 12px', borderRadius: 5, fontSize: '0.68rem', cursor: 'pointer',
                  background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontWeight: 500 }}
              >Cancel — discard</button>
            </div>
          </div>
        )}
        <PromptQueueSection
          items={promptQueueItems}
          onCancel={(id) => ipcRenderer?.send('prompt-queue:cancel', { id })}
        />
        <QueueTab
          items={queueItems}
          onRerun={(item) => ipcRenderer?.send('queue:rerun', { id: item.id })}
          onCancel={(item) => ipcRenderer?.send('queue:cancel', { id: item.id })}
        />
      </div>

      {/* ── Cron tab — always mounted, hidden when inactive ─────────────────── */}
      <div
        className="overflow-y-auto overflow-x-hidden p-4"
        style={{ display: activeTab === 'cron' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}
      >
        <CronTab
          items={cronItems}
          onToggle={(item) => ipcRenderer?.send('cron:toggle', { id: item.id })}
          onDelete={(item) => ipcRenderer?.send('cron:delete', { id: item.id })}
          onRerun={(item) => ipcRenderer?.send('cron:run-now', { id: item.id })}
        />
      </div>

      {/* ── Skills tab — always mounted, hidden when inactive ────────────────── */}
      <div
        className="overflow-y-auto overflow-x-hidden p-4"
        style={{ display: activeTab === 'skills' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}
      >
        <SkillsTab
          items={skillItems}
          onSaveSecret={(skillName, key, value) =>
            ipcRenderer?.send('skills:save-secret', { skillName, key, value })
          }
          onOpenCode={(filePath) =>
            ipcRenderer?.send('skills:open-code', { filePath })
          }
          onUploadSkill={() =>
            ipcRenderer?.send('skills:upload')
          }
          onOAuthConnect={(skillName, provider, tokenKey, scopes) =>
            ipcRenderer?.send('skills:oauth-connect', { skillName, provider, tokenKey, scopes })
          }
          onScopesChange={(skillName, provider, scopes) =>
            ipcRenderer?.send('skills:update-oauth-scopes', { skillName, provider, scopes })
          }
          onDelete={(skillName) =>
            ipcRenderer?.send('skills:delete', { skillName })
          }
        />
      </div>

      {/* ── Connections tab — always mounted, hidden when inactive ─────────── */}
      <div
        className="overflow-y-auto overflow-x-hidden p-4"
        style={{ display: activeTab === 'connections' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}
      >
        <ConnectionsTab
          items={connectionItems}
          onConnect={(provider, tokenKey, scopes) =>
            ipcRenderer?.send('connections:connect', { provider, tokenKey, scopes })
          }
          onDisconnect={(provider, tokenKey) =>
            ipcRenderer?.send('connections:disconnect', { provider, tokenKey })
          }
          onRefresh={() => ipcRenderer?.send('connections:list')}
        />
      </div>

      {/* ── Store tab — always mounted, hidden when inactive ────────────────── */}
      <div
        className="overflow-y-auto overflow-x-hidden p-4"
        style={{ display: activeTab === 'store' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}
      >
        <StoreTab
          initialSearch={skillStoreSearch}
          onBuildSkill={() => setActiveTab('results')}
        />
      </div>

      {/* ── Results tab — always mounted, hidden when inactive ──────────────── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4"
        style={{ display: activeTab === 'results' ? 'flex' : 'none', flexDirection: 'column' }}
      >
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

          {/* Skill build pipeline progress — shown when a skill is being built/validated/installed */}
          {skillBuild && skillBuild.phase !== 'idle' && (
            <SkillBuildProgress
              state={skillBuild}
              onAnswer={(answer) => {
                ipcRenderer?.send('skill:build-answer', { name: skillBuild.skillName, answer });
                setSkillBuild(prev => prev ? { ...prev, phase: 'installing' } : prev);
              }}
              onCancel={() => {
                setSkillBuild(null);
                // Reset AutomationProgress too — it listens for this event
                ipcRenderer?.emit('results-window:set-prompt');
              }}
            />
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
