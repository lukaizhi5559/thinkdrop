/**
 * feedStore — external store for the Results feed domain.
 *
 * Replaces the UnifiedOverlay pattern of `useState` + `useRef` mirror +
 * sync `useEffect` triplets that existed only so mount-once IPC handlers
 * could read fresh values. Here `getState()` is always current and actions
 * are synchronous — the stale-closure bug class disappears by construction.
 *
 * Purity rule: this module must stay free of React/DOM/IPC imports and use
 * `import type` for component types — `feedStore.test.mts` runs it under
 * `node --test --experimental-strip-types` with no bundler.
 */
import type { FeedEntry, FeedDraft } from '../components/ResultsFeed';
import type { CommsTask } from '../components/QueueTaskCard';
import type { WebResultItem } from '../components/rich-content/WebResultCard';
import type { SearchSource } from '../components/ResultsContent';

export type FeedEntryInput = FeedEntry extends infer T
  ? T extends FeedEntry ? Omit<T, 'id' | 'ts'> & { id?: string; ts?: number } : never
  : never;

export interface HistoryPage {
  ids: string[];
  loadedAt: number;
}

export interface FeedState {
  entries: FeedEntry[];
  /** rAF-published stream display text — subscribe to this, not `acc`. */
  streamText: string;
  resultItems: WebResultItem[];
  searchSources: SearchSource[];
  commsTasks: CommsTask[];
  historyLoading: boolean;
  hasMoreHistory: boolean;
  liveRunHidden: boolean;
  // Stream/run status flags — moved here because IPC handlers read them
  // synchronously; that is what killed their ref-mirrors.
  isStreaming: boolean;
  isThinking: boolean;
  isAutomationMode: boolean;
  isSubmitting: boolean;
  isTaskWorking: boolean;
  isGlowActive: boolean;
  preflightAuthPending: boolean;
  isDropping: boolean;
}

interface FeedInternal {
  streamAcc: string;        // synchronous source of truth for the live segment
  streamSegment: string;    // last committed segment (mid-automation snapshots)
  streamCompleted: boolean; // a 'done' landed — next chunk starts a fresh stream
  placeholderStream: boolean;
  historyCursor: string | null;
  historyPages: HistoryPage[];
  sessionBoundary: string;
  taskExchange: Map<string, string>;
  lastExchangeId: string | null;
  lastPrompt: string;
  feedSeq: number;
  taskPrompts: Map<string, string>;
  hasDropped: boolean;             // drop-sound already played this stream
  playedIntentSound: Set<string>;  // dedup intent sounds per taskId
}

export interface FeedStore {
  getState: () => FeedState;
  subscribe: (fn: () => void) => () => void;
  internal: FeedInternal;
  // entries
  appendEntry: (e: FeedEntryInput) => string;
  patchEntry: (id: string, updates: Partial<FeedEntry>) => void;
  patchByTaskId: (taskId: string, updates: Partial<FeedEntry>) => void;
  prependHistory: (mapped: FeedEntry[], opts: { cursor: string; hasMore: boolean }) => void;
  evictExpiredHistory: (now: number, ttlMs: number) => string[] | null;
  removeEntry: (id: string) => void;
  resetEntries: () => void;
  upsertProactive: (thoughtId: string, pendingId: string) => void;
  appendUserEntry: (text: string, attachments?: FeedAttachment[]) => string | null;
  ensureRunEntry: (taskId: string, prompt?: string | null) => void;
  exchangeForTask: (taskId?: string | null, prompt?: string | null) => string | undefined;
  // stream
  streamAppendChunk: (text: string) => void;
  streamReplace: (text: string) => void;
  flushStream: () => void;
  clearStream: () => void;
  commitInFlightStream: () => void;
  // misc published fields
  set: (patch: Partial<FeedState>) => void;
  setCommsTasks: (fn: (prev: CommsTask[]) => CommsTask[]) => void;
  setHistoryLoading: (v: boolean) => void;
  getTask: (taskId: string) => CommsTask | undefined;
}

// ── Pure helpers (exported for tests + the history mapper) ──────────────────

export type FeedAttachment = { kind: 'file' | 'folder' | 'context' | 'thought' | 'highlight'; label: string; path?: string };

/** Run-entry drafts with a steps-derived fallback — when the run summary's
 * `drafts` array missed the snapshot (races, missed step_done), recover them
 * from per-step `draftPath` metadata so the Apply affordance still renders. */
