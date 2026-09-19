import { useState, useEffect, useRef, useCallback, useMemo, startTransition, useDeferredValue } from 'react';
import { useDynamicHeight, MAX_HEIGHT } from './utils/useDynamicHeight';
const ipcRenderer = (window as any).electron?.ipcRenderer;
import { playThinkDropSound, playDropSound, playIntentSound, playDefaultSound } from '../utils/thinkDropSound';

// Debug logging flag — gates high-frequency renderer logs (per-LLM-chunk,
// submit-path) that spam the devtools console and cost render time on hot
// paths. Flip to true to debug streaming/submit issues.
const DEBUG_LOG = false;
const dbg = (...args: any[]) => { if (DEBUG_LOG) console.log(...args); };
import {
  CronTab,
  SkillsTab,
  ConnectionsTab,
  AgentsTab,
  BrainTab,
  type TabId,
  type ThoughtItem,
} from './TabComponents';
import { QueueTaskList, type CommsTask } from './QueueTaskCard';
import type { WebResultItem } from './rich-content/WebResultCard';
import { SlideoutDrawer } from './SlideoutDrawer';
import { SettingsTab } from './SettingsTab';
import { RulesManagementPanel } from './RulesManagementPanel';
import { PromptInputBar, type PromptInputBarHandle } from './PromptInputBar';
import { OverlayStyles } from './OverlayStyles';
import { LearnModeOverlay, type LearnModeState } from './LearnModeOverlay';
import { HighlightDebugPanel } from './HighlightDebugPanel';
import { OverlayHeader } from './OverlayHeader';
import { ResultsContent, type SkillBuildState, type BridgeStatus, type SearchSource, type ActionChip, type InstallPrompt, type SchedulePending } from './ResultsContent';
import { ResultsFeed, friendlyErrorMessage, type FeedEntry } from './ResultsFeed';
import type { RunSummary } from './AutomationProgress';

// New entries: FeedEntry minus the assigned fields (id/ts optional). The
// conditional distributes over the union so each variant keeps its props.
type FeedEntryInput = FeedEntry extends infer T
  ? T extends FeedEntry ? Omit<T, 'id' | 'ts'> & { id?: string; ts?: number } : never
  : never;
// TrainingBanner removed — training now handled by TrainingPanel in AgentsTab
import { TeachMeDialog } from './TeachMeDialog';
import type { AIActivityPanelHandle } from './AIActivityPanel';

// --- Types (imported from TabComponents for compatibility) ---
import type { QueueItem, CronItem, SkillItem, ConnectionItem, AgentItem } from './TabComponents';

interface PromptQueueItem {
  id: string;
  message: string;
  status: 'running' | 'done' | 'error';
  responseLanguage?: string | null;
}

interface TrainingModeState {
  active: boolean;
  agentId: string | null;
  hostname: string | null;
  phase: 'observing' | 'teach_me' | 'review' | 'testing' | 'generating';
  narrative: Array<{ timestamp: number; action: string; description: string }>;
  teachMeQuestion?: string;
  teachMeOptions?: string[];
  testResult?: { success: boolean; message: string };
  generatedSkill?: { name: string; parameters: string[] };
}

