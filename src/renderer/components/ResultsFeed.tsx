import React, { useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { Favicon } from './DefaultFaviconIcon';
import { ThinkDropLogo } from './SlideoutDrawer';
import { RichContentRenderer } from './rich-content';
import { WebResultsGrid, stripItemImageMarkdown } from './rich-content';
import { StepIcon, SkillBadge, SkillIcon } from './AutomationProgress';
import type { RunSummary } from './AutomationProgress';
import { QueueTaskCard, BrainIcon } from './QueueTaskCard';
import type { CommsTask } from './QueueTaskCard';
import type { WebResultItem } from './rich-content/WebResultCard';

// ── Feed entry model ─────────────────────────────────────────────────────────
// One item per row in the conversation feed. `ts` drives day dividers.
// `exchangeId` correlates every entry that belongs to one user submission —
// entries sharing an exchangeId render contiguously (user → assistant → run)
// regardless of the order async events appended them in. Entries without one
// (proactive, system, history) keep their own slot in the list.

export type FeedRunStatus = 'queued' | 'running' | 'awaiting-approval' | 'auth-required' | 'waiting-for-input' | 'done' | 'failed' | 'cancelled';

/** An edit.agent draft pending user apply. `openIn` names the processes holding
 *  the target file — non-empty means apply requires closing that app first. */
export interface FeedDraft {
  draftPath: string;
  filePath: string | null;
  openIn: string[];
  diff?: string | null;
  applied?: boolean;
  applying?: boolean;
  applyError?: string | null;
}

export type FeedEntry =
  | { id: string; ts: number; kind: 'user'; text: string; exchangeId?: string; attachments?: { kind: 'file' | 'folder' | 'context' | 'thought' | 'highlight'; label: string; path?: string }[] }
  | { id: string; ts: number; kind: 'assistant'; text: string; items?: WebResultItem[]; sources?: { url: string; hostname: string; title?: string }[]; taskId?: string; pending?: boolean; prompt?: string; isError?: boolean; errorRaw?: string; exchangeId?: string }
  | { id: string; ts: number; kind: 'run'; title: string; status: FeedRunStatus; steps?: { title: string; status: string; skill?: string; output?: string; savedFilePath?: string }[]; savedFilePaths?: string[]; drafts?: FeedDraft[]; error?: string | null; taskId?: string; planFile?: string | null; durationMs?: number | null; prompt?: string; exchangeId?: string }
  | { id: string; ts: number; kind: 'proactive'; text: string; thoughtId?: string; pending?: boolean; exchangeId?: string }
  | { id: string; ts: number; kind: 'system'; text: string; exchangeId?: string };

interface ResultsFeedProps {
  entries: FeedEntry[];
  /** Entries from this id onward form the active exchange — rendered inside the
   *  measured zone (drives window height). Everything before it is history. */
  activeExchangeId: string | null;
  /** Ref applied to the measured (current-exchange) zone wrapper. */
  measureRef: RefObject<HTMLDivElement>;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  onRedo: (prompt: string) => void;
  onCopy: (text: string) => void;
  onPlanApprove: (taskId: string, planFile: string | null) => void;
  onPlanCancel: (taskId: string, planFile: string | null) => void;
  onOpenPath: (path: string) => void;
  onOpenSourceUrl: (url: string) => void;
  /** "Close <app> & Apply" / "Apply" on an edit.agent draft — closes the holding
   *  document (save prompt if unsaved) then applies the draft to the original. */
  onApplyDraft?: (entryId: string, draft: FeedDraft) => void;
  /** Look up a live comms task by id — run entries with a match render the real
   *  QueueTaskCard (task-scoped AutomationProgress inside). */
  resolveTask?: (taskId: string) => CommsTask | undefined;
  onContinueThread?: (task: CommsTask) => void;
  /** Terminal snapshot emitted by a live card's embedded AutomationProgress —
   *  used to keep the static fallback data current after the task is purged. */
  onRunSummaryForTask?: (taskId: string, summary: RunSummary) => void;
  /** Deep-link into the Queue tab — scrolls to + flashes the task card. */
  onOpenQueue?: (taskId: string) => void;
  /** Target-icon action — pin a body as an isolated [Context:] chip; the next
   *  submit pins a fresh iso_* session so only tagged bodies ride as context. */
  onIsolateContext?: (text: string) => void;
  /** Is this body's [Context:] chip currently in the input bar? (icon tint) */
  isContextActive?: (text: string) => boolean;
  /** Live exchange region — rendered at the bottom of the measured zone. */
  children?: React.ReactNode;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function _dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function _dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (_dayKey(ts) === _dayKey(today.getTime())) return 'Today';
  if (_dayKey(ts) === _dayKey(yesterday.getTime())) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
}

// ── Exchange grouping ─────────────────────────────────────────────────────────
// Display-order transform over the append-only entry list. Entries sharing an
// exchangeId render as one contiguous block positioned at the exchange's first
// entry, sorted user → assistant → run. Entries with no exchangeId (proactive
// thoughts, system notes, loaded history) are singletons — they can never
// split an exchange mid-render, so a thought arriving between a prompt and its
// reply lands after the whole exchange, not inside it.
const EXCHANGE_KIND_ORDER: Partial<Record<FeedEntry['kind'], number>> = {
  user: 0,
  assistant: 1,
  run: 2,
};

export function groupForDisplay(list: FeedEntry[]): FeedEntry[] {
  if (list.length < 2) return list;
  const groups: FeedEntry[][] = [];
  const byExchange = new Map<string, FeedEntry[]>();
  for (const e of list) {
    const xid = e.exchangeId;
    if (!xid) { groups.push([e]); continue; }
    let g = byExchange.get(xid);
    if (!g) { g = []; byExchange.set(xid, g); groups.push(g); }
    g.push(e);
  }
  return groups.flatMap(g =>
    g.length > 1
      ? [...g].sort((a, b) =>
          (EXCHANGE_KIND_ORDER[a.kind] ?? 1) - (EXCHANGE_KIND_ORDER[b.kind] ?? 1) || a.ts - b.ts)
      : g
  );
}

// Stable no-op so QueueTaskCard's effect deps never churn — an inline
// `() => {}` gets a fresh identity per render and retriggers the card's
// transition watcher (it still early-returns, but only by luck).
const NOOP_HEIGHT = () => {};

// Collapsible group for consecutive proactive thought-runs in the feed.
// Starts expanded — collapse hides the cards, keeping one summary line.
function ThoughtsGroup({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const [hover, setHover] = useState(false);
  const count = React.Children.count(children);
  return (
    <div style={{ margin: '4px 0' }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="flex items-center gap-1.5 text-left"
        style={{
          background: hover ? 'rgba(129,140,248,0.12)' : 'none',
          border: 'none', padding: '3px 8px', margin: '0 -8px', borderRadius: 6,
          cursor: 'pointer', transition: 'background 0.15s',
        }}
      >
        <BrainIcon size={15} />
        <span className="text-[12px] font-medium" style={{ color: 'rgba(129,140,248,0.9)' }}>
          Thoughts{count > 1 ? ` · ${count}` : ''}
        </span>
        <span className="text-[24px]" style={{ color: 'rgba(255,255,255,0.55)', marginBottom: '3px', lineHeight: 0 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && children}
    </div>
  );
}

function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="flex items-center gap-3 select-none" style={{ margin: '14px 0 10px' }}>
      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
      <span style={{ color: '#6b7280', fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.04em' }}>{_dayLabel(ts)}</span>
      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
    </div>
  );
}

function PendingDots({ color = '#60a5fa' }: { color?: string }) {
  return (
    <div className="flex gap-1.5" style={{ padding: '4px 0' }}>
      <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color, animationDelay: '0ms' }} />
      <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color, animationDelay: '200ms' }} />
      <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color, animationDelay: '400ms' }} />
    </div>
  );
}

