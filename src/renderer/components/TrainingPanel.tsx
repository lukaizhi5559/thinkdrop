import React, { useState, useEffect, useRef } from 'react';
import { TrainingReviewPanel } from './TrainingReviewPanel';
import { RightSlideoutDrawer } from './RightSlideoutDrawer';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface TrainingPanelProps {
  agentId: string;
  hostname: string;
  onDone: (skillName: string) => void;
  onCancel: () => void;
  mode?: 'freeform' | 'guided';
  plan?: any[];
}

interface RecordedStep {
  id: number;
  type: 'url' | 'click' | 'fill' | 'select' | 'submit' | 'check' | 'drag' | 'scroll' | 'extract';
  target: string;
  selector?: string;
  value?: string;
  url?: string;
  pageTitle?: string;
  extractType?: 'text' | 'href' | 'value' | 'html';
  extractName?: string;
  timestamp: number;
}

// Dot-name validation: suffix only (agent prefix auto-added)
// Allows multi-segment names like editor, html.editor, try.it.editor
const SKILL_SUFFIX_RE = /^[a-z][a-z0-9_]*(\.([a-z][a-z0-9_]*))*$/;

function validateSkillSuffix(suffix: string): string | null {
  if (!suffix) return 'Skill name is required';
  if (suffix.length < 2) return 'At least 2 characters';
  if (!SKILL_SUFFIX_RE.test(suffix)) return 'Lowercase letters, numbers, underscores, dots (e.g. editor, html.editor)';
  return null;
}