export function deriveRunDrafts(entry: FeedEntry): FeedDraft[] {
  if (entry.kind !== 'run') return [];
  if (entry.drafts && entry.drafts.length > 0) return entry.drafts;
  return (entry.steps || [])
    .filter(s => typeof s.draftPath === 'string' && s.draftPath.length > 0)
    .map(s => ({
      draftPath: s.draftPath!,
      filePath: s.savedFilePath || null,
      openIn: Array.isArray(s.openIn) ? s.openIn : [],
      diff: s.diff || null,
    }));
}

/** Parse a leading [Tag: body] block into attachment chips (for bubbles + history). */
export function extractAttachments(raw: string): FeedAttachment[] {
  const out: FeedAttachment[] = [];
  let rest = String(raw || '');
  const tagRe = /^\[(Highlighted|File|Folder|Thought|Context):\s*([^\n]*)\]\n?/;
  let m: RegExpMatchArray | null;
  while ((m = rest.match(tagRe))) {
    const kindRaw = m[1].toLowerCase();
    const body = m[2].trim();
    const isPath = kindRaw === 'file' || kindRaw === 'folder';
    const kind = (kindRaw === 'highlighted' ? 'highlight' : kindRaw) as FeedAttachment['kind'];
    out.push({
      kind,
      label: isPath ? (body.split('/').filter(Boolean).pop() || body) : body.slice(0, 120),
      ...(isPath ? { path: body } : {}),
    });
    rest = rest.slice(m[0].length);
  }
  return out;
}

/** Strip context wrappers from the text shown in the user bubble. */
export function toDisplayPrompt(raw: string): string {
  let t = raw;
  if (t.startsWith('[Resumed task discussion]')) {
    const idx = t.lastIndexOf('\n\n');
    if (idx > 0) t = t.slice(idx + 2);
  }
  while (/^\[(?:Highlighted|File|Folder|Thought|Context):[^\n]*\]\n?/.test(t)) {
    t = t.replace(/^\[(?:Highlighted|File|Folder|Thought|Context):[^\n]*\]\n?/, '');
  }
  t = t.replace(/^\s*\n+/, '');
  // Engine plumbing injected by the stategraph (planner metadata, not user
  // text). [Resolved file path:] is appended AFTER the parenthetical, so the
  // paren strip must not be end-anchored — the chips already convey this.
  t = t.replace(/\n*\s*\(Context from prior turn:[^)]*\)/g, '');
  t = t.replace(/\n*\s*\[Resolved file path:[^\n]*\]/g, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  // Proactive dispatches append a save-dir instruction — engine internals,
  // not user text (leaks the brain outdir path into the bubble).
  t = t.replace(/\n*\s*Save any files you produce to:[^\n]*\s*$/, '');
  return t.trim();
}

/**
 * logConversation stores a planner-context tail on command_automate /
 * memory_retrieve assistant messages — "Step outputs:" blocks + "Saved
 * files:" — so follow-up prompts can reference real step content. Blocks
 * that merely repeat the lead answer render as the same response shown 2-3×.
 * Drop only the duplicate blocks; distinct outputs and saved paths stay.
 */
export function dedupePlannerTail(text: string): string {
  const STEP_MARK = '\n\nStep outputs:';
  const SAVED_MARK = '\n\nSaved files:';
  const cut = text.indexOf(STEP_MARK);
  if (cut < 0) return text;
  const lead = text.slice(0, cut).trimEnd();
  if (!lead) return text;
  let tail = text.slice(cut + STEP_MARK.length);
  let saved = '';
  const sIdx = tail.indexOf(SAVED_MARK);
  if (sIdx >= 0) { saved = tail.slice(sIdx); tail = tail.slice(0, sIdx); }
  const lines = tail.split('\n');
  const starts: number[] = [];
  lines.forEach((l, i) => { if (/^\[[^\]]+\]:/.test(l)) starts.push(i); });
  if (starts.length === 0) return text;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const leadN = norm(lead);
  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const block = lines.slice(starts[i], end).join('\n').trimEnd();
    const body = block.replace(/^\[[^\]]*\]:\s*/, '');
    if (norm(body) !== leadN) blocks.push(block);
  }
  if (blocks.length === 0) return (lead + saved).trim();
  return `${lead}\n\nStep outputs:\n${blocks.join('\n\n')}${saved}`.trim();
}