// --- Components ---
export function UnifiedOverlay() {
  // --- Tab State ---
  const [activeTab, setActiveTab] = useState<TabId | 'settings' | 'rules'>('results');
  // Deferred tab value: TabBar highlight uses activeTab (urgent — instant on click),
  // tab content display styles + useDynamicHeight use deferredTab (non-blocking swap).
  const deferredTab = useDeferredValue(activeTab);
  const [isSlideoutOpen, setIsSlideoutOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [unreadTabs, setUnreadTabs] = useState<Set<TabId>>(new Set());

  // questionAlert: assistant is blocked on a question (ask_user / grill
  // batch) — click navigates to where the QuestionCard lives. Proactive
  // thought-engine outreach now lands directly in the Results feed.
  const [questionAlert, setQuestionAlert] = useState<{ text: string; tab: 'queue' | 'results'; ts: number } | null>(null);

  // Modal card element — when set (modal open), useDynamicHeight grows the window
  // to fit the modal's full content. Cleared automatically when the modal unmounts.
  const [modalCardEl, setModalCardEl] = useState<HTMLDivElement | null>(null);

  // --- Prompt Input State ---
  // promptText, promptHistory, terminalHistory, and textareaRef now live in
  // PromptInputBar so typing doesn't re-render the entire overlay.
  const [highlights, setHighlights] = useState<string[]>([]);
  // "Continue Thread" — task discussion pinned as context for the next prompt.
  const [threadContext, setThreadContext] = useState<{ taskId: string; sessionId: string | null; prompt: string; result: string | null } | null>(null);
  const [copyButtonGlowing, setCopyButtonGlowing] = useState(false);
  const [_isRecording, setIsRecording] = useState(false);
  // Skill panel removed - now in slideout
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [preflightAuthPending, setPreflightAuthPending] = useState(false);
  const preflightAuthPendingRef = useRef(false);
  useEffect(() => { preflightAuthPendingRef.current = preflightAuthPending; }, [preflightAuthPending]);

  // --- Results State ---
  const [streamingResponse, setStreamingResponse] = useState('');
  const [resultItems, setResultItems] = useState<WebResultItem[]>([]);

  // --- Conversation feed ---
  // Committed timeline: user bubbles, assistant messages, collapsed run cards,
  // proactive outreach, system lines. The live exchange (streamingResponse,
  // AutomationProgress, question cards) renders below it and settles into
  // entries when the run completes.
  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([]);
  const feedEntriesRef = useRef<FeedEntry[]>([]);
  // Recently-appended user prompts — synchronous dedupe log. Unlike
  // feedEntriesRef (synced via useEffect → lags a render cycle), this is
  // updated inside appendUserEntry itself, so submit → set-prompt echo →
  // task:created all see each other immediately even when other entry kinds
  // (run cards, system lines) interleave.
  const recentUserPromptsRef = useRef<{ text: string; ts: number }[]>([]);
  useEffect(() => { feedEntriesRef.current = feedEntries; }, [feedEntries]);
  const feedSeqRef = useRef(0);
  // Live AutomationProgress hides once its run summary commits to the feed —
  // the collapsed run entry represents it. Unhidden on the next prompt.
  const [liveRunHidden, setLiveRunHidden] = useState(false);
  // Mirrors of streamed state for commit-time reads — IPC handlers are mounted
  // once so state closures are stale; refs hold the latest values.
  const streamAccRef = useRef('');       // accumulated text of the current stream segment
  const streamSegmentRef = useRef('');   // last completed segment (committed at done/all_done)
  const placeholderStreamRef = useRef(false); // stream was a handoff placeholder (task:complete patches it)
  const resultItemsRef = useRef<WebResultItem[]>([]);
  const searchSourcesRef = useRef<SearchSource[]>([]);
  const lastPromptRef = useRef('');      // last user text — stored on entries for redo
  // History pagination (conversation-service). sessionBoundary: entries logged
  // after mount are live entries — history pages only look strictly older.
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const historyCursorRef = useRef<string | null>(null);
  const historyLoadingRef = useRef(false);
  const hasMoreHistoryRef = useRef(false);
  const sessionBoundaryRef = useRef<string>(new Date().toISOString());
  const pendingPrependRef = useRef<{ prevScrollHeight: number } | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingElapsed, setThinkingElapsed] = useState(0);
  const [isTaskWorking, setIsTaskWorking] = useState(false);
  const [isAutomationMode, setIsAutomationMode] = useState(false);
  const isAutomationModeRef = useRef(false);
  useEffect(() => { isAutomationModeRef.current = isAutomationMode; }, [isAutomationMode]);
  // Track elapsed time while thinking — for progressive status messages
  useEffect(() => {
    if (!isThinking) { setThinkingElapsed(0); return; }
    const interval = setInterval(() => {
      setThinkingElapsed(s => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isThinking]);
  const [streamingStartedRef, setStreamingStartedRef] = useState(false);
  const [actionChips, setActionChips] = useState<ActionChip[]>([]);
  const [searchSources, setSearchSources] = useState<SearchSource[]>([]);
  const [showSourcesPanel, setShowSourcesPanel] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [isDropping, setIsDropping] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  
  // --- Debug Terminal State ---
  const [isDebugMode] = useState(false);
  
  // --- Highlight Debug State ---
  const [showHighlightDebug, setShowHighlightDebug] = useState(false);
  const [highlightQuery, setHighlightQuery] = useState('');
  const [, setActiveHighlight] = useState<string | null>(null);
  
  // Ref to AIActivityPanel for executing terminal commands
  const aiActivityPanelRef = useRef<AIActivityPanelHandle>(null);

  // Imperative handle to PromptInputBar — used for voice inject + focus.
  const promptInputBarRef = useRef<PromptInputBarHandle>(null);
  

  // --- Gather Context State (like StandalonePromptCapture) ---
  const [gatherPending, setGatherPending] = useState(false);
  const [gatherQuestion, setGatherQuestion] = useState<string | null>(null);
  const [isGlowActive, setIsGlowActive] = useState(false);

  // --- AI Activity Panel Status ---
  // const isRunning = isSubmitting || isStreaming || isThinking || isAutomationMode || isInstalling || gatherPending;

  // --- Queue/Cron/Skills/Connections/Agents State ---
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [cronItems, setCronItems] = useState<CronItem[]>([]);
  const [skillItems, setSkillItems] = useState<SkillItem[]>([]);
  const [connectionItems, setConnectionItems] = useState<ConnectionItem[]>([]);
  const [agentItems, setAgentItems] = useState<AgentItem[]>([]);
  const [promptQueueItems, setPromptQueueItems] = useState<PromptQueueItem[]>([]);
  const [brainThoughts, setBrainThoughts] = useState<ThoughtItem[]>([]);
  const [restartAlert, setRestartAlert] = useState<{ items: PromptQueueItem[] } | null>(null);

  // --- comms-graph task state (concurrent handoff tasks) ---
  const [commsTasks, setCommsTasks] = useState<CommsTask[]>([]);
  // taskNotification state retired — TaskCompleteBanner commented out; feed
  // run cards handle completion/approval surfacing.
  // Deep-link target for the queue tab — set when navigating from a notification
  const [queueFocus, setQueueFocus] = useState<{ taskId: string; status?: string; nonce: number } | null>(null);

  // --- Skill Build State ---
  const [skillBuild, setSkillBuild] = useState<SkillBuildState | null>(null);
  const pendingInstallRef = useRef<((confirmed: boolean) => void) | null>(null);

  // --- Agent Training State ---
  const [trainingMode, setTrainingMode] = useState<TrainingModeState | null>(null);

  // --- Agent Learn State ---
  const [learnMode, setLearnMode] = useState<LearnModeState | null>(null);

  // --- UI State ---
  const [schedulePending, setSchedulePending] = useState<SchedulePending | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  // --- Voice session (hidden-Chrome voice bridge via voice-service) ---
  // active → PromptInputBar swaps the textarea for VoiceBars + transcript line.
  const [voiceSession, setVoiceSession] = useState<{
    active: boolean;
    state: string;      // ready | listening | speaking | processing | idle | error
    interimText: string;
    finalText: string;
    level: number;      // 0..1 mic amplitude
  }>({ active: false, state: 'idle', interimText: '', finalText: '', level: 0 });
  const _lastVoiceLevelAtRef = useRef(0);
  // const [, setPromptTextHeader] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const resultsMeasureRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollBottomRef = useRef<HTMLDivElement>(null);
  // Fixed sections measured by useDynamicHeight (intrinsic content height, not the clipped root).
  const headerRef = useRef<HTMLDivElement>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);

  // --- Tab Content Refs for Dynamic Height ---
  const queueTabRef = useRef<HTMLDivElement>(null);
  const cronTabRef = useRef<HTMLDivElement>(null);
  const agentsTabRef = useRef<HTMLDivElement>(null);
  const skillsTabRef = useRef<HTMLDivElement>(null);
  const connectionsTabRef = useRef<HTMLDivElement>(null);
  // const storeTabRef = useRef<HTMLDivElement>(null); // Store tab removed
  const settingsTabRef = useRef<HTMLDivElement>(null);
  const rulesTabRef = useRef<HTMLDivElement>(null);
  const brainTabRef = useRef<HTMLDivElement>(null);

  // --- Glow Timer Ref ---
  const glowOffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Install Output Scroll Ref ---
  const installOutputRef = useRef<HTMLDivElement>(null);

  // --- Drop Sound Ref ---
  const hasDroppedRef = useRef(false);

  // --- Stream completion tracker ---
  // Flips to true when a 'done' message arrives. On the first chunk of the NEXT
  // stream we detect this and clear streamingResponse before appending, preventing
  // old content from being prepended to the new answer (the race-condition double).
  const streamCompletedRef = useRef(false);

  // --- Stable token for token-based IPC deduplication ---
  // Stable across renders; preload uses it to ensure exactly one listener per channel.
  const listenerToken = useRef('unified-overlay');
  const _playedIntentSoundRef = useRef(new Set<string>()); // Dedup intent sounds per task

  // --- Dragging State ---
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);   // Synchronous — safe to read inside ResizeObserver/setTimeout closures
  const isResizingRef = useRef(false);   // True while native window resize handle is active
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragOffsetX = useRef(0);
  const dragOffsetY = useRef(0);
  // Epoch ms until which content-driven resize is suppressed after a manual collapse click.
  const manualCollapseUntilRef = useRef(0);
  // Epoch ms of the last mouseup — keeps resize suppressed briefly after a
  // drag ends so a queued/debounced set-content-height can't snap the window.
  const dragEndedAtRef = useRef(0);
  const dragRafRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);

  // Suppress all resize IPC while user is dragging, using the native resize handle,
  // within the brief hold window after a manual collapse via the width toggle, or
  // just after a drag ends (a queued animated setBounds mid/post-drag = visible snap).
  const shouldSuppressResize = () =>
    isDraggingRef.current || isResizingRef.current ||
    Date.now() < manualCollapseUntilRef.current ||
    Date.now() - dragEndedAtRef.current < 180;

  // --- Dynamic Height Management ---
  // Single consolidated pipeline: measures fixed sections (header + input bar)
  // plus the ACTIVE tab's intrinsic content height. `results` points at the INNER
  // auto-height content div (contentRef) — NOT the h-full scroll container, whose
  // scrollHeight can't drop below its window-constrained clientHeight (ratchet).
  // Collapse is measurement-driven: results content ~0 → COLLAPSED_HEIGHT.
  // Sends one IPC (unified:set-content-height); main owns clamping + anchoring.
  const contentRefs = useMemo(() => ({
    results: resultsMeasureRef,
    queue: queueTabRef,
    cron: cronTabRef,
    agents: agentsTabRef,
    skills: skillsTabRef,
    connections: connectionsTabRef,
    // store: storeTabRef, // Store tab removed
    settings: settingsTabRef,
    rules: rulesTabRef,
    brain: brainTabRef,
  }), []);

  // Memoized tab badge counts — avoids recompute on every parent render.
  const queueCount = useMemo(() =>
    queueItems.filter(i => i.status !== 'done').length + promptQueueItems.length,
    [queueItems, promptQueueItems]
  );
  const cronCount = useMemo(() =>
    cronItems.filter(i => i.status === 'active').length,
    [cronItems]
  );

  const { measureNow } = useDynamicHeight({
    activeTab: deferredTab,
    headerRef,
    inputBarRef,
    contentRefs,
    overlayEl: modalCardEl,
    getWidth: () => (isExpanded ? 900 : 400),
    // While expanded, pin the window at MAX_HEIGHT (expand = 900xMAX).
    // NOTE: isScrolledUp intentionally does NOT force height — scroll/hover
    // resize caused visible snapping; the feed scrolls inside the panel.
    forceHeight: isExpanded ? MAX_HEIGHT : null,
    debounceMs: 120,
    suppress: shouldSuppressResize,
  });

  // --- Width Toggle ---
  // Expand  → 900 wide + MAX_HEIGHT (pinned while expanded, see forceHeight below).
  //              Stashes current bounds in main so collapse can return to them.
  // Collapse → 400 wide, restore pre-expand bounds (position + size), then
  //              re-measure so the height tracks actual content at 400 width
  //              (empty results → COLLAPSED_HEIGHT, populated → content height).
  const toggleWidth = useCallback(() => {
    const newExpanded = !isExpanded;
    console.log('[Width Toggle] Toggling to:', newExpanded ? 'expanded (900xMAX)' : 'compact (restore+measure)');
    setIsExpanded(newExpanded);
    if (newExpanded) {
      // Save current bounds so collapse can return to this exact spot.
      ipcRenderer?.send('unified:set-content-height', { width: 900, height: MAX_HEIGHT, animate: true, saveBounds: true });
    } else {
      // Suppress content-driven re-growth briefly so the width-collapse reflow
      // doesn't immediately undo the user's collapse click. 200ms covers the
      // reflow; measureNow() right after re-snaps height to real content.
      manualCollapseUntilRef.current = Date.now() + 200;
      // Restore pre-expand bounds (no height override — main uses stashed size).
      ipcRenderer?.send('unified:set-content-height', { width: 400, animate: true, restoreBounds: true });
      // After the reflow hold, re-measure so height tracks content at 400 width.
      setTimeout(() => {
        manualCollapseUntilRef.current = 0;
        measureNow();
      }, 220);
    }
    console.log('[Width Toggle] Sent IPC unified:set-content-height');
  }, [isExpanded, measureNow]);

  // --- Feed helpers ---
  const appendFeedEntry = useCallback((e: FeedEntryInput): string => {
    const id = e.id || `fe_${Date.now()}_${feedSeqRef.current++}`;
    const ts = e.ts ?? Date.now();
    setFeedEntries(prev => [...prev, { ...e, id, ts } as FeedEntry]);
    return id;
  }, []);

  const patchFeedEntry = useCallback((id: string, updates: Partial<FeedEntry>) => {
    setFeedEntries(prev => prev.map(e => (e.id === id ? ({ ...e, ...updates } as FeedEntry) : e)));
  }, []);

  const patchFeedEntryByTask = useCallback((taskId: string, updates: Partial<FeedEntry>) => {
    setFeedEntries(prev => prev.map(e =>
      (e.kind === 'assistant' || e.kind === 'run') && e.taskId === taskId
        ? ({ ...e, ...updates } as FeedEntry)
        : e
    ));
  }, []);

  // User-bubble append with dedupe — local submit, the unified:set-prompt
  // echo, and task:created all fire for the same prompt. The echo carries the
  // full wrapped text (highlight tags + thread context) so match on suffix,
  // not equality. Dedupe state lives in recentUserPromptsRef (synchronous) —
  // not feedEntriesRef — so rapid interleaved appends can't slip through.
  const appendUserEntry = useCallback((text: string) => {
    const clean = (text || '').trim();
    if (!clean) return;
    const now = Date.now();
    recentUserPromptsRef.current = recentUserPromptsRef.current.filter(p => now - p.ts < 4000);
    const isDup = recentUserPromptsRef.current.some(p =>
      p.text === clean || clean.endsWith(p.text) || p.text.endsWith(clean));
    if (isDup) return;
    recentUserPromptsRef.current.push({ text: clean, ts: now });
    lastPromptRef.current = clean;
    appendFeedEntry({ kind: 'user', text: clean });
  }, [appendFeedEntry]);

  // Commit any in-flight (un-'done') stream text before a new prompt wipes it —
  // otherwise a resubmit mid-stream silently drops the partial AI message.
  const commitInFlightStream = useCallback(() => {
    const text = streamAccRef.current;
    if (!text || !text.trim()) return;
    appendFeedEntry({
      kind: 'assistant',
      text,
      items: resultItemsRef.current,
      sources: searchSourcesRef.current,
      prompt: lastPromptRef.current || undefined,
    });
    streamAccRef.current = '';
    placeholderStreamRef.current = false;
  }, [appendFeedEntry]);

  // Active exchange = the last user entry onward (drives window height).
  const activeExchangeId = useMemo(() => {
    for (let i = feedEntries.length - 1; i >= 0; i--) {
      if (feedEntries[i].kind === 'user') return feedEntries[i].id;
    }
    return null;
  }, [feedEntries]);

  const scrollToBottom = useCallback(() => {
    scrollBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  // Page older history in from the conversation service (20 at a time).
  // endDate bounds pages strictly below the session boundary so live entries
  // never collide with fetched history.
  const requestHistoryPage = useCallback((endDate: string | null) => {
    if (!ipcRenderer || historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    ipcRenderer.send('conversation:list', { limit: 20, endDate, sortOrder: 'DESC' });
  }, []);

  const loadOlderHistory = useCallback(() => {
    if (!hasMoreHistoryRef.current || historyLoadingRef.current) return;
    const container = scrollContainerRef.current;
    pendingPrependRef.current = container ? { prevScrollHeight: container.scrollHeight } : null;
    requestHistoryPage(historyCursorRef.current);
  }, [requestHistoryPage]);

  // After older entries prepend, keep the viewport anchored where the user was.
  useEffect(() => {
    const pending = pendingPrependRef.current;
    const container = scrollContainerRef.current;
    if (!pending || !container) return;
    pendingPrependRef.current = null;
    container.scrollTop += container.scrollHeight - pending.prevScrollHeight;
  }, [feedEntries]);

  // --- Tab Switching ---
  const handleTabSelect = useCallback((tab: TabId | 'settings' | 'rules') => {
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
    } else if (tab === 'agents') {
      ipcRenderer?.send('agents:list');
    } else if (tab === 'brain') {
      ipcRenderer?.send('thoughts:list');
    }
  }, []);

  // --- Slideout Navigation ---
  const handleSlideoutNavigate = useCallback((tab: TabId | 'settings' | 'rules') => {
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
    } else if (tab === 'agents') {
      ipcRenderer?.send('agents:list');
    } else if (tab === 'brain') {
      ipcRenderer?.send('thoughts:list');
    }
  }, []);

  // --- Submit handler (called by PromptInputBar with text + highlights + gatherPending) ---
  // The child already cleared its own promptText via flushSync (fast — small component).
  // This handler resets parent state via startTransition (non-blocking) + sends the IPC.
  // The browser paints the child's text clear first, then "Thinking…" appears after the
  // transition renders the parent — no 0.5-1s freeze blocking the paint.
  const handleSubmitFromInputBar = useCallback(async (finalPromptText: string, finalHighlights: string[], wasGatherPending: boolean) => {
    dbg('🚀 [UNIFIED] handleSubmit called');

    // Preserve any still-streaming AI text before the reset below wipes it —
    // a resubmit mid-stream shouldn't silently drop the partial message.
    commitInFlightStream();

    // Reset parent state via startTransition — non-blocking, lets the browser paint
    // the child's cleared text before the parent re-renders.
    startTransition(() => {
      setHighlights([]);
      setStreamingResponse('');
      setResultItems([]);
      setSearchSources([]);
      setIsStreaming(false);
      setIsThinking(true);
      setIsSubmitting(true); // Show cancel/stop button during preflight and automation
      setIsAutomationMode(false);
      setInstallPrompt(null);
      setActionChips([]);
      setInstallOutput([]);
      setGatherPending(false);
      setGatherQuestion(null);
      setLiveRunHidden(false);
      setStreamingStartedRef(false);
    });
    streamAccRef.current = '';
    hasDroppedRef.current = false;

    if (!finalPromptText.trim() && finalHighlights.length === 0) {
      dbg('⚠️ [UNIFIED] No text or highlights, skipping submit');
      setIsThinking(false);
      setIsSubmitting(false);
      return;
    }
    if (isSubmitting && !wasGatherPending) {
      setIsThinking(false);
      return;
    }

    // Handle gather flow - just send answer (state already reset above)
    if (wasGatherPending) {
      dbg('📋 [UNIFIED] gather:pending was active — routing to gather:answer');
      ipcRenderer?.send('gather:answer', { answer: finalPromptText.trim() });
      return; // Return after sending gather answer (state is already reset)
    }

    playThinkDropSound();

    let finalPrompt = '';

    // "Continue Thread" — inject the recalled task's context so the next prompt
    // continues that discussion even without a session pin (belt-and-suspenders:
    // sessionId covers sliding-window history; this excerpt guarantees context).
    if (threadContext) {
      // 12000 chars keeps full code snippets/documents intact (the old 2000 cap
      // cut mid-file) while staying well under the 50k message limit.
      const rawResult = (threadContext.result || '').replace(/【[^】]*】/g, '').trim();
      const excerpt = rawResult.length > 12000
        ? rawResult.slice(0, 12000) + '\n… [truncated — full result retained in session history]'
        : rawResult;
      finalPrompt += `[Resumed task discussion]\nEarlier request: "${threadContext.prompt}"\n`;
      if (excerpt) finalPrompt += `Earlier result (excerpt):\n${excerpt}\n`;
      finalPrompt += '\n';
    }

    if (finalHighlights.length > 0) {
      finalPrompt += finalHighlights.map(h =>
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
      appendFeedEntry({ kind: 'system', text: '⚠️ Message too long — trim highlights or split into multiple parts.' });
      setIsSubmitting(false);
      return;
    }

    dbg('📤 [UNIFIED] Final prompt to send:', finalPrompt.trim());
    dbg('🔍 [UNIFIED] ipcRenderer available?', !!ipcRenderer);

    // Commit the user bubble + zoom the window to the fresh exchange
    appendUserEntry(finalPromptText);
    scrollToBottom();

    // Send to main process - match StandalonePromptCapture exactly
    ipcRenderer?.send('prompt-queue:submit', {
      prompt: finalPrompt.trim(),
      selectedText: finalHighlights.join('\n'),
      sessionId: threadContext?.sessionId || undefined,
    });
    setThreadContext(null); // one-shot chip — the session stays current via resolvedSessionId
    dbg('✅ [UNIFIED] Prompt enqueued');

    // Note: isSubmitting stays true until task completes (handled in all_done)
  }, [isSubmitting, threadContext, appendUserEntry, appendFeedEntry, scrollToBottom, commitInFlightStream]);

  const handleHighlightRemove = useCallback((index: number) => {
    setHighlights(prev => prev.filter((_, i) => i !== index));
  }, []);

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
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
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
  }, [highlights]);

  // --- Voice Recording ---
  // const toggleRecording = () => {
  //   if (isRecording) {
  //     ipcRenderer?.send('voice:stop-recording');
  //   } else {
  //     ipcRenderer?.send('voice:start-recording');
  //   }
  // };

  // --- File Attach ---
  const handleAttachClick = useCallback(() => {
    ipcRenderer?.send('dialog:open-file');
  }, []);

  // --- Stable callbacks for memoized tab components ---
  // These are wrapped in useCallback so that React.memo on the tab components
  // actually works — without this, inline arrow functions create new refs on
  // every parent render (e.g. every keystroke) and force all tabs to re-render.
  const handleCronToggle = useCallback((item: any) => ipcRenderer?.send('cron:toggle', { id: item.id }), []);
  const handleCronDelete = useCallback((item: any) => ipcRenderer?.send('cron:delete', { id: item.id }), []);
  const handleCronRerun = useCallback((item: any) => ipcRenderer?.send('cron:run-now', { id: item.id }), []);
  const handleAgentsRefresh = useCallback(() => ipcRenderer?.send('agents:list'), []);
  const handleSkillsSaveSecret = useCallback((skillName: string, key: string, value: string) => ipcRenderer?.send('skills:save-secret', { skillName, key, value }), []);
  const handleSkillsOpenCode = useCallback((filePath: string) => ipcRenderer?.send('skills:open-code', { filePath }), []);
  const handleSkillsOAuthConnect = useCallback((skillName: string, provider: string, tokenKey: string, scopes: any) => ipcRenderer?.send('skills:oauth-connect', { skillName, provider, tokenKey, scopes }), []);
  const handleSkillsScopesChange = useCallback((skillName: string, provider: string, scopes: any) => ipcRenderer?.send('skills:update-oauth-scopes', { skillName, provider, scopes }), []);
  const handleSkillsRepairOAuth = useCallback((skillName: string) => ipcRenderer?.send('skills:repair-oauth', { skillName }), []);
  const handleSkillsDelete = useCallback((skillName: string) => ipcRenderer?.send('skills:delete', { skillName }), []);
  const handleSkillsInstallFromUrl = useCallback((url: string, nameOverride?: string, descriptionOverride?: string) => ipcRenderer?.send('skill:install-from-url', { url, nameOverride, descriptionOverride }), []);
  const handleSkillsInstallFromFile = useCallback((filePath: string, nameOverride?: string, descriptionOverride?: string) => ipcRenderer?.send('skill:install-from-file', { filePath, nameOverride, descriptionOverride }), []);
  const handleSkillsRefresh = useCallback(() => ipcRenderer?.send('skills:list'), []);
  const handleConnectionsConnect = useCallback((provider: string, tokenKey: string, scopes: any) => ipcRenderer?.send('connections:connect', { provider, tokenKey, scopes }), []);
  const handleConnectionsDisconnect = useCallback((provider: string, tokenKey: string) => ipcRenderer?.send('connections:disconnect', { provider, tokenKey }), []);
  const handleConnectionsRefresh = useCallback(() => ipcRenderer?.send('connections:list'), []);
  const handleThoughtDecide = useCallback((id: string, decision: 'approve' | 'dismiss' | 'snooze', minutes?: number) => {
    ipcRenderer?.send('thought:decide', { id, decision, minutes });
  }, []);
  const handleThoughtsRefresh = useCallback(() => ipcRenderer?.send('thoughts:list'), []);
  // "Continue Thread" — load the task's result into the Results tab AND pin its
  // discussion as context (chip + sessionId) for the user's next prompt.
  const handleContinueThread = useCallback((task: any) => {
    if (task.result) {
      appendFeedEntry({
        kind: 'assistant',
        text: task.result,
        items: task.items || undefined,
        taskId: task.id,
        prompt: task.prompt || undefined,
      });
      setActiveTab('results');
      scrollToBottom();
    }
    setThreadContext({
      taskId: task.id,
      sessionId: task.sessionId || null,
      prompt: task.prompt || '',
      result: task.result || null,
    });
  }, [appendFeedEntry, scrollToBottom]);
  const handleThreadContextClear = useCallback(() => setThreadContext(null), []);
  const handleQueueHeightChange = useCallback(() => {
    if (shouldSuppressResize()) return;
    measureNow();
  }, [shouldSuppressResize, measureNow]);
  const handleQueueFocusHandled = useCallback(() => setQueueFocus(null), []);

  // --- Learn Mode callbacks (stabilized for LearnModeOverlay memo) ---
  const handleLearnCancel = useCallback((agentId: string) => {
    ipcRenderer?.send('agents:learn-cancel', { agentId });
  }, []);
  const handleLearnDone = useCallback(() => {
    setLearnMode(null);
    setActiveTab('agents');
  }, []);

  // --- Highlight Debug callbacks (stabilized for HighlightDebugPanel memo) ---
  const handleHighlightDebugExecute = useCallback((query: string) => {
    let action: string, searchText: string | undefined;
    if (query === 'all') {
      action = 'highlight_all';
    } else if (query === 'boundaries') {
      action = 'highlight_boundaries';
    } else if (query === 'assets') {
      action = 'highlight_assets';
    } else {
      action = 'highlight_search';
      searchText = query;
    }
    fetch('http://localhost:3007/app.agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, searchText, duration: 0 }),
    });
    setShowHighlightDebug(false);
    setHighlightQuery('');
    setActiveHighlight(action);
  }, []);

  const handleHighlightDebugClose = useCallback(() => {
    setShowHighlightDebug(false);
    setHighlightQuery('');
    fetch('http://localhost:3007/app.agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear_highlights' }),
    });
    setActiveHighlight(null);
  }, []);

  // --- Window Controls ---
  const handleClose = useCallback(() => {
    ipcRenderer?.send('window:hide');
  }, []);

  const handleCopy = useCallback(() => {
    const lastAssistant = [...feedEntriesRef.current].reverse().find(e => e.kind === 'assistant' && e.text);
    const text = streamingResponse
      || (lastAssistant && lastAssistant.kind === 'assistant' ? lastAssistant.text : '')
      || '';
    if (text) {
      ipcRenderer?.send('clipboard:write-text', text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  }, [streamingResponse]);

  // --- Feed row actions ---
  const handleFeedCopy = useCallback((text: string) => {
    ipcRenderer?.send('clipboard:write-text', text);
  }, []);

  const handleFeedRedo = useCallback((prompt: string) => {
    ipcRenderer?.send('prompt-queue:submit', { prompt, selectedText: '' });
  }, []);

  const handleFeedPlanApprove = useCallback((taskId: string, planFile: string | null) => {
    ipcRenderer?.send('plan:approve', { taskId, planFile });
  }, []);

  const handleFeedPlanCancel = useCallback((taskId: string, planFile: string | null) => {
    ipcRenderer?.send('plan:cancel', { taskId, planFile });
  }, []);

  const handleFeedOpenPath = useCallback((path: string) => {
    ipcRenderer?.send('shell:open-path', path);
  }, []);

  const handleToggleSlideout = useCallback(() => {
    setIsSlideoutOpen(prev => !prev);
  }, []);

  // --- Click outside handler for sources panel ---
  useEffect(() => {
    if (!showSourcesPanel) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const panel = document.querySelector('[data-sources-panel]');
      const button = document.querySelector('[data-sources-button]');
      
      if (panel && !panel.contains(target) && button && !button.contains(target)) {
        setShowSourcesPanel(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSourcesPanel]);

  // --- Clear copy-button pulse on any click inside the overlay ---
  // The copy capture button's onClick (sends copy-button:click) fires first in
  // the bubble phase, so saving still works. Any other click clears the glow
  // and tells main to discard the stored captured text.
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (!copyButtonGlowing) return;
    const target = e.target as HTMLElement;
    if (target?.closest?.('#copy-capture-button')) return;
    setCopyButtonGlowing(false);
    ipcRenderer?.send('copy-button:clear');
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
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left mouse
    if (!ipcRenderer) return;

    isDraggingRef.current = true; // Set ref synchronously — readable in any closure immediately
    setIsDragging(true);
    const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffsetX.current = e.clientX - bounds.left;
    dragOffsetY.current = e.clientY - bounds.top;
    console.log('[Drag] Mouse down - starting drag');
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!ipcRenderer) return;
      const newX = Math.round(e.screenX - dragOffsetX.current);
      const newY = Math.round(e.screenY - dragOffsetY.current);
      if (!Number.isFinite(newX) || !Number.isFinite(newY)) return;
      // rAF-throttle: raw mousemove can fire faster than the main process can
      // apply setPosition — queued IPCs make the window lag then jump to catch
      // up. Coalesce to one move per frame.
      pendingMoveRef.current = { x: newX, y: newY };
      if (dragRafRef.current == null) {
        dragRafRef.current = requestAnimationFrame(() => {
          dragRafRef.current = null;
          const p = pendingMoveRef.current;
          if (p) ipcRenderer.send('window:move', p);
        });
      }
    };

    const handleMouseUp = () => {
      // Flush any pending coalesced move so the window ends under the cursor.
      if (dragRafRef.current != null) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null; }
      const p = pendingMoveRef.current;
      if (p) { ipcRenderer?.send('window:move', p); pendingMoveRef.current = null; }
      dragEndedAtRef.current = Date.now(); // post-drag resize suppression window
      isDraggingRef.current = false; // Clear ref synchronously
      setIsDragging(false);
      // Tell main to clamp the panel back into the work area (animated snap-back
      // if the user dragged it partly off-screen). We don't clamp during
      // mousemove because that would fight the cursor.
      ipcRenderer?.send('window:move-done');
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

    // NOTE: Token-based deduplication in preload ensures exactly one listener per channel.
    // The 'unified-overlay' token automatically evicts any stale listener on re-registration.

    // --- Results / Streaming ---
    const handleWsMessage = (message: { type: string; text?: string; lane?: string; payload?: any; taskId?: string; isPlaceholder?: boolean }) => {
      if (!message) return;
      const preview = message.text ? `"${message.text.substring(0, 50)}${message.text.length > 50 ? '...' : ''}"` : '(no text)';
      dbg(`[UNIFIED:DIAG] msg.type=${message.type} lane=${message.lane} preview=${preview} curRespLen=${streamingResponse.length}`);
      dbg('📨 [UNIFIED] WebSocket message received:', message.type, preview, 'lane:', message.lane, 'full message:', message);

      if (message.type === 'chunk' || message.type === 'llm_stream_chunk') {
        dbg('💬 [UNIFIED] Received chunk, length:', message.text?.length || 0);
        setIsThinking(false);
        setIsStreaming(true);
        if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
        setIsGlowActive(true);

        // Defensive: reset automation mode if we're receiving regular content (not automation)
        // This catches cases where a new non-automation prompt starts but automation UI persists
        if (isAutomationMode && !message.lane?.includes('automation') && !streamingResponse) {
          dbg('🔄 [UNIFIED] First chunk on new prompt - resetting automation mode');
          setIsAutomationMode(false);
          setActionChips([]);
          setInstallPrompt(null);
        }

        // Play drop sound once when streaming starts (skip for fast lane and
        // handoff placeholder chunks — the drip is for the real answer only)
        if (!hasDroppedRef.current && message.lane !== 'fast' && !message.isPlaceholder) {
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
          dbg('🔄 [UNIFIED] New stream started after completion — will clear previous response');
        }

        const msgText = message?.text || message.payload?.text || '';
        if (msgText.startsWith('\x00SOURCES\x00')) {
          try {
            const sources = JSON.parse(msgText.slice('\x00SOURCES\x00'.length));
            if (Array.isArray(sources)) { setSearchSources(sources); searchSourcesRef.current = sources; }
          } catch (_) {}
          return;
        } else if (msgText.startsWith('\x00ITEMS\x00')) {
          try {
            const items = JSON.parse(msgText.slice('\x00ITEMS\x00'.length));
            if (Array.isArray(items)) { setResultItems(items); resultItemsRef.current = items; }
          } catch (_) {}
          return;
        } else if (msgText.startsWith('\x00REPLACE\x00')) {
          const newText = msgText.slice('\x00REPLACE\x00'.length);
          dbg('🔄 [UNIFIED] Replacing text, new length:', newText.length);
          streamAccRef.current = newText;
          setStreamingResponse(newText);
        } else {
          dbg('➕ [UNIFIED] Appending text, length:', msgText.length);
          if (message.isPlaceholder) placeholderStreamRef.current = true;
          setStreamingResponse(prev => {
            // If this is the first chunk of a new stream, discard prev (old answer) atomically.
            const base = isNewStream ? '' : prev;
            const combined = base + msgText;
            streamAccRef.current = combined;
            dbg('📝 [UNIFIED] Combined length:', combined.length, isNewStream ? '(new stream — cleared prev)' : '');
            return combined;
          });
        }
      } else if (message.type === 'done' || message.type === 'llm_stream_end') {
        setIsStreaming(false);
        setIsThinking(false);
        // Don't reset isSubmitting/isAutomationMode during automation — the plan
        // generation LLM stream ends before execution completes, which would
        // prematurely hide the cancel button. Automation cleanup is handled by
        // the 'all_done' event in handleAutomationProgress.
        if (!preflightAuthPendingRef.current && !isAutomationModeRef.current) {
          setIsSubmitting(false); // Task complete - reset cancel button
        }
        if (!isAutomationModeRef.current) {
          setIsAutomationMode(false); // Clear automation status
        }
        streamCompletedRef.current = true;
        dbg('✅ [UNIFIED] Streaming complete, final streamingResponse length:', streamingResponse.length);
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 300);

        // ── Feed commit ─────────────────────────────────────────────────
        // Mid-run 'done's during automation only snapshot the segment — the
        // final commit happens at all_done (plan-gen text is discarded, the
        // synth summary is what settles into the feed).
        if (isAutomationModeRef.current) {
          if (streamAccRef.current.trim()) streamSegmentRef.current = streamAccRef.current;
          streamAccRef.current = '';
        } else {
          const finalText = streamAccRef.current;
          if (finalText.trim()) {
            const wasPlaceholder = placeholderStreamRef.current;
            appendFeedEntry({
              kind: 'assistant',
              text: finalText,
              items: resultItemsRef.current,
              sources: searchSourcesRef.current,
              taskId: message.taskId || undefined,
              pending: wasPlaceholder || undefined,
              prompt: lastPromptRef.current || undefined,
            });
            if (wasPlaceholder) placeholderStreamRef.current = false;
            streamSegmentRef.current = '';
            setStreamingResponse('');
            setResultItems([]);
            setSearchSources([]);
            resultItemsRef.current = [];
            searchSourcesRef.current = [];
          }
          streamAccRef.current = '';
        }
      } else if (message.type === 'ready') {
        dbg('✅ [UNIFIED] VS Code extension ready');
      }
    };

    const handleClear = () => {
      setStreamingResponse('');
      setResultItems([]);
      setSearchSources([]);
      setIsGlowActive(false);
      setIsThinking(false);
      setIsStreaming(false);
      setIsAutomationMode(false);
      setInstallPrompt(null);
      setActionChips([]);
      setInstallOutput([]);
      setGatherPending(false); // Reset gather state
      setGatherQuestion(null);
      setStreamingStartedRef(false); // Reset streaming started flag
      hasDroppedRef.current = false;
      streamCompletedRef.current = false;
      streamAccRef.current = '';
      streamSegmentRef.current = '';
      resultItemsRef.current = [];
      searchSourcesRef.current = [];
      setFeedEntries([]);
      setLiveRunHidden(false);
    };

    const handleSetPrompt = (_text: string) => {
      // Reset all state for new prompt — do NOT setPromptText here,
      // PromptInputBar already cleared it synchronously via flushSync (child-local).
      // Echo of the submitted prompt — commit the user bubble (deduped against
      // the local append in handleSubmitFromInputBar; this also catches
      // external submits like voice injection and queue retries).
      commitInFlightStream(); // preserve any abandoned stream text first
      const clean = (_text || '').trim();
      if (clean) {
        if (clean.startsWith('Building skill:') || clean.startsWith('Skill execution:') ||
            clean.startsWith('Scheduled:')) {
          appendFeedEntry({ kind: 'system', text: clean.length > 140 ? clean.slice(0, 140) + '…' : clean });
        } else {
          appendUserEntry(clean);
        }
      }
      setLiveRunHidden(false);
      streamAccRef.current = '';
      setStreamingResponse('');
      setResultItems([]);
      setSearchSources([]);
      setShowSourcesPanel(false);
      setIsStreaming(false);
      setIsThinking(true);
      setIsSubmitting(true); // Task starting - set submitting state
      setActiveTab('results'); // Auto-switch to results panel
      setIsAutomationMode(false); // AutomationProgress will self-activate on 'planning' event
      // Keep refs in sync immediately — the 'done' handler checks these refs and
      // must see the fresh values when the response completes, not after a render cycle.
      isAutomationModeRef.current = false;
      preflightAuthPendingRef.current = false;
      setInstallPrompt(null);
      setActionChips([]);
      setInstallOutput([]);
      setGatherPending(false); // Reset gather state
      setGatherQuestion(null);
      setStreamingStartedRef(false); // Reset streaming started flag
      if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
      setIsGlowActive(true);
      hasDroppedRef.current = false;
      streamCompletedRef.current = false;
    };

    // --- Automation Progress ---
    const markUnreadTab = (tab: TabId) => {
      setUnreadTabs(prev => {
        const next = new Set(prev);
        next.add(tab);
        return next;
      });
    };

    const handleAutomationProgress = (data: any) => {
      // ── Intent decided (stategraph) — no longer drives sound/••• ──
      // Sound + ••• fire at task:created (comms-graph regex guess) for
      // immediate feedback — by the time intent:decided arrives the moment
      // has passed, so the stategraph's event is kept as a no-op here.
      if (data?.type === 'intent:decided') {
        return;
      }
      if (data?.type === 'reminder_fired') {
        // Scheduled run starting — AIActivityPanel is intentionally disabled, so let
        // AutomationProgress handle the deferred step progress. Do NOT suppress it.
        // Switch to the results tab so the user sees the deferred steps activate.
        if (data?.triggerIntent === 'execute_steps') {
          setIsAutomationMode(true);
          setActiveTab('results');
        }
        return; // Don't trigger planning flow for scheduled runs
      } else if (data?.type === 'planning') {
        setIsThinking(false);
        // NOTE: Do NOT set isAutomationMode here. The 'planning' event fires for
        // ALL queries (including simple ones like "what time is it"). Setting
        // isAutomationMode=true here would prevent the 'done' handler from
        // resetting isSubmitting, leaving the red cancel button stuck.
        // Real automation mode is set by 'plan:generated' / 'plan:found_existing'.
        // Queue-task recovery (retry/resume) re-emits 'planning' tagged with
        // taskId. Don't yank the user off the Queue tab — the QueueTaskCard's
        // own AutomationProgress instance handles task-scoped progress. Only
        // foreground (untagged) planning events switch to the Results tab.
        if (!data?.taskId) {
          setActiveTab('results');
          setInstallPrompt(null);
          setActionChips([]);
        }
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
        // Alert card: task-scoped questions live on the Queue card, global
        // gather questions live here in Results — click navigates to it.
        const qText = data?.question || data?.text || 'I have a question before I continue';
        setQuestionAlert({ text: String(qText), tab: data?.taskId ? 'queue' : 'results', ts: Date.now() });
        // Scroll to the question so the user sees the action-required banner/options
        setTimeout(scrollToBottom, 50);
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
        // Extract structured items from skillResults (web.crawl extractItems, browser.agent extract_items)
        if (Array.isArray(data.skillResults)) {
          const extractedItems = data.skillResults
            .filter((r: any) => r && Array.isArray(r.items) && r.items.length > 0)
            .flatMap((r: any) => r.items)
            .slice(0, 24);
          if (extractedItems.length > 0) {
            setResultItems(extractedItems);
            resultItemsRef.current = extractedItems;
          }
        }
        if (data?.cancelled) {
          // Extra safety: ensure clean state on cancelled tasks
          setPreflightAuthPending(false);
          setIsSubmitting(false);
          setIsThinking(false);
          setIsStreaming(false);
          setIsAutomationMode(false);
          setIsGlowActive(false);
        } else {
          // Task complete — always reset submitting state.
          // (Previously kept isSubmitting=true if preflightAuthPending was stuck,
          //  but all_done means the task is genuinely done regardless of auth state.)
          setPreflightAuthPending(false);
          setIsSubmitting(false);
        }
        setIsAutomationMode(false); // Clear automation status
        setInstallPrompt(null);
        setIsInstalling(false);
        glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 400);

        // ── Feed commit: the synth summary settles into the feed. The live
        // AutomationProgress hides via its own onRunSummary → collapsed run card.
        const autoText = (streamAccRef.current.trim() ? streamAccRef.current : streamSegmentRef.current).trim();
        if (autoText && !data?.cancelled) {
          appendFeedEntry({
            kind: 'assistant',
            text: autoText,
            items: resultItemsRef.current,
            sources: searchSourcesRef.current,
            prompt: lastPromptRef.current || undefined,
          });
          setStreamingResponse('');
          setResultItems([]);
          setSearchSources([]);
        }
        streamAccRef.current = '';
        streamSegmentRef.current = '';
        resultItemsRef.current = [];
        searchSourcesRef.current = [];
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
    const handleQueueUpdate = (items: QueueItem[]) => {
      setQueueItems(items);
      if (items.some(i => i.status === 'building' || i.status === 'planning')) {
        setUnreadTabs(prev => new Set(prev).add('queue'));
      }
    };

    const handleQueueItemDone = (data: { id: string; result?: string; error?: string }) => {
      setQueueItems(prev => prev.map(item =>
        item.id === data.id
          ? { ...item, status: data.error ? 'error' : 'done', result: data.result, error: data.error }
          : item
      ));
    };

    // --- Cron ---
    const handleCronList = (items: CronItem[]) => {
      setCronItems(items);
    };

    const handleCronUpdate = (item: CronItem) => {
      setCronItems(prev => {
        const exists = prev.find(i => i.id === item.id);
        if (exists) {
          return prev.map(i => i.id === item.id ? item : i);
        }
        return [...prev, item];
      });
    };

    // --- Skills ---
    const handleSkillsList = (items: SkillItem[]) => {
      setSkillItems(items);
    };

    // --- Agents ---
    const handleAgentsList = (items: AgentItem[]) => {
      setAgentItems(items);
    };

    const handleAgentNew = (agent: AgentItem) => {
      setAgentItems(prev => {
        const exists = prev.find(a => a.id === agent.id);
        return exists ? prev.map(a => a.id === agent.id ? agent : a) : [...prev, agent];
      });
    };

    const handleAgentUpdate = (_data: { agentId: string; status: string; progress?: number }) => {
      setAgentItems(prev => prev.map(a =>
        a.id === _data.agentId ? { ...a, status: _data.status as any } : a
      ));
    };

    // --- Connections ---
    const handleConnectionsList = (items: ConnectionItem[]) => {
      setConnectionItems(items);
    };

    // --- Prompt Queue ---
    const handlePromptQueueUpdate = (items: PromptQueueItem[]) => {
      setPromptQueueItems(items);
    };

    const handleRestartAlert = (data: { items: PromptQueueItem[] }) => {
      setRestartAlert(data);
    };

    // --- Highlights ---
    const handleHighlightsUpdate = (newHighlights: string[]) => {
      setHighlights(prev => {
        const combined = [...prev, ...newHighlights];
        // Remove duplicates
        return combined.filter((h, i) => combined.indexOf(h) === i);
      });
    };

    const handleHighlightsAvailable = (available: boolean) => {
      if (available) {
        ipcRenderer?.send('highlights:confirm');
      }
    };

    const handleHighlightsConfirmed = (data: { highlights: string[]; sourceApp?: string }) => {
      setHighlights(prev => {
        const combined = [...prev, ...data.highlights];
        return combined.filter((h, i) => combined.indexOf(h) === i);
      });
    };

    // --- Copy Button Glow ---
    const handleCopyButtonGlow = (glowing: boolean) => {
      setCopyButtonGlowing(!!glowing);
    };

    // --- Voice ---
    const handleVoiceInject = (data: { message: string }) => {
      promptInputBarRef.current?.setPromptText(data.message);
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

    // --- Voice bridge session events (main relays POST /voice.event) ---
    const handleVoiceSession = (data: { active: boolean }) => {
      setVoiceSession(v => ({
        ...v,
        active: !!data?.active,
        ...(data?.active ? {} : { state: 'idle', interimText: '', finalText: '', level: 0 }),
      }));
    };
    const handleVoiceState = (data: { state: string }) => {
      setVoiceSession(v => ({ ...v, state: data?.state || 'idle' }));
    };
    const handleVoiceInterim = (data: { text: string }) => {
      setVoiceSession(v => ({ ...v, interimText: data?.text || '', state: 'listening' }));
    };
    const handleVoiceFinal = (data: { text: string }) => {
      setVoiceSession(v => ({ ...v, interimText: '', finalText: data?.text || '', state: 'processing' }));
    };
    const handleVoiceLevel = (data: { level: number }) => {
      // Mic level arrives ~10Hz — throttle re-renders to ~6Hz.
      const now = Date.now();
      if (now - _lastVoiceLevelAtRef.current < 150) return;
      _lastVoiceLevelAtRef.current = now;
      setVoiceSession(v => ({ ...v, level: data?.level || 0 }));
    };

    // --- File Drop Response ---
    const handleFileDropResult = (data: { highlights: string[] }) => {
      console.log('[File Drop] Received result:', data);
      if (data.highlights) {
        setHighlights(prev => {
          const combined = [...prev, ...data.highlights];
          return combined.filter((h, i) => combined.indexOf(h) === i);
        });
      }
    };

    // --- Skill Build ---
    const handleSkillBuildProgress = (newState: SkillBuildState) => {
      setSkillBuild(newState);
    };

    const handleInstallConfirm = (result: { confirmed: boolean }) => {
      if (pendingInstallRef.current) {
        pendingInstallRef.current(result.confirmed);
        pendingInstallRef.current = null;
      }
    };

    // --- Schedule ---
    const handleSchedulePending = (pending: { id: string; label: string; targetTime: string }) => {
      setSchedulePending(pending);
    };

    // --- Bridge Status ---
    const handleBridgeStatus = (status: BridgeStatus) => {
      setBridgeStatus(status);
    };

    // --- Scan Progress ---
    const handleScanProgress = () => {};

    // --- Action Chips ---
    const handleActionChips = (chips: ActionChip[]) => {
      console.log(' [UNIFIED] Received action chips:', chips);
      setActionChips(chips);
    };

    // --- Gather Context Handler (like StandalonePromptCapture) ---
    const handleGatherPending = ({ active, question }: { active: boolean; question?: string | null }) => {
      console.log('[UNIFIED] Gather pending:', active, question);
      setGatherPending(active);
      setGatherQuestion(active && question ? question : null);
      if (!active) setQuestionAlert(null); // question answered/timed out — drop the alert card
    };

    // --- Queue Enqueued Handler ---
    const handleQueueEnqueued = (data?: any) => {
      dbg('[UNIFIED] Queue enqueued - clearing previous response', data?.isResume ? '(resume)' : '');
      // Wrap in startTransition so the browser can paint the cleared input text
      // (from PromptInputBar's flushSync) before the parent re-renders. Without this,
      // the synchronous setState calls here would block the paint and cause submit lag.
      startTransition(() => {
        setStreamingResponse('');
        setResultItems([]);
        if (!data?.isResume) { // Don't kill automation mode on ASK_USER resume
          setIsAutomationMode(false);
          setActionChips([]);
          setInstallPrompt(null);
          setGatherPending(false);
          setGatherQuestion(null);
          setStreamingStartedRef(false); // Reset streaming started flag
        }
      });
      hasDroppedRef.current = false; // Reset drop sound flag
    };

    // --- Search Sources ---
    const handleSearchSources = (sources: SearchSource[]) => {
      setSearchSources(sources);
      searchSourcesRef.current = sources;
    };

    // --- Agent Learn Progress ---
    const handleAgentLearnProgress = (data: { 
      type: string; 
      agentId: string; 
      hostname?: string; 
      startUrl?: string;
      message?: string;
      states?: string[];
      stateCount?: number;
      duration?: number;
      error?: string;
    }) => {
      switch (data.type) {
        case 'learn:start':
          setLearnMode({
            active: true,
            agentId: data.agentId,
            hostname: data.hostname || null,
            progress: 0,
            message: 'Opening browser — sign in when prompted...',
            discoveredStates: [],
            startTime: Date.now(),
            authRequired: false,
            totalUrls: (data as any).totalUrls || 1,
            currentUrlIndex: 0,
          });
          break;
        case 'learn:auth_required':
          setLearnMode(prev => prev ? {
            ...prev,
            authRequired: true,
            message: data.message || 'Sign in to continue.',
          } : null);
          break;
        case 'learn:auth_waiting':
          setLearnMode(prev => prev ? { ...prev, authRequired: true, message: data.message || 'Waiting for sign-in...' } : null);
          break;
        case 'learn:auth_resolved':
          // Early dismissal: browser.act detected login callback params before waitForAuth returned
          setLearnMode(prev => prev ? { ...prev, authRequired: false, message: '✓ Signed in! Starting site scan...' } : null);
          break;
        case 'learn:auth_success':
          setLearnMode(prev => prev ? { ...prev, authRequired: false, message: '✓ Signed in! Starting site scan...' } : null);
          break;
        case 'learn:auth_failed':
          setLearnMode(prev => prev ? {
            ...prev,
            active: false,
            message: 'Sign-in not completed. Click Learn again to retry.',
          } : null);
          setTimeout(() => setLearnMode(null), 5000);
          break;
        case 'learn:navigating':
          setLearnMode(prev => prev ? { ...prev, message: data.message || 'Navigating...' } : null);
          break;
        case 'learn:exploring':
          setLearnMode(prev => prev ? { 
            ...prev,
            totalUrls: (data as any).totalUrls || prev.totalUrls || 1,
            progress: Math.max(prev.progress, 5),
            message: data.message || 'Exploring site...'
          } : null);
          break;
        case 'learn:url_scan_start': {
          const _urlIdx = (data as any).urlIndex || 1;
          const _urlTotal = (data as any).totalUrls || 1;
          const _urlStartPct = ((_urlIdx - 1) / _urlTotal) * 80;
          setLearnMode(prev => prev ? {
            ...prev,
            totalUrls: _urlTotal,
            currentUrlIndex: _urlIdx,
            message: (data as any).message || `Scanning URL ${_urlIdx}/${_urlTotal}…`,
            progress: Math.max(prev.progress, _urlStartPct),
          } : null);
          break;
        }
        case 'learn:url_scan_complete': {
          const _doneIdx = (data as any).urlIndex || 1;
          const _doneTotal = (data as any).totalUrls || 1;
          const _urlDonePct = (_doneIdx / _doneTotal) * 80;
          setLearnMode(prev => prev ? {
            ...prev,
            message: (data as any).message || `Completed URL ${_doneIdx}/${_doneTotal}`,
            progress: Math.max(prev.progress, _urlDonePct),
          } : null);
          break;
        }
        case 'learn:state_discovered':
          setLearnMode(prev => prev ? { 
            ...prev, 
            discoveredStates: [...prev.discoveredStates, ...(data.states || [])],
            message: `Discovered ${data.states?.length || 0} new states`
          } : null);
          break;
        case 'learn:complete': {
          // Calculate resolved value BEFORE setLearnMode so we can use it for timeout check
          const resolvedRequiresDismissal = (data as any).requiresDismissal ?? (learnMode?.requiresDismissal) ?? false;
          setLearnMode(prev => ({
            active: false,
            agentId: prev?.agentId || null,
            hostname: prev?.hostname || null,
            progress: 100,
            message: (data as any).message || `Learn complete! Found ${data.stateCount} states`,
            discoveredStates: data.states || prev?.discoveredStates || [],
            startTime: prev?.startTime || null,
            authRequired: prev?.authRequired || false,
            requiresDismissal: resolvedRequiresDismissal,
            scanStats: (data as any).scanStats ?? prev?.scanStats ?? null,
          }));
          // Only auto-dismiss if requiresDismissal is not set
          if (!resolvedRequiresDismissal) {
            setTimeout(() => setLearnMode(null), 3000);
          }
          // Refresh agents list to show updated status and skills
          ipcRenderer?.send('agents:list');
          break;
        }
        case 'learn:error':
          setLearnMode(prev => prev ? {
            ...prev,
            active: false,
            message: `Error: ${data.error}`,
          } : null);
          setTimeout(() => setLearnMode(null), 5000);
          break;
        case 'learn:cancelling':
          setLearnMode(prev => prev ? { ...prev, active: false, message: 'Cancelling...' } : null);
          setTimeout(() => setLearnMode(null), 1500);
          break;
        case 'learn:cancelled':
          setLearnMode({
            active: false,
            agentId: data.agentId,
            hostname: null,
            progress: 0,
            message: 'Learn cancelled',
            discoveredStates: [],
            startTime: null,
            authRequired: false,
          });
          setTimeout(() => setLearnMode(null), 3000);
          break;
        case 'learn:goal_start':
          setLearnMode(prev => prev ? {
            ...prev,
            message: (data as any).message || `Goal ${(data as any).goalIndex}/${(data as any).totalGoals}: ${(data as any).goal}`,
            progress: Math.max(prev.progress, ((((data as any).goalIndex - 1) / ((data as any).totalGoals || 1)) * 80)),
          } : null);
          break;
        case 'learn:goal_complete':
          setLearnMode(prev => prev ? {
            ...prev,
            message: (data as any).message || `Goal ${(data as any).goalIndex}/${(data as any).totalGoals} complete`,
            progress: Math.max(prev.progress, (((data as any).goalIndex / ((data as any).totalGoals || 1)) * 80)),
          } : null);
          break;
        case 'learn:goal_achieved':
          setLearnMode(prev => prev ? {
            ...prev,
            message: (data as any).achieved === false
              ? `⚠ Goal incomplete after ${(data as any).steps || 0} action(s)`
              : `🏁 Goal achieved in ${(data as any).steps || 0} step(s)`,
          } : null);
          break;
        case 'learn:decomposed':
          setLearnMode(prev => prev ? {
            ...prev,
            message: (data as any).message || `🗺 Plan: ${((data as any).microSteps || []).length} step(s)`,
          } : null);
          break;
        case 'learn:micro_step_start':
          setLearnMode(prev => prev ? {
            ...prev,
            message: (data as any).message || `↳ Step ${(data as any).microStepIndex}/${(data as any).totalMicroSteps}: ${(data as any).microStep}`,
          } : null);
          break;
        case 'learn:cache_hit':
          setLearnMode(prev => prev ? {
            ...prev,
            message: `⚡ Cache hit — ${(data as any).count || 0} actions (no rescan needed)`,
          } : null);
          break;
        case 'learn:cache_miss':
          setLearnMode(prev => prev ? {
            ...prev,
            message: `🔍 Scanning page — ${(data as any).count || 0} elements found`,
          } : null);
          break;
        case 'learn:action_executing':
          setLearnMode(prev => prev ? {
            ...prev,
            message: (data as any).message || `▶ Step ${(data as any).step}: ${(data as any).action} — ${(data as any).element || ''}`,
          } : null);
          break;
        case 'learn:action_executed':
          setLearnMode(prev => prev ? {
            ...prev,
            message: (data as any).ok ? `✓ Step ${(data as any).step} done` : `⚠ Step ${(data as any).step} failed (continuing)`,
          } : null);
          break;
        case 'learn:page_transition':
          setLearnMode(prev => prev ? {
            ...prev,
            message: `↗ Navigated to new page`,
          } : null);
          break;
        case 'learn:ui_state_detected':
          setLearnMode(prev => prev ? {
            ...prev,
            message: `⚡ UI state: ${(data as any).state || 'modal/dropdown detected'}`,
          } : null);
          break;
        case 'explore:scan_start':
          setLearnMode(prev => prev ? { ...prev, message: `Scanning ${data.hostname || 'site'}…` } : null);
          break;
        case 'explore:url_scan_start': {
          const _eUrlIdx = (data as any).urlIndex || 1;
          const _eUrlTotalRaw = (data as any).totalUrls || 1;
          setLearnMode(prev => {
            if (!prev) return null;
            const _eUrlTotal = _eUrlTotalRaw || prev.totalUrls || 1;
            const _eStartPct = ((_eUrlIdx - 1) / _eUrlTotal) * 80;
            return {
              ...prev,
              totalUrls: _eUrlTotal,
              currentUrlIndex: _eUrlIdx,
              message: `Scanning URL ${_eUrlIdx}/${_eUrlTotal}: ${(data as any).url || data.hostname || ''}`,
              progress: Math.max(prev.progress, Math.max(5, _eStartPct)),
            };
          });
          break;
        }
        case 'explore:url_scan_complete': {
          const _eDoneIdx = (data as any).urlIndex || 1;
          const _eDoneTotal = (data as any).totalUrls || 1;
          const _eDonePct = (_eDoneIdx / _eDoneTotal) * 80;
          setLearnMode(prev => prev ? {
            ...prev,
            message: `Completed URL ${_eDoneIdx}/${_eDoneTotal}`,
            progress: Math.max(prev.progress, _eDonePct),
          } : null);
          break;
        }
        case 'explore:scan_elements_start':
          setLearnMode(prev => {
            if (!prev) return null;
            const urlIdx = prev.currentUrlIndex || 1;
            const urlTotal = prev.totalUrls || 1;
            const baseProgress = ((urlIdx - 1) / urlTotal) * 80;
            return {
              ...prev,
              message: `Scanning ${(data as any).state || 'page'} — ${(data as any).elementCount || 0} interactive elements`,
              progress: Math.max(prev.progress, Math.max(baseProgress, 5)),
            };
          });
          break;
        case 'explore:scan_progress':
          setLearnMode(prev => {
            if (!prev) return null;
            const urlIdx = prev.currentUrlIndex || 1;
            const urlTotal = prev.totalUrls || 1;
            const baseProgress = ((urlIdx - 1) / urlTotal) * 80;
            const sliceSize = (1 / urlTotal) * 80;
            const pct = (data as any).percent != null
              ? (data as any).percent
              : (data as any).current != null && (data as any).total
                ? ((data as any).current / (data as any).total) * 100
                : 0;
            const cumulative = baseProgress + (pct / 100) * sliceSize;
            return {
              ...prev,
              message: data.message || `Processing elements…`,
              progress: Math.max(prev.progress, cumulative),
            };
          });
          break;
        case 'explore:scan_filtered':
        case 'explore:scan_success':
        case 'explore:scan_failed':
          setLearnMode(prev => prev ? {
            ...prev,
            message: data.message || prev.message,
          } : null);
          break;
        case 'explore:scan_extracting':
          setLearnMode(prev => {
            if (!prev) return null;
            const urlIdx = prev.currentUrlIndex || 1;
            const urlTotal = prev.totalUrls || 1;
            const baseProgress = ((urlIdx - 1) / urlTotal) * 80;
            const sliceSize = (1 / urlTotal) * 80;
            const elemCurrent = (data as any).current || 0;
            const elemTotal = (data as any).total || 1;
            const cumulative = baseProgress + (elemCurrent / elemTotal) * sliceSize;
            return {
              ...prev,
              message: `Extracting ${(data as any).interaction || 'element'}: "${(data as any).label || ''}"`,
              progress: Math.max(prev.progress, cumulative),
            };
          });
          break;
        case 'explore:bot_detected':
          setLearnMode(prev => prev ? {
            ...prev,
            message: `Bot protection detected on ${data.hostname || 'page'} — skipping`,
          } : null);
          break;
        case 'explore:reveal_start':
          setLearnMode(prev => prev ? {
            ...prev,
            message: `Opening ${(data as any).revealType || 'panel'} to find hidden elements…`,
          } : null);
          break;
        case 'explore:reveal_complete':
          setLearnMode(prev => prev ? {
            ...prev,
            message: `${(data as any).revealType || 'Panel'} scanned: ${(data as any).actionsFound || 0} elements found`,
          } : null);
          break;
        case 'explore:scan_data_collected':
          setLearnMode(prev => prev ? {
            ...prev,
            message: `Collected: "${(data as any).label || 'item'}"`,
          } : null);
          break;
        case 'learn:re_exploring':
          setLearnMode(prev => prev ? {
            ...prev,
            message: data.message || 'Re-scanning with web research insights…',
          } : null);
          break;
        case 'explore:scan_skill_progress':
          setLearnMode(prev => prev ? {
            ...prev,
            message: (data as any).message || 
              ((data as any).total 
                ? `Creating skills: ${(data as any).current || 0} of ${(data as any).total}` 
                : `Creating atomic skills…`),
            progress: Math.max(prev?.progress ?? 80, 80 + ((data as any).total 
              ? ((data as any).current / (data as any).total) * 15 
              : 5)),
          } : null);
          break;
        case 'explore:scan_complete':
          setLearnMode(prev => prev ? {
            ...prev,
            message: data.message || `Site scan done — found ${(data as any).totalActions || 0} interactive elements`,
            progress: Math.max(prev.progress, 85),
          } : null);
          break;
        case 'explore:scan_summary':
          // Final completion with stats and requiresDismissal flag
          // Always update state - don't check prev, scan_summary should always display
          console.log('[UnifiedOverlay] scan_summary received:', data);
          setLearnMode(prev => ({
            active: false,
            agentId: prev?.agentId || null,
            hostname: prev?.hostname || null,
            progress: 100,
            message: data.message || `Scan complete!`,
            discoveredStates: prev?.discoveredStates || [],
            startTime: prev?.startTime || null,
            authRequired: prev?.authRequired || false,
            requiresDismissal: (data as any).requiresDismissal || false,
            scanStats: {
              totalElements: (data as any).totalElements || 0,
              successful: (data as any).successful || 0,
              failed: (data as any).failed || 0,
              filtered: (data as any).filtered || 0,
              states: (data as any).states || 0,
              skillsGenerated: (data as any).skillsGenerated || 0,
              dataItems: (data as any).dataItems || 0,
              duration: (data as any).duration || 0,
            },
          }));
          // Refresh agents list immediately + after 1.5s to catch async DB writes
          ipcRenderer?.send('agents:list');
          setTimeout(() => ipcRenderer?.send('agents:list'), 1500);
          // Only auto-dismiss if requiresDismissal is not set
          if (!(data as any).requiresDismissal) {
            setTimeout(() => setLearnMode(null), 3000);
          }
          break;
        case 'explore:scan_error':
          setLearnMode(prev => prev ? {
            ...prev,
            message: `Scan error: ${data.error || 'unknown'}`,
          } : null);
          break;
      }
    };

    // --- Agent Training Progress ---
    const handleTrainingProgress = (data: {
      type: string;
      agentId: string;
      hostname?: string;
      startUrl?: string;
      message?: string;
      narrative?: Array<{ timestamp: number; action: string; description: string }>;
      question?: string;
      options?: string[];
      success?: boolean;
      skillName?: string;
      parameters?: string[];
    }) => {
      switch (data.type) {
        case 'training:start':
          setTrainingMode({
            active: true,
            agentId: data.agentId,
            hostname: data.hostname || null,
            phase: 'observing',
            narrative: [],
          });
          break;
        case 'training:observing':
        case 'training:narrative':
          setTrainingMode(prev => prev ? {
            ...prev,
            phase: 'observing',
            narrative: data.narrative || prev.narrative,
          } : null);
          break;
        case 'training:teach_me':
          setTrainingMode(prev => prev ? {
            ...prev,
            phase: 'teach_me',
            teachMeQuestion: data.question,
            teachMeOptions: data.options,
          } : null);
          break;
        case 'training:review':
          setTrainingMode(prev => prev ? {
            ...prev,
            phase: 'review',
            narrative: data.narrative || prev.narrative,
          } : null);
          break;
        case 'testing:start':
        case 'testing:progress':
          setTrainingMode(prev => prev ? { ...prev, phase: 'testing' } : null);
          break;
        case 'testing:complete':
        case 'testing:failed':
          setTrainingMode(prev => prev ? {
            ...prev,
            phase: 'review',
            testResult: { success: data.success || false, message: data.message || '' },
          } : null);
          break;
        case 'generating:start':
          setTrainingMode(prev => prev ? { ...prev, phase: 'generating' } : null);
          break;
        case 'generating:complete':
          setTrainingMode(prev => prev ? {
            ...prev,
            phase: 'review',
            generatedSkill: { name: data.skillName || '', parameters: data.parameters || [] },
          } : null);
          break;
        case 'training:cancelled':
          setTrainingMode(null);
          break;
      }
    };

    // Register all listeners with the stable 'unified-overlay' token.
    // Preload deduplicates per channel so StrictMode remounts are safe.
    const token = listenerToken.current;
    ipcRenderer.on('ws-bridge:message', handleWsMessage, token);
    ipcRenderer.on('unified:set-prompt', handleSetPrompt, token);
    ipcRenderer.on('voice:session', handleVoiceSession, token);
    ipcRenderer.on('voice:state', handleVoiceState, token);
    ipcRenderer.on('voice:interim', handleVoiceInterim, token);
    ipcRenderer.on('voice:final', handleVoiceFinal, token);
    ipcRenderer.on('voice:level', handleVoiceLevel, token);
    ipcRenderer.on('unified:clear', handleClear, token);
    ipcRenderer.on('automation:progress', handleAutomationProgress, token);
    ipcRenderer.on('is-streaming', (data: { isStreaming: boolean }) => {
      setIsStreaming(data.isStreaming);
      if (data.isStreaming) {
        setActiveTab('results');
        setUnreadTabs(prev => {
          const next = new Set(prev);
          next.delete('results');
          return next;
        });
      }
    }, token);
    ipcRenderer.on('ui:switch-to-results', () => {
      setActiveTab('results');
      setUnreadTabs(prev => {
        const next = new Set(prev);
        next.delete('results');
        return next;
      });
    }, token);
    // Generic tab navigation (notification clicks, alert cards)
    ipcRenderer.on('ui:switch-tab', (data: { tab?: string }) => {
      const tab = data?.tab;
      if (tab === 'results' || tab === 'queue' || tab === 'cron' || tab === 'agents' || tab === 'skills' || tab === 'store' || tab === 'connections' || tab === 'brain') {
        setActiveTab(tab);
        setUnreadTabs(prev => { const next = new Set(prev); next.delete(tab as TabId); return next; });
      }
    }, token);
    // Preflight auth routing: switch to agents tab when user clicks "Open Agents Tab"
    ipcRenderer.on('preflight:open-agents-tab', (data: any) => {
      if (data?.agentId) {
        try {
          sessionStorage.setItem('preflight:highlight-agent', data.agentId);
          sessionStorage.setItem('preflight:agent-setup', JSON.stringify(data));
          window.dispatchEvent(new CustomEvent('preflight:agent-setup', { detail: data }));
        } catch (_) {}
      }
      setActiveTab('agents');
      setUnreadTabs(prev => {
        const next = new Set(prev);
        next.delete('agents');
        return next;
      });
    }, token);
    // Preflight re-check: switch back to results/automation tab after CLI setup
    ipcRenderer.on('preflight:recheck', (_data: any) => {
      setActiveTab('results');
      setUnreadTabs(prev => {
        const next = new Set(prev);
        next.delete('results');
        return next;
      });
    }, token);
    // Phase 9: Take-over routing — switch to agents tab and start training
    ipcRenderer.on('agents:open-training', (data: any) => {
      setActiveTab('agents');
      setUnreadTabs(prev => {
        const next = new Set(prev);
        next.delete('agents');
        return next;
      });
      if (data?.agentId) {
        try { sessionStorage.setItem('preflight:highlight-agent', data.agentId); } catch (_) {}
        try { sessionStorage.setItem('takeover:train-agent', data.agentId); } catch (_) {}
        // Store full training context (mode, task, startUrl, keepSession) so the
        // trainer can attach to the live session or start fresh from a deep-link.
        try { sessionStorage.setItem('takeover:train-context', JSON.stringify(data)); } catch (_) {}
        // Dispatch a real-time event so AgentsTab picks up the handoff even when already mounted
        try { window.dispatchEvent(new CustomEvent('agents:open-training', { detail: data })); } catch (_) {}
      }
    }, token);
    ipcRenderer.on('queue:update', handleQueueUpdate, token);
    ipcRenderer.on('queue:item-done', handleQueueItemDone, token);
    ipcRenderer.on('cron:list', handleCronList, token);
    ipcRenderer.on('cron:update', handleCronUpdate, token);
    ipcRenderer.on('skills:list', handleSkillsList, token);
    ipcRenderer.on('agents:list', handleAgentsList, token);
    ipcRenderer.on('agents:new', handleAgentNew, token);
    ipcRenderer.on('agents:update', handleAgentUpdate, token);
    ipcRenderer.on('connections:list', handleConnectionsList, token);
    ipcRenderer.on('prompt-queue:update', handlePromptQueueUpdate, token);
    ipcRenderer.on('prompt-queue:restart-alert', handleRestartAlert, token);
    ipcRenderer.on('highlights:update', handleHighlightsUpdate, token);
    ipcRenderer.on('highlights:available', handleHighlightsAvailable, token);
    ipcRenderer.on('highlights:confirmed', handleHighlightsConfirmed, token);
    ipcRenderer.on('copy-button:glow', handleCopyButtonGlow, token);
    ipcRenderer.on('voice:inject-prompt', handleVoiceInject, token);
    ipcRenderer.on('voice:response', handleVoiceResponse, token);
    ipcRenderer.on('voice:recording-started', handleVoiceRecordingStarted, token);
    ipcRenderer.on('voice:recording-stopped', handleVoiceRecordingStopped, token);
    ipcRenderer.on('file-drop:result', handleFileDropResult, token);
    ipcRenderer.on('skill-build:progress', handleSkillBuildProgress, token);
    ipcRenderer.on('install:confirm', handleInstallConfirm, token);
    ipcRenderer.on('schedule:pending', handleSchedulePending, token);
    ipcRenderer.on('bridge:status', handleBridgeStatus, token);
    ipcRenderer.on('scan:progress', handleScanProgress, token);
    ipcRenderer.on('agents:learn-progress', handleAgentLearnProgress, token);
    ipcRenderer.on('agents:train-progress', handleTrainingProgress, token);
    ipcRenderer.on('action-chips', handleActionChips, token);
    ipcRenderer.on('search:sources', handleSearchSources, token);
    ipcRenderer.on('gather:pending', handleGatherPending, token);
    ipcRenderer.on('queue:enqueued', handleQueueEnqueued, token);

    // ── Conversation history pages (Results feed scroll-up pagination) ───────
    // Response: { messages } newest-first, bounded above by sessionBoundary.
    ipcRenderer.on('conversation:list', (data: { messages?: any[] }) => {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      const msgs = Array.isArray(data?.messages) ? data.messages : [];
      if (msgs.length > 0) {
        const mapped: FeedEntry[] = msgs
          .map((m: any) => {
            const ts = Date.parse(m.timestamp || m.created_at || '') || Date.now();
            const id = `db_${m.id}`;
            // sender: 'user' | 'assistant' | 'system' (system = recovery/ask_user
            // turns — kept out of the feed).
            if (m.sender === 'user') return { id, ts, kind: 'user', text: String(m.text || '') } as FeedEntry;
            if (m.sender === 'assistant') {
              return { id, ts, kind: 'assistant', text: String(m.text || '') } as FeedEntry;
            }
            return null;
          })
          .filter((e): e is FeedEntry => e !== null && (e as any).text !== undefined)
          .sort((a, b) => a.ts - b.ts); // chronological for the feed
        const oldest = msgs.reduce((a: any, b: any) =>
          (String(a.timestamp || a.created_at) < String(b.timestamp || b.created_at) ? a : b));
        historyCursorRef.current = String(oldest.timestamp || oldest.created_at);
        setFeedEntries(prev => {
          const existing = new Set(prev.map(e => e.id));
          return [...mapped.filter(e => !existing.has(e.id)), ...prev];
        });
      }
      setHasMoreHistory(msgs.length >= 20);
      hasMoreHistoryRef.current = msgs.length >= 20;
    }, token);

    // ── Brain tab / Thought engine events ────────────────────────────────────
    // thoughts:list — full list refresh (after tab open, refresh, or a decision)
    ipcRenderer.on('thoughts:list', (data: { thoughts?: ThoughtItem[] }) => {
      setBrainThoughts(Array.isArray(data?.thoughts) ? data.thoughts : []);
    }, token);
    // thought:update — incremental lifecycle event { kind, thought, outcomeText? }
    ipcRenderer.on('thought:update', (evt: { kind?: string; thought?: ThoughtItem; outcomeText?: string }) => {
      const t = evt?.thought;
      if (!t?.id) return;
      setBrainThoughts(prev => {
        const idx = prev.findIndex(x => x.id === t.id);
        const next = [...prev];
        if (idx >= 0) next[idx] = { ...next[idx], ...t };
        else next.unshift(t);
        return next;
      });
      // Badge the Brain tab — a proactive notification/approval request
      // deserves the unread dot (cleared when the user opens the tab).
      setUnreadTabs(prev => new Set(prev).add('brain'));
      // Proactive outreach (notify/question actions) → feed entries at the
      // exchange tail — they open the window via the measured zone.
      if (evt.kind === 'notify' || evt.kind === 'question') {
        const text = String(t.summary || t.action?.payload?.text || 'ThinkDrop');
        const pendingId = `proactive-pending-${t.id}`;
        // A re-nudge replaces its pending line (deduped per thought).
        setFeedEntries(prev => {
          const filtered = prev.filter(e => !(e.kind === 'proactive' && e.thoughtId === t.id));
          return [...filtered, { id: pendingId, ts: Date.now(), kind: 'proactive', thoughtId: t.id, text: '', pending: true } as FeedEntry];
        });
        // Brief "incoming message…" beat, then the text lands.
        setTimeout(() => {
          patchFeedEntry(pendingId, { text, pending: false } as Partial<FeedEntry>);
        }, 700);
      }
    }, token);

    // ── comms-graph task events ──────────────────────────────────────────────
    ipcRenderer.on('task:created', (data: any) => {
      if (data?.taskId) {
        const isRestored = data.restored === true;
        // ── Intent sound + ••• working indicator (from comms-graph regex guess) ──
        // The comms-graph's guessedIntent (pure regex) is now available at
        // task:created for ALL handoff tasks (parked and non-parked), forwarded
        // through handoff.cjs → /comms.handoff → task:created.
        // - If guessedIntent matches → play intent-specific sound
        // - If guessedIntent is null (regex miss) → default chime
        // - ••• shows for all non-command_automate handoff tasks (incl. regex miss)
        // - command_automate gets the notification banner instead (no •••)
        // Dedup via _playedIntentSoundRef so a resumed task's second
        // task:created doesn't re-play the sound.
        if (!isRestored) {
          // Play once per task — a parked task's second task:created on resume
          // must not re-play the sound.
          if (!_playedIntentSoundRef.current.has(data.taskId)) {
            _playedIntentSoundRef.current.add(data.taskId);
            if (data.guessedIntent) {
              playIntentSound(data.guessedIntent);
            } else {
              playDefaultSound();
            }
          }
          // Show ••• for all handoff tasks except command_automate.
          // guessedIntent null (regex miss) still shows •••.
          if (data.guessedIntent !== 'command_automate') {
            setIsTaskWorking(true);
          }
        }
        setCommsTasks(prev => {
          if (prev.some(t => t.id === data.taskId)) return prev;
          return [...prev, {
            id: data.taskId,
            prompt: data.prompt || '',
            agentId: data.agentId || null,
            status: 'queued' as const,
            createdAt: data.createdAt || Date.now(),
            startedAt: data.startedAt || null,
            doneAt: data.doneAt || null,
            error: null,
            progress: { step: 0, totalSteps: 0, currentStep: null, eta: null },
            result: null,
            intent: data.guessedIntent || 'handoff',
            source: data.source || 'text',
            sessionId: data.sessionId || null,
          }];
        });
        if (!isRestored) {
          setUnreadTabs(prev => { const n = new Set(prev); n.add('queue'); return n; });

          // ── Feed: bubble + run card ────────────────────────────────────
          // The prompt echo also arrives via unified:set-prompt — deduped there.
          // Service-dispatched handoffs (scheduled runs, voice, API) have no
          // local submit, so ensure the bubble exists here too.
          if (data.prompt) appendUserEntry(data.prompt);
          if (data.guessedIntent === 'command_automate') {
            appendFeedEntry({
              kind: 'run',
              taskId: data.taskId,
              title: data.prompt || 'Automation run',
              status: 'queued',
              prompt: data.prompt || undefined,
            });
          }
        }
      }
    }, token);

    ipcRenderer.on('task:progress', (data: any) => {
      if (data?.taskId) {
        setCommsTasks(prev => prev.map(t => {
          if (t.id !== data.taskId) return t;
          return {
            ...t,
            status: 'running',
            progress: {
              step: data.step || t.progress.step,
              totalSteps: data.totalSteps || t.progress.totalSteps,
              currentStep: data.node || data.currentStep || t.progress.currentStep,
              eta: t.progress.eta,
            },
          };
        }));
        patchFeedEntryByTask(data.taskId, { status: 'running' } as Partial<FeedEntry>);
      }
    }, token);

    ipcRenderer.on('task:complete', (data: any) => {
      if (data?.taskId) {
        const status = data.status || (data.error ? 'failed' : 'done');
        const taskIntent = data.intent || null;
        const isCommandAutomate = taskIntent === 'command_automate';
        const isRestored = data.restored === true;

        setCommsTasks(prev => prev.map(t => {
          if (t.id !== data.taskId) return t;
          return {
            ...t,
            status: status as any,
            doneAt: (status === 'done' || status === 'failed' || status === 'cancelled') ? (data.doneAt || t.doneAt || Date.now()) : t.doneAt,
            result: data.answer || t.result,
            thinking: data.thinking || t.thinking || null,
            sources: data.sources || t.sources || null,
            items: data.items || t.items || null,
            error: data.error || null,
            planFile: data.planFile || t.planFile || null,
            sessionId: data.sessionId || t.sessionId || null,
          };
        }));

        // Clean up intent sound dedup set + clear working indicator
        _playedIntentSoundRef.current.delete(data.taskId);
        setIsTaskWorking(false);

        // Clear the prompt glow on terminal states. Handoff tasks never emit a
        // ws-bridge 'done' at the end of the run, and non-plan intents
        // (web_search, memory_retrieve, general_knowledge) never emit 'all_done'
        // — so task:complete is their only reliable "finished" signal. Paused
        // states (awaiting-approval / auth-required / waiting-for-input) keep
        // the glow on as an attention signal.
        if (status === 'done' || status === 'failed' || status === 'cancelled') {
          if (glowOffTimerRef.current) clearTimeout(glowOffTimerRef.current);
          glowOffTimerRef.current = setTimeout(() => setIsGlowActive(false), 400);
        }

        if (!isRestored) {
          // ── Feed: settle run card + placeholder answer ────────────────────
          // The task-notification banner is retired — the Results feed is the
          // single surface. Sounds preserved.
          const settlePendingAssistant = (text: string, items?: any[]) => {
            const hit = [...feedEntriesRef.current].reverse().find(e =>
              e.kind === 'assistant' && (e.taskId === data.taskId || e.pending));
            if (hit) {
              patchFeedEntry(hit.id, { text, pending: false, items } as Partial<FeedEntry>);
            } else {
              appendFeedEntry({ kind: 'assistant', text, items, taskId: data.taskId, prompt: lastPromptRef.current || undefined });
            }
          };

          if (isCommandAutomate) {
            // Patch (or append) the run card for this task.
            setFeedEntries(prev => {
              const runPatch = { status: status as any, error: data.error || null, planFile: data.planFile || undefined };
              const idx = prev.findIndex(e => e.kind === 'run' && e.taskId === data.taskId);
              if (idx < 0) {
                return [...prev, { id: `fe_${Date.now()}_${feedSeqRef.current++}`, ts: Date.now(), kind: 'run', taskId: data.taskId, title: data.prompt || 'Automation run', prompt: data.prompt || undefined, ...runPatch } as FeedEntry];
              }
              const next = prev.slice();
              next[idx] = { ...next[idx], ...runPatch } as FeedEntry;
              return next;
            });
            if (status === 'done' && data.answer) {
              settlePendingAssistant(data.answer, Array.isArray(data.items) ? data.items : undefined);
            } else if (status === 'failed' || status === 'cancelled') {
              // Settle any pending placeholder ("Give me a sec…") into a
              // friendly error card so it doesn't spin forever under the
              // failed run card.
              const raw = data.error || `Task ${status}`;
              const pendingHit = [...feedEntriesRef.current].reverse().find(e =>
                e.kind === 'assistant' && (e.taskId === data.taskId || e.pending));
              if (pendingHit) {
                patchFeedEntry(pendingHit.id, {
                  text: friendlyErrorMessage(raw), pending: false, isError: true,
                  errorRaw: raw,
                  prompt: (pendingHit.kind === 'assistant' ? pendingHit.prompt : undefined) || lastPromptRef.current || undefined,
                } as Partial<FeedEntry>);
              }
            }
            // Water-drip used to live on TaskCompleteBanner — moved here.
            if (status === 'done' || status === 'failed' || status === 'cancelled') playDropSound();
          } else if (status === 'done' && data.answer) {
            // ── Non-command_automate: settle the placeholder into the real answer ──
            settlePendingAssistant(data.answer, Array.isArray(data.items) ? data.items : undefined);
            setStreamingResponse('');
            setResultItems([]);
            setIsStreaming(false);
            setIsTaskWorking(false);
            streamCompletedRef.current = true;
            playDropSound();
          } else if (status === 'failed' || status === 'cancelled') {
            // Failed run → friendly error card in the feed (raw error kept in
            // errorRaw). Patch the active-exchange assistant entry — including
            // preamble streams like "Give me a sec" that may not carry
            // pending/taskId — so the preamble is replaced, not stranded.
            const raw = data.error || `Task ${status}`;
            const friendly = friendlyErrorMessage(raw);
            const entries = feedEntriesRef.current;
            let lastUserIdx = -1;
            for (let i = entries.length - 1; i >= 0; i--) {
              if (entries[i].kind === 'user') { lastUserIdx = i; break; }
            }
            const hit = [...entries].reverse().find(e =>
              e.kind === 'assistant' &&
              (e.taskId === data.taskId || e.pending ||
                (lastUserIdx >= 0 && entries.indexOf(e) > lastUserIdx)));
            if (hit) {
              patchFeedEntry(hit.id, {
                text: friendly, pending: false, isError: true, errorRaw: raw,
                prompt: (hit.kind === 'assistant' ? hit.prompt : undefined) || lastPromptRef.current || undefined,
              } as Partial<FeedEntry>);
            } else {
              appendFeedEntry({
                kind: 'assistant', text: friendly, isError: true, errorRaw: raw,
                taskId: data.taskId, prompt: lastPromptRef.current || undefined,
              });
            }
          }
          setUnreadTabs(prev => { const n = new Set(prev); n.add('queue'); return n; });
        }
      }
    }, token);

    // Remove task from UI when user deletes it
    ipcRenderer.on('task:removed', (data: any) => {
      if (data?.taskId) {
        setCommsTasks(prev => prev.filter(t => t.id !== data.taskId));
      }
    }, token);

    // Request initial data
    historyCursorRef.current = sessionBoundaryRef.current;
    requestHistoryPage(sessionBoundaryRef.current);
    ipcRenderer.send('queue:list');
    ipcRenderer.send('cron:list');
    ipcRenderer.send('skills:list');
    ipcRenderer.send('agents:list');
    ipcRenderer.send('connections:list');

    return () => {
      const token = listenerToken.current;
      ipcRenderer.removeListenerByToken('ws-bridge:message', token);
      ipcRenderer.removeListenerByToken('unified:set-prompt', token);
      ipcRenderer.removeListenerByToken('unified:clear', token);
      ipcRenderer.removeListenerByToken('automation:progress', token);
      ipcRenderer.removeListenerByToken('is-streaming', token);
      ipcRenderer.removeListenerByToken('queue:update', token);
      ipcRenderer.removeListenerByToken('queue:item-done', token);
      ipcRenderer.removeListenerByToken('cron:list', token);
      ipcRenderer.removeListenerByToken('cron:update', token);
      ipcRenderer.removeListenerByToken('skills:list', token);
      ipcRenderer.removeListenerByToken('agents:list', token);
      ipcRenderer.removeListenerByToken('agents:new', token);
      ipcRenderer.removeListenerByToken('agents:update', token);
      ipcRenderer.removeListenerByToken('connections:list', token);
      ipcRenderer.removeListenerByToken('prompt-queue:update', token);
      ipcRenderer.removeListenerByToken('prompt-queue:restart-alert', token);
      ipcRenderer.removeListenerByToken('highlights:update', token);
      ipcRenderer.removeListenerByToken('highlights:available', token);
      ipcRenderer.removeListenerByToken('highlights:confirmed', token);
      ipcRenderer.removeListenerByToken('copy-button:glow', token);
      ipcRenderer.removeListenerByToken('voice:inject-prompt', token);
      ipcRenderer.removeListenerByToken('voice:response', token);
      ipcRenderer.removeListenerByToken('voice:recording-started', token);
      ipcRenderer.removeListenerByToken('voice:recording-stopped', token);
      ipcRenderer.removeListenerByToken('file-drop:result', token);
      ipcRenderer.removeListenerByToken('skill-build:progress', token);
      ipcRenderer.removeListenerByToken('install:confirm', token);
      ipcRenderer.removeListenerByToken('schedule:pending', token);
      ipcRenderer.removeListenerByToken('bridge:status', token);
      ipcRenderer.removeListenerByToken('scan:progress', token);
      ipcRenderer.removeListenerByToken('agents:learn-progress', token);
      ipcRenderer.removeListenerByToken('agents:train-progress', token);
      ipcRenderer.removeListenerByToken('action-chips', token);
      ipcRenderer.removeListenerByToken('search:sources', token);
      ipcRenderer.removeListenerByToken('gather:pending', token);
      ipcRenderer.removeListenerByToken('queue:enqueued', token);
      ipcRenderer.removeListenerByToken('task:removed', token);
      ipcRenderer.removeListenerByToken('task:created', token);
      ipcRenderer.removeListenerByToken('task:progress', token);
      ipcRenderer.removeListenerByToken('task:complete', token);
      ipcRenderer.removeListenerByToken('conversation:list', token);
      ipcRenderer.removeListenerByToken('ui:switch-to-results', token);
      ipcRenderer.removeListenerByToken('preflight:open-agents-tab', token);
      ipcRenderer.removeListenerByToken('preflight:recheck', token);
      ipcRenderer.removeListenerByToken('agents:open-training', token);
    };
  }, []);

  // --- Auto-scroll during streaming ---
  // Uses instant scroll (scrollTop = scrollHeight) instead of scrollIntoView({behavior:'smooth'}).
  // Smooth animation (~300ms) can't keep up with rapid streaming chunks (~50-100ms) —
  // the animations constantly restart and the scroll position lags behind, cutting off content.
  // Skips auto-scroll when the user has scrolled up to read earlier content.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isScrolledUp || pendingPrependRef.current) return;
    if (!isStreaming && !isThinking && feedEntries.length === 0) return;
    container.scrollTop = container.scrollHeight;
  }, [streamingResponse, feedEntries, isStreaming, isThinking, isScrolledUp]);

  // --- Scroll tracking + history pagination ---
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const updateScroll = () => {
      const threshold = 24;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
      setIsScrolledUp(!atBottom);
      // Near the top → pull the next older 20
      if (el.scrollTop < 60) loadOlderHistory();
    };

    el.addEventListener('scroll', updateScroll, { passive: true });
    updateScroll();

    return () => el.removeEventListener('scroll', updateScroll);
  }, [loadOlderHistory]);

  // Window height is driven by:
  // 1. useDynamicHeight hook - resizes on tab switches and tab content changes
  // 2. AutomationProgress's onHeightChange callback - real-time ResizeObserver during automation
  // which measures the component's own root div — outside the clipped layout chain.

  // --- Render Helpers ---
  // renderHighlightChips moved to PromptInputBar (it owns the input area now).

  // --- Action Chip Click ---
  const handleActionChip = useCallback((chip: ActionChip) => {
    setActionChips([]);
    if (ipcRenderer) {
      const chipText = typeof chip === 'string' ? chip : (chip as any).label || String(chip);
      ipcRenderer.send('prompt-queue:submit', { prompt: chipText, selectedText: '' });
    }
  }, []);

  // --- Install Confirm Click (button → main) ---
  const handleInstallButtonClick = useCallback((confirmed: boolean) => {
    const fn = (window as any).__unifiedInstallConfirm;
    if (typeof fn === 'function') fn(confirmed);
  }, []);

  // --- Stable callbacks for ResultsContent memo ---
  const handleScheduleDismiss = useCallback((id: string) => {
    ipcRenderer?.send('schedule:dismiss', { id });
    setSchedulePending(null);
  }, []);

  const handleAutomationHeightChange = useCallback(() => {
    if (shouldSuppressResize()) return;
    measureNow();
  }, [shouldSuppressResize, measureNow]);

  const handleAutomationActiveChange = useCallback((active: boolean) => {
    if (streamingStartedRef && active) return;
    setIsAutomationMode(active);
    setIsGlowActive(active);
  }, [streamingStartedRef]);

  // AutomationProgress terminal summary → collapsed run card in the feed, and
  // the live component hides (it stays mounted for the next run's IPC events).
  const handleRunSummary = useCallback((summary: RunSummary) => {
    appendFeedEntry({
      kind: 'run',
      title: summary.title,
      status: summary.status,
      steps: summary.steps,
      savedFilePaths: summary.savedFilePaths,
      planFile: summary.planFile,
      error: summary.error,
      durationMs: summary.durationMs,
      prompt: lastPromptRef.current || undefined,
    });
    setLiveRunHidden(true);
  }, [appendFeedEntry]);

  const handleOpenRules = useCallback(() => {
    handleTabSelect('rules');
  }, [handleTabSelect]);

  const handleToggleSourcesPanel = useCallback(() => {
    setShowSourcesPanel(prev => !prev);
  }, []);

  return (
    <div
      className="w-full h-full flex flex-col"
      style={{ position: 'relative' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Glow effect for automation mode */}
      <OverlayStyles />
      <div className={`drag-glow-ring${isDragOver ? ' active' : ''}`} />
      <div className={`prompt-glow-ring${isGlowActive ? ' active' : isThinking ? ' thinking' : ''}`} />

      {/* Main Container */}
      <div
        className="w-full h-full flex flex-col"
        onClick={handleOverlayClick}
        style={{
          backgroundColor: 'rgba(23, 23, 23, 0.95)',
          borderRadius: '11px',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Header - Two Row Layout */}
        <OverlayHeader
          headerRef={headerRef}
          isDragging={isDragging}
          isExpanded={isExpanded}
          showCopyButton={!!streamingResponse}
          isCopied={isCopied}
          activeTab={activeTab}
          queueCount={queueCount}
          cronCount={cronCount}
          unreadTabs={unreadTabs}
          onToggleWidth={toggleWidth}
          onCopy={handleCopy}
          onClose={handleClose}
          onMouseDown={handleMouseDown}
          onToggleSlideout={handleToggleSlideout}
          onTabSelect={handleTabSelect}
        />

        {/* Slideout Drawer */}
        <SlideoutDrawer
          isOpen={isSlideoutOpen}
          onClose={() => setIsSlideoutOpen(false)}
          onNavigate={handleSlideoutNavigate}
          activeTab={activeTab}
        />

        {/* Main Content Area - constrained for scroll */}
        <div className="flex-1 overflow-hidden relative">
          {/* Results Tab - Always mounted, hidden with CSS when inactive */}
          <div
            ref={scrollContainerRef}
            className="h-full overflow-y-auto overflow-x-hidden p-4"
            style={{ display: deferredTab === 'results' ? 'block' : 'none' }}
          >
            {/* Conversation feed — history renders above the measured zone;
                only the active exchange (children slot) drives window height. */}
            <ResultsFeed
              entries={feedEntries}
              activeExchangeId={activeExchangeId}
              measureRef={resultsMeasureRef}
              historyLoading={historyLoading}
              hasMoreHistory={hasMoreHistory}
              onRedo={handleFeedRedo}
              onCopy={handleFeedCopy}
              onPlanApprove={handleFeedPlanApprove}
              onPlanCancel={handleFeedPlanCancel}
              onOpenPath={handleFeedOpenPath}
              onOpenSourceUrl={(url) => ipcRenderer?.send('shell:open-url', url)}
            >
              {/* Proactive alert cards — question blocks + thought-engine outreach */}
              {questionAlert && (
                <div
                  className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 cursor-pointer hover:bg-amber-500/20 transition-colors"
                  onClick={() => { setActiveTab(questionAlert.tab); setQuestionAlert(null); }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[0.72rem] text-amber-200">❓ {questionAlert.text}</div>
                    <button
                      className="text-amber-400/70 hover:text-amber-300 text-xs leading-none"
                      onClick={(e) => { e.stopPropagation(); setQuestionAlert(null); }}
                    >✕</button>
                  </div>
                  <div className="text-[0.6rem] text-amber-400/60 mt-0.5">
                    {new Date(questionAlert.ts).toLocaleTimeString()} · tap to answer{questionAlert.tab === 'queue' ? ' in Queue' : ''}
                  </div>
                </div>
              )}
              <ResultsContent
                liveRunHidden={liveRunHidden}
                contentRef={contentRef}
                scrollBottomRef={scrollBottomRef}
                installOutputRef={installOutputRef}
                streamingResponse={streamingResponse}
                resultItems={resultItems}
                isStreaming={isStreaming}
                isThinking={isThinking}
                thinkingElapsed={thinkingElapsed}
                isTaskWorking={isTaskWorking}
                isAutomationMode={isAutomationMode}
                isDropping={isDropping}
                installPrompt={installPrompt}
                isInstalling={isInstalling}
                installOutput={installOutput}
                actionChips={actionChips}
                searchSources={searchSources}
                showSourcesPanel={showSourcesPanel}
                schedulePending={schedulePending}
                bridgeStatus={bridgeStatus}
                skillBuild={skillBuild}
                deferredTab={deferredTab}
                setIsSubmitting={setIsSubmitting}
                setPreflightAuthPending={setPreflightAuthPending}
                onScheduleDismiss={handleScheduleDismiss}
                onInstallConfirm={handleInstallButtonClick}
                onActionChip={handleActionChip}
                onToggleSourcesPanel={handleToggleSourcesPanel}
                onOpenSourceUrl={(url) => ipcRenderer?.send('shell:open-url', url)}
                onScrollToBottom={scrollToBottom}
                onOpenRules={handleOpenRules}
                onHeightChange={handleAutomationHeightChange}
                onActiveChange={handleAutomationActiveChange}
                onRunSummary={handleRunSummary}
              />
            </ResultsFeed>
          </div>

          {/* Queue Tab — no top padding so the sticky filter bar sits flush under the tab bar */}
          <div 
            ref={queueTabRef}
            className="overflow-y-auto overflow-x-hidden px-4 pb-4 flex flex-col gap-2"
            style={{ display: deferredTab === 'queue' ? 'flex' : 'none', height: 'auto', maxHeight: '100%' }}
          >
              {restartAlert && (
                <div style={{ marginTop: 12, borderRadius: 9, padding: '10px 14px', backgroundColor: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.3)', display: 'flex', flexDirection: 'column', gap: 6 }}>
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

              {/* comms-graph background tasks (concurrent handoffs) — at top */}
              <QueueTaskList
                tasks={commsTasks}
                onContinueThread={handleContinueThread}
                onHeightChange={handleQueueHeightChange}
                focusRequest={queueFocus}
                onFocusHandled={handleQueueFocusHandled}
              />
            </div>

          {/* Cron Tab */}
          <div 
            ref={cronTabRef}
            className="overflow-y-auto overflow-x-hidden p-4"
            style={{ display: deferredTab === 'cron' ? 'block' : 'none', height: 'auto', maxHeight: '100%' }}
          >
              <CronTab
                items={cronItems}
                onToggle={handleCronToggle}
                onDelete={handleCronDelete}
                onRerun={handleCronRerun}
              />
            </div>

          {/* Agents Tab */}
          <div 
            ref={agentsTabRef}
            className="overflow-y-auto overflow-x-hidden"
            style={{ display: deferredTab === 'agents' ? 'block' : 'none', height: 'auto', maxHeight: '100%' }}
          >
              <AgentsTab
                items={agentItems}
                onRefresh={handleAgentsRefresh}
                onContentResize={measureNow}
                modalCardRef={setModalCardEl}
              />
            </div>

          {/* Skills Tab */}
          <div 
            ref={skillsTabRef}
            className="overflow-y-auto overflow-x-hidden p-4"
            style={{ display: deferredTab === 'skills' ? 'block' : 'none', height: 'auto', maxHeight: '100%' }}
          >
              <SkillsTab
                items={skillItems}
                onSaveSecret={handleSkillsSaveSecret}
                onOpenCode={handleSkillsOpenCode}
                onOAuthConnect={handleSkillsOAuthConnect}
                onScopesChange={handleSkillsScopesChange}
                onRepairOAuth={handleSkillsRepairOAuth}
                onDelete={handleSkillsDelete}
                onInstallFromUrl={handleSkillsInstallFromUrl}
                onInstallFromFile={handleSkillsInstallFromFile}
                onRefreshSkills={handleSkillsRefresh}
                onContentResize={measureNow}
                modalCardRef={setModalCardEl}
              />
            </div>

          {/* Connections Tab */}
          <div 
            ref={connectionsTabRef}
            className="overflow-y-auto overflow-x-hidden p-4"
            style={{ display: deferredTab === 'connections' ? 'block' : 'none', height: 'auto', maxHeight: '100%' }}
          >
              <ConnectionsTab
                items={connectionItems}
                onConnect={handleConnectionsConnect}
                onDisconnect={handleConnectionsDisconnect}
                onRefresh={handleConnectionsRefresh}
              />
            </div>

          {/* Store Tab — removed (skills now managed in Skills tab) */}
          {/* <div
            ref={storeTabRef}
            className="overflow-y-auto overflow-x-hidden p-4"
            style={{ display: deferredTab === 'store' ? 'block' : 'none', height: 'auto', maxHeight: '100%' }}
          >
              <StoreTab onBuildSkill={() => setActiveTab('results')} />
          </div> */}

          {/* Settings Tab */}
          <div 
            ref={settingsTabRef}
            className="overflow-y-auto overflow-x-hidden p-4"
            style={{ display: deferredTab === 'settings' ? 'block' : 'none', height: 'auto', maxHeight: '100%' }}
          >
              <SettingsTab />
            </div>

          {/* Rules Tab */}
          <div 
            ref={rulesTabRef}
            className="overflow-y-auto overflow-x-hidden p-4"
            style={{ display: deferredTab === 'rules' ? 'block' : 'none', height: 'auto', maxHeight: '100%' }}
          >
              <RulesManagementPanel />
            </div>

          {/* Brain Tab — Thought/Trigger engine visibility */}
          <div
            ref={brainTabRef}
            className="overflow-y-auto overflow-x-hidden px-4 pb-4"
            style={{ display: deferredTab === 'brain' ? 'block' : 'none', height: 'auto', maxHeight: '100%' }}
          >
              <BrainTab
                thoughts={brainThoughts}
                onDecide={handleThoughtDecide}
                onRefresh={handleThoughtsRefresh}
              />
            </div>

          {/* Floating scroll-to-bottom button */}
          {deferredTab === 'results' && isScrolledUp && (
            <button
              onClick={scrollToBottom}
              className="absolute rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105"
              style={{
                right: 16,
                bottom: 16,
                width: 36,
                height: 36,
                backgroundColor: 'rgba(59, 130, 246, 0.18)',
                border: '1px solid rgba(59, 130, 246, 0.45)',
                color: '#93c5fd',
                zIndex: 20,
                backdropFilter: 'blur(4px)',
              }}
              title="Scroll to bottom"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>

        {/* AI Activity Panel - visible on all tabs */}
        {/* <AIActivityPanel
          ref={aiActivityPanelRef}
          isDebugMode={isDebugMode}
          activeTab={activeTab}
          isRunning={isSubmitting || isStreaming || isThinking}
          currentOperation={statusText}
        /> */}

        {/* Bottom Input Bar */}
        <PromptInputBar
          ref={promptInputBarRef}
          inputBarRef={inputBarRef}
          highlights={highlights}
          onHighlightRemove={handleHighlightRemove}
          gatherPending={gatherPending}
          gatherQuestion={gatherQuestion}
          isDebugMode={isDebugMode}
          isSubmitting={isSubmitting}
          copyButtonGlowing={copyButtonGlowing}
          onPaste={handlePaste}
          onAttachClick={handleAttachClick}
          onCopyClick={() => ipcRenderer?.send('copy-button:click')}
          onCancel={() => ipcRenderer?.send('automation:cancel')}
          onSubmit={handleSubmitFromInputBar}
          aiActivityPanelRef={aiActivityPanelRef}
          threadContext={threadContext}
          onThreadContextClear={handleThreadContextClear}
          voiceSession={voiceSession}
        />
      </div>

      {/* Learn Mode Overlay — shown when learning is active OR when showing completion summary */}
      <LearnModeOverlay
        learnMode={learnMode}
        onCancel={handleLearnCancel}
        onDone={handleLearnDone}
      />

      {/* Training Mode Banner removed — handled by TrainingPanel slideout in AgentsTab */}

      {/* Teach Me Dialog */}
      {trainingMode?.active && trainingMode.phase === 'teach_me' && trainingMode.agentId && (
        <TeachMeDialog
          agentId={trainingMode.agentId}
          question={trainingMode.teachMeQuestion || 'What should I learn here?'}
          options={trainingMode.teachMeOptions || ['Continue', 'Skip']}
          onAnswer={(answer, explanation) => {
            ipcRenderer?.send('agents:train-answer', { 
              agentId: trainingMode.agentId, 
              answer, 
              explanation 
            });
          }}
          onSkip={() => {
            ipcRenderer?.send('agents:train-answer', { 
              agentId: trainingMode.agentId, 
              answer: 'Skip', 
              explanation: 'User chose to skip' 
            });
          }}
        />
      )}

      {/* Highlight Debug Button (Dev Mode Only) */}
      {import.meta.env.DEV && showHighlightDebug && (
        <HighlightDebugPanel
          highlightQuery={highlightQuery}
          onQueryChange={setHighlightQuery}
          onExecute={handleHighlightDebugExecute}
          onClose={handleHighlightDebugClose}
        />
      )}

      {/* comms-graph task completion banner — retired: the Results feed is now
          the single surface for handoff completions/approvals. The water-drip
          sound moved to the task:complete handler; Approve&Run lives on the
          feed's run cards (plan:approve with taskId+planFile).
      <TaskCompleteBanner
        notification={taskNotification}
        onDismiss={() => setTaskNotification(null)}
        onShowResult={(taskId) => {
          const task = commsTasks.find(t => t.id === taskId);
          if (task) handleContinueThread(task);
          setTaskNotification(null);
        }}
        onGoToQueue={(taskId, status) => {
          setActiveTab('queue');
          setUnreadTabs(prev => { const n = new Set(prev); n.delete('queue'); return n; });
          if (taskId) setQueueFocus({ taskId, status, nonce: Date.now() });
          setTaskNotification(null);
        }}
        onApprove={(taskId, planFile) => {
          ipcRenderer.send('plan:approve', { taskId, planFile });
          setTaskNotification(null);
        }}
      />
      */}
    </div>
  );
}
