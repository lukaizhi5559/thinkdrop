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

import { useEffect, useRef, useState } from 'react';
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
  cliTool?: string | null;
  mcpServer?: string | null;
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
  /** Run actually started — card flips to a read-only run surface. */
  started?: boolean;
  /** Task num → title, emitted by main so the card can render live run rows. */
  taskTitles?: { num: number; title: string }[];
  /** Live per-task run state, patched by plan:task_progress events. */
  taskStatuses?: Record<number, { status: string; result?: string | null }>;
  /** Plan reached a terminal state — {status:'done'|'failed', failedTasks}. */
  finished?: { status: string; failedTasks: number[] };
  /** Frontmatter status mirrors (running/done/failed/revising…). */
  planStatus?: string;
  /** Parsed task count at emit time — an empty plan reads allClear otherwise. */
  taskCount?: number;
  /** A different plan took over the active session — card is inert. */
  superseded?: boolean;
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

// plan-format TASK_STATUS strings carry emoji prefixes ('🔄 running',
// '✅ done'…) — normalize by substring so both raw and prefixed values work.
function _runStep(status: string | undefined): { step: 'running' | 'done' | 'failed' | 'skipped' | 'pending'; color: string; text: string } {
  const s = String(status || '').toLowerCase();
  if (s.includes('running')) return { step: 'running', color: '#60a5fa', text: 'running' };
  if (s.includes('done'))    return { step: 'done', color: '#4ade80', text: 'done' };
  if (s.includes('failed'))  return { step: 'failed', color: '#f87171', text: 'failed' };
  if (s.includes('skipped')) return { step: 'skipped', color: '#9ca3af', text: 'skipped' };
  return { step: 'pending', color: '#64748b', text: 'queued' };
}