/** Map one conversation-service message to a FeedEntry (or null to skip). */
export function mapHistoryMessage(m: any): FeedEntry | null {
  const ts = Date.parse(m.timestamp || m.created_at || '') || Date.now();
  const id = `db_${m.id}`;
  const intent = m?.metadata?.intent;
  if (m.sender === 'user') {
    const raw = String(m.text || '');
    const attachments = extractAttachments(raw);
    return { id, ts, kind: 'user', text: toDisplayPrompt(raw), ...(attachments.length ? { attachments } : {}) } as FeedEntry;
  }
  // Thought-engine nudges persist as assistant rows with metadata.source —
  // reload them as proactive entries (brain styling), not chat bubbles.
  if (m.sender === 'assistant' && m?.metadata?.source === 'thought_engine') {
    return {
      id, ts, kind: 'proactive', text: String(m.text || ''),
      thoughtId: m.metadata.thoughtId,
    } as FeedEntry;
  }
  if (m.sender === 'assistant') {
    let text = String(m.text || '');
    if (intent === 'command_automate' || intent === 'memory_retrieve') {
      text = dedupePlannerTail(text);
    }
    return { id, ts, kind: 'assistant', text, taskId: m?.metadata?.taskId || undefined } as FeedEntry;
  }
  return null; // 'system' rows (recovery/ask_user) stay out of the feed
}

const normText = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Batch-map a conversation:list page: map → drop empties → chronological →
 * collapse consecutive (kind, text) duplicates. Paused/resumed runs re-log
 * the same user prompt once per execute() and land adjacently (system rows
 * are filtered); legit re-asks always have an assistant reply between them.
 */
export function mapHistoryMessages(msgs: any[], opts?: { tasks?: { id: string; prompt?: string; sessionId?: string | null }[] }): FeedEntry[] {
  // Chronological fold: track the preceding user message's RAW text so the
  // assistant entry can carry `prompt` — history rows keep their redo action
  // (live commits get prompt from internal.lastPrompt; reloaded rows had
  // nothing before this).
  let lastUserRaw: string | undefined;
  const tasks = opts?.tasks || [];
  return msgs
    .slice()
    .sort((a, b) => (Date.parse(a.timestamp || a.created_at || '') || 0) -
                    (Date.parse(b.timestamp || b.created_at || '') || 0))
    .map(m => {
      const e = mapHistoryMessage(m);
      if (m?.sender === 'user') {
        lastUserRaw = String(m.text || '');
      } else if (e && e.kind === 'assistant') {
        if (lastUserRaw && !e.prompt) e.prompt = lastUserRaw;
        // Retroactive queue link: rows logged before metadata.taskId existed
        // correlate to journal-restored tasks by session + exact prompt match.
        // Conservative — a miss leaves no icon rather than a wrong deep-link.
        if (!e.taskId && m?.sessionId && lastUserRaw) {
          const hit = tasks.find(t =>
            t.sessionId === m.sessionId &&
            normText(t.prompt || '') === normText(lastUserRaw!));
          if (hit) e.taskId = hit.id;
        }
      }
      return e;
    })
    .filter((e): e is FeedEntry => e !== null && !!(e as any).text)
    .sort((a, b) => a.ts - b.ts)
    .filter((e, i, arr) => {
      if (i === 0) return true;
      const prev = arr[i - 1];
      return !(prev.kind === e.kind &&
        normText((prev as any).text || '') === normText((e as any).text || ''));
    });
}

/** Oldest message's timestamp — the next page's `endDate` cursor. */
export function oldestMessageCursor(msgs: any[]): string {
  const oldest = msgs.reduce((a: any, b: any) =>
    (String(a.timestamp || a.created_at) < String(b.timestamp || b.created_at) ? a : b));
  return String(oldest.timestamp || oldest.created_at);
}

// ── Store factory ───────────────────────────────────────────────────────────

