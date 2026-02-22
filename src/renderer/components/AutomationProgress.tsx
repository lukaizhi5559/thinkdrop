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
}

type AutomationPhase =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'done'
  | 'failed';

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

  // Notify parent to re-measure height whenever visible content changes
  useEffect(() => {
    onHeightChange?.();
  }, [phase, steps, expandedSteps]);

  // Notify parent when we become active/inactive
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
              ? { ...s, status: 'done', stdout: data.stdout, exitCode: data.exitCode }
              : s
          ));
          // Auto-expand steps that have meaningful stdout
          if (data.stdout && data.stdout.trim().length > 0) {
            setExpandedSteps(prev => new Set([...prev, data.stepIndex]));
          }
          break;

        case 'step_failed':
          setSteps(prev => prev.map(s =>
            s.index === data.stepIndex
              ? { ...s, status: 'failed', error: data.error, stderr: data.stderr }
              : s
          ));
          break;

        case 'all_done': {
          setPhase('done');
          setTotalCount(data.totalCount);
          // Merge any final stdout from skillResults into steps
          if (Array.isArray(data.skillResults)) {
            setSteps(prev => prev.map((s, i) => {
              const r = data.skillResults[i];
              if (!r) return s;
              return {
                ...s,
                status: r.ok ? 'done' : 'failed',
                stdout: r.stdout || s.stdout,
                stderr: r.stderr || s.stderr,
                error: r.error || s.error,
                exitCode: r.exitCode ?? s.exitCode,
              };
            }));
          }
          break;
        }
      }
    };

    ipcRenderer.on('automation:progress', handleProgress);
    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('automation:progress', handleProgress);
        ipcRenderer.removeListener('results-window:set-prompt', handleNewPrompt);
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
        {(phase === 'executing' || phase === 'done') && (() => {
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
      </div>

      {/* ── Global error ─────────────────────────────────────────────────── */}
      {globalError && (
        <div className="px-3 py-2 rounded-lg text-xs"
          style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderLeft: '3px solid #ef4444', color: '#fca5a5' }}>
          {humanizeError(globalError)}
        </div>
      )}

      {/* ── Step list ────────────────────────────────────────────────────── */}
      {steps.length > 0 && (
        <div className="space-y-2">
          {steps.map((step) => {
            const hasOutput = (step.stdout && step.stdout.trim().length > 0) ||
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
                  <div className="ml-6.5 mt-1.5">
                    {step.stdout && step.stdout.trim().length > 0 && (
                      <pre className="text-xs rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all"
                        style={{
                          backgroundColor: 'rgba(0,0,0,0.4)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: '#d1fae5',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          maxHeight: '200px',
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
                  </div>
                )}
              </div>
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
    </div>
  );
}