export function PlanCheckCard({ check, compact = true }: PlanCheckCardProps) {
  const [confirmBypass, setConfirmBypass] = useState<string | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({});
  // 'all clear' / 'N issues' is a live refresh control — shows a transient
  // "checking…" state until the re-emitted plan:check payload lands.
  const [checking, setChecking] = useState(false);
  // Per-action busy state (item id or 'run-all'/'run-review') — cleared when
  // the next plan:check payload lands, so clicked buttons can't look dead.
  const [busy, setBusy] = useState<string | null>(null);
  // Read-only task inspector — fetched on demand via plan:get.
  const [inspecting, setInspecting] = useState(false);
  const [inspectTasks, setInspectTasks] = useState<any[] | null>(null);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  // Narrow-overlay footer — measured from the card itself (the unified
  // window's width isn't the card's; a ResizeObserver is exact).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => { setChecking(false); setBusy(null); }, [check]);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((ents) => {
      const w = ents[0]?.contentRect?.width || 0;
      setNarrow(w > 0 && w < 430);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const issues = check.items.filter(i => i.status === 'issue');
  const warns = check.items.filter(i => i.status === 'warn');
  // Compact: pass rows are folded into the task summary; issues/warns/pending
  // still render in detail so their action buttons stay reachable.
  const detailItems = compact ? check.items.filter(i => i.status !== 'pass') : check.items;
  // Drafting phase — an empty task list makes allClear vacuously true; the
  // run controls stay off until there's something to run.
  const isDrafting = (check.taskCount === 0) || check.planStatus === 'drafting';
  const runnable = check.allClear && !isDrafting;
  const blockers = check.items.filter(i => i.status === 'issue' || i.status === 'pending');
  const blockerTitle = isDrafting
    ? 'Still drafting — tasks appear as they are planned'
    : blockers.length
      ? `Blocked: ${blockers.map(b => b.label).join(' · ')}`
      : undefined;

  // Run-state: once started (or task progress arrived), the card is the live
  // run surface — readiness rows swap for per-task status rows.
  const isRunning = !!check.started && !check.finished;
  const isFinished = !!check.finished;
  const titleByNum = new Map<number, string>((check.taskTitles || []).map(t => [t.num, t.title]));
  const statusNums = Object.keys(check.taskStatuses || {}).map(Number).filter(n => Number.isFinite(n));
  const runNums = [...new Set([...titleByNum.keys(), ...statusNums])].sort((a, b) => a - b);

  const _submitKey = (item: PlanCheckItem, envName: string) => {
    const field = `${item.id}:${envName}`;
    const value = (keyInputs[field] || '').trim();
    if (!value) return;
    _send(check.planId, item.id, 'submit-key', { envName, value });
    setSubmitted(prev => ({ ...prev, [field]: true }));
  };

  return (
    <div ref={rootRef} style={{
      borderRadius: 10,
      padding: '10px 12px',
      backgroundColor: COLORS.cardBg,
      border: COLORS.cardBorder,
      opacity: check.superseded || isFinished ? 0.6 : 1,
      transition: 'opacity 0.25s ease',
    }}>
      {/* Header — AP blue-dot + title pattern */}
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <div className="flex items-center gap-2">
          <div className="flex-shrink-0 w-3 h-3 rounded-full" style={{ backgroundColor: '#3b82f6' }} />
          <span style={{ color: COLORS.headerText, fontSize: '0.78rem', fontWeight: 600 }}>
            {isFinished ? `Plan run — ${check.finished!.status}` : isRunning ? 'Plan run' : 'Plan readiness'}
          </span>
        </div>
        <button
          type="button"
          title="Re-run readiness checks"
          disabled={checking || !!check.started}
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
            cursor: checking || check.started ? 'default' : 'pointer',
            opacity: checking || check.started ? 0.6 : 1,
          }}
        >
          {isFinished ? check.finished!.status : isRunning ? 'running…' : checking ? 'checking…' : check.allClear
            ? (warns.length ? `${warns.length} warning${warns.length === 1 ? '' : 's'}` : 'all clear')
            : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {compact && !check.started && !check.taskStatuses && (
        <div style={{ marginBottom: detailItems.length ? 8 : 0 }}>
          <TaskRows tasks={summarizeTasks(check.items)} compact />
        </div>
      )}

      {/* Live run rows — the card IS the run surface once started; per-task
          status patches land on taskStatuses via plan:task_progress. */}
      {(check.started || check.taskStatuses) && runNums.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: detailItems.length ? 8 : 0 }}>
          {runNums.map(num => {
            const st = check.taskStatuses?.[num]?.status;
            const g = _runStep(st);
            return (
              <div key={num} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.72rem', lineHeight: '18px' }}>
                <StepIcon status={g.step} />
                <span style={{ color: '#94a3b8', flexShrink: 0 }}>Task {num}</span>
                <span style={{ color: COLORS.bodyText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
                  — {titleByNum.get(num) || `Task ${num}`}
                </span>
                <span style={{ color: g.color, fontSize: '0.66rem', flexShrink: 0 }}>{g.text}</span>
              </div>
            );
          })}
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
              {/* Regenerate — step rows only (they carry no agentId); agent
                  rows patched to 'pending' mid-setup must not show this. */}
              {(item.kind === 'steps-failed' || item.kind === 'missing-steps') && !item.agentId && (
                <button
                  onClick={() => { setBusy(item.id); _send(check.planId, item.id, 'retry-steps'); }}
                  style={{ ..._rowBtn, flexShrink: 0, opacity: busy === item.id ? 0.6 : 1 }}
                >
                  {busy === item.id ? 'Working…' : item.kind === 'steps-failed' ? 'Retry generation' : 'Regenerate'}
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
                    <>
                      <button
                        onClick={() => { setBusy(item.id); _send(check.planId, item.id, 'cli-setup'); }}
                        style={{ ..._rowBtn, opacity: busy === item.id ? 0.6 : 1 }}
                      >
                        {busy === item.id ? 'Working…' : 'Set up'}
                      </button>
                      {/* Local-lane escape hatch — a draft that duplicates a
                          built-in lane (filesystem → shell) can be swapped
                          without installing anything. */}
                      {item.suggested && (
                        <button
                          onClick={() => { setBusy(item.id); _send(check.planId, item.id, 'use-agent'); }}
                          title={`Skip setup — rewrite the task to use ${item.suggested}`}
                          style={{ ..._rowBtnGhost, opacity: busy === item.id ? 0.6 : 1 }}
                        >
                          Use {item.suggested}
                        </button>
                      )}
                    </>
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
      {check.superseded && (
        <div style={{ color: COLORS.secondaryText, fontSize: '0.70rem', marginTop: 8 }}>
          Superseded — a different plan is active now. Open this plan to make it current again.
        </div>
      )}

      {/* Finished — terminal run summary. Live progress is the task rows
          above; this is the closing line. */}
      {isFinished && (
        <div style={{
          marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 10,
          color: check.finished!.status === 'done' ? COLORS.secondaryText : COLORS.issueText,
          fontSize: '0.72rem',
        }}>
          {check.finished!.status === 'done'
            ? 'Plan finished — all tasks complete.'
            : `Plan finished with failures${check.finished!.failedTasks?.length ? ` — task${check.finished!.failedTasks.length === 1 ? '' : 's'} ${check.finished!.failedTasks.join(', ')}` : ''}.`}
        </div>
      )}

      {/* Inspect tasks — read-only expansion: prompt + generated steps per
          task. Always available (even while issues block the run) — it
          answers "what will this plan actually do?" without starting it. */}
      {inspecting && (
        <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 8 }}>
          {inspectTasks === null && !inspectErr && (
            <div style={{ color: COLORS.mutedText, fontSize: '0.70rem' }}>Loading tasks…</div>
          )}
          {inspectErr && (
            <div style={{ color: COLORS.issueText, fontSize: '0.70rem' }}>{inspectErr}</div>
          )}
          {(inspectTasks || []).map(t => (
            <div key={t.num} style={{ marginBottom: 8 }}>
              <div style={{ color: '#94a3b8', fontSize: '0.68rem', fontWeight: 600 }}>
                Task {t.num} — {t.title || String(t.prompt || '').slice(0, 60)}
              </div>
              {t.prompt && (
                <div style={{ color: COLORS.secondaryText, fontSize: '0.66rem', marginTop: 2, lineHeight: 1.4 }}>
                  {String(t.prompt).slice(0, 220)}{String(t.prompt).length > 220 ? '…' : ''}
                </div>
              )}
              {Array.isArray(t.steps) && t.steps.length > 0 && (
                <div style={{ marginTop: 3, marginLeft: 8 }}>
                  {t.steps.map((s: any, i: number) => (
                    <div key={i} style={{ color: COLORS.mutedText, fontSize: '0.64rem', lineHeight: 1.5 }}>
                      {i + 1}. {s.description || s.skill}
                      <span style={{ color: '#4b5563' }}> ({s.skill})</span>
                    </div>
                  ))}
                </div>
              )}
              {(!Array.isArray(t.steps) || !t.steps.length) && (
                <div style={{ color: '#4b5563', fontSize: '0.64rem', marginTop: 2, marginLeft: 8, fontStyle: 'italic' }}>
                  steps still generating
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* All-clear nudge — the gate is open but nothing has started yet; make
          the required action explicit so nobody waits on a silent card. */}
      {!check.started && !check.cancelled && check.allClear && !isDrafting && (
        <div style={{ marginTop: 8, color: COLORS.secondaryText, fontSize: '0.68rem' }}>
          Ready — say "run it" or press Run all to start{check.items.some(i => i.kind === 'approval-required') ? ' · Review run pauses before each task' : ''}.
        </div>
      )}
      {isDrafting && !check.cancelled && !check.started && (
        <div style={{ marginTop: 8, color: COLORS.mutedText, fontSize: '0.68rem', fontStyle: 'italic' }}>
          Drafting — tasks and readiness appear as the plan takes shape.
        </div>
      )}

      {/* Footer — narrow overlay stacks vertically in order:
          Open Plan / Inspect Tasks / Review run / Run all / Cancel.
          Full width keeps the side-by-side row. */}
      {!check.cancelled && !check.started && !check.superseded && (
        <div
          className="flex"
          style={{
            gap: 6, marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 10,
            flexDirection: narrow ? 'column' : 'row', flexWrap: 'nowrap',
          }}
        >
          {!narrow && (
            <button
              onClick={() => _send(check.planId, undefined, 'cancel')}
              style={{ ..._btnBase, backgroundColor: COLORS.dangerBg, border: COLORS.dangerBorder, color: COLORS.dangerText }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = COLORS.dangerBg)}
            >Cancel</button>
          )}
          <button
            onClick={() => _send(check.planId, undefined, 'open-plan', { planFile: check.planFile || '' })}
            title="Open the full plan in the on-screen document view"
            style={{ ..._btnBase, backgroundColor: 'transparent', border: COLORS.ghostBorder, color: COLORS.secondaryText }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >Open plan</button>
          <button
            onClick={() => {
              if (inspecting) { setInspecting(false); return; }
              setInspecting(true);
              if (inspectTasks !== null || inspectErr) return;
              if (!check.planFile) { setInspectErr('No plan file yet — still drafting.'); return; }
              ipcRenderer?.invoke('plan:get', { planFile: check.planFile })
                .then((res: any) => {
                  if (res?.error) setInspectErr(res.error);
                  else setInspectTasks(res?.tasks || []);
                })
                .catch((e: any) => setInspectErr(e?.message || 'Failed to load tasks'));
            }}
            title="Inspect each task's prompt and generated steps (read-only)"
            style={{ ..._btnBase, backgroundColor: 'transparent', border: COLORS.ghostBorder, color: inspecting ? '#93c5fd' : COLORS.secondaryText }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >{inspecting ? 'Hide tasks' : 'Inspect tasks'}</button>
          {!narrow && <span style={{ flex: 1 }} />}
          <button
            onClick={() => { setBusy('run-review'); _send(check.planId, undefined, 'run-review'); }}
            disabled={!runnable}
            title={blockerTitle || 'Run each task in order, pausing for approval before every task'}
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
          >{busy === 'run-review' ? 'Starting…' : 'Review run'}</button>
          <button
            onClick={() => { setBusy('run-all'); _send(check.planId, undefined, 'run-all'); }}
            disabled={!runnable}
            title={blockerTitle || 'Run all tasks back-to-back — review gates are auto-approved'}
            style={{
              ..._btnBase, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontWeight: 600,
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
            {busy === 'run-all' ? 'Starting…' : 'Run all'}
          </button>
          {narrow && (
            <button
              onClick={() => _send(check.planId, undefined, 'cancel')}
              style={{ ..._btnBase, backgroundColor: COLORS.dangerBg, border: COLORS.dangerBorder, color: COLORS.dangerText }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = COLORS.dangerBg)}
            >Cancel</button>
          )}
        </div>
      )}
    </div>
  );
}

export default PlanCheckCard;
