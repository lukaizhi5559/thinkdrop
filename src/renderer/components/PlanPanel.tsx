/**
 * PlanPanel — Displays a generated plan.md for user approval before execution.
 *
 * Shows:
 *   1. Streaming plan markdown as the LLM generates it (plan:chunk events)
 *   2. Full plan rendered in markdown once generation is complete (plan:generated)
 *   3. Raw-edit toggle — user can edit the plan.md directly in a textarea
 *   4. Approve / Cancel / Open-in-editor buttons
 *   5. Step-by-step execution progress (plan:step_start, plan:step_done, etc.)
 *   6. Existing plan reuse suggestion (plan:found_existing)
 *
 * IPC events consumed (all arrive as 'automation:progress'):
 *   plan:chunk         — { token: string }            — streaming token
 *   plan:generated     — { planFile, planContent, title } — generation done
 *   plan:found_existing — { planFile, planContent, similarity } — reuse suggestion
 *   plan:step_start    — { stepIndex, title }          — step beginning
 *   plan:step_done     — { stepIndex, title }          — step done
 *   plan:step_failed   — { stepIndex, title, error }   — step failed
 *   plan:complete      — {}                            — all steps done
 *
 * IPC events emitted:
 *   plan:approve       — { planFile }
 *   plan:cancel        — { planFile }
 *   plan:open-editor   — { planFile }
 *   plan:rescan        — { planFile }
 */

import React, { useEffect, useRef, useState } from 'react';
import { RichContentRenderer } from './rich-content';

const ipcRenderer = (window as any).electron?.ipcRenderer;

// ── Types ─────────────────────────────────────────────────────────────────────

type PlanPhase =
  | 'streaming'    // LLM still generating
  | 'review'       // generation done, awaiting user approval
  | 'executing'    // user approved, steps running
  | 'complete'     // all steps done
  | 'failed'       // a step failed
  | 'idle';        // default / not active

interface StepProgress {
  index: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
}

