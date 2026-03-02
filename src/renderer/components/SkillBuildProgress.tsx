import { useState, useEffect } from 'react';

// ── Lightweight JS syntax highlighter ────────────────────────────────────────
function highlightJS(code: string): string {
  const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Process line by line to handle comments cleanly
  return code.split('\n').map(line => {
    // Full-line // comment
    const commentMatch = line.match(/^(\s*)((\/\/.*)$)/);
    if (commentMatch) {
      return esc(commentMatch[1]) + `<span style="color:#6b7280;font-style:italic">${esc(commentMatch[2])}</span>`;
    }
    // Inline // comment — split at first //
    const inlineIdx = line.indexOf('//');
    const codePart = inlineIdx >= 0 ? line.slice(0, inlineIdx) : line;
    const commentPart = inlineIdx >= 0 ? line.slice(inlineIdx) : '';

    let result = esc(codePart)
      // strings
      .replace(/(&apos;|&#39;|`[^`]*`|'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*")/g,
        m => `<span style="color:#86efac">${m}</span>`)
      // keywords
      .replace(/\b(const|let|var|function|async|await|return|if|else|for|while|try|catch|throw|new|this|module|exports|require|typeof|instanceof|of|in|class|extends|import|export|default|null|undefined|true|false)\b/g,
        m => `<span style="color:#c084fc">${m}</span>`)
      // numbers
      .replace(/\b(\d+)\b/g, m => `<span style="color:#f9a8d4">${m}</span>`)
      // function calls / method names
      .replace(/\b([a-zA-Z_$][\w$]*)(?=\s*\()/g,
        m => `<span style="color:#93c5fd">${m}</span>`);

    if (commentPart) {
      result += `<span style="color:#6b7280;font-style:italic">${esc(commentPart)}</span>`;
    }
    return result;
  }).join('\n');
}

// ── Types ────────────────────────────────────────────────────────────────────

export type BuildPhase =
  | 'idle'
  | 'fetching'      // Fetching SKILL.md from GitHub or local scaffold
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
  round: number;
  maxRounds: number;
  rounds: BuildRound[];
  question?: string;
  keyLabel?: string;      // human-readable key name e.g. "Client Id"
  serviceContext?: string; // service name e.g. "Google / Gmail"
  options?: string[];
  error?: string;
  installedPath?: string;
  tokenCount?: number;    // streamed token count during building
  draft?: string;         // current generated code draft
  smokeTest?: { ok: boolean; output?: string; error?: string }; // post-install smoke test result
  autoSetupFailed?: boolean; // browser.agent OAuth flow failed — switched back to manual
  scannedFields?: ScannedField[] | null; // fields from browser.agent scan_page
}

interface ScannedField {
  name: string;        // SCREAMING_SNAKE_CASE key e.g. GMAIL_EMAIL
  label: string;       // Human label e.g. "Email or phone"
  type: 'email' | 'password' | 'text' | 'url';
  placeholder?: string;
  required?: boolean;
}

// ── API key guidance database ─────────────────────────────────────────────────

interface KeyGuide {
  title: string;
  steps: string[];
  url: string;
  urlLabel: string;
}

const KEY_GUIDES: Record<string, KeyGuide> = {
  GMAIL_API_KEY: {
    title: 'How to get a Gmail API key',
    steps: [
      'Go to Google Cloud Console → Create a project',
      'Enable the Gmail API under "APIs & Services"',
      'Create credentials → OAuth 2.0 Client ID (Desktop app)',
      'Download the JSON and run the OAuth flow to get an access token',
      'Paste your access token below',
    ],
    url: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
    urlLabel: 'Open Google Cloud Console →',
  },
  GMAIL_ACCESS_TOKEN: {
    title: 'How to get a Gmail access token',
    steps: [
      'Go to Google Cloud Console and enable Gmail API',
      'Create OAuth 2.0 credentials (Desktop app type)',
      'Use the OAuth Playground or a local script to get an access token',
      'The token grants ThinkDrop read-only access to your Gmail',
    ],
    url: 'https://developers.google.com/oauthplayground',
    urlLabel: 'Open OAuth Playground →',
  },
  GMAIL_CLIENT_ID: {
    title: 'How to get Gmail OAuth Client ID',
    steps: [
      'Go to Google Cloud Console → APIs & Services → Credentials',
      'Click "Create Credentials" → OAuth 2.0 Client IDs',
      'Set application type to "Desktop app"',
      'Copy the Client ID shown — it ends in .apps.googleusercontent.com',
    ],
    url: 'https://console.cloud.google.com/apis/credentials',
    urlLabel: 'Open Google Credentials →',
  },
  GMAIL_CLIENT_SECRET: {
    title: 'How to get Gmail OAuth Client Secret',
    steps: [
      'In Google Cloud Console → Credentials, find your OAuth 2.0 client',
      'Click the pencil/edit icon',
      'Copy the "Client Secret" value shown',
    ],
    url: 'https://console.cloud.google.com/apis/credentials',
    urlLabel: 'Open Google Credentials →',
  },
  GMAIL_REFRESH_TOKEN: {
    title: 'How to get a Gmail Refresh Token',
    steps: [
      'Use the OAuth Playground: select Gmail API v1 scope',
      'Authorize with your Google account',
      'Exchange authorization code for tokens',
      'Copy the "Refresh token" — it stays valid until revoked',
    ],
    url: 'https://developers.google.com/oauthplayground',
    urlLabel: 'Open OAuth Playground →',
  },
  TWILIO_ACCOUNT_SID: {
    title: 'How to get your Twilio Account SID',
    steps: [
      'Sign up at twilio.com (free trial available)',
      'Go to Console Dashboard',
      'Copy your "Account SID" — starts with AC...',
    ],
    url: 'https://www.twilio.com/console',
    urlLabel: 'Open Twilio Console →',
  },
  TWILIO_AUTH_TOKEN: {
    title: 'How to get your Twilio Auth Token',
    steps: [
      'In Twilio Console Dashboard, click "Show" next to Auth Token',
      'Copy the auth token — keep it secret',
    ],
    url: 'https://www.twilio.com/console',
    urlLabel: 'Open Twilio Console →',
  },
  TWILIO_FROM_NUMBER: {
    title: 'How to get a Twilio phone number',
    steps: [
      'In Twilio Console → Phone Numbers → Manage → Buy a number',
      'Get a free trial number (starts with +1...)',
      'Copy the number in E.164 format: +15551234567',
    ],
    url: 'https://www.twilio.com/console/phone-numbers/search',
    urlLabel: 'Get a Twilio number →',
  },
  SMS_API_KEY: {
    title: 'How to get an SMS API key',
    steps: [
      'ThinkDrop uses Twilio for SMS — sign up at twilio.com',
      'Free trial includes a phone number and $15 credit',
      'You will need: Account SID, Auth Token, and a Twilio phone number',
    ],
    url: 'https://www.twilio.com/try-twilio',
    urlLabel: 'Sign up for Twilio →',
  },
};

// ── Step icon — matches AutomationProgress StepIcon exactly ──────────────────

type StepState = 'pending' | 'running' | 'done' | 'failed' | 'paused';

function StepIcon({ status }: { status: StepState }) {
  if (status === 'done') return (
    <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
      style={{ backgroundColor: '#22c55e' }}>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </div>
  );
  if (status === 'failed') return (
    <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
      style={{ backgroundColor: '#ef4444' }}>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </div>
  );
  if (status === 'running') return (
    <div className="flex-shrink-0 w-4 h-4 rounded-full border-2 animate-spin"
      style={{ borderColor: '#60a5fa', borderTopColor: 'transparent' }} />
  );
  if (status === 'paused') return (
    <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
      style={{ backgroundColor: 'rgba(249,115,22,0.2)', border: '1.5px solid #f97316' }}>
      <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#f97316' }} />
    </div>
  );
  return (
    <div className="flex-shrink-0 w-4 h-4 rounded-full border-2"
      style={{ borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'rgba(255,255,255,0.03)' }} />
  );
}

// ── Skill badge — same as AutomationProgress ─────────────────────────────────

function SkillBadge({ label, color = '#93c5fd', bg = 'rgba(59,130,246,0.15)', border = 'rgba(59,130,246,0.25)' }:
  { label: string; color?: string; bg?: string; border?: string }) {
  return (
    <span className="text-xs font-mono px-1.5 py-0.5 rounded"
      style={{ backgroundColor: bg, color, border: `1px solid ${border}` }}>
      {label}
    </span>
  );
}

// ── Pipeline step definitions ─────────────────────────────────────────────────

const PIPELINE: { phase: BuildPhase; label: string; badge: string }[] = [
  { phase: 'fetching',   label: 'Fetch template',        badge: 'fetch'    },
  { phase: 'building',   label: 'Draft skill',           badge: 'draft'    },
  { phase: 'validating', label: 'Validate',              badge: 'validate' },
  { phase: 'fixing',     label: 'Fix issues',            badge: 'fix'      },
  { phase: 'installing', label: 'Install',               badge: 'install'  },
];

const PHASE_ORDER: BuildPhase[] = ['fetching', 'building', 'validating', 'fixing', 'installing', 'done'];

function phaseToStepState(stepPhase: BuildPhase, currentPhase: BuildPhase): StepState {
  if (currentPhase === 'error') {
    const stepIdx = PHASE_ORDER.indexOf(stepPhase);
    const curIdx  = PHASE_ORDER.indexOf(currentPhase);
    return stepIdx < curIdx ? 'done' : stepIdx === curIdx ? 'failed' : 'pending';
  }
  if (currentPhase === 'asking' && stepPhase === 'installing') return 'paused';
  const stepIdx = PHASE_ORDER.indexOf(stepPhase);
  const curIdx  = PHASE_ORDER.indexOf(currentPhase);
  if (currentPhase === 'done') return 'done';
  if (stepIdx < curIdx) return 'done';
  if (stepIdx === curIdx) return 'running';
  return 'pending';
}

// ── API Key Guidance panel ────────────────────────────────────────────────────

function ApiKeyGuide({ secretKey, onOpenUrl }: { secretKey: string; onOpenUrl: (url: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const guide = KEY_GUIDES[secretKey];
  if (!guide) return null;

  return (
    <div style={{ borderRadius: 8, border: '1px solid rgba(99,102,241,0.2)', overflow: 'hidden' }}>
      <button
        onClick={() => setExpanded(p => !p)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
          background: 'rgba(99,102,241,0.07)', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '0.65rem' }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontSize: '0.68rem', color: '#a5b4fc', fontWeight: 600 }}>
          {guide.title}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.2)' }}>
          <ol style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {guide.steps.map((step, i) => (
              <li key={i} style={{ fontSize: '0.67rem', color: '#9ca3af', lineHeight: 1.5 }}>{step}</li>
            ))}
          </ol>
          <button
            onClick={() => onOpenUrl(guide.url)}
            style={{
              marginTop: 8, padding: '4px 10px', borderRadius: 6, fontSize: '0.67rem', cursor: 'pointer',
              background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.35)',
              color: '#a5b4fc', display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            {guide.urlLabel}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  state: SkillBuildState;
  onAnswer?: (answer: string) => void;
  onCancel?: () => void;
  onOpenUrl?: (url: string) => void;
}

type SetupMode = 'choose' | 'guided' | 'auto' | 'developer';

export default function SkillBuildProgress({ state, onAnswer, onCancel, onOpenUrl }: Props) {
  const [userInput, setUserInput] = useState('');
  const [setupMode, setSetupMode] = useState<SetupMode>('choose');
  const [editedDraft, setEditedDraft] = useState<string>('');
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [scannedFieldValues, setScannedFieldValues] = useState<Record<string, string>>({});
  const {
    phase, skillDisplayName, round, maxRounds,
    rounds, question, keyLabel, serviceContext, options, error, installedPath, tokenCount, draft,
    autoSetupFailed, scannedFields,
  } = state;

  // currentSecretKey comes from state.skillBuildCurrentSecretKey via the SkillBuildState
  const currentSecretKey = (state as any).skillBuildCurrentSecretKey || '';

  // When browser.agent OAuth fallback fires, switch to guided mode automatically
  useEffect(() => {
    if (autoSetupFailed && setupMode === 'auto') {
      setSetupMode('guided');
    }
  }, [autoSetupFailed]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenUrl = (url: string) => {
    if (onOpenUrl) onOpenUrl(url);
    else (window as any).electron?.ipcRenderer?.send('shell:open-url', { url });
  };

  if (phase === 'idle') return null;

  const isActive  = phase !== 'done' && phase !== 'error';
  const isDone    = phase === 'done';
  const isError   = phase === 'error';
  const isAsking  = phase === 'asking';
  const doneCount = PIPELINE.filter(s => phaseToStepState(s.phase, phase) === 'done').length;
  const total     = PIPELINE.length;

  return (
    <div className="space-y-3">

      {/* ── Phase header — mirrors AutomationProgress header ───────────────── */}
      <div className="flex items-center gap-2">
        {isActive && !isAsking && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#60a5fa', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#60a5fa' }}>
              Building skill…
            </span>
          </>
        )}
        {isAsking && (
          <>
            <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(249,115,22,0.2)', border: '1.5px solid #f97316' }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#f97316' }} />
            </div>
            <span className="text-sm font-medium" style={{ color: '#f97316' }}>
              Input required to continue
            </span>
          </>
        )}
        {isDone && (
          <>
            <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
              style={{ backgroundColor: '#22c55e' }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
                strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <span className="text-sm font-medium" style={{ color: '#22c55e' }}>
              Skill installed
            </span>
          </>
        )}
        {isError && (
          <>
            <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
              style={{ backgroundColor: '#ef4444' }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
                strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </div>
            <span className="text-sm font-medium" style={{ color: '#f87171' }}>
              Build failed
            </span>
          </>
        )}

        {/* Spacer + skill name + step counter */}
        <div className="flex-1" />
        <span style={{ color: '#c4b5fd', fontSize: '0.68rem', fontFamily: 'ui-monospace,monospace', fontWeight: 600 }}>
          {skillDisplayName}
        </span>
        {isActive && (
          <span style={{ color: '#4b5563', fontSize: '0.66rem' }}>
            {doneCount} / {total}
          </span>
        )}
        {isActive && (
          <button onClick={onCancel}
            style={{
              background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5,
              cursor: 'pointer', color: '#6b7280', fontSize: '0.65rem', padding: '2px 7px',
            }}>
            Cancel
          </button>
        )}
      </div>


      {/* ── Multi-round fix banner ─────────────────────────────────────────── */}
      {round > 1 && isActive && !isAsking && (
        <div style={{ padding: '10px 14px', borderRadius: 10, backgroundColor: '#1a1108',
          border: '1px solid #c2410c', position: 'sticky', top: 0, zIndex: 10 }}>
          <div className="flex items-center gap-2.5">
            <div className="w-3 h-3 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#fb923c', borderTopColor: 'transparent' }} />
            <div>
              <div style={{ color: '#fdba74', fontSize: '0.75rem', fontWeight: 600 }}>
                Self-healing — fix cycle {round} / {maxRounds}
              </div>
              <div style={{ color: '#a3a3a3', fontSize: '0.68rem', marginTop: 2 }}>
                Validator found issues — Creator Agent applying fixes now.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Pipeline step list — vertical, matches AutomationProgress rows ─── */}
      <div className="space-y-2">
        {PIPELINE.map((step) => {
          const status = phaseToStepState(step.phase, phase);
          const isRunning = status === 'running';
          const isDoneStep = status === 'done';
          const isPaused = status === 'paused';
          const isFailed = status === 'failed';
          const isPending = status === 'pending';

          // Find validation round data for this step
          const roundData = step.phase === 'validating' || step.phase === 'fixing'
            ? rounds.filter(r => step.phase === 'fixing' ? r.fixed : !r.fixed || isDoneStep)
            : [];

          return (
            <div key={step.phase} style={{
              borderRadius: 8, padding: '8px 10px',
              backgroundColor: isRunning ? 'rgba(96,165,250,0.06)'
                : isPaused ? 'rgba(249,115,22,0.06)'
                : isDoneStep ? 'rgba(255,255,255,0.02)'
                : isFailed ? 'rgba(239,68,68,0.06)'
                : 'rgba(255,255,255,0.015)',
              border: `1px solid ${
                isRunning ? 'rgba(96,165,250,0.2)'
                : isPaused ? 'rgba(249,115,22,0.3)'
                : isDoneStep ? 'rgba(255,255,255,0.06)'
                : isFailed ? 'rgba(239,68,68,0.2)'
                : 'rgba(255,255,255,0.04)'
              }`,
              opacity: isPending ? 0.45 : 1,
              transition: 'all 0.15s',
            }}>
              <div className="flex items-center gap-2.5">
                <StepIcon status={status} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <SkillBadge
                      label={step.badge}
                      color={isDoneStep ? '#86efac' : isRunning ? '#93c5fd' : isPaused ? '#fb923c' : isFailed ? '#fca5a5' : '#6b7280'}
                      bg={isDoneStep ? 'rgba(34,197,94,0.12)' : isRunning ? 'rgba(59,130,246,0.12)' : isPaused ? 'rgba(249,115,22,0.12)' : isFailed ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.04)'}
                      border={isDoneStep ? 'rgba(34,197,94,0.3)' : isRunning ? 'rgba(59,130,246,0.25)' : isPaused ? 'rgba(249,115,22,0.35)' : isFailed ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.08)'}
                    />
                    <span style={{
                      fontSize: '0.71rem', color: isRunning ? '#e5e7eb' : isDoneStep ? '#9ca3af' : isPaused ? '#fb923c' : '#6b7280',
                    }}>
                      {step.label}
                    </span>
                    {/* Token counter while building */}
                    {isRunning && step.phase === 'building' && tokenCount != null && tokenCount > 0 && (
                      <span style={{
                        fontSize: '0.62rem', color: '#4b5563', fontFamily: 'ui-monospace,monospace',
                        background: 'rgba(255,255,255,0.04)', padding: '1px 5px', borderRadius: 4,
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}>
                        {tokenCount} tokens
                      </span>
                    )}
                    {/* Round badge */}
                    {(step.phase === 'fixing' || (step.phase === 'validating' && round > 1)) && round > 1 && (
                      <span style={{
                        fontSize: '0.6rem', color: '#f59e0b', background: 'rgba(245,158,11,0.1)',
                        padding: '1px 5px', borderRadius: 4, border: '1px solid rgba(245,158,11,0.2)',
                      }}>
                        round {round}
                      </span>
                    )}
                  </div>

                  {/* Validation issues inline */}
                  {rounds.length > 0 && (step.phase === 'validating' || step.phase === 'fixing') && roundData.length === 0 && (
                    rounds.slice(-1).map(r => (
                      <div key={r.round} style={{ marginTop: 5 }}>
                        {r.issues.map((issue, ii) => (
                          <div key={ii} className="flex items-start gap-1.5" style={{ marginTop: 3 }}>
                            <span style={{
                              fontSize: '0.63rem', flexShrink: 0, marginTop: 1,
                              color: issue.severity === 'error' ? '#f87171' : issue.severity === 'warning' ? '#f59e0b' : '#6b7280',
                            }}>
                              {issue.severity === 'error' ? '✕' : issue.severity === 'warning' ? '△' : 'ℹ'}
                            </span>
                            <span style={{
                              fontSize: '0.65rem', lineHeight: 1.4,
                              color: issue.severity === 'error' ? '#fca5a5' : issue.severity === 'warning' ? '#fcd34d' : '#6b7280',
                            }}>
                              {issue.line != null && (
                                <span style={{ fontFamily: 'ui-monospace,monospace', opacity: 0.55, marginRight: 4 }}>L{issue.line}</span>
                              )}
                              {issue.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))
                  )}

                  {/* Done: show issue count summary */}
                  {isDoneStep && step.phase === 'validating' && rounds.length > 0 && (
                    <div style={{ marginTop: 3, fontSize: '0.65rem', color: '#4b5563' }}>
                      {rounds[rounds.length - 1].issues.length === 0
                        ? 'No issues'
                        : `${rounds[rounds.length - 1].issues.length} issue${rounds[rounds.length - 1].issues.length !== 1 ? 's' : ''} — ${rounds[rounds.length - 1].fixed ? 'resolved' : 'no errors'}`
                      }
                    </div>
                  )}

                  {/* Done: installed path */}
                  {isDoneStep && step.phase === 'installing' && installedPath && (
                    <div style={{ marginTop: 3, fontSize: '0.63rem', color: '#4b5563', fontFamily: 'ui-monospace,monospace',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {installedPath}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Collapsible code view (draft) ─────────────────────────────────── */}
      {(draft || phase === 'building' || phase === 'fixing') && (
        <div style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,0.07)', overflow: 'hidden' }}>
          <button
            onClick={() => setCodeExpanded(p => !p)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 10px', background: 'rgba(255,255,255,0.03)',
              border: 'none', cursor: 'pointer', textAlign: 'left',
            }}
          >
            {(phase === 'building' || phase === 'fixing') && !draft ? (
              <div className="w-3 h-3 rounded-full border-2 animate-spin flex-shrink-0"
                style={{ borderColor: '#60a5fa', borderTopColor: 'transparent' }} />
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" strokeLinecap="round"
                style={{ transition: 'transform 0.15s', transform: codeExpanded ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0 }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            )}
            <span style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace,monospace' }}>
              {phase === 'building' ? 'Generating code…'
                : phase === 'fixing' ? 'Applying fixes…'
                : draft ? `View generated code (${draft.length} chars)` : 'Code'}
            </span>
            {tokenCount != null && tokenCount > 0 && (phase === 'building' || phase === 'fixing') && (
              <span style={{
                marginLeft: 'auto', fontSize: '0.6rem', color: '#6b7280',
                fontFamily: 'ui-monospace,monospace', background: 'rgba(255,255,255,0.04)',
                padding: '1px 5px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.06)',
              }}>
                {tokenCount} tokens
              </span>
            )}
          </button>
          {codeExpanded && draft && (
            <pre
              style={{
                margin: 0, padding: '10px 12px', fontSize: '0.62rem', lineHeight: 1.6,
                fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre-wrap',
                wordBreak: 'break-all', background: 'rgba(0,0,0,0.35)',
                maxHeight: 280, overflowY: 'auto', color: '#e5e7eb',
              }}
              dangerouslySetInnerHTML={{ __html: highlightJS(draft) }}
            />
          )}
        </div>
      )}

      {/* ── Secret setup — 3-mode card ──────────────────────────────────────── */}
      {isAsking && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 12 }}>

          {/* Header: what is needed and for which service */}
          <div style={{ padding: '10px 12px', borderRadius: 9,
            background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span style={{ color: '#fbbf24', fontSize: '0.72rem', fontWeight: 600 }}>
                Secret required to install
              </span>
            </div>
            <div style={{ color: '#d1d5db', fontSize: '0.7rem', lineHeight: 1.5 }}>
              {serviceContext ? (
                <><span style={{ color: '#e5e7eb', fontWeight: 600 }}>{serviceContext}</span>{' — '}</>
              ) : null}
              {keyLabel ? (
                <><span style={{ color: '#a5b4fc', fontFamily: 'ui-monospace,monospace', fontSize: '0.68rem',
                  background: 'rgba(99,102,241,0.12)', padding: '1px 5px', borderRadius: 3 }}>{keyLabel}</span>{' '}
                </>
              ) : null}
              <span style={{ color: '#9ca3af' }}>{question || 'Required by the skill. Will be stored securely in macOS Keychain.'}</span>
            </div>
          </div>

          {/* Mode chooser */}
          {setupMode === 'choose' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Option 1: Guided (Recommended) */}
              <button
                onClick={() => setSetupMode('guided')}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                  borderRadius: 9, border: '1px solid rgba(34,197,94,0.3)',
                  background: 'rgba(34,197,94,0.06)', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
                </svg>
                <div>
                  <div style={{ color: '#4ade80', fontSize: '0.72rem', fontWeight: 600, marginBottom: 2 }}>
                    Step-by-step guide
                    <span style={{ marginLeft: 6, fontSize: '0.6rem', color: '#86efac',
                      background: 'rgba(34,197,94,0.15)', padding: '1px 5px', borderRadius: 3, fontWeight: 400 }}>
                      Recommended
                    </span>
                  </div>
                  <div style={{ color: '#6b7280', fontSize: '0.67rem', lineHeight: 1.4 }}>
                    We walk you through getting {serviceContext ? `your ${serviceContext} credentials` : 'the required keys'} step by step.
                  </div>
                </div>
              </button>

              {/* Option 2: Auto-setup */}
              <button
                onClick={() => { setSetupMode('auto'); onAnswer?.('__auto_setup__'); }}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                  borderRadius: 9, border: '1px solid rgba(99,102,241,0.25)',
                  background: 'rgba(99,102,241,0.05)', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                  <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
                </svg>
                <div>
                  <div style={{ color: '#a5b4fc', fontSize: '0.72rem', fontWeight: 600, marginBottom: 2 }}>
                    Do it for me
                  </div>
                  <div style={{ color: '#6b7280', fontSize: '0.67rem', lineHeight: 1.4 }}>
                    ThinkDrop opens the browser and sets up{serviceContext ? ` ${serviceContext}` : ' the service'} for you automatically.
                  </div>
                </div>
              </button>

              {/* Option 3: Developer */}
              <button
                onClick={() => { setSetupMode('developer'); setEditedDraft(draft || ''); }}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                  borderRadius: 9, border: '1px solid rgba(107,114,128,0.2)',
                  background: 'rgba(107,114,128,0.04)', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                  <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                <div>
                  <div style={{ color: '#9ca3af', fontSize: '0.72rem', fontWeight: 600, marginBottom: 2 }}>
                    Edit the code yourself
                    <span style={{ marginLeft: 6, fontSize: '0.6rem', color: '#6b7280',
                      background: 'rgba(107,114,128,0.12)', padding: '1px 5px', borderRadius: 3, fontWeight: 400 }}>
                      Developers only
                    </span>
                  </div>
                  <div style={{ color: '#6b7280', fontSize: '0.67rem', lineHeight: 1.4 }}>
                    Edit the skill code directly — swap services, add your own logic, hardcode keys.
                  </div>
                </div>
              </button>
            </div>
          )}

          {/* ── Auto mode — browser OAuth in progress ────────────────────── */}
          {setupMode === 'auto' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 12 }}>
              <button onClick={() => setSetupMode('choose')}
                style={{ alignSelf: 'flex-start', fontSize: '0.65rem', color: '#6b7280',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                ← Back
              </button>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                borderRadius: 9, background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.25)',
              }}>
                <div className="w-4 h-4 rounded-full border-2 animate-spin flex-shrink-0"
                  style={{ borderColor: '#a5b4fc', borderTopColor: 'transparent' }} />
                <div>
                  <div style={{ color: '#a5b4fc', fontSize: '0.72rem', fontWeight: 600, marginBottom: 2 }}>
                    Opening browser…
                  </div>
                  <div style={{ color: '#6b7280', fontSize: '0.67rem', lineHeight: 1.4 }}>
                    ThinkDrop is setting up{serviceContext ? ` ${serviceContext}` : ' the service'} automatically.
                    A browser window will open — complete the sign-in and return here.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Guided mode ─────────────────────────────────────────────────── */}
          {setupMode === 'guided' && (() => {
            // Multi-field submit: pack all values as __fields__:{...} JSON so main.js
            // can store each field under its own keytar key
            const allFilled = scannedFields
              ? scannedFields.every(f => !f.required || (scannedFieldValues[f.name] || '').trim())
              : userInput.trim().length > 0;

            const handleSubmit = () => {
              if (!allFilled) return;
              if (scannedFields && scannedFields.length > 0) {
                const packed = '__fields__:' + JSON.stringify(scannedFieldValues);
                onAnswer?.(packed);
                setScannedFieldValues({});
              } else {
                onAnswer?.(userInput.trim());
                setUserInput('');
              }
              setSetupMode('choose');
            };

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 12 }}>
                <button onClick={() => setSetupMode('choose')}
                  style={{ alignSelf: 'flex-start', fontSize: '0.65rem', color: '#6b7280',
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  ← Back
                </button>
                {currentSecretKey && (
                  <ApiKeyGuide secretKey={currentSecretKey} onOpenUrl={handleOpenUrl} />
                )}
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
                ) : scannedFields && scannedFields.length > 0 ? (
                  /* ── Multi-field form from page scan ── */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {scannedFields.map((field, idx) => (
                      <div key={field.name} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <label style={{ color: '#9ca3af', fontSize: '0.65rem', fontWeight: 500 }}>
                          {field.label}{field.required && <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>}
                        </label>
                        <input
                          type={field.type === 'password' ? 'password' : field.type === 'email' ? 'email' : 'text'}
                          value={scannedFieldValues[field.name] || ''}
                          onChange={e => setScannedFieldValues(prev => ({ ...prev, [field.name]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter' && idx === scannedFields.length - 1) handleSubmit(); }}
                          placeholder={field.placeholder || field.label}
                          autoFocus={idx === 0}
                          style={{
                            padding: '5px 9px', borderRadius: 6, fontSize: '0.7rem',
                            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(99,102,241,0.35)',
                            color: '#e5e7eb', outline: 'none',
                          }}
                          onFocus={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.7)'; }}
                          onBlur={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.35)'; }}
                        />
                      </div>
                    ))}
                    <button
                      onClick={handleSubmit}
                      disabled={!allFilled}
                      style={{
                        marginTop: 2, padding: '5px 12px', borderRadius: 6, fontSize: '0.7rem', fontWeight: 600,
                        alignSelf: 'flex-end',
                        cursor: allFilled ? 'pointer' : 'not-allowed',
                        background: allFilled ? 'rgba(99,102,241,0.25)' : 'rgba(99,102,241,0.07)',
                        border: '1px solid rgba(99,102,241,0.4)',
                        color: allFilled ? '#a5b4fc' : '#4b5563',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Submit →
                    </button>
                  </div>
                ) : (
                  /* ── Single generic input fallback ── */
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="password"
                      value={userInput}
                      onChange={e => setUserInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && userInput.trim()) handleSubmit();
                      }}
                      placeholder={`Paste your ${keyLabel || 'API key'}…`}
                      autoFocus
                      style={{
                        flex: 1, padding: '5px 9px', borderRadius: 6, fontSize: '0.7rem',
                        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(99,102,241,0.35)',
                        color: '#e5e7eb', outline: 'none',
                      }}
                      onFocus={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.7)'; }}
                      onBlur={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.35)'; }}
                    />
                    <button
                      onClick={handleSubmit}
                      disabled={!allFilled}
                      style={{
                        padding: '5px 12px', borderRadius: 6, fontSize: '0.7rem', fontWeight: 600,
                        cursor: allFilled ? 'pointer' : 'not-allowed',
                        background: allFilled ? 'rgba(99,102,241,0.25)' : 'rgba(99,102,241,0.07)',
                        border: '1px solid rgba(99,102,241,0.4)',
                        color: allFilled ? '#a5b4fc' : '#4b5563',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Submit →
                    </button>
                  </div>
                )}
              </div>
            );
          })()}


          {/* ── Developer / edit code mode ───────────────────────────────────── */}
          {setupMode === 'developer' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 12 }}>
              <button onClick={() => setSetupMode('choose')}
                style={{ alignSelf: 'flex-start', fontSize: '0.65rem', color: '#6b7280',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                ← Back
              </button>
              <div style={{ color: '#9ca3af', fontSize: '0.68rem', lineHeight: 1.4 }}>
                Edit the skill code below. When done, click <span style={{ color: '#a5b4fc' }}>Save &amp; Install</span>.
              </div>
              <textarea
                value={editedDraft}
                onChange={e => setEditedDraft(e.target.value)}
                spellCheck={false}
                style={{
                  width: '100%', minHeight: 220, padding: '8px 10px',
                  borderRadius: 7, fontSize: '0.61rem', lineHeight: 1.6,
                  fontFamily: 'ui-monospace,monospace',
                  background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(99,102,241,0.25)',
                  color: '#e5e7eb', outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                }}
              />
              <button
                onClick={() => {
                  if (editedDraft.trim()) {
                    onAnswer?.('__edit_skill__:' + editedDraft.trim());
                    setSetupMode('choose');
                  }
                }}
                disabled={!editedDraft.trim()}
                style={{
                  padding: '6px 14px', borderRadius: 7, fontSize: '0.72rem', fontWeight: 600,
                  cursor: editedDraft.trim() ? 'pointer' : 'not-allowed',
                  background: editedDraft.trim() ? 'rgba(99,102,241,0.2)' : 'rgba(99,102,241,0.06)',
                  border: '1px solid rgba(99,102,241,0.4)',
                  color: editedDraft.trim() ? '#a5b4fc' : '#4b5563',
                }}
              >
                Save &amp; Install →
              </button>
            </div>
          )}

        </div>
      )}

      {/* ── Done summary ─────────────────────────────────────────────────────── */}
      {isDone && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div className="px-3 py-2 rounded-lg text-xs flex items-center gap-2"
            style={{ backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#86efac' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Skill installed successfully
            {installedPath && (
              <span style={{ color: '#4b5563', fontFamily: 'ui-monospace,monospace', fontSize: '0.6rem', marginLeft: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                {installedPath}
              </span>
            )}
          </div>
          {/* Smoke test result */}
          {state.smokeTest && (
            <div className="px-3 py-2 rounded-lg text-xs flex items-start gap-2" style={{
              backgroundColor: state.smokeTest.ok ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${state.smokeTest.ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.2)'}`,
              color: state.smokeTest.ok ? '#86efac' : '#fca5a5',
            }}>
              <span style={{ flexShrink: 0 }}>{state.smokeTest.ok ? '✓' : '✕'}</span>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 1 }}>
                  Smoke test {state.smokeTest.ok ? 'passed' : 'failed'}
                </div>
                {(state.smokeTest.output || state.smokeTest.error) && (
                  <div style={{ color: state.smokeTest.ok ? '#4ade80' : '#f87171', fontFamily: 'ui-monospace,monospace',
                    fontSize: '0.6rem', opacity: 0.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {state.smokeTest.output || state.smokeTest.error}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Error banner ─────────────────────────────────────────────────────── */}
      {isError && error && (
        <div className="px-3 py-2 rounded-lg text-xs"
          style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderLeft: '3px solid #ef4444', color: '#fca5a5' }}>
          {error}
        </div>
      )}
    </div>
  );
}
