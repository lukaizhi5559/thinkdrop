/**
 * feedIpc — feed-domain IPC handlers, extracted from UnifiedOverlay.
 *
 * Handlers are module-level functions closing over the store — no React
 * closures, so no stale-state reads and no ref mirrors. Component-coupled
 * side-effects (tab switching, scroll anchoring, non-feed UI setters) go
 * through the `ui` bridge passed to installFeedIpc.
 */
import { friendlyErrorMessage } from '../components/ResultsFeed';
import { playDropSound, playIntentSound, playDefaultSound } from '../utils/thinkDropSound';
import { mapHistoryMessages, oldestMessageCursor, toDisplayPrompt, type FeedStore } from './feedStore.mts';

const ipcRenderer = (window as any).electron?.ipcRenderer;

/** DOM/component services the handlers need — supplied by UnifiedOverlay. */
export interface FeedIpcUi {
  dbg: (...args: any[]) => void;
  setActiveTab: (tab: string) => void;
  markUnread: (tab: string) => void;
  setActionChips: (chips: any[]) => void;
  setInstallPrompt: (p: any) => void;
  /** Flip the scroll-anchor ref so the next entries change applies the shift. */
  markPrependCommitted: () => void;
}

// Module-scope ephemera owned by these handlers (single overlay instance).
let glowOffTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleGlowOff(fn: () => void, ms: number) {
  if (glowOffTimer) clearTimeout(glowOffTimer);
  glowOffTimer = setTimeout(fn, ms);
}
export function cancelGlowOff() {
  if (glowOffTimer) { clearTimeout(glowOffTimer); glowOffTimer = null; }
}

