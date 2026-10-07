/**
 * PlanCheckCard — "Plan readiness" checklist card for ResultsFeed.
 *
 * Renders the deterministic per-task readiness rows emitted by main's
 * `plan:check` event (shared/plan-check.cjs). Issues carry inline actions that
 * dispatch `plan:check:action` IPC:
 *
 *   signin        → [Sign in] [Bypass ⚠]      (browser service agents)
 *   cli-key       → per-secret text inputs + [Submit]
 *   cli-login     → [Run login]                (cli/api/mcp agents)
 *   cli-setup     → [Set up]                   (draft agent — build+install)
 *   unknown-agent → [Use <suggested>] [Find options]
 *   steps-failed / missing-steps → [Retry generation] (advisory — warn/pending)
 *
 * Bypass is gated behind an inline disclaimer — the user must confirm
 * "Proceed anyway" before the bypass is persisted. Voice phrases ("sign in",
 * "bypass", "use google docs", "cancel plan") hit the same handlers through
 * main's _matchPlanCheckAction.
 *
 * Visual language mirrors AutomationProgress's plan-review card: StepIcon
 * status circles, status-colored row text, blue "Approve & Run" / red
 * "Cancel" button pair.
 */

import { useEffect, useState } from 'react';
import { StepIcon } from './AutomationProgress';
import { TaskRows, summarizeTasks } from './PlanTaskRows';

const ipcRenderer = (window as any).electron?.ipcRenderer;

const COLORS = {
  cardBg: 'rgba(255,255,255,0.03)',
  cardBorder: '1px solid rgba(255,255,255,0.09)',
  headerText: '#93c5fd',
  bodyText: '#e5e7eb',
  secondaryText: '#9ca3af',
  mutedText: '#abafb8',
  warnBg: 'rgba(251,191,36,0.08)',
  warnBorder: '1px solid rgba(251,191,36,0.28)',
  warnText: '#fcd34d',
  issueText: '#fca5a5',
  pendingText: '#fbbf24',
  // AP plan-review button pair
  primaryBg: 'rgba(59,130,246,0.18)',
  primaryBorder: '1px solid rgba(59,130,246,0.45)',
  primaryText: '#93c5fd',
  dangerBg: 'rgba(239,68,68,0.08)',
  dangerBorder: '1px solid rgba(239,68,68,0.25)',
  dangerText: '#f87171',
  ghostBorder: '1px solid rgba(107,114,128,0.3)',
  inputBg: 'rgba(255,255,255,0.04)',
  inputBorder: '1px solid rgba(255,255,255,0.08)',
  inputText: '#e5e7eb',
};

export interface PlanCheckItem {
  id: string;
  taskNum?: number;
  agentId?: string;
  label: string;
  detail?: string;
  status: 'pass' | 'pending' | 'issue' | 'warn';
  kind?: 'signin' | 'cli-key' | 'cli-login' | 'cli-setup' | 'unknown-agent' | 'missing-steps' | 'steps-failed' | 'approval-required';
  suggested?: string | null;
  envNames?: string[];
  serviceType?: string;
  authState?: string;
  bypassed?: boolean;
}

export interface PlanCheckPayload {
  planId: string | null;
  /** Absolute path of the plan .md — carried so 'open-plan' works even after
   *  main's pending-check slot has moved on. */
  planFile?: string;
  items: PlanCheckItem[];
  allClear: boolean;
  authOpened?: string;
  cancelled?: boolean;
  error?: string;
}

interface PlanCheckCardProps {
  check: PlanCheckPayload;
  /** Compact mode (default): one grouped row per task on top; the detailed
   *  item list below is limited to non-passing rows (issues, pending steps,
   *  warnings) so action buttons stay reachable. Pass false for the full
   *  item-by-item audit list. */
  compact?: boolean;
  /** Legacy "Run plan" override — unused by the new footer, kept for callers. */
  onRun?: () => void;
}

