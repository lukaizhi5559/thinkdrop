/**
 * AutomationProgress — Windsurf-style live automation progress display.
 *
 * Shows:
 *   1. "Generating plan..." spinner while planSkills runs
 *   2. Step list (N / total done) as executeCommand fires step events
 *   3. Stdout output inline under each completed step
 *   4. Final summary on completion or error banner on failure
 */

import { useEffect, useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

// ── Types ─────────────────────────────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'done' | 'failed';

interface Step {
  index: number;
  skill: string;
  description: string;
  status: StepStatus;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number;
  savedFilePath?: string;
}

type AutomationPhase =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'done'
  | 'failed'
  | 'ask_user'
  | 'guide_step'
  | 'schedule_wait';

interface AskUserPrompt {
  question: string;
  options: string[];
}

interface GuideStepCard {
  instruction: string;
  url: string | null;
  highlight: string | null;
  imageUrl: string | null;
  description: string;
  mode: 'page_event' | 'ipc';
}

interface AutomationProgressProps {
  onHeightChange?: () => void;
  onActiveChange?: (active: boolean) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done') {
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
        style={{ backgroundColor: '#22c55e' }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
    );
  }
  if (status === 'running') {
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full border-2 animate-spin"
        style={{ borderColor: '#3b82f6', borderTopColor: 'transparent' }} />
    );
  }
  if (status === 'failed') {
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
        style={{ backgroundColor: '#ef4444' }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </div>
    );
  }
  // pending
  return (
    <div className="flex-shrink-0 w-4 h-4 rounded-full"
      style={{ backgroundColor: 'rgba(156,163,175,0.25)', border: '1px solid rgba(156,163,175,0.4)' }} />
  );
}

function humanizeError(error: string): string {
  if (!error) return error;
  // Strip [MCPClient] prefix and URL noise
  let msg = error
    .replace(/\[MCPClient\]\s*/g, '')
    .replace(/Request timeout after \d+ms:\s*https?:\/\/[^\s]+/g, 'Request timed out')
    .replace(/https?:\/\/\S+/g, '')
    .trim();
  // Map common internal errors to human-readable messages
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return 'Step timed out — retrying with more time...';
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('connection refused')) {
    return 'Could not reach the service — is it running?';
  }
  if (msg.includes('permission denied') || msg.includes('EACCES')) {
    return 'Permission denied';
  }
  if (msg.includes('command not found') || msg.includes('ENOENT')) {
    return `Command not found: ${msg.match(/"([^"]+)"/)?.[1] || 'unknown'}`;
  }
  // Search returned no results — recoverSkill will REPLAN automatically
  if (msg.includes('search_no_results')) {
    return 'No results found — trying a different approach...';
  }
  // Plan parse failure
  if (msg.includes('Failed to parse skill plan') || msg.includes('unable to generate a response') || msg.includes('Could not generate a skill plan')) {
    return 'Could not generate a plan for this request. Try rephrasing it.';
  }
  // Truncate anything still too long
  return msg.length > 100 ? msg.slice(0, 100) + '…' : msg;
}

