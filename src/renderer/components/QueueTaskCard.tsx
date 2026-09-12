import React from 'react';
import AutomationProgress from './AutomationProgress';
import { playDropSound } from '../utils/thinkDropSound';
import { Favicon } from './DefaultFaviconIcon';
import RichContentRenderer from './rich-content/RichContentRenderer';

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
  intent: string;
  source: string;
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
  'cancelled':          { label: 'Cancelled',       color: '#6b7280', bg: 'rgba(107,114,128,0.06)',  border: 'rgba(107,114,128,0.18)' },
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

// ── QueueTaskCard — wraps AutomationProgress in an expandable card ────────────
export function QueueTaskCard({ task, onShowResult }: {
  task: CommsTask;
  onShowResult?: (task: CommsTask) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [thinkingExpanded, setThinkingExpanded] = React.useState(false);
  const cfg = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.queued;
  const isActive = task.status === 'running' || task.status === 'queued' || task.status === 'waiting-for-agent' || task.status === 'auth-required' || task.status === 'awaiting-approval' || task.status === 'waiting-for-input';
  const needsAttention = task.status === 'auth-required' || task.status === 'awaiting-approval' || task.status === 'waiting-for-input';
  const preview = task.prompt.length > 80 ? task.prompt.slice(0, 80) + '…' : task.prompt;
  const elapsed = useElapsed(task.startedAt || task.createdAt, isActive);
  const elapsedStr = _formatTime(elapsed);
  const diff = Date.now() - (task.doneAt || task.createdAt);
  const agoStr = _timeAgo(diff);
  const agentName = task.agentId ? task.agentId.replace(/\.agent$/, '') : 'auto';

  // Auto-expand when task is active or needs attention
  React.useEffect(() => {
    if (isActive || needsAttention) {
      setExpanded(true);
    }
  }, [task.status]);

  const handleExpand = () => setExpanded(e => !e);
  const handleShowResult = () => { if (onShowResult) onShowResult(task); };

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
    }}>
      {/* ── Card header (always visible) ── */}
      <div style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={handleExpand}>
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
              {preview}
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
                <span style={{ fontSize: '0.56rem', color: '#6b7280', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                {/* Delete / clear task */}
                <button
                  onClick={(e) => { e.stopPropagation(); ipcRenderer?.send('task:delete', { taskId: task.id }); }}
                  title="Remove task"
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

                {/* Expand chevron — AgentsTab style */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleExpand(); }}
                  title={expanded ? 'Collapse' : 'Show details'}
                  style={{
                    padding: '4px 7px', borderRadius: 5, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: expanded ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)',
                    border: expanded ? '1px solid rgba(99,102,241,0.25)' : '1px solid rgba(255,255,255,0.1)',
                    color: expanded ? '#818cf8' : '#6b7280', transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = expanded ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.1)')}
                  onMouseLeave={e => (e.currentTarget.style.background = expanded ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)')}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
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
            setIsSubmitting={() => {}}
            onAuthPending={() => {}}
            activeTab="queue"
            onHeightChange={() => {}}
            onActiveChange={() => {}}
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
              content={task.result.replace(/【[^】]*】/g, '')}
              animated={false}
              className="text-xs"
            />
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 10px' }}>
          {task.status === 'done' && task.result && onShowResult && (
            <button onClick={handleShowResult} style={{
              padding: '3px 8px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
              background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.2)',
              color: '#4ade80', fontWeight: 500,
            }}>
              Show in Results
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

// ── QueueTaskList — renders all comms-graph tasks ──────────────────────────────
export function QueueTaskList({ tasks, onShowResult }: {
  tasks: CommsTask[];
  onShowResult?: (task: CommsTask) => void;
}) {
  if (tasks.length === 0) {
    return (
      <div style={{
        padding: '20px 12px', textAlign: 'center',
        color: '#4b5563', fontSize: '0.7rem',
      }}>
        No background tasks. Handoffs from voice or chat will appear here.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {tasks.map(task => (
        <QueueTaskCard key={task.id} task={task} onShowResult={onShowResult} />
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
            style={{ color: '#6b7280', transform: showPanel ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
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
          <div style={{ padding: '6px 12px 4px', fontSize: '0.65rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
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
                <div style={{ fontSize: '0.62rem', color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
  onGoToQueue?: () => void;
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
  const preview = notification.prompt.length > 60
    ? notification.prompt.slice(0, 60) + '…'
    : notification.prompt;
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
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
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
            }}>
              {isFailed ? 'Task Failed' : isAuthRequired ? 'Sign-in Needed' : isAwaitingApproval ? 'Plan Ready — Approve?' : 'Task Complete'}
            </div>

            {/* Prompt preview (header) */}
            <div style={{
              fontSize: '0.69rem', color: '#d1d5db', lineHeight: 1.45, marginBottom: 6,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {isFailed ? (notification.error || 'Something went wrong') : `"${preview}"`}
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

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {/* Approve button for awaiting-approval */}
              {isAwaitingApproval && onApprove && (
                <button onClick={() => onApprove(notification.taskId, (notification as any).planFile)} style={{
                  padding: '4px 14px', borderRadius: 6, fontSize: '0.64rem', cursor: 'pointer',
                  background: 'rgba(96,165,250,0.18)', border: '1px solid rgba(96,165,250,0.35)',
                  color: '#60a5fa', fontWeight: 600,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(96,165,250,0.28)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(96,165,250,0.18)')}
                >
                  Approve Plan
                </button>
              )}
              {isAwaitingApproval && (
                <button onClick={handleDismiss} style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: '0.64rem', cursor: 'pointer',
                  background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.3)',
                  color: '#f87171', fontWeight: 500,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.22)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.12)')}
                >
                  Cancel
                </button>
              )}
              {!isFailed && !isAuthRequired && !isAwaitingApproval && notification.answer && onShowResult && (
                <button onClick={() => onShowResult(notification.taskId)} style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: '0.64rem', cursor: 'pointer',
                  background: 'rgba(74,222,128,0.18)', border: '1px solid rgba(74,222,128,0.35)',
                  color: '#4ade80', fontWeight: 600,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(74,222,128,0.28)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(74,222,128,0.18)')}
                >
                  View Result
                </button>
              )}
              {onGoToQueue && (
                <button onClick={onGoToQueue} style={{
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
              <button onClick={handleDismiss} style={{
                padding: '4px 10px', borderRadius: 6, fontSize: '0.64rem', cursor: 'pointer',
                background: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
                color: '#6b7280', fontWeight: 500, marginLeft: 'auto',
                transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#9ca3af'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = '#6b7280'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
