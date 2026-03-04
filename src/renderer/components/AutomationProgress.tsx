/**
 * AutomationProgress — Windsurf-style live automation progress display.
 *
 * Shows:
 *   1. "Generating plan..." spinner while planSkills runs
 *   2. Step list (N / total done) as executeCommand fires step events
 *   3. Stdout output inline under each completed step
 *   4. Final summary on completion or error banner on failure
 */

import { useEffect, useState, useMemo } from 'react';
import { semanticSkillSearch, SkillMatch } from '../utils/semanticSkillSearch';

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
  | 'gathering'
  | 'planning'
  | 'executing'
  | 'done'
  | 'failed'
  | 'ask_user'
  | 'guide_step'
  | 'schedule_wait'
  | 'evaluating'
  | 'retrying_with_fix';

interface GatherQuestion {
  id: string;
  question: string;
  hint: string | null;
  type: 'choice' | 'text' | 'credential';
  options: string[] | null;
  links: { label: string; url: string }[];
}

interface GatherCredential {
  credentialKey: string;
  question: string;
  hint: string | null;
  helpUrl: string | null;
}

interface GatherConfirm {
  question: string;
  credentialKey: string;
  confirmId: string;
}

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

// ── CapabilityGapCard ──────────────────────────────────────────────────────────

interface CapabilityGapProps {
  capabilityGap: { capability: string; suggestion: string; scaffolded: boolean };
  onBrowseStore: () => void;
  onBuildSkill: (skill: any) => void;
  onBuildScaffold: () => void;
}

