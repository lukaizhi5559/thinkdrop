import React from 'react';
import AutomationProgress from './AutomationProgress';
import type { RunSummary } from './AutomationProgress';
import { playDropSound } from '../utils/thinkDropSound';
import { Favicon } from './DefaultFaviconIcon';
import RichContentRenderer from './rich-content/RichContentRenderer';
import WebResultsGrid from './rich-content/WebResultsGrid';
import { stripItemImageMarkdown } from './rich-content/itemImages';
import type { WebResultItem } from './rich-content/WebResultCard';

const ipcRenderer = (window as any).electron?.ipcRenderer;

// ── Types ──────────────────────────────────────────────────────────────────────
export type TaskStatus = 'waiting-for-agent' | 'queued' | 'running' | 'auth-required' | 'awaiting-approval' | 'waiting-for-input' | 'done' | 'failed' | 'cancelled';

export interface CommsTask {
  id: string;
  prompt: string;
  agentId: string | null;
  status: TaskStatus;
  createdAt: number;
  startedAt: number | null;
  doneAt: number | null;
  error: string | null;
  progress: {
    step: number;
    totalSteps: number;
    currentStep: string | null;
    eta: { lo: number; hi: number } | null;
  };
  result: string | null;
  thinking?: string | null;
  sources?: { url: string; title: string; hostname: string }[] | null;
  items?: WebResultItem[] | null;
  intent: string;
  source: string;
  planFile?: string | null;
  /** Conversation session this task's discussion lives in — used by Continue Thread. */
  sessionId?: string | null;
}

// ── Status config ──────────────────────────────────────────────────────────────
const TASK_STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; bg: string; border: string; spin?: boolean }> = {
  'waiting-for-agent':  { label: 'Waiting',          color: '#fbbf24', bg: 'rgba(251,191,36,0.06)',  border: 'rgba(251,191,36,0.18)' },
  'queued':             { label: 'Queued',           color: '#9ca3af', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.07)' },
  'running':            { label: 'Running',          color: '#60a5fa', bg: 'rgba(96,165,250,0.06)',  border: 'rgba(96,165,250,0.18)',  spin: true },
  'auth-required':     { label: 'Sign-in needed',    color: '#fbbf24', bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.3)' },
  'awaiting-approval':  { label: 'Approval needed',  color: '#fbbf24', bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.3)' },
  'waiting-for-input':  { label: 'Needs input',      color: '#fbbf24', bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.3)' },
  'done':               { label: 'Done',             color: '#4ade80', bg: 'rgba(74,222,128,0.06)',   border: 'rgba(74,222,128,0.18)' },
  'failed':             { label: 'Failed',           color: '#f87171', bg: 'rgba(248,113,113,0.06)',  border: 'rgba(248,113,113,0.18)' },
  'cancelled':          { label: 'Cancelled',       color: '#abafb8', bg: 'rgba(107,114,128,0.06)',  border: 'rgba(107,114,128,0.18)' },
};