// plan-check status → AutomationProgress StepStatus (shares its StepIcon).
const STATUS_TO_STEP: Record<string, 'done' | 'failed' | 'needs_input' | 'pending'> = {
  pass: 'done', issue: 'failed', warn: 'needs_input', pending: 'pending',
};
const LABEL_COLOR: Record<string, string> = {
  pass: COLORS.bodyText, issue: COLORS.issueText, warn: COLORS.pendingText, pending: COLORS.mutedText,
};

const _btnBase = { padding: '6px 14px', borderRadius: 7, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 500 } as const;
const _rowBtn = {
  fontSize: '0.66rem', padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
  backgroundColor: COLORS.primaryBg, border: COLORS.primaryBorder, color: COLORS.primaryText,
} as const;
const _rowBtnGhost = {
  ..._rowBtn, backgroundColor: 'transparent', border: COLORS.ghostBorder, color: COLORS.secondaryText,
} as const;
const _rowBtnWarn = {
  ..._rowBtn, backgroundColor: 'transparent', border: COLORS.warnBorder, color: COLORS.warnText,
} as const;

function _send(planId: string | null, itemId: string | undefined, action: string, extra: Record<string, string> = {}) {
  ipcRenderer?.send('plan:check:action', { planId, itemId, action, ...extra });
}