interface PlanPanelProps {
  onComplete?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PlanPanel({ onComplete }: PlanPanelProps) {
  const [phase, setPhase] = useState<PlanPhase>('idle');
  const [planFile, setPlanFile] = useState<string | null>(null);
  const [planContent, setPlanContent] = useState<string>('');
  const [planTitle, setPlanTitle] = useState<string>('');
  const [streamBuffer, setStreamBuffer] = useState<string>('');
  const [showRawEdit, setShowRawEdit] = useState(false);
  const [editedContent, setEditedContent] = useState<string>('');
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [existingSuggestion, setExistingSuggestion] = useState<{
    planFile: string;
    planContent: string;
    similarity: number;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const streamEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll while streaming
  useEffect(() => {
    if (phase === 'streaming') {
      streamEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [streamBuffer, phase]);

  // Listen to automation:progress events relevant to plan
  useEffect(() => {
    if (!ipcRenderer) return;

    const handleProgress = (_event: any, data: any) => {
      if (!data?.type?.startsWith('plan:')) return;
      console.log('[PlanPanel:DEBUG] automation:progress received — type:', data.type);

      switch (data.type) {
        case 'plan:chunk': {
          setPhase('streaming');
          setStreamBuffer(prev => prev + (data.token || ''));
          break;
        }

        case 'plan:generated': {
          setPlanFile(data.planFile || null);
          setPlanContent(data.content || data.planContent || '');
          setPlanTitle(data.title || 'Execution Plan');
          setEditedContent(data.content || data.planContent || '');
          setStreamBuffer('');
          setPhase('review');
          // Parse step titles from plan for progress display later
          const stepTitles = parseStepTitles(data.content || data.planContent || '');
          setSteps(stepTitles.map((title, i) => ({ index: i, title, status: 'pending' })));
          break;
        }

        case 'plan:found_existing': {
          const existingContent = data.content || data.planContent || '';
          // Populate plan state and switch to review phase so the panel becomes visible.
          // The existingSuggestion banner at the top lets the user reuse or force a new plan.
          setPlanFile(data.planFile || null);
          setPlanContent(existingContent);
          setEditedContent(existingContent);
          setPlanTitle(data.title || 'Existing Plan');
          setStreamBuffer('');
          setPhase('review');
          const existingStepTitles = parseStepTitles(existingContent);
          setSteps(existingStepTitles.map((title, i) => ({ index: i, title, status: 'pending' })));
          setExistingSuggestion({
            planFile: data.planFile,
            planContent: existingContent,
            similarity: data.similarity ?? 1,
          });
          break;
        }

        case 'plan:step_start': {
          console.log('[PlanPanel:DEBUG] plan:step_start received — data:', JSON.stringify(data));
          setPhase('executing');
          // planExecutor uses stepNum (1-based) + totalSteps; PlanPanel uses 0-based index.
          // Normalise: prefer stepNum/totalSteps, fall back to legacy stepIndex.
          const stepNum = data.stepNum ?? (data.stepIndex != null ? data.stepIndex + 1 : 1);
          const totalSteps = data.totalSteps ?? 1;
          const stepIdx = stepNum - 1; // convert to 0-based
          console.log('[PlanPanel:DEBUG] plan:step_start — stepNum:', stepNum, 'totalSteps:', totalSteps, 'stepIdx:', stepIdx);
          setSteps(prev => {
            console.log('[PlanPanel:DEBUG] setSteps prev:', JSON.stringify(prev));
            // If steps array is empty or smaller than totalSteps, initialise it first
            const base: StepProgress[] = prev.length >= totalSteps
              ? prev
              : Array.from({ length: totalSteps }, (_, i) =>
                  prev[i] ?? { index: i, title: `Step ${i + 1}`, status: 'pending' as const }
                );
            return base.map(s =>
              s.index === stepIdx ? { ...s, title: data.title || s.title, status: 'running' } : s
            );
          });
          break;
        }

        case 'plan:step_done': {
          const doneSN = data.stepNum ?? (data.stepIndex != null ? data.stepIndex + 1 : null);
          const doneIdx = doneSN != null ? doneSN - 1 : data.stepIndex;
          setSteps(prev =>
            prev.map(s =>
              s.index === doneIdx ? { ...s, status: 'done' } : s
            )
          );
          break;
        }

        case 'plan:step_failed': {
          const failSN = data.stepNum ?? (data.stepIndex != null ? data.stepIndex + 1 : null);
          const failIdx = failSN != null ? failSN - 1 : data.stepIndex;
          setSteps(prev =>
            prev.map(s =>
              s.index === failIdx ? { ...s, status: 'failed', error: data.error } : s
            )
          );
          setPhase('failed');
          break;
        }

        case 'plan:complete': {
          setPhase('complete');
          onComplete?.();
          break;
        }
      }
    };

    ipcRenderer.on('automation:progress', handleProgress);
    return () => ipcRenderer.removeListener('automation:progress', handleProgress);
  }, [onComplete]);

  // Reset when a new prompt starts (prompt text set means fresh run)
  useEffect(() => {
    if (!ipcRenderer) return;
    const handleNewPrompt = (_evt: any, text?: string) => {
      // Don't reset when a plan is being approved and re-run — the plan:step_start
      // events will update PlanPanel directly. Resetting here would flash to blank.
      if (typeof text === 'string' && text.startsWith('[plan_execute:')) return;
      setPhase('idle');
      setStreamBuffer('');
      setPlanContent('');
      setPlanFile(null);
      setPlanTitle('');
      setEditedContent('');
      setSteps([]);
      setExistingSuggestion(null);
      setShowRawEdit(false);
    };
    ipcRenderer.on('results-window:set-prompt', handleNewPrompt);
    return () => ipcRenderer.removeListener('results-window:set-prompt', handleNewPrompt);
  }, []);

  if (phase === 'idle') return null;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const handleApprove = () => {
    if (!planFile) return;
    const contentToApprove = showRawEdit ? editedContent : planContent;
    // If user edited, save and rescan first
    if (showRawEdit && editedContent !== planContent) {
      setIsSaving(true);
      ipcRenderer?.send('plan:rescan', { planFile, content: editedContent });
      // After rescan comes back (or timeout), approve
      setTimeout(() => {
        ipcRenderer?.send('plan:approve', { planFile, content: contentToApprove });
        setIsSaving(false);
        setShowRawEdit(false);
      }, 800);
    } else {
      ipcRenderer?.send('plan:approve', { planFile });
    }
    setPhase('executing');
  };

  const handleCancel = () => {
    ipcRenderer?.send('plan:cancel', { planFile });
    setPhase('idle');
    setStreamBuffer('');
    setPlanContent('');
    setPlanFile(null);
  };

  const handleOpenEditor = () => {
    ipcRenderer?.send('plan:open-editor', { planFile });
  };

  const handleUseExisting = () => {
    if (!existingSuggestion) return;
    setPlanFile(existingSuggestion.planFile);
    setPlanContent(existingSuggestion.planContent);
    setEditedContent(existingSuggestion.planContent);
    setPlanTitle('Existing Plan');
    const stepTitles = parseStepTitles(existingSuggestion.planContent);
    setSteps(stepTitles.map((title, i) => ({ index: i, title, status: 'pending' })));
    setExistingSuggestion(null);
    setPhase('review');
  };

  const renderPlanModeBanner = () => (
    <div style={planModeBannerStyle}>
      <div className="flex items-center gap-2 flex-wrap">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 9v4"/>
          <path d="M12 17h.01"/>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        </svg>
        <span style={{ color: '#fcd34d', fontSize: '0.72rem', fontWeight: 600 }}>
          You are in Plan Mode - type in chat to update or correct this plan.
        </span>
        <button
          onClick={handleCancel}
          style={planModeExitBtnStyle}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(251,191,36,0.2)')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(251,191,36,0.1)')}
        >
          Exit Plan Mode
        </button>
      </div>
    </div>
  );

  // ── Streaming view ────────────────────────────────────────────────────────────

  if (phase === 'streaming') {
    return (
      <div style={wrapStyle}>
        <div style={headerStyle}>
          <div className="flex items-center gap-2">
            <div style={dotStyle('#3b82f6', true)} />
            <span style={labelStyle}>Generating plan...</span>
          </div>
        </div>
        <div style={{ padding: '0 14px', marginTop: 10 }}>
          {renderPlanModeBanner()}
        </div>
        <div style={{ padding: '10px 14px', maxHeight: 280, overflowY: 'auto', fontFamily: 'ui-monospace,monospace', fontSize: '0.72rem', color: '#d1d5db', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {streamBuffer}
          <span style={{ display: 'inline-block', width: 6, height: 12, backgroundColor: '#3b82f6', marginLeft: 2, verticalAlign: 'middle', animation: 'pulse 1s ease-in-out infinite' }} />
        </div>
        <div ref={streamEndRef} />
      </div>
    );
  }

  // ── Existing plan suggestion ───────────────────────────────────────────────────

  const renderExistingSuggestion = () => {
    if (!existingSuggestion || phase !== 'review') return null;
    const pct = Math.round(existingSuggestion.similarity * 100);
    return (
      <div style={{ margin: '0 0 10px', padding: '8px 12px', borderRadius: 8, backgroundColor: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span style={{ color: '#c4b5fd', fontSize: '0.73rem', fontWeight: 600 }}>
            Similar plan found ({pct}% match)
          </span>
          <button
            onClick={handleUseExisting}
            style={smallBtnStyle('#a78bfa', 'rgba(139,92,246,0.2)', 'rgba(139,92,246,0.35)')}
          >
            Reuse it
          </button>
          <button
            onClick={() => {
              setExistingSuggestion(null);
              ipcRenderer?.send('plan:new', { planFile });
              setPhase('idle');
            }}
            style={smallBtnStyle('#6b7280', 'transparent', 'rgba(255,255,255,0.1)')}
          >
            New plan
          </button>
        </div>
      </div>
    );
  };

  // ── Review view ───────────────────────────────────────────────────────────────

  if (phase === 'review') {
    return (
      <div style={wrapStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div className="flex items-center gap-2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            <span style={labelStyle}>{planTitle || 'Execution Plan'}</span>
          </div>
          <div className="flex items-center gap-2">
            {planFile && (
              <button
                onClick={handleOpenEditor}
                style={{ ...smallBtnStyle('#9ca3af', 'transparent', 'rgba(255,255,255,0.1)'), display: 'flex', alignItems: 'center', gap: 4 }}
                title="Open plan.md in default editor"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                Open
              </button>
            )}
            <button
              onClick={() => setShowRawEdit(v => !v)}
              style={{ ...smallBtnStyle(showRawEdit ? '#fbbf24' : '#9ca3af', showRawEdit ? 'rgba(251,191,36,0.1)' : 'transparent', showRawEdit ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.1)') }}
            >
              {showRawEdit ? 'Preview' : 'Edit'}
            </button>
          </div>
        </div>

        {/* Plan mode banner */}
        <div style={{ padding: '0 14px', marginTop: 10 }}>
          {renderPlanModeBanner()}
        </div>

        {/* Existing suggestion banner */}
        <div style={{ padding: '0 14px' }}>
          {renderExistingSuggestion()}
        </div>

        {/* Plan body */}
        <div style={{ padding: '10px 14px', maxHeight: 340, overflowY: 'auto' }}>
          {showRawEdit ? (
            <textarea
              value={editedContent}
              onChange={e => setEditedContent(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%',
                minHeight: 220,
                resize: 'vertical',
                backgroundColor: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6,
                color: '#d1d5db',
                fontFamily: 'ui-monospace,monospace',
                fontSize: '0.7rem',
                lineHeight: 1.65,
                padding: '8px 10px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          ) : (
            <RichContentRenderer
              content={planContent}
              animated={false}
              className="text-sm"
            />
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-2" style={{ padding: '8px 14px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <button
            onClick={handleApprove}
            disabled={isSaving}
            style={{
              padding: '5px 16px',
              borderRadius: 6,
              backgroundColor: 'rgba(34,197,94,0.18)',
              border: '1px solid rgba(34,197,94,0.4)',
              color: '#4ade80',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: isSaving ? 'not-allowed' : 'pointer',
              opacity: isSaving ? 0.6 : 1,
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => !isSaving && (e.currentTarget.style.backgroundColor = 'rgba(34,197,94,0.3)')}
            onMouseLeave={e => !isSaving && (e.currentTarget.style.backgroundColor = 'rgba(34,197,94,0.18)')}
          >
            {isSaving ? 'Scanning...' : '▶ Approve & Run'}
          </button>
          <button
            onClick={handleCancel}
            style={cancelBtnStyle}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.18)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.1)')}
          >
            Cancel
          </button>
          {planFile && (
            <span style={{ marginLeft: 'auto', color: '#4b5563', fontSize: '0.65rem', fontFamily: 'ui-monospace,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }} title={planFile}>
              {planFile.split('/').pop()}
            </span>
          )}
        </div>
      </div>
    );
  }

  // ── Execution progress view ───────────────────────────────────────────────────

  if (phase === 'executing' || phase === 'complete' || phase === 'failed') {
    const doneCount = steps.filter(s => s.status === 'done').length;
    const totalCount = steps.length;
    const isDone = phase === 'complete';
    const isFailed = phase === 'failed';

    return (
      <div style={wrapStyle}>
        <div style={headerStyle}>
          <div className="flex items-center gap-2">
            {isDone ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            ) : isFailed ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            ) : (
              <div style={dotStyle('#3b82f6', true)} />
            )}
            <span style={labelStyle}>
              {isDone ? `Plan complete (${totalCount} steps)` : isFailed ? 'Plan failed' : `Executing plan… ${doneCount}/${totalCount}`}
            </span>
          </div>
        </div>

        <div style={{ padding: '8px 14px', maxHeight: 300, overflowY: 'auto' }}>
          {steps.map((step) => (
            <div key={step.index} className="flex items-start gap-2" style={{ marginBottom: 6 }}>
              <span style={{ flexShrink: 0, marginTop: 1 }}>
                {step.status === 'done' && <span style={{ color: '#4ade80', fontSize: '0.8rem' }}>✓</span>}
                {step.status === 'running' && <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: '#3b82f6', animation: 'pulse 1s ease-in-out infinite', marginTop: 3 }} />}
                {step.status === 'failed' && <span style={{ color: '#f87171', fontSize: '0.8rem' }}>✗</span>}
                {step.status === 'pending' && <span style={{ color: '#4b5563', fontSize: '0.8rem' }}>○</span>}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: '0.73rem', color: step.status === 'pending' ? '#6b7280' : step.status === 'failed' ? '#fca5a5' : '#d1d5db', lineHeight: 1.4 }}>
                  {step.title}
                </span>
                {step.error && (
                  <div style={{ marginTop: 3, fontSize: '0.67rem', color: '#f87171', fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {step.error}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {(isDone || isFailed) && (
          <div className="flex gap-2" style={{ padding: '8px 14px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            {isFailed && (
              <button
                onClick={handleApprove}
                style={{ padding: '4px 12px', borderRadius: 6, backgroundColor: 'rgba(251,146,60,0.15)', border: '1px solid rgba(251,146,60,0.35)', color: '#fdba74', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}
              >
                Retry from failed step
              </button>
            )}
            <button
              onClick={handleCancel}
              style={{ ...cancelBtnStyle, marginLeft: isFailed ? 0 : 'auto' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.1)')}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    );
  }

  return null;
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const wrapStyle: React.CSSProperties = {
  margin: '0 0 10px',
  borderRadius: 10,
  backgroundColor: 'rgba(15,15,15,0.92)',
  border: '1px solid rgba(59,130,246,0.22)',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 12px',
  borderBottom: '1px solid rgba(255,255,255,0.07)',
  backgroundColor: 'rgba(59,130,246,0.07)',
};

const labelStyle: React.CSSProperties = {
  color: '#93c5fd',
  fontSize: '0.75rem',
  fontWeight: 600,
};

const dotStyle = (color: string, animate: boolean): React.CSSProperties => ({
  width: 7,
  height: 7,
  borderRadius: '50%',
  backgroundColor: color,
  flexShrink: 0,
  animation: animate ? 'pulse 1.5s ease-in-out infinite' : 'none',
});

const smallBtnStyle = (color: string, bg: string, border: string): React.CSSProperties => ({
  padding: '2px 8px',
  borderRadius: 5,
  backgroundColor: bg,
  border: `1px solid ${border}`,
  color,
  fontSize: '0.68rem',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'all 0.15s',
});

const cancelBtnStyle: React.CSSProperties = {
  padding: '5px 14px',
  borderRadius: 6,
  backgroundColor: 'rgba(239,68,68,0.1)',
  border: '1px solid rgba(239,68,68,0.25)',
  color: '#f87171',
  fontSize: '0.75rem',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'all 0.15s',
};

const planModeBannerStyle: React.CSSProperties = {
  margin: '0 0 10px',
  padding: '8px 12px',
  borderRadius: 8,
  backgroundColor: 'rgba(251,191,36,0.08)',
  border: '1px solid rgba(251,191,36,0.28)',
};

const planModeExitBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  padding: '2px 8px',
  borderRadius: 5,
  backgroundColor: 'rgba(251,191,36,0.1)',
  border: '1px solid rgba(251,191,36,0.35)',
  color: '#fcd34d',
  fontSize: '0.68rem',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'all 0.15s',
};

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Parse step titles from a plan.md file.
 * Looks for lines like: ## Step N: title  (with optional status emoji prefix)
 */
function parseStepTitles(content: string): string[] {
  const titles: string[] = [];
  const lines = content.split('\n');
  // Match: ## Step 1: ...  OR  ### Step 1 — ...  OR  ## ⬜ Step 1: ...
  const stepRegex = /^#{2,3}\s+(?:[⬜🔄✅❌⏭]\s+)?Step\s+\d+[:\s\u2014\u2013-]+(.+)/iu;
  for (const line of lines) {
    const m = line.match(stepRegex);
    if (m) titles.push(m[1].trim());
  }
  return titles;
}