// ── SVG icons (no emojis) ──────────────────────────────────────────────────────
const StatusIcon = ({ status, color, size = 14 }: { status: TaskStatus; color: string; size?: number }) => {
  if (TASK_STATUS_CONFIG[status]?.spin) {
    return (
      <div style={{ position: 'relative', width: size, height: size }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${color}20` }} />
        <div style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          border: `2px solid ${color}`,
          borderTopColor: 'transparent',
          borderRightColor: 'transparent',
          animation: 'spin 0.9s linear infinite',
        }} />
      </div>
    );
  }
  if (status === 'auth-required') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    );
  }
  if (status === 'awaiting-approval' || status === 'waiting-for-input') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      </svg>
    );
  }
  if (status === 'done') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    );
  }
  if (status === 'failed' || status === 'cancelled') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    );
  }
  // Queued / waiting — small dot
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <circle cx="12" cy="12" r="5"/>
    </svg>
  );
};

const AgentIcon = ({ agentId, size = 14 }: { agentId: string | null; size?: number }) => {
  if (!agentId) {
    // Auto — gear icon
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    );
  }
  // Agent — browser window icon
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <circle cx="6" cy="6" r="0.5" fill="#9ca3af"/>
      <circle cx="8.5" cy="6" r="0.5" fill="#9ca3af"/>
    </svg>
  );
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function useElapsed(createdAt: number, active: boolean) {
  const [elapsed, setElapsed] = React.useState(Date.now() - createdAt);
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setElapsed(Date.now() - createdAt), 1000);
    return () => clearInterval(t);
  }, [active, createdAt]);
  return elapsed;
}

function _formatTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

function _timeAgo(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  return `${Math.round(ms / 3600000)}h ago`;
}

// ── PromptText — renders prompts containing [File:]/[Folder:]/[Highlighted:]
// tags with compact inline chips (icon + basename). The underlying string keeps
// the full path — display only. Truncates by display length, not raw length. ──
const _TAG_RE = /\[(File|Folder|Highlighted):\s*([^\]]+)\]/g;

function _chipSeg(kind: 'file' | 'folder', label: string, full: string, key: number) {
  const color = kind === 'folder' ? '#4ade80' : '#93c5fd';
  return (
    <span key={key} title={full} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, verticalAlign: '-1px',
      padding: '0 5px', borderRadius: 4, margin: '0 1px',
      background: kind === 'folder' ? 'rgba(74,222,128,0.12)' : 'rgba(59,130,246,0.12)',
      border: `1px solid ${kind === 'folder' ? 'rgba(74,222,128,0.28)' : 'rgba(59,130,246,0.28)'}`,
      color,
    }}>
      {kind === 'folder' ? (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      ) : (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
        </svg>
      )}
      {label}
    </span>
  );
}

export function PromptText({ text, maxLen = 80 }: { text: string; maxLen?: number }) {
  // Split into segments: text runs + tagged file/folder/highlight spans
  const segs: { kind: 'text' | 'file' | 'folder' | 'highlight'; text: string; label: string; full: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(_TAG_RE)) {
    if (m.index > last) segs.push({ kind: 'text', text: text.slice(last, m.index), label: text.slice(last, m.index), full: '' });
    const kind = m[1].toLowerCase() as 'file' | 'folder' | 'highlight';
    const inner = m[2].trim();
    const label = kind === 'highlight' ? inner : (inner.split('/').filter(Boolean).pop() || inner);
    segs.push({ kind, text: inner, label, full: inner });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ kind: 'text', text: text.slice(last), label: text.slice(last), full: '' });

  // Truncate by display length (label length for chips, raw for text)
  let remaining = maxLen;
  const out: React.ReactNode[] = [];
  let truncated = false;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const len = s.label.length;
    if (s.kind === 'file' || s.kind === 'folder') {
      if (len <= remaining) {
        out.push(_chipSeg(s.kind, s.label, s.full, i));
        remaining -= len;
      } else { truncated = true; break; }
    } else {
      if (len <= remaining) {
        out.push(<React.Fragment key={i}>{s.label}</React.Fragment>);
        remaining -= len;
      } else {
        out.push(<React.Fragment key={i}>{s.label.slice(0, remaining)}</React.Fragment>);
        truncated = true;
        break;
      }
    }
  }
  return <>{out}{truncated && '…'}</>;
}

// ── QueueTaskCard — wraps AutomationProgress in an expandable card ────────────
export function QueueTaskCard({ task, onContinueThread, onHeightChange, flash, onRunSummary, autoCollapseOnSettle }: {
  task: CommsTask;
  onContinueThread?: (task: CommsTask) => void;
  onHeightChange?: () => void;
  flash?: boolean;
  /** Forwarded to the embedded AutomationProgress — feed cards use it to keep
   *  a static snapshot for after the live task is purged. */
  onRunSummary?: (summary: RunSummary) => void;
  /** Results feed only: collapse the card when the run reaches a terminal state. */
  autoCollapseOnSettle?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [headerHover, setHeaderHover] = React.useState(false);
  const [thinkingExpanded, setThinkingExpanded] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const cfg = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.queued;
  const isActive = task.status === 'running' || task.status === 'queued' || task.status === 'waiting-for-agent' || task.status === 'auth-required' || task.status === 'awaiting-approval' || task.status === 'waiting-for-input';
  const needsAttention = task.status === 'auth-required' || task.status === 'awaiting-approval' || task.status === 'waiting-for-input';
  const elapsed = useElapsed(task.startedAt || task.createdAt, isActive);
  const elapsedStr = _formatTime(elapsed);
  const diff = Date.now() - (task.doneAt || task.createdAt);
  const agoStr = _timeAgo(diff);
  const agentName = task.agentId ? task.agentId.replace(/\.agent$/, '') : 'auto';

  // Notify parent of height changes after DOM updates (expand/collapse, auto-expand)
  const notifyHeightChange = React.useCallback(() => {
    if (onHeightChange) {
      requestAnimationFrame(() => onHeightChange());
    }
  }, [onHeightChange]);

  // Auto-expand when task is active or needs attention
  React.useEffect(() => {
    if (isActive || needsAttention) {
      setExpanded(true);
      notifyHeightChange();
    }
  }, [task.status, notifyHeightChange]);

  // Deep-link from a notification: force expand while flashed
  React.useEffect(() => {
    if (flash) {
      setExpanded(true);
      notifyHeightChange();
    }
  }, [flash, notifyHeightChange]);

  // Results feed only: settle → collapse so the card doesn't hog the chat.
  React.useEffect(() => {
    if (!autoCollapseOnSettle) return;
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
      setExpanded(false);
      notifyHeightChange();
    }
  }, [task.status, autoCollapseOnSettle, notifyHeightChange]);

  // Require a second click before permanently deleting an individual task.
  React.useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  React.useEffect(() => {
    setConfirmingDelete(false);
  }, [task.status]);

  const handleExpand = () => {
    setExpanded(e => !e);
    notifyHeightChange();
  };
  const handleContinueThread = () => { if (onContinueThread) onContinueThread(task); };

  return (
    <div style={{
      width: '100%',
      margin: '1px 0',
      borderRadius: 9,
      backgroundColor: cfg.bg,
      border: `1px solid ${cfg.border}`,
      transition: 'border-color 0.15s, background-color 0.15s',
      overflow: 'hidden',
      ...(needsAttention ? { boxShadow: `0 0 0 1px ${cfg.border}` } : {}),
      ...(flash ? { animation: 'td-queue-flash 0.8s ease-in-out 3' } : {}),
    }}>
      {/* ── Card header (always visible) ── */}
      <div
        style={{
          padding: '10px 12px', cursor: 'pointer',
          backgroundColor: headerHover ? 'rgba(255,255,255,0.03)' : 'transparent',
          transition: 'background-color 0.15s',
        }}
        onClick={handleExpand}
        onMouseEnter={() => setHeaderHover(true)}
        onMouseLeave={() => setHeaderHover(false)}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          {/* Status icon */}
          <div style={{ flexShrink: 0, paddingTop: 2 }}>
            <StatusIcon status={task.status} color={cfg.color} size={14} />
          </div>

          {/* Content */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Agent badge */}
            {task.agentId && (
              <span style={{
                fontSize: '0.6rem', color: cfg.color, fontFamily: 'ui-monospace,monospace',
                background: cfg.bg, padding: '1px 5px', borderRadius: 3,
                border: `1px solid ${cfg.border}`, marginBottom: 4, display: 'inline-flex',
                alignItems: 'center', gap: 4,
              }}>
                <AgentIcon agentId={task.agentId} size={9} />
                {agentName}
              </span>
            )}

            {/* Prompt preview */}
            <div style={{ fontSize: '0.71rem', color: '#d1d5db', lineHeight: 1.45, marginTop: task.agentId ? 4 : 0 }}>
              <PromptText text={task.prompt} maxLen={80} />
            </div>

            {/* Waiting-for-agent message */}
            {task.status === 'waiting-for-agent' && (
              <div style={{ fontSize: '0.58rem', color: '#fbbf24', marginTop: 3, fontStyle: 'italic' }}>
                Waiting for {agentName} to finish current task…
              </div>
            )}

            {/* Progress info */}
            {task.status === 'running' && task.progress.currentStep && (
              <div style={{ fontSize: '0.58rem', color: '#60a5fa', marginTop: 3 }}>
                {task.progress.step > 0 && task.progress.totalSteps > 0
                  ? `Step ${task.progress.step}/${task.progress.totalSteps}: ${task.progress.currentStep}`
                  : task.progress.currentStep}
              </div>
            )}

            {/* Error */}
            {task.error && (
              <div style={{ marginTop: 4, fontSize: '0.66rem', color: '#f87171', lineHeight: 1.4 }}>
                {task.error}
              </div>
            )}

            {/* Status row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: '0.6rem', color: cfg.color, fontWeight: 600,
                background: cfg.bg, padding: '1px 5px', borderRadius: 3, border: `1px solid ${cfg.border}`,
              }}>
                {cfg.label}
              </span>
              {isActive && (
                <span style={{ fontSize: '0.6rem', color: cfg.color, fontFamily: 'ui-monospace,monospace', opacity: 0.85 }}>
                  {elapsedStr}
                </span>
              )}
              {!isActive && <span style={{ fontSize: '0.6rem', color: '#4b5563' }}>{agoStr}</span>}

              {/* Auto-purge countdown for completed/cancelled/failed */}
              {(task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') && task.doneAt && (
                <span style={{ fontSize: '0.56rem', color: '#abafb8', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#abafb8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  {(() => {
                    const ttlMs = 7 * 24 * 60 * 60 * 1000;
                    const left = Math.max(0, (task.doneAt! + ttlMs) - Date.now());
                    const days = Math.floor(left / (24 * 60 * 60 * 1000));
                    const hours = Math.floor((left % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                    if (days >= 1) return `removes in ${days}d ${hours}h`;
                    return `removes in ${hours}h`;
                  })()}
                </span>
              )}

              {/* Action buttons on the right */}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                {/* Abort button — for active/running tasks */}
                {['running', 'queued', 'waiting-for-agent', 'auth-required', 'awaiting-approval', 'waiting-for-input'].includes(task.status) && (
                  <button
                    onClick={(e) => { e.stopPropagation(); ipcRenderer?.send('task:cancel', { taskId: task.id }); }}
                    title="Abort task"
                    style={{
                      padding: '4px 6px', borderRadius: 5, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)',
                      color: '#f87171', transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.16)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.08)')}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="6" y="6" width="12" height="12" rx="1"/>
                    </svg>
                  </button>
                )}
                {/* Delete button — for terminal tasks (done/failed/cancelled) */}
                {['done', 'failed', 'cancelled'].includes(task.status) && (
                  confirmingDelete ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingDelete(false);
                        ipcRenderer?.send('task:delete', { taskId: task.id });
                      }}
                      title="Confirm remove task"
                      aria-label="Confirm remove task"
                      style={{
                        padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: 4,
                        background: 'rgba(248,113,113,0.18)', border: '1px solid rgba(248,113,113,0.4)',
                        color: '#f87171', fontSize: '0.6rem', fontWeight: 600, transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.3)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.18)')}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
                      </svg>
                      Sure?
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
                      title="Remove task"
                      aria-label="Remove task"
                      style={{
                        padding: '4px 6px', borderRadius: 5, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)',
                        color: '#f87171', transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.16)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.08)')}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
                      </svg>
                    </button>
                  )
                )}

                {/* Expand chevron — AgentsTab style */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleExpand(); }}
                  title={expanded ? 'Collapse' : 'Show details'}
                  style={{
                    padding: '5px 9px', borderRadius: 5, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: expanded ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)',
                    border: expanded ? '1px solid rgba(99,102,241,0.25)' : '1px solid rgba(255,255,255,0.1)',
                    color: expanded ? '#818cf8' : '#abafb8', transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = expanded ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.1)')}
                  onMouseLeave={e => (e.currentTarget.style.background = expanded ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    {expanded ? <polyline points="18,15 12,9 6,15"/> : <polyline points="6,9 12,15 18,9"/>}
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Expanded section — full AutomationProgress ── */}
      {/* IMPORTANT: keep AutomationProgress mounted even when collapsed so it
          preserves state (plan review, preflight cards, step progress).
          Use display:none instead of conditional rendering. */}
      <div style={{
        display: expanded ? 'block' : 'none',
        borderTop: expanded ? `1px solid ${cfg.border}` : 'none',
        backgroundColor: 'rgba(0,0,0,0.15)',
      }}>
        {/* Inner padding so AutomationProgress/PlanPanel/QuestionCard don't touch edges */}
        <div style={{ padding: '12px' }}>
          <AutomationProgress
            taskId={task.id}
            planFile={task.status === 'awaiting-approval' ? task.planFile || undefined : undefined}
            setIsSubmitting={() => {}}
            onAuthPending={() => {}}
            activeTab="queue"
            onHeightChange={notifyHeightChange}
            onActiveChange={() => {}}
            onRunSummary={onRunSummary}
          />
        </div>

        {/* Thinking (collapsible, if present) */}
        {task.thinking && (
          <div style={{ margin: '0 12px 8px' }}>
            <button
              onClick={(e) => { e.stopPropagation(); setThinkingExpanded(!thinkingExpanded); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                background: 'rgba(129,140,248,0.06)', border: '1px solid rgba(129,140,248,0.15)',
                color: '#818cf8', fontSize: '0.66rem', fontWeight: 600,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(129,140,248,0.12)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(129,140,248,0.06)')}
            >
              <BrainIcon size={13} color="#818cf8" />
              <span>Thinking</span>
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto', transform: thinkingExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                <polyline points="6,9 12,15 18,9"/>
              </svg>
            </button>
            {thinkingExpanded && (
              <div style={{
                marginTop: 4, padding: '8px 10px', borderRadius: 6,
                fontSize: '0.64rem', color: '#9ca3af', lineHeight: 1.5,
                fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid rgba(129,140,248,0.1)',
                maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap',
              }}>
                {task.thinking}
              </div>
            )}
          </div>
        )}

        {/* Source pill (favicon stack + dropdown) — shown when sources exist */}
        {task.sources && task.sources.length > 0 && (
          <div style={{ margin: '0 12px 8px' }}>
            <SourcePill sources={task.sources} />
          </div>
        )}

        {/* Extracted items (cards) — shown when items exist */}
        {task.items && task.items.length > 0 && (
          <div style={{ margin: '0 12px 8px' }}>
            <WebResultsGrid items={task.items} />
          </div>
        )}

        {/* Result (if done) — rendered via RichContentRenderer for markdown + citation strip */}
        {task.result && (
          <div style={{
            margin: '0 12px 8px',
            padding: '8px 10px', borderRadius: 6,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.06)',
            maxHeight: 200, overflowY: 'auto',
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(255,255,255,0.15) transparent',
          }}>
            <RichContentRenderer
              content={stripItemImageMarkdown(task.result.replace(/【[^】]*】/g, ''), task.items)}
              animated={false}
              className="text-xs"
            />
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 10px' }}>
          {task.status === 'done' && task.result && onContinueThread && (
            <button onClick={handleContinueThread}
              title="Load result and attach this discussion as context for your next prompt"
              style={{
                padding: '3px 8px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)',
                color: '#a78bfa', fontWeight: 500,
              }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Continue Thread
            </button>
          )}
          {task.status === 'running' && (
            <button onClick={(e) => {
              e.stopPropagation();
              if (ipcRenderer) ipcRenderer.send('task:cancel', { taskId: task.id });
            }} style={{
              padding: '3px 8px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
              background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)',
              color: '#f87171', fontWeight: 500,
            }}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Queue filters ────────────────────────────────────────────────────────────
type StatusBucket = 'in-progress' | 'done' | 'cancelled' | 'failed';

const STATUS_BUCKET_MAP: Record<TaskStatus, StatusBucket> = {
  'queued': 'in-progress',
  'waiting-for-agent': 'in-progress',
  'running': 'in-progress',
  'auth-required': 'in-progress',
  'awaiting-approval': 'in-progress',
  'waiting-for-input': 'in-progress',
  'done': 'done',
  'failed': 'failed',
  'cancelled': 'cancelled',
};

const STATUS_BUCKETS: { id: StatusBucket; label: string; color: string }[] = [
  { id: 'in-progress', label: 'In progress', color: '#60a5fa' },
  { id: 'done',        label: 'Done',        color: '#4ade80' },
  { id: 'cancelled',   label: 'Cancelled',   color: '#abafb8' },
  { id: 'failed',      label: 'Failed',      color: '#f87171' },
];

type TimeKey = '1h' | '1d' | '1w' | '1m' | 'range';

const TIME_CHIPS: { id: TimeKey; label: string; ms: number }[] = [
  { id: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { id: '1d', label: '1d', ms: 24 * 60 * 60 * 1000 },
  { id: '1w', label: 'W',  ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '1m', label: 'M',  ms: 30 * 24 * 60 * 60 * 1000 },
];

const FILTER_LS_KEY = 'td.queue.filters.v1';
type StatusSel = 'all' | StatusBucket[];
interface QueueFilters { timeKey: TimeKey | null; rangeFrom: string; rangeTo: string; statusSel: StatusSel; }
const DEFAULT_FILTERS: QueueFilters = { timeKey: '1h', rangeFrom: '', rangeTo: '', statusSel: ['in-progress'] };

function _loadFilters(): QueueFilters {
  try {
    const p = JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '');
    return {
      timeKey: p.timeKey ?? '1h',
      rangeFrom: p.rangeFrom ?? '',
      rangeTo: p.rangeTo ?? '',
      statusSel: p.statusSel === 'all' || Array.isArray(p.statusSel) ? p.statusSel : ['in-progress'],
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

// Event time: doneAt for terminal tasks, createdAt for active ones.
function _eventTs(t: CommsTask): number { return t.doneAt ?? t.createdAt; }

function _matchesTime(t: CommsTask, timeKey: TimeKey | null, rangeFrom: string, rangeTo: string): boolean {
  if (!timeKey) return true;
  const ts = _eventTs(t);
  if (timeKey === 'range') {
    if (rangeFrom && ts < new Date(rangeFrom + 'T00:00:00').getTime()) return false;
    if (rangeTo && ts > new Date(rangeTo + 'T23:59:59.999').getTime()) return false;
    return true;
  }
  const chip = TIME_CHIPS.find(c => c.id === timeKey);
  return chip ? ts >= Date.now() - chip.ms : true;
}

function _matchesSearch(t: CommsTask, q: string): boolean {
  if (!q) return true;
  return t.prompt.toLowerCase().includes(q)
    || (t.agentId || '').toLowerCase().includes(q)
    || (t.error || '').toLowerCase().includes(q)
    || (t.result || '').toLowerCase().includes(q);
}

function _toggleBucket(sel: StatusSel, b: StatusBucket): StatusSel {
  if (sel === 'all') return [b];
  const next = sel.includes(b) ? sel.filter(x => x !== b) : [...sel, b];
  return next.length === 0 ? 'all' : next;
}

// ── QueueFilterBar — sticky search + collapsible time/status filter rows ──────
function QueueFilterBar({ search, onSearchChange, open, onToggleOpen, filters, onFilters, bucketCounts, matchCount, totalCount, onReset, onDeleteFiltered }: {
  search: string;
  onSearchChange: (v: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  filters: QueueFilters;
  onFilters: (patch: Partial<QueueFilters>) => void;
  bucketCounts: Record<StatusBucket, number>;
  matchCount: number;
  totalCount: number;
  onReset?: () => void;
  onDeleteFiltered?: () => void;
}) {
  const { timeKey, rangeFrom, rangeTo, statusSel } = filters;
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  // Auto-revert the "Sure?" confirmation if the user doesn't follow through
  React.useEffect(() => {
    if (!confirmingDelete) return;
    const t = setTimeout(() => setConfirmingDelete(false), 4000);
    return () => clearTimeout(t);
  }, [confirmingDelete]);
  const isDefaultSel = statusSel !== 'all' && statusSel.length === 1 && statusSel[0] === 'in-progress';
  const isCustomized = timeKey !== DEFAULT_FILTERS.timeKey || !isDefaultSel || !!search;
  const chipStyle = (active: boolean, color: string): React.CSSProperties => ({
    padding: '2px 7px', borderRadius: 20, fontSize: '0.63rem', fontWeight: 500,
    cursor: 'pointer', border: `1px solid ${active ? color : 'rgba(255,255,255,0.08)'}`,
    background: active ? `${color}22` : 'transparent',
    color: active ? color : '#abafb8', transition: 'all 0.1s',
    flexShrink: 0, whiteSpace: 'nowrap',
  });
  const dateInputStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: 5, color: '#e5e7eb', fontSize: '0.62rem', padding: '2px 4px',
    colorScheme: 'dark', outline: 'none',
  };
  const timeLabel = !timeKey ? 'All time' : timeKey === 'range' ? 'Date range' : timeKey;
  const statusLabel = statusSel === 'all'
    ? 'All'
    : statusSel.map(b => STATUS_BUCKETS.find(s => s.id === b)?.label || b).join(' + ');

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 6,
      // Negative margins bleed the sticky bar to the queue tab's edge (container has px-4)
      margin: '0 -16px',
      backgroundColor: 'rgba(23,23,23,0.94)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 16px 6px',
    }}>
      {/* Row 1 — search input + ⋯ toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#abafb8" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input type="text"
            placeholder="Search tasks…"
            value={search} onChange={e => onSearchChange(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '5px 26px 5px 26px',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 7, color: '#e5e7eb', fontSize: '0.74rem', outline: 'none',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(167,139,250,0.5)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; }}
          />
          {search && (
            <button onClick={() => onSearchChange('')}
              style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: '#abafb8', fontSize: '0.7rem', padding: 2 }}>
              ✕
            </button>
          )}
        </div>
        <button onClick={onToggleOpen} title={open ? 'Hide filters' : 'Show filters'}
          style={{
            position: 'relative', padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: open ? 'rgba(167,139,250,0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${open ? 'rgba(167,139,250,0.3)' : 'rgba(255,255,255,0.09)'}`,
            color: open ? '#a78bfa' : '#abafb8', transition: 'background 0.15s',
          }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
          </svg>
          {isCustomized && (
            <span style={{
              position: 'absolute', top: 2, right: 2, width: 5, height: 5,
              borderRadius: '50%', backgroundColor: '#a78bfa',
            }} />
          )}
        </button>
      </div>

      {/* Collapsed summary badge — shows what's selected while rows are hidden */}
      {!open && (
        <button onClick={onToggleOpen}
          style={{
            alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 4,
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          }}
          title="Show filters">
          <span style={{ fontSize: '0.6rem', color: '#abafb8' }}>
            {timeLabel} · {statusLabel} · {matchCount}/{totalCount}
          </span>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6,9 12,15 18,9"/>
          </svg>
        </button>
      )}

      {open && (<>
        {/* Row 2 — time chips (single-select, toggle-off = all time) + date range */}
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          {TIME_CHIPS.map(c => (
            <button key={c.id} onClick={() => onFilters({ timeKey: timeKey === c.id ? null : c.id })}
              style={chipStyle(timeKey === c.id, '#a78bfa')}>
              {c.label}
            </button>
          ))}
          <button onClick={() => onFilters({ timeKey: timeKey === 'range' ? null : 'range' })}
            title="Pick a date range"
            style={{ ...chipStyle(timeKey === 'range', '#a78bfa'), display: 'flex', alignItems: 'center' }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
          </button>
          {timeKey === 'range' && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: '0.6rem', color: '#abafb8' }}>From</span>
              <input type="date" value={rangeFrom} onChange={e => onFilters({ rangeFrom: e.target.value })} style={dateInputStyle} />
              <span style={{ fontSize: '0.6rem', color: '#abafb8' }}>To</span>
              <input type="date" value={rangeTo} onChange={e => onFilters({ rangeTo: e.target.value })} style={dateInputStyle} />
            </div>
          )}

          {/* Filter actions — reset to everything, delete currently-shown tasks */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          {onReset && (
            <button onClick={onReset} title="Show everything — clear all filters"
              aria-label="Clear all filters"
              style={{
                padding: '3px 6px', borderRadius: 5, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
                color: '#9ca3af', transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
            </button>
          )}
          {onDeleteFiltered && (confirmingDelete ? (
            <button
              onClick={() => { setConfirmingDelete(false); onDeleteFiltered(); }}
              title={`Confirm delete ${matchCount} shown task${matchCount !== 1 ? 's' : ''}`}
              style={{
                padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
                background: 'rgba(248,113,113,0.18)', border: '1px solid rgba(248,113,113,0.4)',
                color: '#f87171', fontSize: '0.62rem', fontWeight: 600, transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.3)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.18)')}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
              </svg>
              Sure?
            </button>
          ) : (
            <button onClick={() => setConfirmingDelete(true)} disabled={matchCount === 0}
              title={`Delete ${matchCount} shown task${matchCount !== 1 ? 's' : ''}`}
              aria-label={`Delete ${matchCount} shown tasks`}
              style={{
                padding: '3px 6px', borderRadius: 5, cursor: matchCount === 0 ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)',
                color: '#f87171', opacity: matchCount === 0 ? 0.4 : 1, transition: 'background 0.15s',
              }}
              onMouseEnter={e => { if (matchCount > 0) e.currentTarget.style.background = 'rgba(248,113,113,0.16)'; }}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.08)')}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
              </svg>
            </button>
          ))}
          </div>
        </div>

        {/* Row 3 — status chips (multi-select + All) */}
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => onFilters({ statusSel: 'all' })} style={chipStyle(statusSel === 'all', '#a78bfa')}>
            All
          </button>
          {STATUS_BUCKETS.map(b => {
            const active = statusSel !== 'all' && statusSel.includes(b.id);
            return (
              <button key={b.id} onClick={() => onFilters({ statusSel: _toggleBucket(statusSel, b.id) })}
                style={chipStyle(active, b.color)}>
                {b.label} {bucketCounts[b.id]}
              </button>
            );
          })}
        </div>

        {/* Match count */}
        <div style={{ color: '#4b5563', fontSize: '0.62rem' }}>
          {matchCount} of {totalCount} task{totalCount !== 1 ? 's' : ''}
        </div>
      </>)}
    </div>
  );
}

