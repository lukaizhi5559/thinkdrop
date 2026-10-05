/**
 * PlanCheckCard — "Running Planning Check" checklist card for ResultsFeed.
 *
 * Renders the deterministic per-task readiness rows emitted by main's
 * `plan:check` event (shared/plan-check.cjs). Issues carry inline actions that
 * dispatch `plan:check:action` IPC:
 *
 *   signin        → [Sign in] [Bypass ⚠]      (browser service agents)
 *   cli-key       → per-secret text inputs + [Submit]
 *   cli-login     → [Run login]                (cli/api/mcp agents)
 *   unknown-agent → [Use <suggested>] [Find options]
 *
 * Bypass is gated behind an inline disclaimer — the user must confirm
 * "Proceed anyway" before the bypass is persisted. Voice phrases ("sign in",
 * "bypass", "use google docs", "cancel plan") hit the same handlers through
 * main's _matchPlanCheckAction.
 */

import { useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

const COLORS = {
  cardBg: 'rgba(56,189,248,0.06)',
  cardBorder: '1px solid rgba(56,189,248,0.28)',
  headerText: '#7dd3fc',
  bodyText: '#e5e7eb',
  secondaryText: '#9ca3af',
  mutedText: '#abafb8',
  warnBg: 'rgba(245,158,11,0.10)',
  warnBorder: '1px solid rgba(245,158,11,0.35)',
  warnText: '#fbbf24',
  passText: '#4ade80',
  issueText: '#f87171',
  pendingText: '#fbbf24',
  btnBg: 'rgba(56,189,248,0.15)',
  btnBorder: '1px solid rgba(56,189,248,0.45)',
  btnText: '#7dd3fc',
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
  status: 'pass' | 'pending' | 'issue';
  kind?: 'signin' | 'cli-key' | 'cli-login' | 'unknown-agent' | 'missing-steps';
  suggested?: string | null;
  envNames?: string[];
  serviceType?: string;
  authState?: string;
  bypassed?: boolean;
}

export interface PlanCheckPayload {
  planId: string | null;
  items: PlanCheckItem[];
  allClear: boolean;
  authOpened?: string;
  cancelled?: boolean;
  error?: string;
}

interface PlanCheckCardProps {
  check: PlanCheckPayload;
  /** Run plan — only enabled when allClear. */
  onRun?: () => void;
}

const STATUS_ICON: Record<string, string> = { pass: '✓', pending: '…', issue: '✗' };
const STATUS_COLOR: Record<string, string> = {
  pass: COLORS.passText, pending: COLORS.pendingText, issue: COLORS.issueText,
};

function _send(planId: string | null, itemId: string | undefined, action: string, extra: Record<string, string> = {}) {
  ipcRenderer?.send('plan:check:action', { planId, itemId, action, ...extra });
}

export function PlanCheckCard({ check, onRun }: PlanCheckCardProps) {
  const [confirmBypass, setConfirmBypass] = useState<string | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({});

  const issues = check.items.filter(i => i.status === 'issue');

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
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <div style={{ color: COLORS.headerText, fontSize: '0.76rem', fontWeight: 600 }}>
          Plan readiness check
        </div>
        <div style={{ color: COLORS.mutedText, fontSize: '0.69rem' }}>
          {check.allClear ? 'all clear' : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {check.items.map(item => (
          <div key={item.id}>
            <div className="flex items-center" style={{ gap: 8 }}>
              <span style={{ color: STATUS_COLOR[item.status] || COLORS.mutedText, fontSize: '0.72rem', width: 12, flexShrink: 0 }}>
                {STATUS_ICON[item.status] || '·'}
              </span>
              <span style={{ color: item.status === 'issue' ? COLORS.bodyText : COLORS.secondaryText, fontSize: '0.75rem', flex: 1 }}>
                {item.label}
                {item.bypassed && <span style={{ color: COLORS.warnText, fontSize: '0.65rem' }}> (bypassed)</span>}
              </span>
              {item.status === 'issue' && (
                <span className="flex" style={{ gap: 5, flexShrink: 0 }}>
                  {item.kind === 'signin' && (
                    <>
                      <button
                        onClick={() => _send(check.planId, item.id, 'signin')}
                        style={{ fontSize: '0.66rem', padding: '2px 8px', borderRadius: 5, backgroundColor: COLORS.btnBg, border: COLORS.btnBorder, color: COLORS.btnText, cursor: 'pointer' }}
                      >{check.authOpened === item.agentId ? 'Verifying…' : 'Sign in'}</button>
                      {check.authOpened === item.agentId && (
                        <button
                          onClick={() => _send(check.planId, item.id, 'i-signed-in')}
                          style={{ fontSize: '0.66rem', padding: '2px 8px', borderRadius: 5, backgroundColor: 'transparent', border: COLORS.btnBorder, color: COLORS.secondaryText, cursor: 'pointer' }}
                        >I signed in</button>
                      )}
                      <button
                        onClick={() => setConfirmBypass(item.id)}
                        style={{ fontSize: '0.66rem', padding: '2px 8px', borderRadius: 5, backgroundColor: 'transparent', border: COLORS.warnBorder, color: COLORS.warnText, cursor: 'pointer' }}
                      >Bypass</button>
                    </>
                  )}
                  {item.kind === 'cli-login' && (
                    <button
                      onClick={() => _send(check.planId, item.id, 'cli-login')}
                      style={{ fontSize: '0.66rem', padding: '2px 8px', borderRadius: 5, backgroundColor: COLORS.btnBg, border: COLORS.btnBorder, color: COLORS.btnText, cursor: 'pointer' }}
                    >Run login</button>
                  )}
                  {item.kind === 'unknown-agent' && (
                    <>
                      {item.suggested && (
                        <button
                          onClick={() => _send(check.planId, item.id, 'use-agent')}
                          style={{ fontSize: '0.66rem', padding: '2px 8px', borderRadius: 5, backgroundColor: COLORS.btnBg, border: COLORS.btnBorder, color: COLORS.btnText, cursor: 'pointer' }}
                        >Use {item.suggested}</button>
                      )}
                      <button
                        onClick={() => _send(check.planId, item.id, 'find-options')}
                        style={{ fontSize: '0.66rem', padding: '2px 8px', borderRadius: 5, backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: COLORS.secondaryText, cursor: 'pointer' }}
                      >Find options</button>
                    </>
                  )}
                </span>
              )}
            </div>

            {/* Bypass disclaimer — inline confirm before the bypass is persisted */}
            {confirmBypass === item.id && (
              <div style={{
                marginTop: 6, marginLeft: 20, padding: '8px 10px', borderRadius: 7,
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
                    style={{ fontSize: '0.66rem', padding: '3px 10px', borderRadius: 5, backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: COLORS.secondaryText, cursor: 'pointer' }}
                  >Go back</button>
                </div>
              </div>
            )}

            {/* cli-key: one input per declared secret */}
            {item.status === 'issue' && item.kind === 'cli-key' && (item.envNames || []).map(envName => {
              const field = `${item.id}:${envName}`;
              return (
                <div key={field} className="flex items-center" style={{ gap: 6, marginTop: 5, marginLeft: 20 }}>
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
                    style={{ fontSize: '0.66rem', padding: '3px 8px', borderRadius: 5, backgroundColor: COLORS.btnBg, border: COLORS.btnBorder, color: COLORS.btnText, cursor: 'pointer', opacity: submitted[field] ? 0.5 : 1 }}
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

      {/* Footer */}
      {!check.cancelled && (
        <div className="flex justify-end" style={{ gap: 8, marginTop: 10 }}>
          <button
            onClick={() => _send(check.planId, undefined, 'cancel')}
            style={{ fontSize: '0.70rem', padding: '4px 12px', borderRadius: 6, backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: COLORS.secondaryText, cursor: 'pointer' }}
          >Cancel plan</button>
          <button
            onClick={onRun}
            disabled={!check.allClear}
            style={{
              fontSize: '0.70rem', padding: '4px 12px', borderRadius: 6, fontWeight: 600,
              backgroundColor: check.allClear ? COLORS.btnBg : 'transparent',
              border: check.allClear ? COLORS.btnBorder : '1px solid rgba(255,255,255,0.08)',
              color: check.allClear ? COLORS.btnText : COLORS.mutedText,
              cursor: check.allClear ? 'pointer' : 'default',
              opacity: check.allClear ? 1 : 0.6,
            }}
          >Run plan</button>
        </div>
      )}
    </div>
  );
}

export default PlanCheckCard;
