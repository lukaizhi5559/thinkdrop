import React from 'react';

/**
 * PlanCard.tsx — one saved plan's status + controls.
 *
 * Shared by the Plans tab (library view) and the Results feed (pinned plans
 * strip + per-plan feed entries) so plan status and actions live wherever
 * the user is looking — not only in the Plans tab.
 *
 * IPC (callers supply handlers; the card itself only sends 'plan:open-editor'
 * and 'plan:rename' which are self-contained):
 *   invoke 'plan:rename' → { ok, planName }
 *   send   'plan:open-editor' → open plan.md in the system editor
 */

const ipcRenderer = (window as any).electron?.ipcRenderer;

export interface PlanTaskSummary {
  num: number;
  title: string;
  status: string;
  mode: string;
  auth: string;
  agents: string[];
  doneWhen?: string | null;
  result?: string;
  steps?: any[] | null;
}

export interface PlanSummary {
  planId: string;
  file: string;
  title: string;
  name: string | null;
  status: string;
  created: string;
  originalPrompt: string;
  isTaskPlan: boolean;
  tasks: PlanTaskSummary[];
}

// ── Status presentation (SVG icons — no emoji, matching tab-bar style) ────────

const _si = { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const PencilIcon = () => (<svg {..._si}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>);
const CheckCircleIcon = () => (<svg {..._si}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>);
const PlayIcon = () => (<svg {..._si} fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21"/></svg>);
const CheckIcon = () => (<svg {..._si}><polyline points="20 6 9 17 4 12"/></svg>);
const XCircleIcon = () => (<svg {..._si}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>);
const StopIcon = () => (<svg {..._si}><rect x="6" y="6" width="12" height="12" rx="1"/></svg>);
const CircleIcon = () => (<svg {..._si}><circle cx="12" cy="12" r="9"/></svg>);

export const PLAN_STATUS_META: Record<string, { Icon: React.ComponentType; color: string; label: string }> = {
  drafting:  { Icon: PencilIcon,      color: '#22d3ee', label: 'Drafting' },
  ready:     { Icon: CheckCircleIcon, color: '#4ade80', label: 'Ready' },
  running:   { Icon: PlayIcon,        color: '#60a5fa', label: 'Running' },
  done:      { Icon: CheckIcon,       color: '#4ade80', label: 'Done' },
  failed:    { Icon: XCircleIcon,     color: '#f87171', label: 'Failed' },
  cancelled: { Icon: StopIcon,        color: '#abafb8', label: 'Cancelled' },
};

/** Map a task's stored "**Status**" value (e.g. '⬜ pending', '✅ done') to an icon. */
function _taskStatusIcon(status: string) {
  const s = (status || '').toLowerCase();
  if (s.includes('done') || s.includes('complete')) return <CheckIcon />;
  if (s.includes('fail') || s.includes('error')) return <XCircleIcon />;
  if (s.includes('run') || s.includes('progress')) return <PlayIcon />;
  if (s.includes('skip') || s.includes('cancel')) return <StopIcon />;
  return <CircleIcon />;
}

const _iconBtn = (color = '#abafb8'): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '4px 7px', borderRadius: 5, cursor: 'pointer',
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
  color, fontSize: '0.62rem', gap: 3, transition: 'background 0.15s',
});

function _fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const sameDay = d >= today;
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Plan card ─────────────────────────────────────────────────────────────────

