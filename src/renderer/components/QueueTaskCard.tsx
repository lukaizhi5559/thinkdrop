import React from 'react';
const ipcRenderer = (window as any).electron?.ipcRenderer;

// ── Types ──────────────────────────────────────────────────────────────────────
export type TaskStatus = 'waiting-for-agent' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

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
  intent: string;
  source: string;
}

// ── Status config ──────────────────────────────────────────────────────────────
const TASK_STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; bg: string; border: string; spin?: boolean }> = {
  'waiting-for-agent': { label: 'Waiting',     color: '#fbbf24', bg: 'rgba(251,191,36,0.06)',  border: 'rgba(251,191,36,0.18)' },
  'queued':            { label: 'Queued',      color: '#9ca3af', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.07)' },
  'running':           { label: 'Running',     color: '#60a5fa', bg: 'rgba(96,165,250,0.06)',  border: 'rgba(96,165,250,0.18)',  spin: true },
  'done':              { label: 'Done',        color: '#4ade80', bg: 'rgba(74,222,128,0.06)',   border: 'rgba(74,222,128,0.18)' },
  'failed':            { label: 'Failed',      color: '#f87171', bg: 'rgba(248,113,113,0.06)',  border: 'rgba(248,113,113,0.18)' },
  'cancelled':         { label: 'Cancelled',   color: '#6b7280', bg: 'rgba(107,114,128,0.06)',  border: 'rgba(107,114,128,0.18)' },
};

// ── Agent favicon/icon mapping ─────────────────────────────────────────────────
const AGENT_ICONS: Record<string, string> = {
  'chatgpt.agent':   '🤖',
  'claude.agent':    '🧠',
  'perplexity.agent':'🔍',
  'grok.agent':      '✦',
  'gmail.agent':     '✉',
  'youtube.agent':   '▶',
  'amazon.agent':    '📦',
  'twitter.agent':   '🐦',
  'reddit.agent':    '👽',
  'github.agent':    '🐙',
  'notion.agent':    '📝',
  'slack.agent':     '💬',
  'spotify.agent':   '🎵',
  'netflix.agent':   '🎬',
};

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