function CapabilityGapCard({ capabilityGap, onBrowseStore, onBuildSkill, onBuildScaffold }: CapabilityGapProps) {
  const [building, setBuilding] = useState<string | null>(null);

  const matches = useMemo(
    () => semanticSkillSearch(capabilityGap.capability, 3),
    [capabilityGap.capability]
  );

  const handleBuild = (skill: any) => {
    setBuilding(skill.name);
    onBuildSkill(skill);
  };

  const handleScaffold = () => {
    setBuilding('__scaffold__');
    onBuildScaffold();
  };

  const CAT_COLORS: Record<string, string> = {
    'Browser & Automation': '#3b82f6',
    'Coding Agents & IDEs': '#8b5cf6',
    'DevOps & Cloud': '#06b6d4',
    'AI & LLMs': '#a78bfa',
    'Communication': '#ec4899',
    'Productivity & Tasks': '#6366f1',
    'Calendar & Scheduling': '#f59e0b',
    'CLI Utilities': '#84cc16',
  };
  const catColor = (c: string) => CAT_COLORS[c] || '#6b7280';

  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.3)' }}>
      {/* Header */}
      <div className="flex items-start gap-2" style={{ marginBottom: 8 }}>
        <div style={{ fontSize: '0.9rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🔌</div>
        <div>
          <div style={{ color: '#fbbf24', fontSize: '0.76rem', fontWeight: 600, marginBottom: 2 }}>
            Skill required — can't do this natively
          </div>
          <div style={{ color: '#9ca3af', fontSize: '0.69rem', lineHeight: 1.4 }}>
            <strong style={{ color: '#e5e7eb' }}>{capabilityGap.capability || 'This capability'}</strong> needs a custom skill.
          </div>
        </div>
      </div>

      {/* Scaffolded confirmation */}
      {capabilityGap.scaffolded && (
        <div style={{ color: '#86efac', fontSize: '0.68rem', marginBottom: 8, paddingLeft: 22 }}>
          ✓ Starter skill scaffolded at <code style={{ backgroundColor: 'rgba(0,0,0,0.3)', padding: '1px 4px', borderRadius: 3 }}>
            {capabilityGap.suggestion?.match(/skills\/[^/]+/)?.[0] || '~/.thinkdrop/skills/...'}
          </code>
        </div>
      )}

      {/* Semantic matches */}
      {matches.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ color: '#6b7280', fontSize: '0.63rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5, paddingLeft: 22 }}>
            Similar skills in store
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {matches.map(({ skill }: SkillMatch) => {
              const col = catColor(skill.category);
              const isBuilding = building === skill.name;
              return (
                <div key={skill.name} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
                  borderRadius: 7, backgroundColor: isBuilding ? `${col}14` : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${isBuilding ? `${col}44` : 'rgba(255,255,255,0.07)'}`,
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: col, boxShadow: `0 0 4px ${col}55` }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#c4b5fd', fontSize: '0.7rem', fontWeight: 600, fontFamily: 'ui-monospace,monospace', marginBottom: 1 }}>
                      {skill.displayName}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: '0.64rem', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {skill.description}
                    </div>
                  </div>
                  <button
                    onClick={() => !building && handleBuild(skill)}
                    disabled={!!building}
                    style={{
                      flexShrink: 0, padding: '3px 9px', borderRadius: 5, fontSize: '0.64rem',
                      fontWeight: 600, cursor: building ? 'not-allowed' : 'pointer',
                      border: `1px solid ${isBuilding ? `${col}55` : 'rgba(139,92,246,0.45)'}`,
                      background: isBuilding ? `${col}22` : 'rgba(139,92,246,0.15)',
                      color: isBuilding ? col : '#c4b5fd',
                      opacity: building && !isBuilding ? 0.35 : 1,
                      display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap',
                    }}
                  >
                    {isBuilding ? (
                      <>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
                            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/>
                          </path>
                        </svg>
                        Building…
                      </>
                    ) : 'Build'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Action row */}
      <div style={{ display: 'flex', gap: 6, paddingLeft: 0, flexWrap: 'wrap' }}>
        {/* Build from scaffold — only shown if scaffold was created */}
        {capabilityGap.scaffolded && (
          <button
            onClick={() => !building && handleScaffold()}
            disabled={!!building}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '5px 11px', borderRadius: 6, cursor: building ? 'not-allowed' : 'pointer',
              backgroundColor: building === '__scaffold__' ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.1)',
              border: '1px solid rgba(34,197,94,0.35)',
              color: '#86efac', fontSize: '0.69rem', fontWeight: 600,
              opacity: building && building !== '__scaffold__' ? 0.4 : 1,
            }}
            onMouseEnter={e => { if (!building) e.currentTarget.style.backgroundColor = 'rgba(34,197,94,0.2)'; }}
            onMouseLeave={e => { if (!building) e.currentTarget.style.backgroundColor = 'rgba(34,197,94,0.1)'; }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            {building === '__scaffold__' ? 'Building scaffold…' : 'Build from scaffold'}
          </button>
        )}
        {/* Browse store */}
        <button
          onClick={onBrowseStore}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '5px 11px', borderRadius: 6, cursor: 'pointer',
            backgroundColor: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
            color: '#fcd34d', fontSize: '0.69rem', fontWeight: 600,
          }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(245,158,11,0.2)')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(245,158,11,0.1)')}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          {matches.length > 0 ? 'Browse more in store' : 'Search Skill Store'}
        </button>
      </div>
    </div>
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
  const [evalMessage, setEvalMessage] = useState<string>('');
  const [retryMessage, setRetryMessage] = useState<string>('');
  const [capabilityGap, setCapabilityGap] = useState<{ capability: string; suggestion: string; scaffolded: boolean } | null>(null);
  const [skillBuildConfirm, setSkillBuildConfirm] = useState<{ skillName: string; summary: string } | null>(null);
  const [gatherQuestion, setGatherQuestion] = useState<GatherQuestion | null>(null);
  const [gatherCredential, setGatherCredential] = useState<GatherCredential | null>(null);
  const [gatherConfirm, setGatherConfirm] = useState<GatherConfirm | null>(null);
  const [gatherCredentialValue, setGatherCredentialValue] = useState('');
  const [gatherCredentialStored, setGatherCredentialStored] = useState<string | null>(null);

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
      setCapabilityGap(null);
      setSkillBuildConfirm(null);
      setGatherQuestion(null);
      setGatherCredential(null);
      setGatherConfirm(null);
      setGatherCredentialValue('');
      setGatherCredentialStored(null);
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
            s.index === data.stepIndex
              ? { ...s, status: 'running', description: data.description || s.description }
              : s
          ));
          break;

        case 'step_done':
          setSteps(prev => prev.map(s =>
            s.index === data.stepIndex
              ? { ...s, status: 'done', description: data.description || s.description, stdout: data.stdout, exitCode: data.exitCode, savedFilePath: data.savedFilePath || undefined }
              : s
          ));
          // Detect shell.run scaffold step that follows needs_skill (marks scaffold as done)
          // Match on stdout containing 'Scaffolded at' since description is just 'shell.run' in the event
          if (data.skill === 'shell.run' && data.stdout && data.stdout.includes('Scaffolded at')) {
            setCapabilityGap(prev => prev ? { ...prev, scaffolded: true } : prev);
          }
          // Auto-expand steps that have meaningful stdout (skip needs_skill — rendered as card)
          if (data.stdout && data.stdout.trim().length > 0 && data.skill !== 'needs_skill') {
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

        case 'gather_start':
          setPhase('gathering');
          setGatherQuestion(null);
          setGatherCredential(null);
          setGatherConfirm(null);
          break;

        case 'gather_question':
          setPhase('gathering');
          setGatherCredential(null);
          setGatherConfirm(null);
          setGatherQuestion({
            id: data.id,
            question: data.question,
            hint: data.hint || null,
            type: data.type || 'text',
            options: data.options || null,
            links: data.links || [],
          });
          break;

        case 'gather_credential':
          setPhase('gathering');
          setGatherQuestion(null);
          setGatherConfirm(null);
          setGatherCredentialValue('');
          setGatherCredential({
            credentialKey: data.credentialKey,
            question: data.question,
            hint: data.hint || null,
            helpUrl: data.helpUrl || null,
          });
          break;

        case 'gather_credential_stored':
          setGatherCredentialStored(data.credentialKey);
          setGatherCredential(null);
          setTimeout(() => setGatherCredentialStored(null), 3000);
          break;

        case 'gather_confirm':
          setPhase('gathering');
          setGatherQuestion(null);
          setGatherCredential(null);
          setGatherConfirm({
            question: data.question,
            credentialKey: data.credentialKey,
            confirmId: data.confirmId,
          });
          break;

        case 'gather_confirmed':
          setGatherConfirm(null);
          break;

        case 'gather_complete':
          setGatherQuestion(null);
          setGatherCredential(null);
          setGatherConfirm(null);
          setPhase('planning');
          setPlanMessage('Starting build…');
          break;

        case 'gather_answer_received':
          setGatherQuestion(null);
          break;

        case 'skill_build_confirm':
          setSkillBuildConfirm({
            skillName: data.skillName,
            summary: data.summary,
          });
          break;

        case 'skill_build_triggered':
          setSkillBuildConfirm(null);
          break;

        case 'evaluating':
          setPhase('evaluating');
          setEvalMessage(data.message || 'Evaluating result quality...');
          break;

        case 'retrying_with_fix':
          setPhase('retrying_with_fix');
          setRetryMessage(data.message || 'Adjusting approach and retrying...');
          // Reset steps for the new plan run
          setSteps([]);
          setTotalCount(0);
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

    // skill_store_trigger — fired by executeCommand when needs_skill step runs
    const handleSkillStoreTrigger = (_event: any, { capability, suggestion }: { capability: string; suggestion: string }) => {
      setCapabilityGap({ capability: capability || '', suggestion: suggestion || '', scaffolded: false });
    };

    ipcRenderer.on('automation:progress', handleProgress);
    ipcRenderer.on('ws-bridge:message', handleBridgeMessage);
    ipcRenderer.on('skill:store-trigger', handleSkillStoreTrigger);
    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('automation:progress', handleProgress);
        ipcRenderer.removeListener('results-window:set-prompt', handleNewPrompt);
        ipcRenderer.removeListener('ws-bridge:message', handleBridgeMessage);
        ipcRenderer.removeListener('skill:store-trigger', handleSkillStoreTrigger);
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

  const handleGatherOptionClick = (option: string) => {
    setGatherQuestion(null);
    ipcRenderer?.send('gather:answer', { answer: option });
  };

  const handleGatherCredentialSubmit = () => {
    if (!gatherCredential || !gatherCredentialValue.trim()) return;
    ipcRenderer?.send('gather:credential', { key: gatherCredential.credentialKey, value: gatherCredentialValue });
    setGatherCredentialValue('');
  };

  const handleGatherConfirm = (yes: boolean) => {
    setGatherConfirm(null);
    ipcRenderer?.send('gather:answer', { answer: yes ? 'yes' : 'no' });
  };

  if (phase === 'idle') return null;

  const doneCount = steps.filter(s => s.status === 'done').length;
  const shownTotal = totalCount || steps.length;

  return (
    <div className="space-y-3">
      {/* ── Phase header ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {phase === 'gathering' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#a78bfa', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#a78bfa' }}>
              Gathering requirements…
            </span>
          </>
        )}
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
        {phase === 'evaluating' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#f59e0b', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#fbbf24' }}>
              {evalMessage}
            </span>
          </>
        )}
        {phase === 'retrying_with_fix' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#f97316', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#fb923c' }}>
              {retryMessage}
            </span>
          </>
        )}
      </div>

      {/* ── Evaluating banner ────────────────────────────────────────────── */}
      {phase === 'evaluating' && (
        <div style={{ padding: '10px 14px', borderRadius: 10, backgroundColor: '#1c1a0e', border: '1px solid #a16207', position: 'sticky', top: 0, zIndex: 10 }}>
          <div className="flex items-center gap-2.5">
            <div className="w-3 h-3 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#facc15', borderTopColor: 'transparent' }} />
            <div>
              <div style={{ color: '#fde047', fontSize: '0.75rem', fontWeight: 600 }}>
                Checking result quality
              </div>
              <div style={{ color: '#a3a3a3', fontSize: '0.68rem', marginTop: 2 }}>
                ThinkDrop is reviewing the output. This may take a few seconds.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Retrying with fix banner ──────────────────────────────────────── */}
      {phase === 'retrying_with_fix' && (
        <div style={{ padding: '10px 14px', borderRadius: 10, backgroundColor: '#1a1108', border: '1px solid #c2410c', position: 'sticky', top: 0, zIndex: 10 }}>
          <div className="flex items-center gap-2.5">
            <div className="w-3 h-3 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#fb923c', borderTopColor: 'transparent' }} />
            <div>
              <div style={{ color: '#fdba74', fontSize: '0.75rem', fontWeight: 600 }}>
                Self-healing — retrying with a fix
              </div>
              <div style={{ color: '#a3a3a3', fontSize: '0.68rem', marginTop: 2 }}>
                A correction rule was saved. Replanning now — no action needed.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Gather: question card ────────────────────────────────────────── */}
      {gatherQuestion && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(167,139,250,0.07)', border: '1px solid rgba(167,139,250,0.3)' }}>
          <div className="flex items-start gap-2" style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.9rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🔍</div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#c4b5fd', fontSize: '0.76rem', fontWeight: 600, marginBottom: 4 }}>
                {gatherQuestion.question}
              </div>
              {gatherQuestion.hint && (
                <div style={{ color: '#6b7280', fontSize: '0.68rem', marginBottom: 6 }}>
                  {gatherQuestion.hint}
                </div>
              )}
              {/* Choice options */}
              {gatherQuestion.options && gatherQuestion.options.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                  {gatherQuestion.options.map((opt) => (
                    <button
                      key={opt}
                      onClick={() => handleGatherOptionClick(opt)}
                      style={{
                        padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                        backgroundColor: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.35)',
                        color: '#c4b5fd', fontSize: '0.69rem', fontWeight: 500,
                      }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(167,139,250,0.22)')}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(167,139,250,0.12)')}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              {/* Helpful links */}
              {gatherQuestion.links && gatherQuestion.links.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {gatherQuestion.links.map((link) => (
                    <a
                      key={link.url}
                      href="#"
                      onClick={e => { e.preventDefault(); ipcRenderer?.send('shell:open-url', link.url); }}
                      style={{ color: '#818cf8', fontSize: '0.67rem', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                    >
                      ↗ {link.label}
                    </a>
                  ))}
                </div>
              )}
              {/* For text-type questions: hint to answer in the prompt bar */}
              {(!gatherQuestion.options || gatherQuestion.options.length === 0) && (
                <div style={{ color: '#4b5563', fontSize: '0.67rem', marginTop: 4 }}>
                  Type your answer in the prompt bar below ↓
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Gather: credential input card ────────────────────────────────── */}
      {gatherCredential && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)' }}>
          <div className="flex items-start gap-2" style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.9rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🔑</div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#6ee7b7', fontSize: '0.76rem', fontWeight: 600, marginBottom: 2 }}>
                {gatherCredential.question}
              </div>
              {gatherCredential.hint && (
                <div style={{ color: '#6b7280', fontSize: '0.68rem', marginBottom: 6 }}>
                  {gatherCredential.hint}
                </div>
              )}
              {gatherCredential.helpUrl && (
                <a
                  href="#"
                  onClick={e => { e.preventDefault(); ipcRenderer?.send('shell:open-url', gatherCredential.helpUrl!); }}
                  style={{ display: 'inline-block', color: '#818cf8', fontSize: '0.67rem', textDecoration: 'underline', textDecorationStyle: 'dotted', marginBottom: 8 }}
                >
                  ↗ Open credentials page
                </a>
              )}
              {/* CLI-style masked input */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: '#10b981', fontSize: '0.72rem', fontFamily: 'monospace', flexShrink: 0 }}>
                  {gatherCredential.credentialKey} =
                </span>
                <input
                  type="password"
                  value={gatherCredentialValue}
                  onChange={e => setGatherCredentialValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleGatherCredentialSubmit(); }}
                  placeholder="Paste value here…"
                  autoFocus
                  style={{
                    flex: 1, background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(16,185,129,0.35)',
                    borderRadius: 5, padding: '4px 8px', color: '#d1fae5', fontSize: '0.72rem',
                    fontFamily: 'monospace', outline: 'none',
                  }}
                />
                <button
                  onClick={handleGatherCredentialSubmit}
                  disabled={!gatherCredentialValue.trim()}
                  style={{
                    padding: '4px 10px', borderRadius: 5, cursor: gatherCredentialValue.trim() ? 'pointer' : 'not-allowed',
                    backgroundColor: gatherCredentialValue.trim() ? 'rgba(16,185,129,0.2)' : 'rgba(16,185,129,0.05)',
                    border: '1px solid rgba(16,185,129,0.35)',
                    color: '#6ee7b7', fontSize: '0.69rem', fontWeight: 600,
                    opacity: gatherCredentialValue.trim() ? 1 : 0.4,
                  }}
                >
                  Store
                </button>
              </div>
              <div style={{ color: '#374151', fontSize: '0.65rem', marginTop: 4 }}>
                Stored securely in keychain — never logged or shared
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Gather: stored confirmation flash ────────────────────────────── */}
      {gatherCredentialStored && (
        <div style={{ padding: '8px 14px', borderRadius: 8, backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
            style={{ backgroundColor: '#22c55e' }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
              strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <span style={{ color: '#86efac', fontSize: '0.72rem', fontWeight: 500 }}>
            <code style={{ fontFamily: 'monospace', color: '#4ade80' }}>{gatherCredentialStored}</code> stored in keychain
          </span>
        </div>
      )}

      {/* ── Gather: confirm existing credential card ──────────────────────── */}
      {gatherConfirm && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.3)' }}>
          <div className="flex items-start gap-2" style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.9rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🗝️</div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#a5b4fc', fontSize: '0.76rem', fontWeight: 600, marginBottom: 4 }}>
                {gatherConfirm.question}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => handleGatherConfirm(true)}
                  style={{
                    padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
                    backgroundColor: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)',
                    color: '#c7d2fe', fontSize: '0.69rem', fontWeight: 600,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.28)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.15)')}
                >
                  Yes, use them
                </button>
                <button
                  onClick={() => handleGatherConfirm(false)}
                  style={{
                    padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
                    backgroundColor: 'rgba(107,114,128,0.1)', border: '1px solid rgba(107,114,128,0.3)',
                    color: '#9ca3af', fontSize: '0.69rem', fontWeight: 500,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(107,114,128,0.2)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(107,114,128,0.1)')}
                >
                  Enter new ones
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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

      {/* ── Skill build confirmation card ───────────────────────────────── */}
      {skillBuildConfirm && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.35)' }}>
          <div className="flex items-start gap-2" style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.95rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🔧</div>
            <div>
              <div style={{ color: '#c4b5fd', fontSize: '0.76rem', fontWeight: 600, marginBottom: 3 }}>
                New skill required
              </div>
              <div style={{ color: '#9ca3af', fontSize: '0.69rem', lineHeight: 1.4, marginBottom: 4 }}>
                <span style={{ color: '#e5e7eb', fontFamily: 'ui-monospace,monospace', fontSize: '0.68rem', background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 3 }}>
                  {skillBuildConfirm.skillName}
                </span>
              </div>
            </div>
          </div>
          <div style={{ color: '#d1d5db', fontSize: '0.71rem', lineHeight: 1.5, marginBottom: 10, paddingLeft: 22, fontStyle: 'italic' }}>
            {skillBuildConfirm.summary}
          </div>
          <div style={{ display: 'flex', gap: 6, paddingLeft: 22 }}>
            <button
              onClick={() => {
                setSkillBuildConfirm(null);
                ipcRenderer?.send('install:confirm', { confirmed: true });
              }}
              style={{
                padding: '5px 12px', borderRadius: 6, fontSize: '0.7rem', fontWeight: 600,
                cursor: 'pointer', background: 'rgba(139,92,246,0.2)',
                border: '1px solid rgba(139,92,246,0.5)', color: '#c4b5fd',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
              </svg>
              Build &amp; Install
            </button>
            <button
              onClick={() => {
                setSkillBuildConfirm(null);
                ipcRenderer?.send('install:confirm', { confirmed: false });
              }}
              style={{
                padding: '5px 12px', borderRadius: 6, fontSize: '0.7rem', fontWeight: 600,
                cursor: 'pointer', background: 'rgba(107,114,128,0.1)',
                border: '1px solid rgba(107,114,128,0.3)', color: '#9ca3af',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Capability gap card (needs_skill) ───────────────────────────── */}
      {capabilityGap && (
        <CapabilityGapCard
          capabilityGap={capabilityGap}
          onBrowseStore={() => ipcRenderer?.send('skill:store-open', { capability: capabilityGap.capability, suggestion: capabilityGap.suggestion })}
          onBuildSkill={(skill) => ipcRenderer?.send('skill:build-start', skill)}
          onBuildScaffold={() => {
            const skillName = capabilityGap.suggestion?.match(/skills\/([^/]+)/)?.[1] || 'custom-skill';
            const scaffoldPath = `${(window as any).__HOME__ || '~'}/.thinkdrop/skills/${skillName}/skill.md`;
            ipcRenderer?.send('skill:build-start', {
              name: skillName,
              displayName: skillName,
              description: capabilityGap.capability,
              category: 'Custom',
              rawUrl: `file://${scaffoldPath}`,
              ocUrl: '',
              isScaffold: true,
              scaffoldPath,
            });
          }}
        />
      )}


      {/* ── Step list ────────────────────────────────────────────────────── */}
      {steps.length > 0 && (
        <div className="space-y-2" style={{ maxHeight: 340, overflowY: 'auto', overflowX: 'hidden' }}>
          {steps.map((step) => {
            const isSynthesize = step.skill === 'synthesize';
            const isNeedsSkill = step.skill === 'needs_skill';
            const hasOutput = isSynthesize
              ? synthesisAnswer.length > 0
              : !isNeedsSkill && ((step.stdout && step.stdout.trim().length > 0) ||
                (step.error && step.error.trim().length > 0));
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