export function installFeedIpc(store: FeedStore, ui: FeedIpcUi): () => void {
  const token = 'unified-overlay';
  if (!ipcRenderer) return () => {};
  const { dbg } = ui;
  const s = store;

  // --- Results / Streaming -------------------------------------------------
  const handleWsMessage = (message: { type: string; text?: string; lane?: string; payload?: any; taskId?: string; isPlaceholder?: boolean }) => {
    if (!message) return;
    const preview = message.text ? `"${message.text.substring(0, 50)}${message.text.length > 50 ? '...' : ''}"` : '(no text)';
    dbg(`[UNIFIED:DIAG] msg.type=${message.type} lane=${message.lane} preview=${preview} curRespLen=${s.internal.streamAcc.length}`);
    dbg('📨 [UNIFIED] WebSocket message received:', message.type, preview, 'lane:', message.lane, 'full message:', message);

    if (message.type === 'chunk' || message.type === 'llm_stream_chunk') {
      dbg('💬 [UNIFIED] Received chunk, length:', message.text?.length || 0);
      s.set({ isThinking: false, isStreaming: true, isGlowActive: true });
      cancelGlowOff();

      // Defensive: reset automation mode if we're receiving regular content (not automation)
      // This catches cases where a new non-automation prompt starts but automation UI persists
      if (s.getState().isAutomationMode && !message.lane?.includes('automation') && !s.internal.streamAcc) {
        dbg('🔄 [UNIFIED] First chunk on new prompt - resetting automation mode');
        s.set({ isAutomationMode: false });
        ui.setActionChips([]);
        ui.setInstallPrompt(null);
      }

      // Play drop sound once when streaming starts (skip for fast lane and
      // handoff placeholder chunks — the drip is for the real answer only)
      if (!s.internal.hasDropped && message.lane !== 'fast' && !message.isPlaceholder) {
        s.internal.hasDropped = true;
        playDropSound();
        s.set({ isDropping: true });
        setTimeout(() => s.set({ isDropping: false }), 600);
      }

      // Detect new stream starting after previous completed. Capture and reset the
      // flag synchronously so subsequent chunks in the same batch don't re-clear.
      const isNewStream = s.internal.streamCompleted;
      if (isNewStream) {
        s.internal.streamCompleted = false;
        dbg('🔄 [UNIFIED] New stream started after completion — will clear previous response');
      }

      const msgText = message?.text || message.payload?.text || '';
      if (msgText.startsWith('\x00SOURCES\x00')) {
        try {
          const sources = JSON.parse(msgText.slice('\x00SOURCES\x00'.length));
          if (Array.isArray(sources)) s.set({ searchSources: sources });
        } catch (_) {}
        return;
      } else if (msgText.startsWith('\x00ITEMS\x00')) {
        try {
          const items = JSON.parse(msgText.slice('\x00ITEMS\x00'.length));
          if (Array.isArray(items)) s.set({ resultItems: items });
        } catch (_) {}
        return;
      } else if (msgText.startsWith('\x00REPLACE\x00')) {
        const newText = msgText.slice('\x00REPLACE\x00'.length);
        dbg('🔄 [UNIFIED] Replacing text, new length:', newText.length);
        s.streamReplace(newText);
      } else {
        dbg('➕ [UNIFIED] Appending text, length:', msgText.length);
        if (message.isPlaceholder) s.internal.placeholderStream = true;
        // streamAcc is the synchronous source of truth — a 'done' arriving in
        // the same IPC batch must read the fresh accumulator, not last frame's
        // published streamText.
        s.streamAppendChunk(msgText);
        dbg('📝 [UNIFIED] Combined length:', s.internal.streamAcc.length, isNewStream ? '(new stream — cleared prev)' : '');
      }
    } else if (message.type === 'done' || message.type === 'llm_stream_end') {
      const st = s.getState();
      s.set({ isStreaming: false, isThinking: false });
      // Don't reset isSubmitting/isAutomationMode during automation — the plan
      // generation LLM stream ends before execution completes, which would
      // prematurely hide the cancel button. Automation cleanup is handled by
      // the 'all_done' event in handleAutomationProgress.
      if (!st.preflightAuthPending && !st.isAutomationMode) {
        s.set({ isSubmitting: false });
      }
      if (!st.isAutomationMode) {
        s.set({ isAutomationMode: false });
      }
      s.internal.streamCompleted = true;
      dbg('✅ [UNIFIED] Streaming complete, final streamAcc length:', s.internal.streamAcc.length);
      scheduleGlowOff(() => s.set({ isGlowActive: false }), 300);

      // ── Feed commit ─────────────────────────────────────────────────
      // Mid-run 'done's during automation only snapshot the segment — the
      // final commit happens at all_done (plan-gen text is discarded, the
      // synth summary is what settles into the feed). Placeholder acks are
      // exempt: they belong to the exchange, so they commit as pending entries
      // even in automation mode — otherwise the ack text stays stranded in the
      // live region below the run card.
      const wasPlaceholder = s.internal.placeholderStream;
      if (st.isAutomationMode && !wasPlaceholder) {
        if (s.internal.streamAcc.trim()) s.internal.streamSegment = s.internal.streamAcc;
        s.internal.streamAcc = '';
      } else {
        const finalText = s.internal.streamAcc;
        if (finalText.trim()) {
          s.appendEntry({
            kind: 'assistant',
            text: finalText,
            items: st.resultItems.length > 0 ? st.resultItems
              : (s.getTask(message.taskId || '')?.items ?? undefined),
            sources: st.searchSources,
            taskId: message.taskId || undefined,
            pending: wasPlaceholder || undefined,
            prompt: s.internal.lastPrompt || undefined,
            exchangeId: s.exchangeForTask(message.taskId, s.internal.lastPrompt),
          });
          if (wasPlaceholder) s.internal.placeholderStream = false;
          s.internal.streamSegment = '';
          s.clearStream();
          s.set({ resultItems: [], searchSources: [] });
        }
        s.internal.streamAcc = '';
      }
    } else if (message.type === 'ready') {
      dbg('✅ [UNIFIED] VS Code extension ready');
    }
  };

  // --- Search Sources ---
  const handleSearchSources = (sources: any[]) => {
    s.set({ searchSources: sources });
  };

  // ── Conversation history pages (Results feed scroll-up pagination) ───────
  // Response: { messages } newest-first, bounded above by sessionBoundary.
  const handleConversationList = (data: { messages?: any[] }) => {
    s.setHistoryLoading(false);
    const msgs = Array.isArray(data?.messages) ? data.messages : [];
    if (msgs.length > 0) {
      const mapped = mapHistoryMessages(msgs, { tasks: s.getState().commsTasks });
      const cursor = oldestMessageCursor(msgs);
      // Only the real prepend may consume the scroll anchor — stray feed
      // updates during this round-trip must not eat it first.
      ui.markPrependCommitted();
      s.prependHistory(mapped, { cursor, hasMore: msgs.length >= 20 });
    } else {
      s.set({ hasMoreHistory: false });
    }
  };

  // ── comms-graph task events ──────────────────────────────────────────────
  const handleTaskCreated = (data: any) => {
    if (!data?.taskId) return;
    const isRestored = data.restored === true;
    // Intent sound + ••• working indicator (from comms-graph regex guess).
    if (!isRestored) {
      // Play once per task — a parked task's second task:created on resume
      // must not re-play the sound.
      if (!s.internal.playedIntentSound.has(data.taskId)) {
        s.internal.playedIntentSound.add(data.taskId);
        if (data.guessedIntent) playIntentSound(data.guessedIntent);
        else playDefaultSound();
      }
      // Show ••• for all handoff tasks except command_automate.
      if (data.guessedIntent !== 'command_automate') {
        s.set({ isTaskWorking: true });
      }
    }
    s.setCommsTasks(prev => {
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
    if (data.prompt) s.internal.taskPrompts.set(data.taskId, data.prompt);
    if (!isRestored) {
      ui.markUnread('queue');
      // Correlation first — the run card (and every later task-scoped event)
      // joins this exchange via taskExchange.
      if (data.prompt) {
        const xid = s.appendUserEntry(data.prompt);
        if (xid) s.internal.taskExchange.set(data.taskId, xid);
      }
      if (data.guessedIntent === 'command_automate') {
        s.ensureRunEntry(data.taskId, data.prompt);
      }
    }
  };

  const handleTaskProgress = (data: any) => {
    if (!data?.taskId) return;
    s.setCommsTasks(prev => prev.map(t => {
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
    s.patchByTaskId(data.taskId, { status: 'running' } as any);
  };

  const handleTaskComplete = (data: any) => {
    if (!data?.taskId) return;
    const status = data.status || (data.error ? 'failed' : 'done');
    const taskIntent = data.intent || null;
    const isCommandAutomate = taskIntent === 'command_automate';
    const isRestored = data.restored === true;

    s.setCommsTasks(prev => prev.map(t => {
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

    s.internal.playedIntentSound.delete(data.taskId);
    s.set({ isTaskWorking: false });

    // Clear the prompt glow on terminal states. Handoff tasks never emit a
    // ws-bridge 'done', and non-plan intents never emit 'all_done' — so
    // task:complete is their only reliable "finished" signal. Paused states
    // keep the glow on as an attention signal.
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      scheduleGlowOff(() => s.set({ isGlowActive: false }), 400);
    }

    if (isRestored) return;

    // ── Feed: settle run card + placeholder answer ──────────────────────
    const settlePendingAssistant = (text: string, items?: any[]) => {
      // The complete payload can lack items even when the comms task carries
      // them — fall back so the feed entry gets the same results grid.
      const resolvedItems = (items && items.length > 0) ? items
        : (s.getTask(data.taskId)?.items ?? undefined);
      const hit = [...s.getState().entries].reverse().find(e =>
        e.kind === 'assistant' && (e.taskId === data.taskId || e.pending));
      if (hit) {
        // Stamp taskId too — the feed's queue-icon deep-link keys off it. And a
        // prompt fallback so redo survives entries committed before lastPrompt.
        s.patchEntry(hit.id, {
          text, pending: false, items: resolvedItems, taskId: data.taskId,
          prompt: (hit as any).prompt || s.internal.lastPrompt || undefined,
        } as any);
      } else {
        s.appendEntry({ kind: 'assistant', text, items: resolvedItems, taskId: data.taskId, prompt: s.internal.lastPrompt || undefined, exchangeId: s.exchangeForTask(data.taskId, s.internal.lastPrompt) });
      }
    };

    // Settle a pending placeholder ("Give me a sec…") or the active-exchange
    // preamble into a friendly error card. Searches any assistant entry after
    // the last user bubble — preamble commits can lack taskId/pending.
    const settleError = () => {
      const raw = data.error || `Task ${status}`;
      const entries = s.getState().entries;
      let lastUserIdx = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].kind === 'user') { lastUserIdx = i; break; }
      }
      const hit = [...entries].reverse().find(e =>
        e.kind === 'assistant' &&
        (e.taskId === data.taskId || e.pending ||
          (lastUserIdx >= 0 && entries.indexOf(e) > lastUserIdx)));
      if (hit) {
        s.patchEntry(hit.id, {
          text: friendlyErrorMessage(raw), pending: false, isError: true,
          errorRaw: raw, taskId: data.taskId,
          prompt: (hit.kind === 'assistant' ? hit.prompt : undefined) || s.internal.lastPrompt || undefined,
        } as any);
        return true;
      }
      return false;
    };

    if (isCommandAutomate) {
      // Patch (or append) the run card for this task — except on 'done': a
      // completed run leaves no card in the feed (the answer bubble carries the
      // result; details stay reachable via the Queue icon / Queue tab). Removal
      // matches by taskId only — never the recency fallback, which could eat a
      // neighbouring untagged card. Failed/cancelled keep their card + error.
      {
        const prev = s.getState().entries;
        if (status === 'done') {
          const idx = prev.findIndex(e => e.kind === 'run' && e.taskId === data.taskId);
          if (idx >= 0) s.set({ entries: prev.filter((_, i) => i !== idx) });
        } else {
          const runPatch = { status: status as any, error: data.error || null, planFile: data.planFile || undefined };
          let idx = prev.findIndex(e => e.kind === 'run' && e.taskId === data.taskId);
          if (idx < 0) {
            for (let i = prev.length - 1; i >= 0; i--) {
              const e = prev[i];
              if (e.kind !== 'run') break;
              if (Date.now() - e.ts < 15000 && !e.taskId) { idx = i; break; }
            }
          }
          const exchangeId = s.exchangeForTask(data.taskId, data.prompt);
          let next;
          if (idx < 0) {
            next = [...prev, { id: `fe_${Date.now()}_${s.internal.feedSeq++}`, ts: Date.now(), kind: 'run', taskId: data.taskId, title: data.prompt ? toDisplayPrompt(data.prompt) || 'Automation run' : 'Automation run', prompt: data.prompt || undefined, exchangeId, ...runPatch } as any];
          } else {
            next = prev.slice();
            const prevRun = next[idx];
            next[idx] = { ...prevRun, taskId: (prevRun.kind === 'run' ? prevRun.taskId : undefined) || data.taskId, exchangeId: prevRun.exchangeId || exchangeId, ...runPatch } as any;
          }
          s.set({ entries: next });
        }
      }
      if (status === 'done' && data.answer) {
        settlePendingAssistant(data.answer, Array.isArray(data.items) ? data.items : undefined);
      } else if (status === 'failed' || status === 'cancelled') {
        settleError();
      }
      // Water-drip used to live on TaskCompleteBanner — moved here.
      if (status === 'done' || status === 'failed' || status === 'cancelled') playDropSound();
    } else if (status === 'done' && data.answer) {
      // ── Non-command_automate: settle the placeholder into the real answer ──
      settlePendingAssistant(data.answer, Array.isArray(data.items) ? data.items : undefined);
      s.internal.streamAcc = '';
      s.internal.placeholderStream = false;
      s.internal.streamCompleted = true;
      s.set({ streamText: '', resultItems: [], isStreaming: false, isTaskWorking: false });
      playDropSound();
    } else if (status === 'failed' || status === 'cancelled') {
      if (!settleError()) {
        const raw = data.error || `Task ${status}`;
        s.appendEntry({
          kind: 'assistant', text: friendlyErrorMessage(raw), isError: true, errorRaw: raw,
          taskId: data.taskId, prompt: s.internal.lastPrompt || undefined,
          exchangeId: s.exchangeForTask(data.taskId, s.internal.lastPrompt),
        });
      }
    }
    ui.markUnread('queue');
  };

  const handleTaskRemoved = (data: any) => {
    if (data?.taskId) {
      s.setCommsTasks(prev => prev.filter(t => t.id !== data.taskId));
      // Task deleted from Queue — drop its feed card too or it dangles as a
      // static fallback with no live data behind it.
      s.set({ entries: s.getState().entries.filter(e => !(e.kind === 'run' && e.taskId === data.taskId)) });
    }
  };

  // ── Registration (token dedupes in preload) ─────────────────────────────
  ipcRenderer.on('ws-bridge:message', handleWsMessage, token);
  ipcRenderer.on('search:sources', handleSearchSources, token);
  ipcRenderer.on('conversation:list', handleConversationList, token);
  ipcRenderer.on('task:created', handleTaskCreated, token);
  ipcRenderer.on('task:progress', handleTaskProgress, token);
  ipcRenderer.on('task:complete', handleTaskComplete, token);
  ipcRenderer.on('task:removed', handleTaskRemoved, token);

  return () => {
    ipcRenderer.removeListenerByToken('ws-bridge:message', token);
    ipcRenderer.removeListenerByToken('search:sources', token);
    ipcRenderer.removeListenerByToken('conversation:list', token);
    ipcRenderer.removeListenerByToken('task:created', token);
    ipcRenderer.removeListenerByToken('task:progress', token);
    ipcRenderer.removeListenerByToken('task:complete', token);
    ipcRenderer.removeListenerByToken('task:removed', token);
  };
}