function SkillBadge({ skill }: { skill: string }) {
  return (
    <span className="text-xs font-mono px-1.5 py-0.5 rounded"
      style={{ backgroundColor: 'rgba(59,130,246,0.15)', color: '#93c5fd', border: '1px solid rgba(59,130,246,0.25)' }}>
      {skill}
    </span>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AutomationProgress({ onHeightChange, onActiveChange }: AutomationProgressProps) {
  const [phase, setPhase] = useState<AutomationPhase>('idle');
  const [steps, setSteps] = useState<Step[]>([]);
  const [planMessage, setPlanMessage] = useState('Generating skill plan...');
  const [totalCount, setTotalCount] = useState(0);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  const [synthesisAnswer, setSynthesisAnswer] = useState<string>('');
  const [savedFilePaths, setSavedFilePaths] = useState<string[]>([]);
  const [askUserPrompt, setAskUserPrompt] = useState<AskUserPrompt | null>(null);
  const [guideStep, setGuideStep] = useState<GuideStepCard | null>(null);
  const [intentType, setIntentType] = useState<string | null>(null);
  const [scheduleCountdown, setScheduleCountdown] = useState<{ label: string; targetTime: string; remainingMs: number } | null>(null);

  // Notify parent to re-measure height whenever visible content changes
  useEffect(() => {
    onHeightChange?.();
  }, [phase, steps, expandedSteps]);

  // Notify parent when we become active/inactive
  // Only active during planning/executing — done/failed/idle should NOT keep the glow on
  useEffect(() => {
    onActiveChange?.(phase !== 'idle');
  }, [phase]);

  useEffect(() => {
    if (!ipcRenderer) return;

    // Reset when a new prompt starts
    const handleNewPrompt = () => {
      setPhase('idle');
      setSteps([]);
      setGlobalError(null);
      setTotalCount(0);
      setExpandedSteps(new Set());
      setSynthesisAnswer('');
      setSavedFilePaths([]);
      setAskUserPrompt(null);
      setGuideStep(null);
      setIntentType(null);
      setScheduleCountdown(null);
    };
    ipcRenderer.on('results-window:set-prompt', handleNewPrompt);

    const handleProgress = (_event: any, data: any) => {
      switch (data.type) {
        case 'planning':
          setPhase('planning');
          setPlanMessage(data.message || 'Generating skill plan...');
          setSteps([]);
          setGlobalError(null);
          setTotalCount(0);
          break;

        case 'plan_ready':
          setPhase('executing');
          setTotalCount(data.steps.length);
          if (data.intent) setIntentType(data.intent);
          setSteps(data.steps.map((s: any) => ({
            index: s.index,
            skill: s.skill,
            description: s.description,
            status: 'pending' as StepStatus,
          })));
          break;

        case 'plan_error':
          setPhase('failed');
          setGlobalError(data.error || 'Plan generation failed');
          break;

        case 'step_start':
          setSteps(prev => prev.map(s =>
            s.index === data.stepIndex ? { ...s, status: 'running' } : s
          ));
          break;

        case 'step_done':
          setSteps(prev => prev.map(s =>
            s.index === data.stepIndex
              ? { ...s, status: 'done', stdout: data.stdout, exitCode: data.exitCode, savedFilePath: data.savedFilePath || undefined }
              : s
          ));
          // Auto-expand steps that have meaningful stdout
          if (data.stdout && data.stdout.trim().length > 0) {
            setExpandedSteps(prev => new Set([...prev, data.stepIndex]));
          }
          // Also accumulate at bottom-level for all_done fallback
          if (data.savedFilePath && data.savedFilePath.startsWith('/')) {
            setSavedFilePaths(prev => {
              if (prev.includes(data.savedFilePath)) return prev;
              return [...prev, data.savedFilePath];
            });
          }
          break;

        case 'step_failed':
          setSteps(prev => prev.map(s =>
            s.index === data.stepIndex
              ? { ...s, status: 'failed', error: data.error, stderr: data.stderr }
              : s
          ));
          break;

        case 'synthesis_start':
          // Keep phase as 'executing' — synthesize node emits step_done with answer as stdout
          break;

        case 'ask_user':
          setPhase('ask_user');
          setAskUserPrompt({ question: data.question, options: data.options || [] });
          break;

        case 'guide_step':
          setPhase('guide_step');
          setGuideStep({
            instruction: data.instruction,
            url: data.url || null,
            highlight: data.highlight || null,
            imageUrl: data.imageUrl || null,
            description: data.description || 'Follow the steps below',
            mode: data.mode === 'page_event' ? 'page_event' : 'ipc',
          });
          break;

        case 'schedule_start':
          setPhase('schedule_wait');
          setScheduleCountdown({ label: data.label || 'Waiting...', targetTime: data.targetTime || '', remainingMs: data.waitMs || 0 });
          break;

        case 'schedule_tick':
          setScheduleCountdown(prev => prev ? { ...prev, remainingMs: data.remainingMs, label: data.description || prev.label } : prev);
          break;

        case 'all_done': {
          setPhase('done');
          setTotalCount(data.totalCount);
          // Merge any final stdout from skillResults into steps.
          // Also backfill savedFilePath onto the step that wrote it so the
          // inline file link appears on the step row (shell.run write steps
          // don't emit savedFilePath in step_done — only synthesize does).
          if (Array.isArray(data.skillResults)) {
            const filePaths: string[] = Array.isArray(data.savedFilePaths) ? data.savedFilePaths : [];
            setSteps(prev => prev.map((s, i) => {
              const r = data.skillResults[i];
              if (!r) return s;
              // Find a savedFilePath that this step wrote by matching against its resolved args script
              let stepFilePath = s.savedFilePath;
              if (!stepFilePath && r.skill === 'shell.run' && filePaths.length > 0) {
                const script = (r.args?.argv || []).find((a: any) => typeof a === 'string') || '';
                stepFilePath = filePaths.find(fp => script.includes(fp) || script.includes(fp.replace(/^\/Users\/[^/]+/, '~')));
              }
              return {
                ...s,
                status: r.ok ? 'done' : 'failed',
                stdout: r.stdout || s.stdout,
                stderr: r.stderr || s.stderr,
                error: r.error || s.error,
                exitCode: r.exitCode ?? s.exitCode,
                savedFilePath: stepFilePath || s.savedFilePath,
              };
            }));
          }
          // Also keep bottom-level list for any paths not matched to a specific step
          if (Array.isArray(data.savedFilePaths) && data.savedFilePaths.length > 0) {
            setSavedFilePaths(data.savedFilePaths);
          }
          break;
        }
      }
    };

    // Capture streaming synthesis answer chunks
    const handleBridgeMessage = (_event: any, message: any) => {
      if (message.type === 'chunk' || message.type === 'llm_stream_chunk') {
        const text = message?.text || message.payload?.text || '';
        if (text) setSynthesisAnswer(prev => prev + text);
      }
    };

    ipcRenderer.on('automation:progress', handleProgress);
    ipcRenderer.on('ws-bridge:message', handleBridgeMessage);
    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('automation:progress', handleProgress);
        ipcRenderer.removeListener('results-window:set-prompt', handleNewPrompt);
        ipcRenderer.removeListener('ws-bridge:message', handleBridgeMessage);
      }
    };
  }, []);

  const toggleExpand = (index: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleOptionClick = (option: string) => {
    setAskUserPrompt(null);
    ipcRenderer?.send('stategraph:process', { prompt: option, selectedText: '' });
  };

  const handleGuideContinue = () => {
    setGuideStep(null);
    setPhase('executing');
    ipcRenderer?.send('guide:continue');
  };

  const handleGuideCancel = () => {
    setGuideStep(null);
    setPhase('idle');
    ipcRenderer?.send('guide:cancel');
  };

  if (phase === 'idle') return null;

  const doneCount = steps.filter(s => s.status === 'done').length;
  const shownTotal = totalCount || steps.length;

  return (
    <div className="space-y-3">
      {/* ── Phase header ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {phase === 'planning' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#60a5fa', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#60a5fa' }}>
              {planMessage}
            </span>
          </>
        )}
        {(phase === 'executing' || phase === 'done') && (phase as string) !== 'synthesizing' && (() => {
          const allDone = phase === 'done' || (shownTotal > 0 && doneCount >= shownTotal);
          return (
            <>
              {allDone ? (
                <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: '#22c55e' }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
                  style={{ borderColor: '#60a5fa', borderTopColor: 'transparent' }} />
              )}
              <span className="text-sm font-medium" style={{ color: allDone ? '#34d399' : '#e5e7eb' }}>
                {doneCount} / {shownTotal} tasks done
              </span>
              {intentType && (
                <span className="text-xs px-1.5 py-0.5 rounded-full font-medium ml-1"
                  style={{
                    backgroundColor: intentType === 'command_automate'
                      ? 'rgba(59,130,246,0.15)'
                      : intentType === 'memory_retrieve'
                      ? 'rgba(168,85,247,0.15)'
                      : 'rgba(107,114,128,0.15)',
                    color: intentType === 'command_automate'
                      ? '#93c5fd'
                      : intentType === 'memory_retrieve'
                      ? '#d8b4fe'
                      : '#9ca3af',
                    border: `1px solid ${intentType === 'command_automate'
                      ? 'rgba(59,130,246,0.25)'
                      : intentType === 'memory_retrieve'
                      ? 'rgba(168,85,247,0.25)'
                      : 'rgba(107,114,128,0.25)'}`,
                  }}>
                  {intentType === 'command_automate' ? 'automate'
                    : intentType === 'memory_retrieve' ? 'recall'
                    : intentType === 'web_search' ? 'search'
                    : intentType === 'screen_intelligence' ? 'screen'
                    : intentType}
                </span>
              )}
            </>
          );
        })()}
        {phase === 'failed' && (
          <>
            <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
              style={{ backgroundColor: '#ef4444' }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
                strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
            <span className="text-sm font-medium" style={{ color: '#f87171' }}>
              Automation failed
            </span>
          </>
        )}
        {phase === 'schedule_wait' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#a78bfa', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#a78bfa' }}>
              Scheduled — waiting to run
            </span>
          </>
        )}
      </div>

      {/* ── Schedule countdown banner ─────────────────────────────────────── */}
      {phase === 'schedule_wait' && scheduleCountdown && (() => {
        const totalSecs = Math.ceil(scheduleCountdown.remainingMs / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        const countdownStr = mins > 0
          ? `${mins}m ${secs.toString().padStart(2, '0')}s`
          : `${secs}s`;
        return (
          <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.3)' }}>
            <div className="flex items-center gap-3">
              <div style={{ fontSize: '1.5rem', lineHeight: 1, color: '#a78bfa', fontVariantNumeric: 'tabular-nums', fontWeight: 700, minWidth: 72 }}>
                {countdownStr}
              </div>
              <div>
                <div style={{ color: '#c4b5fd', fontSize: '0.78rem', fontWeight: 600, marginBottom: 2 }}>
                  Fires at {scheduleCountdown.targetTime}
                </div>
                <div style={{ color: '#7c3aed', fontSize: '0.7rem' }}>
                  {scheduleCountdown.label.replace(/ — \d+m.*$| — \d+s.*$/, '')}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Global error ─────────────────────────────────────────────────── */}
      {globalError && (
        <div className="px-3 py-2 rounded-lg text-xs"
          style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderLeft: '3px solid #ef4444', color: '#fca5a5' }}>
          {humanizeError(globalError)}
        </div>
      )}

      {/* ── Step list ────────────────────────────────────────────────────── */}
      {steps.length > 0 && (
        <div className="space-y-2" style={{ maxHeight: 340, overflowY: 'auto', overflowX: 'hidden' }}>
          {steps.map((step) => {
            const isSynthesize = step.skill === 'synthesize';
            const hasOutput = isSynthesize
              ? synthesisAnswer.length > 0
              : (step.stdout && step.stdout.trim().length > 0) ||
                (step.error && step.error.trim().length > 0);
            const isExpanded = expandedSteps.has(step.index);

            return (
              <div key={step.index}>
                {/* Step row */}
                <div
                  className="flex items-start gap-2.5"
                  style={{ cursor: hasOutput ? 'pointer' : 'default' }}
                  onClick={() => hasOutput && toggleExpand(step.index)}
                >
                  <div className="mt-0.5">
                    <StepIcon status={step.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm" style={{
                        color: step.status === 'pending' ? '#6b7280'
                          : step.status === 'failed' ? '#fca5a5'
                          : '#e5e7eb'
                      }}>
                        {step.description}
                      </span>
                      <SkillBadge skill={step.skill} />
                    </div>
                    {step.status === 'done' && !isExpanded && (() => {
                      const out = step.stdout?.trim() || '';
                      if (out.length === 0) {
                        const desc = step.description?.toLowerCase() || '';
                        const isSearch = desc.includes('find') || desc.includes('search') || desc.includes('locate') || desc.includes('look');
                        return (
                          <div className="text-xs mt-0.5" style={{ color: '#6b7280' }}>
                            {isSearch ? 'No results found' : 'No output'}
                          </div>
                        );
                      }
                      const lines = out.split('\n').filter(l => l.trim());
                      const preview = lines[0].length > 60 ? lines[0].slice(0, 60) + '…' : lines[0];
                      const more = lines.length > 1 ? ` +${lines.length - 1} more` : '';
                      return (
                        <div className="text-xs mt-0.5 font-mono truncate" style={{ color: '#6ee7b7' }}>
                          {preview}<span style={{ color: '#6b7280' }}>{more}</span>
                        </div>
                      );
                    })()}
                    {step.status === 'failed' && step.error && !isExpanded && (
                      <div className="text-xs mt-0.5" style={{ color: '#f87171' }}>
                        {humanizeError(step.error)}
                      </div>
                    )}
                  </div>
                  {/* Inline file link — shown on the step that created the file */}
                  {step.savedFilePath && step.status === 'done' && (
                    <button
                      onClick={e => { e.stopPropagation(); ipcRenderer?.send('shell:open-path', step.savedFilePath); }}
                      className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-xs"
                      style={{ backgroundColor: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#93c5fd', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.2)')}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.1)')}
                      title={step.savedFilePath}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                      </svg>
                      {step.savedFilePath.split('/').pop()}
                    </button>
                  )}
                  {/* Expand chevron */}
                  {hasOutput && (
                    <div className="flex-shrink-0 mt-0.5" style={{ color: '#6b7280' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  )}
                </div>

                {/* Expanded output */}
                {isExpanded && hasOutput && (
                  <div className="ml-6 mt-1.5">
                    {isSynthesize ? (
                      <div className="text-xs rounded-lg px-3 py-2 overflow-y-auto whitespace-pre-wrap"
                        style={{
                          backgroundColor: 'rgba(0,0,0,0.4)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: '#e5e7eb',
                          maxHeight: '300px',
                          lineHeight: '1.5',
                        }}>
                        {synthesisAnswer}
                      </div>
                    ) : (
                      <>
                        {step.stdout && step.stdout.trim().length > 0 && (
                          <pre className="text-xs rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all"
                            style={{
                              backgroundColor: 'rgba(0,0,0,0.4)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              color: '#d1fae5',
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                              maxHeight: '160px',
                              overflowY: 'auto',
                            }}>
                            {step.stdout.trim()}
                          </pre>
                        )}
                        {step.error && (
                          <pre className="text-xs rounded-lg px-3 py-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all"
                            style={{
                              backgroundColor: 'rgba(239,68,68,0.08)',
                              border: '1px solid rgba(239,68,68,0.2)',
                              color: '#fca5a5',
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                              maxHeight: '120px',
                              overflowY: 'auto',
                            }}>
                            {step.error.trim()}
                          </pre>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Saved file links ─────────────────────────────────────────────── */}
      {phase === 'done' && savedFilePaths.length > 0 && (
        <div className="space-y-1.5 mt-1">
          {savedFilePaths.map((filePath) => {
            const fileName = filePath.split('/').pop() || filePath;
            return (
              <button
                key={filePath}
                onClick={() => ipcRenderer?.send('shell:open-path', filePath)}
                className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg transition-colors"
                style={{
                  backgroundColor: 'rgba(59,130,246,0.08)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.15)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.08)')}
                title={filePath}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="text-xs font-medium truncate" style={{ color: '#93c5fd' }}>
                  {fileName}
                </span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginLeft: 'auto' }}>
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Planning pulse (no steps yet) ────────────────────────────────── */}
      {phase === 'planning' && steps.length === 0 && (
        <div className="flex items-center gap-2" style={{ color: '#6b7280' }}>
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          <span className="text-xs">Analyzing your request...</span>
        </div>
      )}

      {/* ── GUIDE STEP: instruction card ──────────────────────────── */}
      {guideStep && (
        <div className="mt-2 rounded-xl overflow-hidden"
          style={{ border: '1px solid rgba(99,102,241,0.35)', backgroundColor: 'rgba(99,102,241,0.06)' }}>
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2"
            style={{ borderBottom: '1px solid rgba(99,102,241,0.2)', backgroundColor: 'rgba(99,102,241,0.1)' }}>
            {guideStep.mode === 'page_event' ? (
              <>
                <div className="w-3 h-3 rounded-full border-2 animate-spin flex-shrink-0"
                  style={{ borderColor: '#a5b4fc', borderTopColor: 'transparent' }} />
                <span className="text-xs font-semibold" style={{ color: '#a5b4fc' }}>Waiting for your action in the browser</span>
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span className="text-xs font-semibold" style={{ color: '#a5b4fc' }}>Action Required</span>
              </>
            )}
          </div>
          {/* Instruction */}
          <div className="px-3 py-2.5">
            <p className="text-sm" style={{ color: '#e5e7eb', lineHeight: 1.6 }}>
              {guideStep.instruction}
            </p>
            {guideStep.mode === 'page_event' && (
              <p className="text-xs mt-2" style={{ color: '#6b7280' }}>
                The browser is highlighting what to click. Once you click it, the guide continues automatically.
              </p>
            )}
          </div>
          {/* Action buttons */}
          <div className="px-3 pb-3 flex gap-2">
            {/* Continue button — only shown in IPC fallback mode */}
            {guideStep.mode === 'ipc' && (
              <button
                onClick={handleGuideContinue}
                className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{
                  backgroundColor: 'rgba(99,102,241,0.2)',
                  border: '1px solid rgba(99,102,241,0.4)',
                  color: '#a5b4fc',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.35)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.2)')}
              >
                ✓ Done — Continue
              </button>
            )}
            {/* Stop Guide button — always shown */}
            <button
              onClick={handleGuideCancel}
              className="py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                flex: guideStep.mode === 'ipc' ? '0 0 auto' : '1',
                padding: '8px 14px',
                backgroundColor: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.25)',
                color: '#f87171',
                cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.08)')}
            >
              Stop Guide
            </button>
          </div>
        </div>
      )}

      {/* ── ASK_USER: clickable option buttons ───────────────────────────── */}
      {askUserPrompt && (
        <div className="mt-2 space-y-2">
          <p className="text-sm font-medium" style={{ color: '#e5e7eb', lineHeight: 1.5 }}>
            {askUserPrompt.question}
          </p>
          {askUserPrompt.options.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-2">
              {askUserPrompt.options.map((option, i) => (
                <button
                  key={i}
                  onClick={() => handleOptionClick(option)}
                  className="text-left px-3 py-2 rounded-lg text-sm transition-colors"
                  style={{
                    backgroundColor: 'rgba(59,130,246,0.08)',
                    border: '1px solid rgba(59,130,246,0.25)',
                    color: '#93c5fd',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.18)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.08)')}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