export function PlanCheckCard({ check, compact = true }: PlanCheckCardProps) {
  const [confirmBypass, setConfirmBypass] = useState<string | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({});
  // 'all clear' / 'N issues' is a live refresh control — shows a transient
  // "checking…" state until the re-emitted plan:check payload lands.
  const [checking, setChecking] = useState(false);
  useEffect(() => { setChecking(false); }, [check]);

  const issues = check.items.filter(i => i.status === 'issue');
  const warns = check.items.filter(i => i.status === 'warn');
  // Compact: pass rows are folded into the task summary; issues/warns/pending
  // still render in detail so their action buttons stay reachable.
  const detailItems = compact ? check.items.filter(i => i.status !== 'pass') : check.items;
  const runnable = check.allClear;

  const _submitKey = (item: PlanCheckItem, envName: string) => {
    const field = `${item.id}:${envName}`;
    const value = (keyInputs[field] || '').trim();
    if (!value) return;
    _send(check.planId, item.id, 'submit-key', { envName, value });
    setSubmitted(prev => ({ ...prev, [field]: true }));
  };

  return (
    <div style={{
      borderRadius: 10,
      padding: '10px 12px',
      backgroundColor: COLORS.cardBg,
      border: COLORS.cardBorder,
    }}>
      {/* Header — AP blue-dot + title pattern */}
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <div className="flex items-center gap-2">
          <div className="flex-shrink-0 w-3 h-3 rounded-full" style={{ backgroundColor: '#3b82f6' }} />
          <span style={{ color: COLORS.headerText, fontSize: '0.78rem', fontWeight: 600 }}>
            Plan readiness
          </span>
        </div>
        <button
          type="button"
          title="Re-run readiness checks"
          disabled={checking}
          onClick={() => { setChecking(true); _send(check.planId, undefined, 'recheck'); }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.07)'; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          style={{
            background: 'transparent',
            border: 'none',
            borderRadius: 4,
            padding: '1px 6px',
            color: COLORS.mutedText,
            fontSize: '0.69rem',
            cursor: checking ? 'default' : 'pointer',
            opacity: checking ? 0.6 : 1,
          }}
        >
          {checking ? 'checking…' : check.allClear
            ? (warns.length ? `${warns.length} warning${warns.length === 1 ? '' : 's'}` : 'all clear')
            : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {compact && (
        <div style={{ marginBottom: detailItems.length ? 8 : 0 }}>
          <TaskRows tasks={summarizeTasks(check.items)} compact />
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {detailItems.map(item => (
          <div key={item.id}>
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5">
                <StepIcon status={STATUS_TO_STEP[item.status] || 'pending'} />
              </div>
              <span style={{ color: LABEL_COLOR[item.status] || COLORS.mutedText, fontSize: '0.75rem', flex: 1, minWidth: 0, paddingTop: 1 }}>
                {item.label}
                {item.bypassed && <span style={{ color: COLORS.warnText, fontSize: '0.65rem' }}> (bypassed)</span>}
                {item.kind === 'approval-required' && (
                  <span style={{ color: '#93c5fd', fontSize: '0.65rem' }}> — approve before it runs</span>
                )}
              </span>
              {(item.kind === 'steps-failed' || item.kind === 'missing-steps') && (
                <button onClick={() => _send(check.planId, item.id, 'retry-steps')} style={{ ..._rowBtn, flexShrink: 0 }}>
                  {item.kind === 'steps-failed' ? 'Retry generation' : 'Regenerate'}
                </button>
              )}
              {item.status === 'issue' && item.kind !== 'steps-failed' && (
                <span className="flex" style={{ gap: 5, flexShrink: 0 }}>
                  {item.kind === 'signin' && (
                    <>
                      <button onClick={() => _send(check.planId, item.id, 'signin')} style={_rowBtn}>
                        {check.authOpened === item.agentId ? 'Verifying…' : 'Sign in'}
                      </button>
                      {check.authOpened === item.agentId && (
                        <button onClick={() => _send(check.planId, item.id, 'i-signed-in')} style={_rowBtnGhost}>
                          I signed in
                        </button>
                      )}
                      <button onClick={() => setConfirmBypass(item.id)} style={_rowBtnWarn}>
                        Bypass
                      </button>
                    </>
                  )}
                  {item.kind === 'cli-login' && (
                    <button onClick={() => _send(check.planId, item.id, 'cli-login')} style={_rowBtn}>
                      Run login
                    </button>
                  )}
                  {item.kind === 'cli-setup' && (
                    <button onClick={() => _send(check.planId, item.id, 'cli-setup')} style={_rowBtn}>
                      Set up
                    </button>
                  )}
                  {item.kind === 'unknown-agent' && (
                    <>
                      {item.suggested && (
                        <button onClick={() => _send(check.planId, item.id, 'use-agent')} style={_rowBtn}>
                          Use {item.suggested}
                        </button>
                      )}
                      <button onClick={() => _send(check.planId, item.id, 'find-options')} style={_rowBtnGhost}>
                        Find options
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>

            {/* Bypass disclaimer — inline confirm before the bypass is persisted */}
            {confirmBypass === item.id && (
              <div style={{
                marginTop: 6, marginLeft: 26, padding: '8px 10px', borderRadius: 8,
                backgroundColor: COLORS.warnBg, border: COLORS.warnBorder,
              }}>
                <div style={{ color: COLORS.warnText, fontSize: '0.70rem', lineHeight: 1.45, marginBottom: 8 }}>
                  Running without signing in to {item.agentId}: tasks using it will likely
                  hit login walls or produce incomplete results — the plan may not finish correctly.
                </div>
                <div className="flex" style={{ gap: 6 }}>
                  <button
                    onClick={() => { _send(check.planId, item.id, 'bypass'); setConfirmBypass(null); }}
                    style={{ fontSize: '0.66rem', padding: '3px 10px', borderRadius: 5, backgroundColor: COLORS.warnBg, border: COLORS.warnBorder, color: COLORS.warnText, cursor: 'pointer', fontWeight: 600 }}
                  >Proceed anyway</button>
                  <button
                    onClick={() => setConfirmBypass(null)}
                    style={{ fontSize: '0.66rem', padding: '3px 10px', borderRadius: 5, backgroundColor: 'transparent', border: COLORS.ghostBorder, color: COLORS.secondaryText, cursor: 'pointer' }}
                  >Go back</button>
                </div>
              </div>
            )}

            {/* cli-key: one input per declared secret */}
            {item.status === 'issue' && item.kind === 'cli-key' && (item.envNames || []).map(envName => {
              const field = `${item.id}:${envName}`;
              return (
                <div key={field} className="flex items-center" style={{ gap: 6, marginTop: 5, marginLeft: 26 }}>
                  <span style={{ color: COLORS.secondaryText, fontSize: '0.66rem', fontFamily: 'monospace', flexShrink: 0 }}>{envName}</span>
                  <input
                    type="password"
                    placeholder="paste key"
                    disabled={!!submitted[field]}
                    value={keyInputs[field] || ''}
                    onChange={e => setKeyInputs(prev => ({ ...prev, [field]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') _submitKey(item, envName); }}
                    style={{
                      flex: 1, fontSize: '0.70rem', padding: '3px 8px', borderRadius: 5,
                      backgroundColor: COLORS.inputBg, border: COLORS.inputBorder,
                      color: COLORS.inputText, outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => _submitKey(item, envName)}
                    disabled={!!submitted[field] || !(keyInputs[field] || '').trim()}
                    style={{ ..._rowBtn, opacity: submitted[field] ? 0.5 : 1 }}
                  >{submitted[field] ? 'Stored' : 'Submit'}</button>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {check.error && (
        <div style={{ color: COLORS.issueText, fontSize: '0.70rem', marginTop: 8 }}>{check.error}</div>
      )}
      {check.cancelled && (
        <div style={{ color: COLORS.secondaryText, fontSize: '0.70rem', marginTop: 8 }}>Plan cancelled.</div>
      )}

      {/* Footer — Cancel / Open plan / Review task / Run all (one line) */}
      {!check.cancelled && (
        <div className="flex" style={{ gap: 6, marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 10, flexWrap: 'nowrap' }}>
          <button
            onClick={() => _send(check.planId, undefined, 'cancel')}
            style={{ ..._btnBase, backgroundColor: COLORS.dangerBg, border: COLORS.dangerBorder, color: COLORS.dangerText }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.18)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = COLORS.dangerBg)}
          >Cancel</button>
          <button
            onClick={() => _send(check.planId, undefined, 'open-plan', { planFile: check.planFile || '' })}
            title="Open the full plan in the on-screen document view"
            style={{ ..._btnBase, backgroundColor: 'transparent', border: COLORS.ghostBorder, color: COLORS.secondaryText }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >Open plan</button>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => _send(check.planId, undefined, 'run-review')}
            disabled={!runnable}
            title="Run each task in order, pausing for approval before every task"
            style={{
              ..._btnBase, fontWeight: 600,
              backgroundColor: 'transparent',
              border: runnable ? '1px solid rgba(96,165,250,0.4)' : '1px solid rgba(255,255,255,0.08)',
              color: runnable ? '#93c5fd' : COLORS.mutedText,
              cursor: runnable ? 'pointer' : 'default',
              opacity: runnable ? 1 : 0.6,
            }}
            onMouseEnter={e => { if (runnable) e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.14)'; }}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >Review task</button>
          <button
            onClick={() => _send(check.planId, undefined, 'run-all')}
            disabled={!runnable}
            title="Run all tasks back-to-back — review gates are auto-approved"
            style={{
              ..._btnBase, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600,
              backgroundColor: runnable ? COLORS.primaryBg : 'transparent',
              border: runnable ? COLORS.primaryBorder : '1px solid rgba(255,255,255,0.08)',
              color: runnable ? COLORS.primaryText : COLORS.mutedText,
              cursor: runnable ? 'pointer' : 'default',
              opacity: runnable ? 1 : 0.6,
            }}
            onMouseEnter={e => { if (runnable) e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.30)'; }}
            onMouseLeave={e => { if (runnable) e.currentTarget.style.backgroundColor = COLORS.primaryBg; }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Run all
          </button>
        </div>
      )}
    </div>
  );
}

export default PlanCheckCard;