// Maps raw backend/provider error strings to a short friendly line for the
// feed. Exported so UnifiedOverlay can use the same mapping when committing
// failed tasks; the raw error is preserved separately in `errorRaw`.
export function friendlyErrorMessage(err: string): string {
  const e = (err || '').toLowerCase();
  if (/all llm providers failed|llm providers? failed|no llm provider/.test(e))
    return "I'm having trouble reaching my AI providers right now — this is usually a connection issue or a provider outage. Please try again in a moment.";
  if (/rate.?limit|429|quota|too many requests/.test(e))
    return "I've hit a rate limit with my AI provider — give it a minute and try again.";
  if (/econnrefused|enotfound|eai_again|network|offline|fetch failed/.test(e))
    return "I can't reach the service right now — check your connection and try again.";
  if (/timed? ?out|timeout|etimedout/.test(e))
    return "That request timed out — please try again.";
  if (/cancelled|canceled|aborted/.test(e))
    return 'That run was cancelled.';
  return 'Something went wrong on my end. The details are below — try again or rephrase your request.';
}

const RUN_STATUS_META: Record<FeedRunStatus, { label: string; color: string }> = {
  'queued':             { label: 'Queued',           color: '#9ca3af' },
  'running':            { label: 'Running',          color: '#60a5fa' },
  'awaiting-approval':  { label: 'Approval needed',  color: '#fbbf24' },
  'auth-required':      { label: 'Sign-in needed',   color: '#fbbf24' },
  'waiting-for-input':  { label: 'Needs input',      color: '#fbbf24' },
  'done':               { label: 'Done',             color: '#4ade80' },
  'failed':             { label: 'Failed',           color: '#f87171' },
  'cancelled':          { label: 'Cancelled',        color: '#abafb8' },
};

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

