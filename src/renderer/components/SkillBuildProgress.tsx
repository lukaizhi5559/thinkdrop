import { useState } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export type BuildPhase =
  | 'idle'
  | 'fetching'      // Fetching SKILL.md from GitHub
  | 'building'      // Creator Agent writing the .cjs skill
  | 'validating'    // Validator Agent reviewing
  | 'fixing'        // Creator Agent applying validator feedback
  | 'installing'    // Writing file + registering in DB
  | 'asking'        // ASK_USER — needs input (API key, config, etc.)
  | 'done'
  | 'error';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
}

export interface BuildRound {
  round: number;
  issues: ValidationIssue[];
  fixed: boolean;
}

export interface SkillBuildState {
  phase: BuildPhase;
  skillName: string;
  skillDisplayName: string;
  category: string;
  round: number;         // current build/validate cycle (1-based)
  maxRounds: number;
  rounds: BuildRound[];  // history of validation rounds
  question?: string;     // ASK_USER prompt
  options?: string[];    // ASK_USER choices
  error?: string;
  installedPath?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<BuildPhase, string> = {
  idle:       'Idle',
  fetching:   'Fetching template…',
  building:   'Creator Agent — drafting skill…',
  validating: 'Validator Agent — reviewing…',
  fixing:     'Creator Agent — applying fixes…',
  installing: 'Installing skill…',
  asking:     'Input needed',
  done:       'Installed',
  error:      'Failed',
};

const PHASE_COLORS: Record<BuildPhase, string> = {
  idle:       '#6b7280',
  fetching:   '#06b6d4',
  building:   '#8b5cf6',
  validating: '#f59e0b',
  fixing:     '#a78bfa',
  installing: '#10b981',
  asking:     '#f97316',
  done:       '#22c55e',
  error:      '#f87171',
};

function IssueIcon({ severity }: { severity: ValidationIssue['severity'] }) {
  if (severity === 'error') return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
  if (severity === 'warning') return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  );
}

function PhaseStep({ label, active, done, color }: { label: string; active: boolean; done: boolean; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: done || active ? 1 : 0.35 }}>
      <div style={{
        width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: done ? `${color}33` : active ? `${color}22` : 'rgba(255,255,255,0.05)',
        border: `1.5px solid ${done || active ? color : 'rgba(255,255,255,0.1)'}`,
      }}>
        {done ? (
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        ) : active ? (
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/>
            </path>
          </svg>
        ) : null}
      </div>
      <span style={{ fontSize: '0.68rem', color: active ? color : done ? '#9ca3af' : '#4b5563' }}>
        {label}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  state: SkillBuildState;
  onAnswer?: (answer: string) => void;
  onCancel?: () => void;
}

const PIPELINE_STEPS: { phase: BuildPhase; label: string }[] = [
  { phase: 'fetching',   label: 'Fetch template' },
  { phase: 'building',   label: 'Draft skill' },
  { phase: 'validating', label: 'Validate' },
  { phase: 'fixing',     label: 'Fix issues' },
  { phase: 'installing', label: 'Install' },
];

const PHASE_ORDER: BuildPhase[] = ['fetching', 'building', 'validating', 'fixing', 'installing', 'done'];