// ── QueueTaskCard ──────────────────────────────────────────────────────────────
export function QueueTaskCard({ task, onExpand, onShowResult }: {
  task: CommsTask;
  onExpand?: (task: CommsTask) => void;
  onShowResult?: (task: CommsTask) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const cfg = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.queued;
  const isActive = task.status === 'running' || task.status === 'queued' || task.status === 'waiting-for-agent';
  const preview = task.prompt.length > 80 ? task.prompt.slice(0, 80) + '…' : task.prompt;
  const elapsed = useElapsed(task.startedAt || task.createdAt, isActive);
  const elapsedStr = _formatTime(elapsed);
  const diff = Date.now() - (task.doneAt || task.createdAt);
  const agoStr = _timeAgo(diff);
  const icon = task.agentId ? (AGENT_ICONS[task.agentId] || '🔧') : '⚙';
  const agentName = task.agentId ? task.agentId.replace(/\.agent$/, '') : 'auto';

  const handleExpand = () => {
    setExpanded(e => !e);
    if (onExpand) onExpand(task);
  };

  const handleShowResult = () => {
    if (onShowResult) onShowResult(task);
  };

  return (
    <div style={{
      borderRadius: 9,
      backgroundColor: cfg.bg,
      border: `1px solid ${cfg.border}`,
      transition: 'all 0.15s',
      overflow: 'hidden',
    }}>
      {/* ── Card header (always visible) ── */}
      <div style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={handleExpand}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          {/* Status icon */}
          <div style={{ flexShrink: 0, paddingTop: 2, fontSize: '0.9rem' }}>
            {cfg.spin ? (
              <div style={{ position: 'relative', width: 14, height: 14 }}>
                <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${cfg.color}20` }} />
                <div style={{
                  position: 'absolute', inset: 0, borderRadius: '50%',
                  border: `2px solid ${cfg.color}`,
                  borderTopColor: 'transparent',
                  borderRightColor: 'transparent',
                  animation: 'spin 0.9s linear infinite',
                }} />
              </div>
            ) : (
              <span>{icon}</span>
            )}
          </div>

          {/* Content */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Agent badge */}
            {task.agentId && (
              <span style={{
                fontSize: '0.6rem', color: cfg.color, fontFamily: 'ui-monospace,monospace',
                background: cfg.bg, padding: '1px 5px', borderRadius: 3,
                border: `1px solid ${cfg.border}`, marginBottom: 4, display: 'inline-block',
              }}>
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
              <span style={{ fontSize: '0.58rem', color: '#4b5563', marginLeft: 'auto' }}>
                {expanded ? '▲' : '▼'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Expanded section ── */}
      {expanded && (
        <div style={{
          borderTop: `1px solid ${cfg.border}`,
          padding: '10px 12px',
          backgroundColor: 'rgba(0,0,0,0.15)',
        }}>
          {/* Full prompt */}
          <div style={{ fontSize: '0.68rem', color: '#9ca3af', marginBottom: 8, lineHeight: 1.5 }}>
            {task.prompt}
          </div>

          {/* Result (if done) */}
          {task.result && (
            <div style={{
              fontSize: '0.68rem', color: '#d1d5db', lineHeight: 1.5,
              padding: '8px 10px', borderRadius: 6,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
              marginBottom: 8,
              maxHeight: 200, overflowY: 'auto',
            }}>
              {task.result.substring(0, 500)}
              {task.result.length > 500 ? '…' : ''}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 6 }}>
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
      )}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {tasks.map(task => (
        <QueueTaskCard key={task.id} task={task} onShowResult={onShowResult} />
      ))}
    </div>
  );
}

// ── TaskCompleteBanner — toast notification on task completion ─────────────────
export function TaskCompleteBanner({ notification, onDismiss, onShowResult, onGoToQueue }: {
  notification: { taskId: string; prompt: string; answer?: string; error?: string; status?: string } | null;
  onDismiss: () => void;
  onShowResult?: (taskId: string) => void;
  onGoToQueue?: () => void;
}) {
  React.useEffect(() => {
    if (!notification) return;
    const t = setTimeout(onDismiss, 10000);
    return () => clearTimeout(t);
  }, [notification, onDismiss]);

  if (!notification) return null;

  const isFailed = notification.status === 'failed' || notification.error;
  const preview = notification.prompt.length > 60
    ? notification.prompt.slice(0, 60) + '…'
    : notification.prompt;

  return (
    <div style={{
      position: 'fixed', bottom: 16, right: 16, zIndex: 9999,
      maxWidth: 360, minWidth: 280,
      borderRadius: 10,
      background: isFailed ? 'rgba(248,113,113,0.12)' : 'rgba(74,222,128,0.12)',
      border: `1px solid ${isFailed ? 'rgba(248,113,113,0.25)' : 'rgba(74,222,128,0.25)'}`,
      backdropFilter: 'blur(12px)',
      padding: '12px 14px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
      animation: 'slideInRight 0.3s ease-out',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: '1rem', flexShrink: 0 }}>
          {isFailed ? '⚠' : '✓'}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.72rem', color: isFailed ? '#f87171' : '#4ade80', fontWeight: 600, marginBottom: 2 }}>
            {isFailed ? 'Task Failed' : 'Request Complete'}
          </div>
          <div style={{ fontSize: '0.68rem', color: '#d1d5db', lineHeight: 1.4 }}>
            {isFailed ? (notification.error || 'Something went wrong') : `"${preview}" is done.`}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {!isFailed && notification.answer && onShowResult && (
              <button onClick={() => onShowResult(notification.taskId)} style={{
                padding: '3px 10px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
                background: 'rgba(74,222,128,0.15)', border: '1px solid rgba(74,222,128,0.3)',
                color: '#4ade80', fontWeight: 500,
              }}>
                Show in Results
              </button>
            )}
            {onGoToQueue && (
              <button onClick={onGoToQueue} style={{
                padding: '3px 10px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                color: '#9ca3af', fontWeight: 500,
              }}>
                Go to Queue
              </button>
            )}
            <button onClick={onDismiss} style={{
              padding: '3px 10px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
              background: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
              color: '#6b7280', fontWeight: 500, marginLeft: 'auto',
            }}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