// Context-isolation icon — crosshair/target. Clicking pins the body text as a
// [Context:] chip; the next submit pins a fresh session so only that body
// rides as context (no conversation history).
function TargetIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="22" y1="12" x2="18" y2="12" /><line x1="6" y1="12" x2="2" y2="12" /><line x1="12" y1="6" x2="12" y2="2" /><line x1="12" y1="22" x2="12" y2="18" />
    </svg>
  );
}

// ── Attachment chips on the user bubble ──────────────────────────────────────
// Shows what rode along with a prompt (file/folder/context/thought/highlight)
// so the exchange history preserves the attachments, not just the typed text.
const _chipIconProps = { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const _FileIcon = () => (<svg {..._chipIconProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>);
const _FolderIcon = () => (<svg {..._chipIconProps}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>);

const _ATTACH_STYLE: Record<string, { bg: string; border: string; fg: string }> = {
  file:      { bg: 'rgba(59,130,246,0.15)',  border: 'rgba(59,130,246,0.3)',  fg: '#93c5fd' },
  folder:    { bg: 'rgba(74,222,128,0.15)',  border: 'rgba(74,222,128,0.3)',  fg: '#4ade80' },
  context:   { bg: 'rgba(34,211,238,0.15)',  border: 'rgba(34,211,238,0.35)', fg: '#67e8f9' },
  thought:   { bg: 'rgba(129,140,248,0.15)', border: 'rgba(129,140,248,0.35)', fg: '#a5b4fc' },
  highlight: { bg: 'rgba(255,255,255,0.1)',  border: 'rgba(255,255,255,0.2)', fg: '#e5e7eb' },
};

function _AttachmentChip({ a, onOpenPath }: { a: { kind: string; label: string; path?: string }; onOpenPath?: (p: string) => void }) {
  const s = _ATTACH_STYLE[a.kind] || _ATTACH_STYLE.highlight;
  const clickable = !!a.path && !!onOpenPath;
  return (
    <span
      className="flex items-center gap-1 px-2 py-0.5 rounded-md"
      title={a.path || a.label}
      onClick={clickable ? () => onOpenPath!(a.path!) : undefined}
      style={{
        backgroundColor: s.bg, border: `1px solid ${s.border}`, color: s.fg,
        fontSize: '0.65rem', lineHeight: 1.4, cursor: clickable ? 'pointer' : 'default',
        maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
    >
      {a.kind === 'folder' && <_FolderIcon />}
      {a.kind === 'file' && <_FileIcon />}
      {a.kind === 'context' && <TargetIcon />}
      {a.kind === 'thought' && <BrainIcon size={10} />}
      <span className="truncate">{a.label}</span>
    </span>
  );
}

// ── Long-message collapse ────────────────────────────────────────────────────
// Height-based clamp (not char-slicing) — markdown stays intact; the fade hints
// at hidden content and the pill toggles the full message.
const COLLAPSE_CHARS = 900;
const COLLAPSE_LINES = 10;
const COLLAPSE_HEIGHT = 220;

function CollapsibleContent({ text, children }: { text: string; children: React.ReactNode }) {
  const needsClamp =
    text.length > COLLAPSE_CHARS || (text.match(/\n/g) || []).length > COLLAPSE_LINES;
  const [expanded, setExpanded] = useState(false);
  if (!needsClamp) return <>{children}</>;
  return (
    <div>
      <div style={{
        maxHeight: expanded ? 'none' : COLLAPSE_HEIGHT,
        overflow: 'hidden',
        // Fade the content itself via mask — flush with the panel's translucent
        // background (a solid overlay div leaves a visible color box).
        ...(expanded ? {} : {
          WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
          maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
        }),
      }}>
        {children}
      </div>
      <div style={{ textAlign: 'center', marginTop: 4 }}>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            padding: '4px 14px', borderRadius: 10, fontSize: '0.78rem', cursor: 'pointer',
            color: '#93c5fd', backgroundColor: 'rgba(59,130,246,0.10)',
            border: '1px solid rgba(59,130,246,0.28)',
          }}
        >
          {expanded ? '▴ Show less' : '▾ Show more'}
        </button>
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

// ── Memoized row ────────────────────────────────────────────────────────────
// One memo boundary per entry: `entries` array identity changes on every
// append/patch/task-progress, but untouched entry objects keep identity — so
// only the patched row re-renders. `liveTask` is resolved by the parent so a
// task:progress object swap re-renders only that row, not every row.

interface FeedEntryRowProps {
  entry: FeedEntry;
  liveTask: CommsTask | undefined;
  /** A run card exists for this entry's task/exchange — it is the progress
   *  indicator, so pending dots are suppressed once it lands (handoff). */
  hasRunCard: boolean;
  runToggled: boolean;
  copied: boolean;
  onRedo: (prompt: string) => void;
  onCopy: (id: string, text: string) => void;
  onPlanApprove: (taskId: string, planFile: string | null) => void;
  onPlanCancel: (taskId: string, planFile: string | null) => void;
  onOpenPath: (path: string) => void;
  onOpenSourceUrl: (url: string) => void;
  onApplyDraft?: (entryId: string, draft: FeedDraft) => void;
  onContinueThread?: (task: CommsTask) => void;
  onRunSummaryForTask?: (taskId: string, summary: RunSummary) => void;
  onToggleRun: (id: string) => void;
  onOpenQueue?: (taskId: string) => void;
  onIsolateContext?: (text: string) => void;
  isContextActive?: (text: string) => boolean;
}

const FeedEntryRow = React.memo(function FeedEntryRow({
  entry, liveTask, hasRunCard, runToggled, copied,
  onRedo, onCopy, onPlanApprove, onPlanCancel, onOpenPath, onOpenSourceUrl,
  onApplyDraft, onContinueThread, onRunSummaryForTask, onToggleRun, onOpenQueue, onIsolateContext, isContextActive,
}: FeedEntryRowProps) {
  const hoverActions = (e: { id: string; text?: string; prompt?: string; taskId?: string }) => {
    // Isolated bodies keep their actions strip visible — the cyan target reads
    // as a persistent "this is your context" badge, not just a hover affordance.
    const isolated = !!(e.text && isContextActive?.(e.text));
    return (
    <div className="feed-actions" style={{ position: 'absolute', right: 4, bottom: 2, display: 'flex', gap: 4, opacity: isolated ? 1 : 0, transition: 'opacity 0.15s' }}>
      {e.taskId && onOpenQueue && (
        <button
          onClick={() => onOpenQueue(e.taskId!)}
          title="View in Queue"
          style={{ padding: 4, borderRadius: 5, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(30,30,32,0.9)', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
        >
          {/* Queue icon — stacked list rows */}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
        </button>
      )}
      {e.prompt && (
        <button
          onClick={() => onRedo(e.prompt!)}
          title="Re-run this prompt"
          style={{ padding: 4, borderRadius: 5, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(30,30,32,0.9)', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
        >
          <RedoIcon />
        </button>
      )}
      {!!e.text && (
        <button
          onClick={() => onCopy(e.id, e.text!)}
          title="Copy response"
          style={{ padding: 4, borderRadius: 5, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(30,30,32,0.9)', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}
      {!!e.text && onIsolateContext && (
        <button
          onClick={() => onIsolateContext(e.text!)}
          title={isolated ? 'Remove context isolation' : 'Isolate context — reply to just this'}
          style={{
            padding: 4, borderRadius: 5, cursor: 'pointer', display: 'flex', alignItems: 'center',
            border: isolated ? '1px solid rgba(34,211,238,0.35)' : '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(30,30,32,0.9)',
            color: isolated ? '#67e8f9' : '#9ca3af',
          }}
        >
          <TargetIcon />
        </button>
      )}
    </div>
    );
  };

  switch (entry.kind) {
    case 'user':
      return (
        <div className="feed-entry flex justify-end" style={{ margin: '16px 0 6px', position: 'relative', paddingBottom: 10 }}>
          <div style={{ maxWidth: '85%' }}>
            <div style={{
              padding: '7px 12px',
              borderRadius: '12px 12px 4px 12px',
              backgroundColor: 'rgba(59,130,246,0.16)',
              border: '1px solid rgba(59,130,246,0.3)',
              color: '#dbeafe',
              fontSize: '0.8rem',
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              <CollapsibleContent text={entry.text}>{entry.text}</CollapsibleContent>
            </div>
            {!!entry.attachments?.length && (
              <div className="flex flex-wrap justify-end gap-1" style={{ marginTop: 4 }}>
                {entry.attachments.map((a, i) => (
                  <_AttachmentChip key={i} a={a} onOpenPath={onOpenPath} />
                ))}
              </div>
            )}
          </div>
          {hoverActions({ id: entry.id, text: entry.text, prompt: entry.text })}
        </div>
      );

    case 'assistant':
      return (
        <div className="feed-entry" style={{ position: 'relative', margin: '2px 0 12px', paddingBottom: 10 }}>
          {/* ThinkDrop avatar row — visual handoff from user bubble to AI reply */}
          <div className="flex items-center gap-1.5 select-none" style={{ marginBottom: 5, opacity: 0.85 }}>
            <ThinkDropLogo size={14} />
          </div>
          {entry.pending ? (
            (() => {
              // Dots only while the task is actively progressing AND no run
              // card exists yet — once the card lands (handoff) it carries
              // progress itself. Paused (awaiting-approval/waiting-for-input/
              // auth-required) or terminal tasks shouldn't look busy either.
              const working = !hasRunCard && (!liveTask || liveTask.status === 'queued' || liveTask.status === 'waiting-for-agent' || liveTask.status === 'running');
              return entry.text ? (
                // Pending ack (e.g. "Let me find you a solid answer on that.") —
                // stays visible above the run card until settlePendingAssistant
                // swaps in the real answer.
                <div>
                  <RichContentRenderer content={entry.text} className="text-sm" onFileLinkClick={onOpenPath} />
                  {working && <PendingDots />}
                </div>
              ) : (
                working ? <PendingDots /> : null
              );
            })()
          ) : entry.isError ? (
            <div style={{
              border: '1px solid rgba(248,113,113,0.28)',
              backgroundColor: 'rgba(248,113,113,0.07)',
              borderRadius: 10,
              padding: '8px 12px',
            }}>
              <div className="flex items-start gap-2">
                <span style={{ fontSize: '0.85rem', lineHeight: 1.4, flexShrink: 0 }}>⚠️</span>
                <div className="flex-1 min-w-0">
                  <div style={{ color: '#fca5a5', fontSize: '0.8rem', lineHeight: 1.45 }}>{entry.text}</div>
                  {entry.errorRaw && (
                    <div style={{ color: 'rgba(252,165,165,0.5)', fontSize: '0.62rem', marginTop: 4, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.errorRaw}>
                      {entry.errorRaw}
                    </div>
                  )}
                  {entry.prompt && (
                    <button
                      onClick={() => onRedo(entry.prompt!)}
                      style={{
                        marginTop: 6, padding: '3px 12px', borderRadius: 8, fontSize: '0.68rem', cursor: 'pointer',
                        color: '#93c5fd', backgroundColor: 'rgba(59,130,246,0.12)',
                        border: '1px solid rgba(59,130,246,0.3)',
                      }}
                    >
                      Try again
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ overflowX: 'hidden', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
              {entry.items && entry.items.length > 0 && <WebResultsGrid items={entry.items} />}
              <CollapsibleContent text={entry.text}>
                <RichContentRenderer
                  content={stripItemImageMarkdown(entry.text, entry.items || [])}
                  animated
                  className="text-sm"
                  onFileLinkClick={onOpenPath}
                  searchResults={entry.items}
                />
              </CollapsibleContent>
              {entry.sources && entry.sources.length > 0 && (
                <div className="flex flex-wrap gap-1.5" style={{ marginTop: 8 }}>
                  {entry.sources.map((s, i) => (
                    <button
                      key={s.url + i}
                      onClick={() => onOpenSourceUrl(s.url)}
                      className="flex items-center gap-1.5"
                      style={{ padding: '2px 8px', borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', cursor: 'pointer' }}
                    >
                      <Favicon domain={s.hostname} size={11} alt="" />
                      <span style={{ color: '#9ca3af', fontSize: '0.65rem' }}>{s.hostname}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {hoverActions(entry)}
        </div>
      );

    case 'run': {
      // Live task → render the real QueueTaskCard: status-tinted card chrome
      // with a task-scoped AutomationProgress inside (plan review, QuestionCard,
      // Approve & Run all native). Falls back to the static summary card once
      // the comms task is purged/removed.
      if (liveTask) {
        return (
          <div style={{ margin: '4px 0 12px' }}>
            <QueueTaskCard
              task={liveTask}
              onContinueThread={onContinueThread}
              onHeightChange={NOOP_HEIGHT}
              onRunSummary={entry.taskId ? (s) => onRunSummaryForTask?.(entry.taskId!, s) : undefined}
              autoCollapseOnSettle
            />
          </div>
        );
      }
      const meta = RUN_STATUS_META[entry.status] || RUN_STATUS_META.done;
      const isActive = entry.status === 'running' || entry.status === 'queued' || entry.status === 'awaiting-approval' || entry.status === 'waiting-for-input' || entry.status === 'auth-required';
      const expanded = runToggled ? !isActive : isActive;
      const steps = entry.steps || [];
      const doneCount = steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
      // Step title colors mirror the live AutomationProgress step rows.
      const stepColor = (status: string) =>
        status === 'pending' ? '#abafb8'
        : status === 'failed' ? '#fca5a5'
        : status === 'skipped' || status === 'needs_input' ? '#fbbf24'
        : '#e5e7eb';
      return (
        <div className="feed-entry" style={{ position: 'relative', margin: '4px 0 12px', paddingBottom: 10 }}>
          <button
            onClick={() => onToggleRun(entry.id)}
            className="feed-run-toggle flex items-center gap-2 w-full text-left"
            style={{ background: 'none', border: 'none', padding: '4px 6px', margin: '0 -6px', borderRadius: 6, cursor: 'pointer' }}
          >
            <span style={{ color: '#93c5fd', fontSize: '0.78rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.title}
            </span>
            <span style={{ color: '#6b7280', fontSize: '0.65rem', flexShrink: 0 }}>
              {steps.length > 0 && `${doneCount}/${steps.length} tasks`}
              {entry.durationMs != null ? ` · ${Math.round(entry.durationMs / 1000)}s` : ''}
            </span>
            <span style={{ color: meta.color, fontSize: '0.65rem', fontWeight: 500, marginLeft: 'auto', flexShrink: 0 }}>
              {meta.label}
            </span>
            {/* Chevron chip — matches QueueTaskCard / "Show more" prominence */}
            <span style={{
              marginLeft: 6, padding: '5px 9px', borderRadius: 5, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: expanded ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)',
              border: expanded ? '1px solid rgba(99,102,241,0.25)' : '1px solid rgba(255,255,255,0.1)',
              color: expanded ? '#818cf8' : '#abafb8',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                {expanded ? <polyline points="18,15 12,9 6,15"/> : <polyline points="6,9 12,15 18,9"/>}
              </svg>
            </span>
          </button>
          {expanded && (
            <div className="flex flex-col gap-2" style={{ marginLeft: 14, marginTop: 8 }}>
              {steps.length === 0 && !entry.error && (!entry.savedFilePaths || entry.savedFilePaths.length === 0) && (
                <div style={{ color: '#6b7280', fontSize: '0.7rem', fontStyle: 'italic' }}>No step details recorded.</div>
              )}
              {steps.map((s, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <div className="mt-0.5"><StepIcon status={s.status as any} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm" style={{
                        color: stepColor(s.status),
                        textDecoration: s.status === 'deferred' ? 'line-through' : undefined,
                        opacity: s.status === 'deferred' ? 0.6 : undefined,
                      }}>{s.title}</span>
                      {s.skill && <><SkillIcon skill={s.skill} /><SkillBadge skill={s.skill} /></>}
                    </div>
                    {s.savedFilePath && (
                      <button
                        onClick={() => onOpenPath(s.savedFilePath!)}
                        className="flex items-center gap-1.5"
                        style={{ marginTop: 3, padding: '2px 8px', borderRadius: 10, backgroundColor: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.25)', color: '#93c5fd', fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}
                        title={s.savedFilePath}
                      >
                        {s.savedFilePath.split('/').pop() || s.savedFilePath}
                      </button>
                    )}
                    {s.output && (
                      <div style={{
                        marginTop: 4, padding: '6px 8px', borderRadius: 6,
                        backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
                        color: '#9ca3af', fontSize: '0.68rem', fontFamily: 'monospace',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        maxHeight: 120, overflow: 'hidden',
                        WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
                        maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
                      }}>
                        {s.output.length > 300 ? s.output.slice(0, 300) + '…' : s.output}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {entry.error && (
                <div style={{ color: '#f87171', fontSize: '0.72rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{friendlyErrorMessage(entry.error)}</div>
              )}
              {entry.savedFilePaths && entry.savedFilePaths.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {entry.savedFilePaths.map(fp => (
                    <button
                      key={fp}
                      onClick={() => onOpenPath(fp)}
                      className="flex items-center gap-1.5"
                      style={{ padding: '3px 9px', borderRadius: 10, backgroundColor: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.25)', color: '#93c5fd', fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}
                      title={fp}
                    >
                      {fp.split('/').pop() || fp}
                    </button>
                  ))}
                </div>
              )}
              {entry.drafts && entry.drafts.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {entry.drafts.map(d => {
                    const holder = d.openIn && d.openIn.length > 0 ? d.openIn[0] : null;
                    return (
                      <div key={d.draftPath} className="flex items-center flex-wrap gap-1.5">
                        <button
                          onClick={() => onOpenPath(d.draftPath)}
                          style={{ padding: '3px 9px', borderRadius: 10, backgroundColor: 'rgba(167,139,250,0.10)', border: '1px solid rgba(167,139,250,0.30)', color: '#c4b5fd', fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}
                          title={`Draft (original untouched): ${d.draftPath}`}
                        >
                          {(d.filePath || d.draftPath).split('/').pop() || 'draft'} (draft)
                        </button>
                        {d.applied ? (
                          <span style={{ padding: '3px 10px', borderRadius: 6, backgroundColor: 'rgba(16,185,129,0.10)', border: '1px solid rgba(16,185,129,0.30)', color: '#6ee7b7', fontSize: '0.68rem', fontWeight: 600 }}>
                            Applied
                          </span>
                        ) : onApplyDraft ? (
                          <button
                            onClick={() => onApplyDraft(entry.id, d)}
                            disabled={!!d.applying}
                            style={{ padding: '3px 10px', borderRadius: 6, backgroundColor: 'rgba(59,130,246,0.14)', border: '1px solid rgba(59,130,246,0.40)', color: '#93c5fd', fontSize: '0.68rem', fontWeight: 600, cursor: d.applying ? 'default' : 'pointer', opacity: d.applying ? 0.6 : 1 }}
                            title={holder
                              ? `Close ${holder}'s copy of ${d.filePath || 'the file'} (you'll be asked to save unsaved changes), then apply the draft`
                              : `Apply the draft over ${d.filePath || 'the original'}`}
                          >
                            {d.applying ? 'Applying…' : holder ? `Close ${holder} & Apply` : 'Apply'}
                          </button>
                        ) : null}
                        {d.applyError && (
                          <span style={{ color: '#f87171', fontSize: '0.65rem' }}>{d.applyError}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {entry.status === 'awaiting-approval' && entry.taskId && (
                <div className="flex gap-2">
                  <button
                    onClick={() => onPlanApprove(entry.taskId!, entry.planFile || null)}
                    style={{ padding: '5px 14px', borderRadius: 6, backgroundColor: 'rgba(59,130,246,0.18)', border: '1px solid rgba(59,130,246,0.45)', color: '#93c5fd', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Approve &amp; Run
                  </button>
                  <button
                    onClick={() => onPlanCancel(entry.taskId!, entry.planFile || null)}
                    style={{ padding: '5px 12px', borderRadius: 6, backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '0.72rem', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
          {hoverActions({ id: entry.id, text: entry.error || entry.title, prompt: entry.prompt, taskId: entry.taskId || undefined })}
        </div>
      );
    }

    case 'proactive':
      return (
        <div className="feed-entry flex items-start gap-2" style={{ margin: '4px 0', position: 'relative', paddingBottom: 10 }}>
          <span className="select-none inline-flex pt-0.5" style={{ opacity: 0.8 }}>
            {/* <BrainIcon size={14} /> */}
          </span>
          {entry.pending ? (
            <PendingDots color="#a78bfa" />
          ) : (
            <div
              className="flex-1 min-w-0 thought-body"
              style={{ overflowX: 'hidden', wordBreak: 'break-word', overflowWrap: 'break-word' }}
            >
              <RichContentRenderer content={entry.text} animated className="text-sm" onFileLinkClick={onOpenPath} />
            </div>
          )}
          {!entry.pending && hoverActions({ id: entry.id, text: entry.text })}
        </div>
      );

    case 'system':
      return (
        <div style={{ margin: '6px 0', textAlign: 'center' }}>
          <span style={{ color: '#6b7280', fontSize: '0.68rem', fontStyle: 'italic' }}>{entry.text}</span>
        </div>
      );
  }
});

function ResultsFeedImpl({
  entries,
  activeExchangeId,
  measureRef,
  historyLoading,
  hasMoreHistory,
  onRedo,
  onCopy,
  onPlanApprove,
  onPlanCancel,
  onOpenPath,
  onOpenSourceUrl,
  onApplyDraft,
  resolveTask,
  onContinueThread,
  onRunSummaryForTask,
  onOpenQueue,
  onIsolateContext,
  isContextActive,
  children,
}: ResultsFeedProps) {
  // Manually-toggled run cards; default = expanded while active, collapsed when
  // the run settles (done/failed/cancelled).
  const [toggledRuns, setToggledRuns] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Group FIRST, then split — the active exchange's block must stay together
  // inside the measured zone even if its entries were appended out of order
  // (e.g. a user bubble that arrived after the reply committed).
  const grouped = useMemo(() => groupForDisplay(entries), [entries]);
  const splitIdx = useMemo(
    () => (activeExchangeId ? grouped.findIndex(e => e.id === activeExchangeId) : -1),
    [grouped, activeExchangeId]
  );
  const historyEntries = splitIdx >= 0 ? grouped.slice(0, splitIdx) : grouped;
  const currentEntries = splitIdx >= 0 ? grouped.slice(splitIdx) : [];

  const toggleRun = (id: string) => {
    setToggledRuns(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleCopy = (id: string, text: string) => {
    onCopy(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(prev => (prev === id ? null : prev)), 1600);
  };

  // Row render — memo boundary per entry (FeedEntryRow). `liveTask` resolves
  // here so a comms-task object swap re-renders only that task's row.
  const renderEntry = (entry: FeedEntry) => {
    const eTaskId = (entry.kind === 'assistant' || entry.kind === 'run') ? entry.taskId : undefined;
    // A run card in the same task/exchange is the progress indicator — its
    // presence suppresses pending dots on the exchange's ack bubble.
    const hasRunCard = grouped.some(e =>
      e.kind === 'run' && (
        (eTaskId && e.taskId === eTaskId) ||
        (entry.exchangeId != null && e.exchangeId === entry.exchangeId)));
    return (
    <FeedEntryRow
      key={entry.id}
      entry={entry}
      hasRunCard={hasRunCard}
      liveTask={eTaskId ? resolveTask?.(eTaskId) : undefined}
      runToggled={toggledRuns.has(entry.id)}
      copied={copiedId === entry.id}
      onRedo={onRedo}
      onCopy={handleCopy}
      onPlanApprove={onPlanApprove}
      onPlanCancel={onPlanCancel}
      onOpenPath={onOpenPath}
      onOpenSourceUrl={onOpenSourceUrl}
      onApplyDraft={onApplyDraft}
      onContinueThread={onContinueThread}
      onRunSummaryForTask={onRunSummaryForTask}
      onToggleRun={toggleRun}
      onOpenQueue={onOpenQueue}
      onIsolateContext={onIsolateContext}
      isContextActive={isContextActive}
    />
    );
  };

  // Renders a slice with day dividers. Consecutive proactive entries
  // (thought-engine nudges + thought-runs, ≥2) collapse under one
  // "Thoughts" header.
  const renderList = (list: FeedEntry[], leadingTs?: number) => {
    const nodes: React.ReactNode[] = [];
    let prevDay = leadingTs != null ? _dayKey(leadingTs) : null;
    let runBuf: FeedEntry[] = [];
    const flushRuns = () => {
      if (!runBuf.length) return;
      const els = runBuf.map(r => renderEntry(r));
      if (runBuf.length >= 1) {
        nodes.push(<ThoughtsGroup key={`thoughts-${runBuf[0].id}`}>{els}</ThoughtsGroup>);
      } else {
        nodes.push(...els);
      }
      runBuf = [];
    };
    for (const e of list) {
      const day = _dayKey(e.ts);
      if (day !== prevDay) {
        flushRuns();
        nodes.push(<DayDivider key={`div-${e.id}`} ts={e.ts} />);
        prevDay = day;
      }
      // Thought items: proactive nudge entries (text bubbles) plus
      // thought-engine run cards — the live task is source:'proactive';
      // after purge the prompt's brain-outdir tail is the surviving marker.
      const isThought = e.kind === 'proactive' || (e.kind === 'run' && (
        resolveTask?.(e.taskId || '')?.source === 'proactive' ||
        /\.thinkdrop[\/\\]brain[\/\\]/.test(e.prompt || '')
      ));
      if (isThought) {
        runBuf.push(e);
        continue;
      }
      flushRuns();
      nodes.push(renderEntry(e));
    }
    flushRuns();
    return nodes;
  };

  const lastHistoryTs = historyEntries.length > 0 ? historyEntries[historyEntries.length - 1].ts : undefined;

  return (
    <>
      <style>{`.feed-entry:hover .feed-actions { opacity: 1 !important; } .feed-run-toggle:hover { background-color: rgba(255,255,255,0.04) !important; }`}</style>

      {/* History zone — unmeasured: window height ignores it. */}
      {(historyEntries.length > 0 || hasMoreHistory || historyLoading) && (
        <div>
          {hasMoreHistory && (
            <div className="flex flex-col items-center gap-1 select-none" style={{ padding: '6px 0 4px', opacity: historyLoading ? 1 : 0.5 }}>
              <ThinkDropLogo size={18} />
              <span style={{ color: '#6b7280', fontSize: '0.62rem', letterSpacing: '0.08em' }}>
                {historyLoading ? 'loading •••' : 'scroll for earlier'}
              </span>
            </div>
          )}
          {renderList(historyEntries)}
        </div>
      )}

      {/* Measured zone — active exchange + live region drives window height. */}
      <div ref={measureRef}>
        {renderList(currentEntries, lastHistoryTs)}
        {children}
      </div>
    </>
  );
}

export const ResultsFeed = React.memo(ResultsFeedImpl);
export default ResultsFeed;
