import React, { useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { Favicon } from './DefaultFaviconIcon';
import { ThinkDropLogo } from './SlideoutDrawer';
import { RichContentRenderer } from './rich-content';
import { WebResultsGrid, stripItemImageMarkdown } from './rich-content';
import type { WebResultItem } from './rich-content/WebResultCard';

// ── Feed entry model ─────────────────────────────────────────────────────────
// One item per row in the conversation feed. `ts` drives ordering + day
// dividers; `exchangeId` isn't stored — the active exchange is derived by the
// parent as "everything from the last user entry onward".

export type FeedRunStatus = 'queued' | 'running' | 'awaiting-approval' | 'auth-required' | 'waiting-for-input' | 'done' | 'failed' | 'cancelled';

export type FeedEntry =
  | { id: string; ts: number; kind: 'user'; text: string }
  | { id: string; ts: number; kind: 'assistant'; text: string; items?: WebResultItem[]; sources?: { url: string; hostname: string; title?: string }[]; taskId?: string; pending?: boolean; prompt?: string; isError?: boolean; errorRaw?: string }
  | { id: string; ts: number; kind: 'run'; title: string; status: FeedRunStatus; steps?: { title: string; status: string }[]; savedFilePaths?: string[]; error?: string | null; taskId?: string; planFile?: string | null; durationMs?: number | null; prompt?: string }
  | { id: string; ts: number; kind: 'proactive'; text: string; thoughtId?: string; pending?: boolean }
  | { id: string; ts: number; kind: 'system'; text: string };

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

function StepStatusGlyph({ status }: { status: string }) {
  const map: Record<string, { ch: string; color: string }> = {
    done: { ch: '✓', color: '#4ade80' },
    failed: { ch: '✕', color: '#f87171' },
    skipped: { ch: '–', color: '#6b7280' },
    deferred: { ch: '⏸', color: '#a78bfa' },
    running: { ch: '…', color: '#60a5fa' },
    pending: { ch: '○', color: '#4b5563' },
  };
  const m = map[status] || map.pending;
  return <span style={{ color: m.color, fontSize: '0.7rem', width: 14, textAlign: 'center', flexShrink: 0 }}>{m.ch}</span>;
}

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
      <div style={{ maxHeight: expanded ? 'none' : COLLAPSE_HEIGHT, overflow: 'hidden', position: 'relative' }}>
        {children}
        {!expanded && (
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, height: 48,
            background: 'linear-gradient(rgba(18,20,24,0), rgba(18,20,24,0.97) 75%)',
            pointerEvents: 'none',
          }} />
        )}
      </div>
      <div style={{ textAlign: 'center', marginTop: 4 }}>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            padding: '2px 12px', borderRadius: 10, fontSize: '0.65rem', cursor: 'pointer',
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
  children,
}: ResultsFeedProps) {
  // Manually-toggled run cards; default = expanded while active, collapsed when
  // the run settles (done/failed/cancelled).
  const [toggledRuns, setToggledRuns] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const splitIdx = useMemo(
    () => (activeExchangeId ? entries.findIndex(e => e.id === activeExchangeId) : -1),
    [entries, activeExchangeId]
  );
  const historyEntries = splitIdx >= 0 ? entries.slice(0, splitIdx) : entries;
  const currentEntries = splitIdx >= 0 ? entries.slice(splitIdx) : [];

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

  const renderHoverActions = (entry: { id: string; text?: string; prompt?: string }) => (
    <div className="feed-actions" style={{ position: 'absolute', right: 4, bottom: 2, display: 'flex', gap: 4, opacity: 0, transition: 'opacity 0.15s' }}>
      {entry.prompt && (
        <button
          onClick={() => onRedo(entry.prompt!)}
          title="Re-run this prompt"
          style={{ padding: 4, borderRadius: 5, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(30,30,32,0.9)', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
        >
          <RedoIcon />
        </button>
      )}
      {!!entry.text && (
        <button
          onClick={() => handleCopy(entry.id, entry.text!)}
          title="Copy response"
          style={{ padding: 4, borderRadius: 5, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(30,30,32,0.9)', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
        >
          {copiedId === entry.id ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}
    </div>
  );

  const renderEntry = (entry: FeedEntry) => {
    switch (entry.kind) {
      case 'user':
        return (
          <div key={entry.id} className="flex justify-end" style={{ margin: '16px 0 6px' }}>
            <div style={{
              maxWidth: '85%',
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
          </div>
        );

      case 'assistant':
        return (
          <div key={entry.id} className="feed-entry" style={{ position: 'relative', margin: '2px 0 14px', paddingBottom: 14 }}>
            {/* ThinkDrop avatar row — visual handoff from user bubble to AI reply */}
            <div className="flex items-center gap-1.5 select-none" style={{ marginBottom: 5, opacity: 0.85 }}>
              <ThinkDropLogo size={14} />
            </div>
            {entry.pending ? (
              <PendingDots />
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
            {renderHoverActions(entry)}
          </div>
        );

      case 'run': {
        const meta = RUN_STATUS_META[entry.status] || RUN_STATUS_META.done;
        const isActive = entry.status === 'running' || entry.status === 'queued' || entry.status === 'awaiting-approval' || entry.status === 'waiting-for-input' || entry.status === 'auth-required';
        const expanded = toggledRuns.has(entry.id) ? !isActive : isActive;
        return (
          <div key={entry.id} className="feed-entry" style={{ position: 'relative', margin: '8px 0', paddingBottom: 14 }}>
            <button
              onClick={() => toggleRun(entry.id)}
              className="flex items-center gap-2 w-full text-left"
              style={{ background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer' }}
            >
              <span style={{ color: '#6b7280', fontSize: '0.7rem', width: 10, flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
              <span style={{ color: '#93c5fd', fontSize: '0.78rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                AI: {entry.title}
              </span>
              <span style={{ color: meta.color, fontSize: '0.65rem', fontWeight: 500, marginLeft: 'auto', flexShrink: 0 }}>
                {meta.label}{entry.durationMs != null ? ` · ${Math.round(entry.durationMs / 1000)}s` : ''}
              </span>
            </button>
            {expanded && (
              <div style={{ marginLeft: 18, marginTop: 6 }}>
                {entry.steps && entry.steps.length > 0 && (
                  <div className="flex flex-col gap-1" style={{ marginBottom: 6 }}>
                    {entry.steps.map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <StepStatusGlyph status={s.status} />
                        <span style={{ color: '#9ca3af', fontSize: '0.72rem' }}>{s.title}</span>
                      </div>
                    ))}
                  </div>
                )}
                {entry.error && (
                  <div style={{ color: '#f87171', fontSize: '0.72rem', marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{friendlyErrorMessage(entry.error)}</div>
                )}
                {entry.savedFilePaths && entry.savedFilePaths.length > 0 && (
                  <div className="flex flex-col gap-1" style={{ marginBottom: 6 }}>
                    {entry.savedFilePaths.map(fp => (
                      <button
                        key={fp}
                        onClick={() => onOpenPath(fp)}
                        className="flex items-center gap-2"
                        style={{ padding: '4px 8px', borderRadius: 6, backgroundColor: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: '#93c5fd', fontSize: '0.7rem', cursor: 'pointer', textAlign: 'left' }}
                      >
                        {fp.split('/').pop() || fp}
                      </button>
                    ))}
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
            {renderHoverActions({ id: entry.id, text: entry.error || entry.title, prompt: entry.prompt })}
          </div>
        );
      }

      case 'proactive':
        return (
          <div key={entry.id} className="flex items-start gap-2" style={{ margin: '8px 0' }}>
            <span className="text-sm leading-5 select-none" style={{ opacity: 0.8 }}>🧠</span>
            {entry.pending ? (
              <PendingDots color="#a78bfa" />
            ) : (
              <div className="flex-1 min-w-0" style={{ overflowX: 'hidden', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
                <RichContentRenderer content={entry.text} animated className="text-sm" onFileLinkClick={onOpenPath} />
              </div>
            )}
          </div>
        );

      case 'system':
        return (
          <div key={entry.id} style={{ margin: '6px 0', textAlign: 'center' }}>
            <span style={{ color: '#6b7280', fontSize: '0.68rem', fontStyle: 'italic' }}>{entry.text}</span>
          </div>
        );
    }
  };

  const renderList = (list: FeedEntry[], leadingTs?: number) => {
    const nodes: React.ReactNode[] = [];
    let prevDay = leadingTs != null ? _dayKey(leadingTs) : null;
    for (const e of list) {
      const day = _dayKey(e.ts);
      if (day !== prevDay) {
        nodes.push(<DayDivider key={`div-${e.id}`} ts={e.ts} />);
        prevDay = day;
      }
      nodes.push(renderEntry(e));
    }
    return nodes;
  };

  const lastHistoryTs = historyEntries.length > 0 ? historyEntries[historyEntries.length - 1].ts : undefined;

  return (
    <>
      <style>{`.feed-entry:hover .feed-actions { opacity: 1 !important; }`}</style>

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