export function createFeedStore(now: () => number = () => Date.now()): FeedStore {
  let state: FeedState = {
    entries: [],
    streamText: '',
    resultItems: [],
    searchSources: [],
    commsTasks: [],
    historyLoading: false,
    hasMoreHistory: false,
    liveRunHidden: false,
    isStreaming: false,
    isThinking: false,
    isAutomationMode: false,
    isSubmitting: false,
    isTaskWorking: false,
    isGlowActive: false,
    preflightAuthPending: false,
    isDropping: false,
  };
  const internal: FeedInternal = {
    streamAcc: '',
    streamSegment: '',
    streamCompleted: false,
    placeholderStream: false,
    historyCursor: null,
    historyPages: [],
    sessionBoundary: new Date().toISOString(),
    taskExchange: new Map(),
    lastExchangeId: null,
    lastPrompt: '',
    feedSeq: 0,
    taskPrompts: new Map(),
    hasDropped: false,
    playedIntentSound: new Set(),
  };
  const listeners = new Set<() => void>();
  let flushScheduled = false;

  const notify = () => listeners.forEach(fn => fn());
  const set = (patch: Partial<FeedState>) => { state = { ...state, ...patch }; notify(); };
  const setEntries = (fn: (prev: FeedEntry[]) => FeedEntry[]) => {
    const next = fn(state.entries);
    if (next !== state.entries) set({ entries: next });
  };

  // rAF (or next-tick) publish of streamText — caps renders at display rate
  // while streamAcc stays synchronous for same-tick 'done' commits.
  const scheduleFlush =
    typeof requestAnimationFrame === 'function'
      ? (fn: () => void) => { requestAnimationFrame(fn); }
      : (fn: () => void) => { setTimeout(fn, 0); };
  const flushStream = () => {
    flushScheduled = false;
    if (state.streamText !== internal.streamAcc) set({ streamText: internal.streamAcc });
  };
  const queueFlush = () => {
    if (!flushScheduled) { flushScheduled = true; scheduleFlush(flushStream); }
  };

  const nextId = () => `fe_${now()}_${internal.feedSeq++}`;

  // Resolve the exchange an entry belongs to: taskId correlation wins; then a
  // matching user bubble's exchange; finally the newest exchange.
  const exchangeForTask = (taskId?: string | null, prompt?: string | null): string | undefined => {
    if (taskId && internal.taskExchange.has(taskId)) return internal.taskExchange.get(taskId);
    const clean = prompt ? toDisplayPrompt(prompt) : '';
    if (clean) {
      const hit = [...state.entries].reverse().find(e => e.kind === 'user' && e.text === clean);
      if (hit?.exchangeId) {
        if (taskId) internal.taskExchange.set(taskId, hit.exchangeId);
        return hit.exchangeId;
      }
    }
    const xid = internal.lastExchangeId || undefined;
    if (taskId && xid) internal.taskExchange.set(taskId, xid);
    return xid;
  };

  const appendEntry = (e: FeedEntryInput): string => {
    const id = e.id || nextId();
    const ts = e.ts ?? now();
    // One assistant answer per taskId — repeated task:complete events patch in
    // place rather than append a second copy. Synchronous getState() makes the
    // old ref+updater two-tier check unnecessary.
    if (e.kind === 'assistant' && e.taskId) {
      const hit = state.entries.find(x => x.kind === 'assistant' && x.taskId === e.taskId);
      if (hit) {
        const { id: _i, ts: _t, ...patch } = e as any;
        setEntries(prev => prev.map(x => x.id === hit.id
          ? ({ ...x, ...patch, pending: e.pending ?? false } as FeedEntry)
          : x));
        return hit.id;
      }
    }
    setEntries(prev => [...prev, { ...e, id, ts } as FeedEntry]);
    return id;
  };

  const patchEntry = (id: string, updates: Partial<FeedEntry>) => {
    setEntries(prev => prev.map(e => (e.id === id ? ({ ...e, ...updates } as FeedEntry) : e)));
  };

  const patchByTaskId = (taskId: string, updates: Partial<FeedEntry>) => {
    setEntries(prev => prev.map(e =>
      (e.kind === 'assistant' || e.kind === 'run') && e.taskId === taskId
        ? ({ ...e, ...updates } as FeedEntry)
        : e
    ));
  };

  const appendUserEntry = (text: string, attachments?: FeedAttachment[]): string | null => {
    const clean = toDisplayPrompt(text);
    if (!clean) return null;
    // Reuse the exchangeId only for an unreplied identical user bubble — the
    // unified:set-prompt echo re-appends the same text ~1s after the local
    // submit and must dedupe, but a re-asked message after a reply is a NEW
    // exchange. run/proactive entries don't advance the turn (run cards can
    // land before the echo; nudges can interleave) — assistant/system do.
    const entries = state.entries;
    let lastUserIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].kind === 'user') { lastUserIdx = i; break; }
    }
    const lastUser = (lastUserIdx >= 0 ? entries[lastUserIdx] : null) as
      Extract<FeedEntry, { kind: 'user' }> | null;
    const turnAdvanced = lastUserIdx >= 0 && entries.slice(lastUserIdx + 1)
      .some(e => e.kind === 'assistant' || e.kind === 'system');
    const xid = (!turnAdvanced && lastUser && lastUser.exchangeId &&
      normText(lastUser.text) === normText(clean))
      ? lastUser.exchangeId
      : `x_${now()}_${internal.feedSeq++}`;
    setEntries(prev => prev.some(e => e.kind === 'user' && e.exchangeId === xid)
      ? prev
      : [...prev, { id: nextId(), ts: now(), kind: 'user', text: clean, exchangeId: xid, ...(attachments?.length ? { attachments } : {}) } as FeedEntry]);
    internal.lastExchangeId = xid;
    internal.lastPrompt = clean;
    return xid;
  };

  const ensureRunEntry = (taskId: string, prompt?: string | null) => {
    if (!taskId) return;
    const p = prompt || internal.taskPrompts.get(taskId) || '';
    if (p && !internal.taskPrompts.has(taskId)) internal.taskPrompts.set(taskId, p);
    const exchangeId = exchangeForTask(taskId, p);
    setEntries(prev => {
      if (prev.some(e => e.kind === 'run' && e.taskId === taskId)) return prev;
      return [...prev, {
        id: nextId(),
        ts: now(),
        kind: 'run',
        taskId,
        title: toDisplayPrompt(p) || 'Automation run',
        prompt: p || undefined,
        exchangeId,
        status: 'running',
      } as FeedEntry];
    });
  };

  const commitInFlightStream = () => {
    const text = internal.streamAcc;
    if (!text || !text.trim()) return;
    appendEntry({
      kind: 'assistant',
      text,
      items: state.resultItems,
      sources: state.searchSources,
      prompt: internal.lastPrompt || undefined,
      exchangeId: internal.lastExchangeId || undefined,
    });
    internal.streamAcc = '';
    internal.placeholderStream = false;
  };

  const prependHistory = (mapped: FeedEntry[], opts: { cursor: string; hasMore: boolean }) => {
    const ids = mapped.map(m => m.id);
    // Actively scrolling history = interest — refresh the whole zone's TTL so
    // a fresh page doesn't get evicted because the floor page is old.
    internal.historyPages.forEach(p => { p.loadedAt = now(); });
    internal.historyPages.push({ ids, loadedAt: now() });
    internal.historyCursor = opts.cursor;
    setEntries(prev => {
      const existing = new Set(prev.map(e => e.id));
      const fresh = mapped.filter(e => !existing.has(e.id));
      if (!fresh.length) return prev;
      return [...fresh, ...prev];
    });
    set({ hasMoreHistory: opts.hasMore });
  };

  /**
   * Drop every prepended page whose TTL expired — history snaps back to the
   * floor page and scroll-up refetches (cursor rewinds to the oldest
   * surviving history row). Returns removed ids, or null when nothing aged
   * out. Scroll-guard lives in the caller (it owns the DOM).
   */
  const evictExpiredHistory = (nowMs: number, ttlMs: number): string[] | null => {
    const pages = internal.historyPages;
    if (!pages.length) return null;
    if (nowMs - pages[0].loadedAt < ttlMs) return null;
    const removed = new Set(pages.flatMap(p => p.ids));
    internal.historyPages = [];
    let cursor = internal.sessionBoundary;
    setEntries(prev => {
      const next = prev.filter(e => !removed.has(e.id));
      // Cursor rewinds to the oldest surviving history row so the next
      // scroll-up refetches exactly the evicted range.
      const oldestHist = next.find(e => e.id.startsWith('db_'));
      if (oldestHist) cursor = new Date(oldestHist.ts).toISOString();
      return next;
    });
    internal.historyCursor = cursor;
    set({ hasMoreHistory: true });
    return [...removed];
  };

  const store: FeedStore = {
    getState: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    internal,
    appendEntry,
    patchEntry,
    patchByTaskId,
    prependHistory,
    evictExpiredHistory,
    removeEntry: (id) => setEntries(prev => prev.filter(e => e.id !== id)),
    resetEntries: () => setEntries(() => []),
    // A re-nudge replaces its pending line — deduped per thoughtId.
    upsertProactive: (thoughtId, pendingId) => {
      setEntries(prev => [
        ...prev.filter(e => !(e.kind === 'proactive' && e.thoughtId === thoughtId)),
        { id: pendingId, ts: now(), kind: 'proactive', thoughtId, text: '', pending: true } as FeedEntry,
      ]);
    },
    appendUserEntry,
    ensureRunEntry,
    exchangeForTask,
    streamAppendChunk: (text) => { internal.streamAcc += text; queueFlush(); },
    streamReplace: (text) => { internal.streamAcc = text; queueFlush(); },
    flushStream,
    clearStream: () => {
      internal.streamAcc = '';
      if (state.streamText) set({ streamText: '' });
    },
    commitInFlightStream,
    set,
    setCommsTasks: (fn) => {
      const next = fn(state.commsTasks);
      if (next !== state.commsTasks) set({ commsTasks: next });
    },
    setHistoryLoading: (v) => set({ historyLoading: v }),
    getTask: (taskId) => state.commsTasks.find(t => t.id === taskId),
  };
  return store;
}

/** Singleton used by the app; tests construct their own via createFeedStore. */
export const feedStore = createFeedStore();