// Step type icons
function StepIcon({ type }: { type: RecordedStep['type'] }) {
  const styles: React.CSSProperties = {
    width: 20, height: 20, borderRadius: 5,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '0.65rem', fontWeight: 700, flexShrink: 0,
  };

  switch (type) {
    case 'url':
      return <div style={{ ...styles, background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>URL</div>;
    case 'click':
      return <div style={{ ...styles, background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>CLK</div>;
    case 'fill':
      return <div style={{ ...styles, background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>TXT</div>;
    case 'select':
      return <div style={{ ...styles, background: 'rgba(236,72,153,0.15)', color: '#ec4899' }}>SEL</div>;
    case 'submit':
      return <div style={{ ...styles, background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>SUB</div>;
    case 'check':
      return <div style={{ ...styles, background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>☑</div>;
    case 'drag':
      return <div style={{ ...styles, background: 'rgba(168,85,247,0.15)', color: '#a855f7' }}>↔</div>;
    case 'scroll':
      return <div style={{ ...styles, background: 'rgba(14,165,233,0.15)', color: '#0ea5e9' }}>↕</div>;
    case 'extract':
      return <div style={{ ...styles, background: 'rgba(139,92,246,0.15)', color: '#8b5cf6' }}>GET</div>;
    default:
      return <div style={{ ...styles, background: 'rgba(107,114,128,0.15)', color: '#6b7280' }}>???</div>;
  }
}

export function TrainingPanel({ agentId, hostname, onDone: _onDone, onCancel, mode: _mode = 'freeform', plan: _plan = [] }: TrainingPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [steps, setSteps] = useState<RecordedStep[]>([]);
  const [skillSuffix, setSkillSuffix] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingMessage, setSavingMessage] = useState<string>('');
  const [isLaunching, setIsLaunching] = useState(true);
  const [launchingUrl, setLaunchingUrl] = useState<string>('');
  const [reviewData, setReviewData] = useState<any>(null);
  const [rejectMessage, setRejectMessage] = useState<string | null>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  const cleanAgentId = agentId.replace(/\.agent$/, '');
  const fullSkillName = `${cleanAgentId}.${skillSuffix}.skill`;

  // Trigger slide-in on mount
  useEffect(() => {
    setIsOpen(true);
  }, []);

  // Listen for training progress events
  useEffect(() => {
    if (!ipcRenderer) return;

    const handleStep = (data: any) => {
      console.log('[TrainingPanel] agents:train-progress received:', {
        type: data?.type,
        dataAgentId: data?.agentId,
        panelAgentId: agentId,
        matches: !!data && data.agentId?.toLowerCase() === agentId.toLowerCase(),
      });
      if (!data || data.agentId?.toLowerCase() !== agentId.toLowerCase()) return;

      if (data.type === 'training:start') {
        setIsLaunching(true);
        setLaunchingUrl(data.startUrl || '');
        return;
      }

      if (data.type === 'training:step-recorded') {
        setIsLaunching(false);
        setSteps(prev => [...prev, {
          id: Date.now(),
          type: data.stepType || 'click',
          target: data.target || '',
          selector: data.selector,
          value: data.value,
          url: data.url,
          pageTitle: data.pageTitle,
          timestamp: data.timestamp || Date.now(),
        }]);
        return;
      }

      if (data.type === 'training:saving') {
        setSaving(true);
        setSavingMessage(data.message || 'Building waypoint recipe…');
        return;
      }

      if (data.type === 'training:saved') {
        setSaving(false);
        setSavingMessage('');
        onCancel();
        return;
      }

      if (data.type === 'training:error') {
        setSaving(false);
        setSavingMessage('');
      }

      if (data.type === 'training:cancelled') {
        setSaving(false);
        setSavingMessage('');
      }
    };

    ipcRenderer.on('agents:train-progress', handleStep);
    return () => { ipcRenderer.removeListener('agents:train-progress', handleStep); };
  }, [agentId]);

  // Listen for review preview/saved/error events
  useEffect(() => {
    if (!ipcRenderer) return;

    const handlePreviewResult = (data: any) => {
      console.log('[TrainingPanel] agents:train-preview-result received:', data);
      if (!data || data.agentId !== agentId) return;
      setSaving(false);
      setSavingMessage('');
      setReviewData(data.preview);
    };

    const handleReviewSaved = (data: any) => {
      console.log('[TrainingPanel] agents:train-review-saved received:', data);
      if (!data || data.agentId !== agentId) return;
      setSaving(false);
      setSavingMessage('');
      setReviewData(null);
      onCancel();
    };

    const handleReviewError = (data: any) => {
      console.log('[TrainingPanel] agents:train-review-error received:', data);
      if (!data || data.agentId !== agentId) return;
      setSaving(false);
      setSavingMessage('');
      if (data.rejected) {
        setRejectMessage(data.error || 'The LLM could not understand the recorded actions. Try recording again with clearer steps.');
      } else {
        setValidationError(data.error || 'Save failed');
      }
    };

    ipcRenderer.on('agents:train-preview-result', handlePreviewResult);
    ipcRenderer.on('agents:train-review-saved', handleReviewSaved);
    ipcRenderer.on('agents:train-review-error', handleReviewError);
    return () => {
      ipcRenderer.removeListener('agents:train-preview-result', handlePreviewResult);
      ipcRenderer.removeListener('agents:train-review-saved', handleReviewSaved);
      ipcRenderer.removeListener('agents:train-review-error', handleReviewError);
    };
  }, [agentId]);

  // Escape key to cancel — works even during saving
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !reviewData) {
        handleCancel();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [reviewData]);

  // Auto-scroll to bottom when new steps arrive
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps]);

  const handleCancel = () => {
    setSaving(false);
    setSavingMessage('');
    onCancel();
  };

  const handleSave = () => {
    const err = validateSkillSuffix(skillSuffix);
    if (err) { setValidationError(err); return; }
    setSaving(true);
    setSavingMessage('Analyzing recorded steps…');
    setRejectMessage(null);
    setValidationError(null);
    // Send preview request — LLM organizes raw events into skill(s) with params
    const skillName = `${cleanAgentId}.${skillSuffix}.skill`;
    console.log('[TrainingPanel] sending agents:train-preview', { agentId, skillName });
    try {
      ipcRenderer?.send('agents:train-preview', { agentId, skillName });
    } catch (err) {
      console.error('[TrainingPanel] send failed:', err);
      setSaving(false);
      setValidationError('Failed to start save. Please restart the app.');
    }
  };

  const handleReset = () => {
    setSteps([]);
    setIsLaunching(false);
    setRejectMessage(null);
    setValidationError(null);
  };

  const handleSuffixChange = (val: string) => {
    const cleaned = val.toLowerCase().replace(/[^a-z0-9_.]/g, '');
    setSkillSuffix(cleaned);
    setValidationError(validateSkillSuffix(cleaned));
  };

  return (
    <>
      <RightSlideoutDrawer
        isOpen={isOpen}
        onClose={handleCancel}
        width={420}
        title={
          <span className="flex items-center gap-2">
            <span
              className="inline-block"
              style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#ef4444', animation: 'pulse 1.5s infinite' }}
            />
            <span>Training: {cleanAgentId}</span>
          </span>
        }
        subtitle={hostname}
      >
        {/* Instruction banner */}
        <div
          className="mx-4 mt-4 p-3 rounded-lg text-xs leading-relaxed break-words"
          style={{
            background: 'rgba(99, 102, 241, 0.08)',
            border: '1px solid rgba(99, 102, 241, 0.2)',
            color: '#a5b4fc',
          }}
        >
          Navigate through the site and perform the action you want to train. Each click, fill, and page change is recorded below. When done, click <strong>Save Skill</strong> — the LLM will organize your interactions into a reusable skill with parameters.
        </div>

        {/* Reject message — shown when LLM can not understand the flow */}
        {rejectMessage && !saving && (
          <div
            className="mx-4 mt-3 p-3 rounded-lg text-xs leading-relaxed break-words"
            style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#fca5a5',
            }}
          >
            <strong>Could not understand the training:</strong> {rejectMessage}
            <div className="mt-2">
              <button
                onClick={handleReset}
                className="text-[11px] text-red-300 underline"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {/* Saving overlay — replaces content while LLM builds recipe */}
        {saving && (
          <div
            className="flex-1 flex flex-col items-center justify-center text-center"
            style={{ padding: '40px 24px' }}
          >
            <div
              style={{
                width: 56, height: 56, borderRadius: '50%',
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#d1fae5', marginBottom: 6 }}>
              Saving Skill…
            </div>
            <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: 24, maxWidth: 260 }}>
              {savingMessage || 'Building waypoint recipe…'}
            </div>
            <div style={{ width: '80%', maxWidth: 240, height: 3, borderRadius: 99, background: 'rgba(16,185,129,0.12)', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                background: 'linear-gradient(90deg, transparent 0%, #10b981 40%, #34d399 60%, transparent 100%)',
                backgroundSize: '200% 100%',
                animation: 'trainShimmer 1.6s ease-in-out infinite',
              }}/>
            </div>
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span style={{ fontSize: '0.7rem', color: '#6b7280', fontStyle: 'italic' }}>LLM cleaning &amp; structuring waypoints…</span>
            </div>
            {/* Cancel button on saving overlay */}
            <button
              onClick={handleCancel}
              className="mt-6 px-4 py-2 rounded-lg text-xs text-gray-400 transition-opacity"
              style={{
                border: '1px solid rgba(255, 255, 255, 0.1)',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Recorded steps — scrollable area */}
        <div
          className="flex-1 overflow-y-auto mx-4 mt-4 pr-1"
          style={{ minHeight: 0, display: saving ? 'none' : undefined }}
        >
          {steps.length === 0 ? (
            isLaunching ? (
              /* Launch preloader — shown while browser is opening */
              <div className="flex flex-col items-center justify-center h-full text-center" style={{ padding: '32px 16px' }}>
                <div
                  style={{
                    width: 52, height: 52, borderRadius: '50%',
                    background: 'rgba(99,102,241,0.12)',
                    border: '1px solid rgba(99,102,241,0.3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginBottom: 14,
                    animation: 'pulse 2s ease-in-out infinite',
                  }}
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="2" y1="12" x2="22" y2="12"/>
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                  </svg>
                </div>
                <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#c7d2fe', marginBottom: 5 }}>
                  Opening browser…
                </div>
                <div style={{ fontSize: '0.72rem', color: '#6b7280', marginBottom: 20, fontFamily: 'ui-monospace, monospace', maxWidth: 260, wordBreak: 'break-all' }}>
                  {launchingUrl || `https://${hostname}`}
                </div>
                <div style={{ width: '80%', maxWidth: 240, height: 3, borderRadius: 99, background: 'rgba(99,102,241,0.12)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    background: 'linear-gradient(90deg, transparent 0%, #818cf8 40%, #a5b4fc 60%, transparent 100%)',
                    backgroundSize: '200% 100%',
                    animation: 'trainShimmer 1.6s ease-in-out infinite',
                  }}/>
                </div>
                <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                  <span style={{ fontSize: '0.7rem', color: '#6b7280', fontStyle: 'italic' }}>Launching browser &amp; injecting recorder…</span>
                </div>
              </div>
            ) : (
              /* Default empty state after reset */
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center mb-3"
                  style={{ background: 'rgba(255,255,255,0.05)' }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                </div>
                <span className="text-xs text-gray-500 italic">Waiting for interactions…</span>
              </div>
            )
          ) : (
            <div className="flex flex-col gap-1">
              {steps.map((step, idx) => {
                const isLast = idx === steps.length - 1;
                return (
                  <div
                    key={step.id}
                    className="flex items-start gap-3 px-3 py-2 rounded-lg"
                    style={{
                      background: isLast ? 'rgba(245, 158, 11, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                      border: isLast ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid transparent',
                    }}
                  >
                    {isLast ? (
                      <div
                        className="flex items-center justify-center"
                        style={{
                          width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                          background: 'rgba(245, 158, 11, 0.2)', color: '#f59e0b',
                          fontSize: '0.7rem',
                        }}
                      >★</div>
                    ) : (
                      <StepIcon type={step.type} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div
                        className="text-xs truncate"
                        style={{ color: isLast ? '#fbbf24' : '#d1d5db' }}
                      >
                        {step.target}
                      </div>
                      {step.url && (
                        <div className="text-[10px] text-gray-500 truncate font-mono mt-0.5">
                          {step.url}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={stepsEndRef} />
              {/* Recording active indicator */}
              <div
                className="flex items-center gap-2 px-3 py-2 mt-1"
                style={{ opacity: 0.7 }}
              >
                <div
                  style={{
                    width: 6, height: 6, borderRadius: '50%',
                    backgroundColor: '#ef4444',
                    animation: 'pulse 1.5s infinite',
                  }}
                />
                <span className="text-[10px] text-gray-500 italic">Recording — interact with the browser…</span>
              </div>
            </div>
          )}
        </div>

        {/* Bottom section — fixed at bottom */}
        <div
          className="px-4 pb-4 pt-3 flex flex-col gap-3"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', display: saving ? 'none' : undefined }}
        >
          {/* Target explanation */}
          {steps.length > 0 && (
            <div
              className="p-3 rounded-lg text-xs leading-relaxed break-words"
              style={{
                background: 'rgba(245, 158, 11, 0.06)',
                border: '1px solid rgba(245, 158, 11, 0.15)',
                color: '#d97706',
              }}
            >
              <strong>★ TARGET</strong> — The AI will navigate here automatically.<br/>
              <span style={{ color: '#92400e' }}>
                Example: &quot;Use {fullSkillName || `${cleanAgentId}.&lt;name&gt;`} to build a superhero website&quot;
              </span>
            </div>
          )}

          {/* Skill Name Input */}
          <div>
            <label className="text-[11px] text-gray-500 block mb-1">Trained Skill Name</label>
            <div className="flex items-center min-w-0">
              <span
                className="px-2 py-2 rounded-l-md text-xs text-gray-500 font-mono flex-shrink-0"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRight: 'none',
                }}
              >
                {cleanAgentId}.
              </span>
              <input
                type="text"
                value={skillSuffix}
                onChange={e => handleSuffixChange(e.target.value)}
                placeholder="create.playlist"
                className="flex-1 min-w-0 px-2 py-2 rounded-r-md text-xs font-mono text-white outline-none"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: validationError
                    ? '1px solid rgba(239, 68, 68, 0.5)'
                    : '1px solid rgba(255, 255, 255, 0.15)',
                }}
              />
              <span
                className="px-2 py-2 rounded-r-md text-xs text-gray-500 font-mono flex-shrink-0"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderLeft: 'none',
                }}
              >
                .skill
              </span>
            </div>
            {validationError && (
              <div className="text-[10px] text-red-400 mt-1">{validationError}</div>
            )}
            {skillSuffix && !validationError && (
              <div className="text-[10px] text-emerald-400 mt-1">
                Will be saved as: <strong>{fullSkillName}</strong>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || steps.length === 0 || !!validationError || !skillSuffix}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity"
              style={{
                background: saving || steps.length === 0 || !!validationError || !skillSuffix
                  ? 'rgba(16, 185, 129, 0.15)'
                  : '#10b981',
                opacity: saving || steps.length === 0 || !!validationError || !skillSuffix ? 0.4 : 1,
                cursor: saving || steps.length === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save Skill'}
            </button>
            <button
              onClick={handleReset}
              disabled={steps.length === 0}
              className="px-4 py-2.5 rounded-lg text-sm text-gray-400 transition-opacity"
              style={{
                border: '1px solid rgba(255, 255, 255, 0.1)',
                background: 'transparent',
                opacity: steps.length === 0 ? 0.4 : 1,
                cursor: steps.length === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </RightSlideoutDrawer>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes trainShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Review Panel — shown when preview data arrives (LLM-organized skills) */}
      {reviewData && (
        <TrainingReviewPanel
          agentId={agentId}
          previewData={reviewData}
          onSave={(adjustedData) => {
            setSaving(true);
            setSavingMessage('Saving skills…');
            ipcRenderer?.send('agents:train-review-save', {
              agentId,
              skills: adjustedData.skills,
              recipe: adjustedData.recipe,
            });
          }}
          onCancel={() => {
            ipcRenderer?.send('agents:train-review-cancel', { agentId });
            setReviewData(null);
          }}
        />
      )}
    </>
  );
}