export function PlanCard({ plan, onContinue, onRun, onCancelRun, onDelete, runState }: {
  plan: PlanSummary;
  onContinue: (p: PlanSummary) => void;
  onRun: (p: PlanSummary) => void;
  onCancelRun: (p: PlanSummary) => void;
  onDelete: (p: PlanSummary) => void;
  runState?: { status: string } | null;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState('');
  const [nameErr, setNameErr] = React.useState<string | null>(null);
  const [confirmDel, setConfirmDel] = React.useState(false);
  const meta = PLAN_STATUS_META[plan.status] || PLAN_STATUS_META.drafting;
  const isRunning = plan.status === 'running' || runState?.status === 'running';
  const runnable = plan.isTaskPlan && plan.tasks.length > 0 && !isRunning;
  const doneCount = plan.tasks.filter(t => t.status.includes('done')).length;

  React.useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const _commitRename = async () => {
    const v = nameDraft.trim();
    if (!v || v === plan.name || !ipcRenderer) { setRenaming(false); setNameErr(null); return; }
    const res = await ipcRenderer.invoke('plan:rename', { planFile: plan.file, planName: v }).catch(() => null);
    if (res?.ok) {
      setRenaming(false);
      setNameErr(null);
    } else {
      setNameErr(res?.error || 'Rename failed');
    }
  };

  return (
    <div style={{
      border: `1px solid ${isRunning ? 'rgba(96,165,250,0.35)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 9, padding: '8px 10px', marginBottom: 8,
      background: 'rgba(255,255,255,0.03)',
    }}>
      {/* Header row: status icon · name · date */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <span style={{ fontSize: '0.8rem', flexShrink: 0, color: meta.color, display: 'flex' }}><meta.Icon /></span>
        {renaming ? (
          <div style={{ flex: 1, minWidth: 0 }}>
          <input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={_commitRename}
            onKeyDown={e => { if (e.key === 'Enter') _commitRename(); if (e.key === 'Escape') { setRenaming(false); setNameErr(null); } }}
            placeholder="history.project.plan"
            style={{
              flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.06)',
              border: `1px solid ${nameErr ? 'rgba(248,113,113,0.5)' : 'rgba(34,211,238,0.4)'}`, borderRadius: 5,
              color: '#e5e7eb', fontSize: '0.72rem', padding: '3px 6px', outline: 'none',
              width: '100%', boxSizing: 'border-box',
            }}
          />
          {nameErr && (
            <div style={{ color: '#f87171', fontSize: '0.6rem', marginTop: 3 }}>{nameErr}</div>
          )}
          </div>
        ) : (
          <button
            onClick={() => { setNameDraft(plan.name || ''); setNameErr(null); setRenaming(true); }}
            title={plan.name ? `Rename ${plan.name}` : 'Click to name (dot-syntax)'}
            style={{
              flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none',
              cursor: 'text', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: plan.name ? '#22d3ee' : '#e5e7eb', fontSize: '0.74rem', fontWeight: 600,
            }}
          >
            {plan.name || plan.title || 'Untitled'}
            {!plan.name && <span style={{ color: '#6b7280', fontWeight: 400 }}> · Untitled</span>}
          </button>
        )}
        <span style={{ fontSize: '0.6rem', color: '#6b7280', flexShrink: 0 }}>{_fmtDate(plan.created)}</span>
      </div>

      {/* Progress strip when tasks exist */}
      {plan.tasks.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
          <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
            <div style={{
              width: `${(doneCount / plan.tasks.length) * 100}%`, height: '100%',
              background: meta.color, transition: 'width 0.3s',
            }} />
          </div>
          <span style={{ fontSize: '0.58rem', color: '#9ca3af', flexShrink: 0 }}>
            {doneCount}/{plan.tasks.length} tasks · {meta.label}
          </span>
        </div>
      )}

      {/* Action row — Continue left; edit/run/delete/expand right-aligned */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7 }}>
        <button onClick={() => onContinue(plan)} title="Continue planning this thread" style={_iconBtn('#22d3ee')}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          Continue
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          <button onClick={() => ipcRenderer?.send('plan:open-editor', { planFile: plan.file })}
            title="Open plan file in editor" style={_iconBtn('#a5b4fc')}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
            </svg>
          </button>
          {isRunning ? (
            <button onClick={() => onCancelRun(plan)} title="Cancel this plan run" style={_iconBtn('#f87171')}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <rect x="6" y="6" width="12" height="12" rx="1"/>
              </svg>
              Stop
            </button>
          ) : (
            <button onClick={() => onRun(plan)} disabled={!runnable}
              title={runnable ? 'Run this plan' : plan.isTaskPlan ? 'No tasks to run' : 'Legacy plan format — run from queue card'}
              style={{ ..._iconBtn('#4ade80'), opacity: runnable ? 1 : 0.4, cursor: runnable ? 'pointer' : 'default' }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="6 3 20 12 6 21"/>
              </svg>
              Run
            </button>
          )}
          {confirmDel ? (
            <button onClick={() => { setConfirmDel(false); onDelete(plan); }} title="Confirm delete"
              style={{ ..._iconBtn('#f87171'), background: 'rgba(248,113,113,0.18)', border: '1px solid rgba(248,113,113,0.4)', fontWeight: 600 }}>
              Sure?
            </button>
          ) : (
            <button onClick={() => setConfirmDel(true)} title="Delete this plan" style={_iconBtn('#f87171')}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          )}
          <button onClick={() => setExpanded(x => !x)} title={expanded ? 'Collapse' : 'Expand tasks'}
            style={_iconBtn()}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Expanded task list */}
      {expanded && (
        <div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 7 }}>
          {plan.originalPrompt && (
            <div style={{ fontSize: '0.62rem', color: '#6b7280', marginBottom: 6, fontStyle: 'italic' }}>
              “{plan.originalPrompt.slice(0, 140)}{plan.originalPrompt.length > 140 ? '…' : ''}”
            </div>
          )}
          {plan.tasks.length === 0 && (
            <div style={{ fontSize: '0.64rem', color: '#6b7280' }}>
              {plan.isTaskPlan ? 'No tasks parsed.' : 'Legacy single-pass plan — tasks live in ## Steps.'}
            </div>
          )}
          {plan.tasks.map(t => (
            <div key={t.num} style={{
              display: 'flex', alignItems: 'flex-start', gap: 7, padding: '4px 0',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
            }}>
              <span style={{ flexShrink: 0, color: '#9ca3af', display: 'flex', marginTop: 1 }}>{_taskStatusIcon(t.status)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.66rem', color: '#e5e7eb', fontWeight: 500 }}>{t.title}</div>
                <div style={{ fontSize: '0.58rem', color: '#6b7280', marginTop: 1 }}>
                  {t.agents.join(' · ') || 'auto'} · {t.mode}
                  {t.auth !== 'none-required' && t.auth !== 'unknown' ? ` · ${t.auth}` : t.auth === 'unknown' ? ' · auth?' : ''}
                </div>
                {t.result && (
                  <div style={{ fontSize: '0.58rem', color: '#9ca3af', marginTop: 2 }}>{t.result.slice(0, 140)}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default PlanCard;