export default function SkillBuildProgress({ state, onAnswer, onCancel }: Props) {
  const [userInput, setUserInput] = useState('');
  const { phase, skillDisplayName, category, round, maxRounds, rounds, question, options, error, installedPath } = state;

  const phaseColor = PHASE_COLORS[phase];
  const currentPhaseIdx = PHASE_ORDER.indexOf(phase);

  const isStepDone = (stepPhase: BuildPhase) => {
    const stepIdx = PHASE_ORDER.indexOf(stepPhase);
    return stepIdx < currentPhaseIdx || phase === 'done';
  };
  const isStepActive = (stepPhase: BuildPhase) => stepPhase === phase;

  if (phase === 'idle') return null;

  return (
    <div style={{
      borderTop: '1px solid rgba(139,92,246,0.2)',
      background: 'rgba(14,14,20,0.97)',
      padding: '12px 14px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: phaseColor, boxShadow: `0 0 6px ${phaseColor}` }} />
          <span style={{ color: '#e5e7eb', fontSize: '0.73rem', fontWeight: 600 }}>
            Building: <span style={{ color: '#c4b5fd', fontFamily: 'ui-monospace,monospace' }}>{skillDisplayName}</span>
          </span>
          <span style={{ fontSize: '0.6rem', padding: '1px 6px', borderRadius: 10,
            background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)' }}>
            {category}
          </span>
        </div>
        {phase !== 'done' && phase !== 'error' && (
          <button onClick={onCancel} style={{
            background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5,
            cursor: 'pointer', color: '#6b7280', fontSize: '0.65rem', padding: '2px 7px',
          }}>Cancel</button>
        )}
      </div>

      {/* Pipeline steps */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {PIPELINE_STEPS.map((step, i) => (
          <div key={step.phase} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PhaseStep
              label={step.label}
              active={isStepActive(step.phase) || (step.phase === 'fixing' && phase === 'asking')}
              done={isStepDone(step.phase)}
              color={PHASE_COLORS[step.phase]}
            />
            {i < PIPELINE_STEPS.length - 1 && (
              <div style={{ width: 14, height: 1, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
            )}
          </div>
        ))}
      </div>

      {/* Round counter */}
      {round > 1 && phase !== 'done' && phase !== 'error' && (
        <div style={{ fontSize: '0.64rem', color: '#6b7280', marginBottom: 8 }}>
          Build cycle <span style={{ color: '#f59e0b' }}>{round}</span> / {maxRounds}
          {round >= maxRounds && <span style={{ color: '#f87171', marginLeft: 4 }}>— max cycles reached</span>}
        </div>
      )}

      {/* Current phase label */}
      <div style={{ fontSize: '0.7rem', color: phaseColor, marginBottom: rounds.length > 0 ? 8 : 0 }}>
        {phase === 'asking' ? question : PHASE_LABELS[phase]}
      </div>

      {/* Validation rounds history */}
      {rounds.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {rounds.map(r => (
            <div key={r.round} style={{
              borderRadius: 6, border: `1px solid ${r.fixed ? 'rgba(34,197,94,0.2)' : 'rgba(248,113,113,0.2)'}`,
              background: r.fixed ? 'rgba(34,197,94,0.05)' : 'rgba(248,113,113,0.05)',
              padding: '6px 8px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: r.issues.length > 0 ? 5 : 0 }}>
                <span style={{ fontSize: '0.66rem', fontWeight: 600, color: r.fixed ? '#86efac' : '#fca5a5' }}>
                  {r.fixed ? '✓ Round ' : '✗ Round '}{r.round} — {r.issues.length} issue{r.issues.length !== 1 ? 's' : ''}
                </span>
              </div>
              {r.issues.map((issue, ii) => (
                <div key={ii} style={{ display: 'flex', alignItems: 'flex-start', gap: 5, marginTop: 3 }}>
                  <IssueIcon severity={issue.severity} />
                  <span style={{
                    fontSize: '0.65rem', lineHeight: 1.4,
                    color: issue.severity === 'error' ? '#fca5a5' : issue.severity === 'warning' ? '#fcd34d' : '#9ca3af',
                  }}>
                    {issue.line != null && <span style={{ opacity: 0.6, marginRight: 4 }}>L{issue.line}</span>}
                    {issue.message}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ASK_USER input */}
      {phase === 'asking' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {options && options.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {options.map(opt => (
                <button key={opt} onClick={() => onAnswer?.(opt)} style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: '0.7rem', cursor: 'pointer',
                  background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)',
                  color: '#c4b5fd',
                }}>{opt}</button>
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text" value={userInput}
                onChange={e => setUserInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && userInput.trim()) { onAnswer?.(userInput.trim()); setUserInput(''); } }}
                placeholder="Type your answer…"
                style={{
                  flex: 1, padding: '5px 9px', borderRadius: 6, fontSize: '0.72rem',
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                  color: '#e5e7eb', outline: 'none',
                }}
                autoFocus
              />
              <button onClick={() => { if (userInput.trim()) { onAnswer?.(userInput.trim()); setUserInput(''); } }}
                style={{
                  padding: '5px 12px', borderRadius: 6, fontSize: '0.7rem', cursor: 'pointer',
                  background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(139,92,246,0.45)', color: '#c4b5fd',
                }}>Send</button>
            </div>
          )}
        </div>
      )}

      {/* Done */}
      {phase === 'done' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span style={{ color: '#86efac', fontSize: '0.7rem' }}>
            Skill installed successfully
            {installedPath && <span style={{ color: '#6b7280', marginLeft: 4, fontFamily: 'ui-monospace,monospace', fontSize: '0.63rem' }}>{installedPath}</span>}
          </span>
        </div>
      )}

      {/* Error */}
      {phase === 'error' && error && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <IssueIcon severity="error" />
          <span style={{ color: '#fca5a5', fontSize: '0.7rem', lineHeight: 1.4 }}>{error}</span>
        </div>
      )}
    </div>
  );
}