// ── QueueTaskList — renders all comms-graph tasks, newest first + filters ──────
export function _QueueTaskList({ tasks, onContinueThread, onHeightChange, focusRequest, onFocusHandled }: {
  tasks: CommsTask[];
  onContinueThread?: (task: CommsTask) => void;
  onHeightChange?: () => void;
  focusRequest?: { taskId: string; status?: string; nonce: number } | null;
  onFocusHandled?: () => void;
}) {
  const [filters, setFilters] = React.useState<QueueFilters>(_loadFilters);
  const [search, setSearch] = React.useState('');
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [flashTaskId, setFlashTaskId] = React.useState<string | null>(null);
  const cardRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const tasksRef = React.useRef(tasks);
  tasksRef.current = tasks;
  const seenIdsRef = React.useRef<Set<string> | null>(null);
  const { timeKey, rangeFrom, rangeTo, statusSel } = filters;

  // Persist filter selections (search text intentionally not persisted)
  React.useEffect(() => {
    try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify({ timeKey, rangeFrom, rangeTo, statusSel })); } catch {}
  }, [timeKey, rangeFrom, rangeTo, statusSel]);

  // New-task safety net: a fresh task must never be hidden by a status filter —
  // auto-include 'in-progress' when a new id appears. createdAt ≈ now always
  // passes the time filter.
  React.useEffect(() => {
    const ids = new Set(tasks.map(t => t.id));
    const prev = seenIdsRef.current;
    seenIdsRef.current = ids;
    if (!prev) return; // first render — restore isn't "new"
    for (const id of ids) {
      if (!prev.has(id)) {
        setFilters(f => (f.statusSel !== 'all' && !f.statusSel.includes('in-progress'))
          ? { ...f, statusSel: [...f.statusSel, 'in-progress'] }
          : f);
        break;
      }
    }
  }, [tasks]);

  // Deep-link from a notification: apply the right filter bucket, relax filters
  // that would hide the target, then flash + scroll to it.
  React.useEffect(() => {
    if (!focusRequest) return;
    const { taskId, status } = focusRequest;
    const bucket = (STATUS_BUCKET_MAP as Record<string, StatusBucket>)[status || ''] || 'in-progress';
    setFilters(f => {
      const task = tasksRef.current.find(t => t.id === taskId);
      const relaxed = task && !_matchesTime(task, f.timeKey, f.rangeFrom, f.rangeTo) ? null : f.timeKey;
      return { ...f, statusSel: [bucket], timeKey: relaxed };
    });
    setSearch('');
    setFlashTaskId(taskId);
    // The queue tab may still be display:none (deferredTab) — scroll after paint.
    // Timers are fire-and-forget: onFocusHandled clears focusRequest, re-running
    // this effect — a cleanup return would cancel the pending scroll/flash.
    setTimeout(() => {
      cardRefs.current[taskId]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 120);
    setTimeout(() => setFlashTaskId(cur => cur === taskId ? null : cur), 2600);
    onFocusHandled?.();
  }, [focusRequest]);

  const q = search.trim().toLowerCase();
  const preStatus = tasks.filter(t => _matchesTime(t, timeKey, rangeFrom, rangeTo) && _matchesSearch(t, q));
  const bucketCounts: Record<StatusBucket, number> = { 'in-progress': 0, done: 0, cancelled: 0, failed: 0 };
  for (const t of preStatus) bucketCounts[STATUS_BUCKET_MAP[t.status] || 'in-progress']++;
  const filtered = preStatus
    .filter(t => statusSel === 'all' || statusSel.includes(STATUS_BUCKET_MAP[t.status] || 'in-progress'))
    .sort((a, b) => _eventTs(b) - _eventTs(a));

  // Window resize: filter rows expand/collapse + filtered count changes
  React.useEffect(() => {
    if (onHeightChange) requestAnimationFrame(() => onHeightChange());
  }, [filtersOpen, filtered.length, onHeightChange]);

  const clearAllFilters = () => {
    setFilters({ timeKey: null, rangeFrom: '', rangeTo: '', statusSel: 'all' });
    setSearch('');
  };
  const handleDeleteFiltered = () => {
    for (const t of filtered) ipcRenderer?.send('task:delete', { taskId: t.id });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <style>{`
        @keyframes td-queue-flash {
          0%, 100% { box-shadow: 0 0 0 0 rgba(167,139,250,0); }
          50% { box-shadow: 0 0 0 2px rgba(167,139,250,0.85), 0 0 16px rgba(167,139,250,0.3); }
        }
      `}</style>
      <QueueFilterBar
        search={search}
        onSearchChange={setSearch}
        open={filtersOpen}
        onToggleOpen={() => setFiltersOpen(o => !o)}
        filters={filters}
        onFilters={patch => setFilters(f => ({ ...f, ...patch }))}
        bucketCounts={bucketCounts}
        matchCount={filtered.length}
        totalCount={tasks.length}
        onReset={clearAllFilters}
        onDeleteFiltered={handleDeleteFiltered}
      />
      {tasks.length === 0 ? (
        <div style={{ padding: '14px 12px', textAlign: 'center', color: '#4b5563', fontSize: '0.7rem' }}>
          No background tasks. Handoffs from voice or chat will appear here.
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: '14px 12px', textAlign: 'center', color: '#4b5563', fontSize: '0.7rem' }}>
          No tasks match these filters.
          <button
            onClick={clearAllFilters}
            style={{
              marginLeft: 6, padding: '2px 8px', borderRadius: 5, fontSize: '0.64rem', cursor: 'pointer',
              background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)',
              color: '#a78bfa', fontWeight: 500,
            }}>
            Clear filters
          </button>
        </div>
      ) : filtered.map(task => (
        <div key={task.id} ref={el => { cardRefs.current[task.id] = el; }}>
          <QueueTaskCard task={task} onContinueThread={onContinueThread} onHeightChange={onHeightChange} flash={task.id === flashTaskId} />
        </div>
      ))}
    </div>
  );
}

// ── Notification SVG icons ─────────────────────────────────────────────────────
const SuccessDropletIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M12 2.5C12 2.5 5 10 5 15a7 7 0 0 0 14 0c0-5-7-12.5-7-12.5z" fill="rgba(74,222,128,0.15)" stroke="#4ade80" strokeWidth="1.5" strokeLinejoin="round"/>
    <polyline points="8.5 14.5 11 17 15.5 12" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const FailureAlertIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" fill="rgba(248,113,113,0.12)" stroke="#f87171" strokeWidth="1.5" strokeLinejoin="round"/>
    <line x1="12" y1="9" x2="12" y2="13" stroke="#f87171" strokeWidth="2" strokeLinecap="round"/>
    <circle cx="12" cy="16.5" r="1" fill="#f87171"/>
  </svg>
);

const AuthRequiredIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" fill="rgba(251,191,36,0.12)" stroke="#fbbf24" strokeWidth="1.5" strokeLinejoin="round"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none" stroke="#fbbf24" strokeWidth="1.5" strokeLinecap="round"/>
    <circle cx="12" cy="16" r="1.5" fill="#fbbf24"/>
  </svg>
);

const ApprovalIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="3" fill="rgba(96,165,250,0.12)" stroke="#60a5fa" strokeWidth="1.5"/>
    <path d="M9 12l2 2 4-4" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const BrainIcon = ({ size = 14, color = '#818cf8' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2a2.5 2.5 0 0 0-2.45 2.5A2.5 2.5 0 0 0 5 7a2.5 2.5 0 0 0-1 4.5A2.5 2.5 0 0 0 5 16a2.5 2.5 0 0 0 2.5 2.5A2.5 2.5 0 0 0 10 21V4a2 2 0 0 0-.5-2z"/>
    <path d="M14.5 2a2.5 2.5 0 0 1 2.45 2.5A2.5 2.5 0 0 1 19 7a2.5 2.5 0 0 1 1 4.5A2.5 2.5 0 0 1 19 16a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 14 21V4a2 2 0 0 1 .5-2z"/>
  </svg>
);

// ── SourcePill — Perplexity-style favicon stack + dropdown (extracted from ResultsWindow) ──
const SourcePill = ({ sources }: { sources: { url: string; title: string; hostname: string }[] }) => {
  const [showPanel, setShowPanel] = React.useState(false);
  if (!sources || sources.length === 0) return null;
  const visible = sources.slice(0, 4);
  const OVERLAP = 10;
  const CIRCLE = 22;
  return (
    <div style={{ position: 'relative', marginBottom: 8 }}>
      <button
        onClick={(e) => { e.stopPropagation(); setShowPanel(!showPanel); }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', userSelect: 'none' }}
      >
        <div style={{ position: 'relative', width: CIRCLE + (visible.length - 1) * (CIRCLE - OVERLAP), height: CIRCLE, flexShrink: 0 }}>
          {visible.map((src, i) => (
            <div key={src.url + i} style={{
              position: 'absolute', left: i * (CIRCLE - OVERLAP), top: 0, width: CIRCLE, height: CIRCLE,
              borderRadius: '50%', overflow: 'hidden', border: '1.5px solid rgba(255,255,255,0.12)',
              backgroundColor: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: visible.length - i, flexShrink: 0,
            }}>
              <Favicon domain={src.hostname} size={14} alt={src.hostname} />
            </div>
          ))}
        </div>
        <span style={{ color: '#9ca3af', fontSize: '0.66rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3 }}>
          {sources.length} {sources.length === 1 ? 'site' : 'sites'}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ color: '#abafb8', transform: showPanel ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {showPanel && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50, width: 280, maxHeight: 320, overflowY: 'auto',
          backgroundColor: '#1c1c1e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)', padding: '6px 0',
        }}>
          <div style={{ padding: '6px 12px 4px', fontSize: '0.65rem', fontWeight: 600, color: '#abafb8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Sources
          </div>
          {sources.map((src, i) => (
            <div key={src.url + i} onClick={(e) => { e.stopPropagation(); if (ipcRenderer) ipcRenderer.send('shell:open-url', src.url); }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px', cursor: 'pointer', transition: 'background 0.1s' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: '#2a2a2c', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Favicon domain={src.hostname} size={12} alt="" />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 500, color: '#e5e7eb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {src.title || src.hostname}
                </div>
                <div style={{ fontSize: '0.62rem', color: '#abafb8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {src.hostname}
                </div>
              </div>
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

// ── TaskCompleteBanner — top-right toast with slide-out animation + sound ──────
export function TaskCompleteBanner({ notification, onDismiss, onShowResult, onGoToQueue, onApprove }: {
  notification: { taskId: string; prompt: string; answer?: string; error?: string; status?: string; planFile?: string | null } | null;
  onDismiss: () => void;
  onShowResult?: (taskId: string) => void;
  onGoToQueue?: (taskId: string, status?: string) => void;
  onApprove?: (taskId: string, planFile?: string | null) => void;
}) {
  const [exiting, setExiting] = React.useState(false);

  // Play water-drip sound when notification appears
  React.useEffect(() => {
    if (notification) {
      playDropSound();
      setExiting(false);
    }
  }, [notification]);

  // Auto-dismiss after 10s (but not for awaiting-approval — user needs to act)
  React.useEffect(() => {
    if (!notification) return;
    if (notification.status === 'awaiting-approval') return; // Don't auto-dismiss approval notifications
    const t = setTimeout(() => {
      setExiting(true);
      setTimeout(onDismiss, 300);
    }, 10000);
    return () => clearTimeout(t);
  }, [notification, onDismiss]);

  if (!notification) return null;

  const isFailed = notification.status === 'failed' || (!!notification.error && notification.status !== 'auth-required' && notification.status !== 'awaiting-approval');
  const isAuthRequired = notification.status === 'auth-required';
  const isAwaitingApproval = notification.status === 'awaiting-approval';
  // Response preview footer — truncated, defensive strip of any residual think tags
  const _stripThink = (t: string) => t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/<\/think(?:ing)?>/g, '').trim();
  const cleanAnswer = notification.answer ? _stripThink(notification.answer) : '';
  const responsePreview = cleanAnswer.length > 80
    ? cleanAnswer.slice(0, 80) + '…'
    : cleanAnswer;

  // Color scheme: green for done, red for failed, amber for auth-required, blue for awaiting-approval
  const accentColor = isFailed ? '#f87171' : isAuthRequired ? '#fbbf24' : isAwaitingApproval ? '#60a5fa' : '#4ade80';
  const accentBg = isFailed
    ? 'linear-gradient(135deg, rgba(248,113,113,0.12), rgba(15,15,25,0.85))'
    : isAuthRequired
      ? 'linear-gradient(135deg, rgba(251,191,36,0.12), rgba(15,15,25,0.85))'
      : isAwaitingApproval
        ? 'linear-gradient(135deg, rgba(96,165,250,0.12), rgba(15,15,25,0.85))'
        : 'linear-gradient(135deg, rgba(74,222,128,0.10), rgba(15,15,25,0.85))';
  const accentBorder = isFailed ? 'rgba(248,113,113,0.3)' : isAuthRequired ? 'rgba(251,191,36,0.3)' : isAwaitingApproval ? 'rgba(96,165,250,0.3)' : 'rgba(74,222,128,0.3)';
  const pulseColor = isFailed ? 'rgba(248,113,113,0.3)' : isAuthRequired ? 'rgba(251,191,36,0.3)' : isAwaitingApproval ? 'rgba(96,165,250,0.3)' : 'rgba(74,222,128,0.3)';
  const pulseFade = isFailed ? 'rgba(248,113,113,0.08)' : isAuthRequired ? 'rgba(251,191,36,0.08)' : isAwaitingApproval ? 'rgba(96,165,250,0.08)' : 'rgba(74,222,128,0.08)';

  const handleDismiss = () => {
    setExiting(true);
    setTimeout(onDismiss, 300);
  };

  return (
    <>
      <style>{`
        @keyframes td-notif-slide-in {
          0%   { transform: translateX(120%) scale(0.95); opacity: 0; }
          60%  { transform: translateX(-8%) scale(1.01); opacity: 1; }
          100% { transform: translateX(0) scale(1); opacity: 1; }
        }
        @keyframes td-notif-slide-out {
          0%   { transform: translateX(0) scale(1); opacity: 1; }
          100% { transform: translateX(120%) scale(0.95); opacity: 0; }
        }
        @keyframes td-notif-pulse {
          0%, 100% { box-shadow: 0 8px 24px rgba(0,0,0,0.3), 0 0 0 0 ${pulseColor}; }
          50%      { box-shadow: 0 8px 24px rgba(0,0,0,0.3), 0 0 0 6px ${pulseFade}; }
        }
      `}</style>
      <div style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        maxWidth: 380,
        minWidth: 300,
        borderRadius: 12,
        background: accentBg,
        border: `1px solid ${accentBorder}`,
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        padding: '14px 16px',
        animation: exiting
          ? 'td-notif-slide-out 0.3s cubic-bezier(0.4, 0, 1, 1) forwards'
          : 'td-notif-slide-in 0.45s cubic-bezier(0.16, 1, 0.3, 1), td-notif-pulse 1.5s ease-in-out 0.5s 2',
      }}>
        {/* X close button — top-right corner */}
        <button
          onClick={handleDismiss}
          aria-label="Close"
          style={{
            position: 'absolute', top: 8, right: 8,
            width: 20, height: 20, padding: 0, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.4)', transition: 'color 0.15s, background 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.85)'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
        {/* Clicking the banner body deep-links to the task in the Queue tab */}
        <div
          style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}
          onClick={() => onGoToQueue?.(notification.taskId, notification.status)}
        >
          {/* SVG icon */}
          <div style={{ flexShrink: 0, paddingTop: 1 }}>
            {isFailed ? <FailureAlertIcon size={22} /> : isAuthRequired ? <AuthRequiredIcon size={22} /> : isAwaitingApproval ? <ApprovalIcon size={22} /> : <SuccessDropletIcon size={22} />}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Title */}
            <div style={{
              fontSize: '0.74rem', fontWeight: 700, marginBottom: 3,
              color: accentColor,
              letterSpacing: 0.2,
              paddingRight: 24,
            }}>
              {isFailed ? 'Task Failed' : isAuthRequired ? 'Sign-in Needed' : isAwaitingApproval ? 'Plan Ready — Approve?' : 'Task Complete'}
            </div>

            {/* Prompt preview (header) */}
            <div style={{
              fontSize: '0.69rem', color: '#d1d5db', lineHeight: 1.45, marginBottom: 6,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {isFailed ? (notification.error || 'Something went wrong') : <>"<PromptText text={notification.prompt} maxLen={60} />"</>}
            </div>

            {/* Response preview footer — only for done tasks with an answer */}
            {!isFailed && !isAuthRequired && responsePreview && (
              <div style={{
                fontSize: '0.66rem', color: '#9ca3af', lineHeight: 1.4, marginBottom: 8,
                fontStyle: 'italic',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {responsePreview}
              </div>
            )}

            {/* Auth-required hint */}
            {isAuthRequired && (
              <div style={{
                fontSize: '0.66rem', color: '#fbbf24', lineHeight: 1.4, marginBottom: 8,
              }}>
                Complete sign-in in the Queue to continue.
              </div>
            )}

            {/* Action buttons — right-justified for awaiting-approval, left for others */}
            <div style={{
              display: 'flex', gap: 6, alignItems: 'center',
              justifyContent: isAwaitingApproval ? 'flex-end' : 'flex-start',
            }}>
              {/* For awaiting-approval: Approve + Cancel on the right */}
              {isAwaitingApproval && onApprove && (
                <button onClick={(e) => { e.stopPropagation(); onApprove(notification.taskId, (notification as any).planFile); }} style={{
                  padding: '5px 16px', borderRadius: 6, fontSize: '0.64rem', cursor: 'pointer',
                  background: 'rgba(96,165,250,0.22)', border: '1px solid rgba(96,165,250,0.45)',
                  color: '#93c5fd', fontWeight: 600,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(96,165,250,0.35)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(96,165,250,0.22)')}
                >
                  Approve
                </button>
              )}
              {isAwaitingApproval && (
                <button onClick={(e) => { e.stopPropagation(); handleDismiss(); }} style={{
                  padding: '5px 14px', borderRadius: 6, fontSize: '0.64rem', cursor: 'pointer',
                  background: 'rgba(248,113,113,0.14)', border: '1px solid rgba(248,113,113,0.32)',
                  color: '#f87171', fontWeight: 500,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.24)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.14)')}
                >
                  Cancel
                </button>
              )}
              {/* For non-approval: View Result + Go to Queue on the left */}
              {!isAwaitingApproval && !isFailed && !isAuthRequired && notification.answer && onShowResult && (
                <button onClick={(e) => { e.stopPropagation(); onShowResult(notification.taskId); }} style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: '0.64rem', cursor: 'pointer',
                  background: 'rgba(74,222,128,0.18)', border: '1px solid rgba(74,222,128,0.35)',
                  color: '#4ade80', fontWeight: 600,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(74,222,128,0.28)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(74,222,128,0.18)')}
                >
                  Continue Thread
                </button>
              )}
              {!isAwaitingApproval && onGoToQueue && (
                <button onClick={(e) => { e.stopPropagation(); onGoToQueue(notification.taskId, notification.status); }} style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: '0.64rem', cursor: 'pointer',
                  background: isAuthRequired ? 'rgba(251,191,36,0.18)' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${isAuthRequired ? 'rgba(251,191,36,0.35)' : 'rgba(255,255,255,0.12)'}`,
                  color: isAuthRequired ? '#fbbf24' : '#9ca3af', fontWeight: 500,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = isAuthRequired ? 'rgba(251,191,36,0.28)' : 'rgba(255,255,255,0.12)')}
                onMouseLeave={e => (e.currentTarget.style.background = isAuthRequired ? 'rgba(251,191,36,0.18)' : 'rgba(255,255,255,0.06)')}
                >
                  Go to Queue
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export const QueueTaskList = React.memo(_QueueTaskList);
