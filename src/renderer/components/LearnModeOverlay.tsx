import React from 'react';

export interface LearnModeScanStats {
  totalElements: number;
  successful: number;
  failed: number;
  filtered: number;
  states: number;
  skillsGenerated: number;
  dataItems?: number;
  duration: number;
}

export interface LearnModeState {
  active: boolean;
  agentId: string | null;
  hostname: string | null;
  progress: number;
  message: string;
  discoveredStates: string[];
  startTime: number | null;
  authRequired: boolean;
  totalUrls?: number;
  currentUrlIndex?: number;
  scanStats?: LearnModeScanStats;
  requiresDismissal?: boolean;
}

interface LearnModeOverlayProps {
  learnMode: LearnModeState | null;
  onCancel: (agentId: string) => void;
  onDone: () => void;
}

function LearnModeOverlayImpl({ learnMode, onCancel, onDone }: LearnModeOverlayProps) {
  if (!learnMode) return null;

  return (
    <div style={{
      position: 'absolute',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.80)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
      pointerEvents: 'none',
    }}>
      <div style={{
        width: 320,
        padding: 28,
        backgroundColor: '#1f2937',
        borderRadius: 16,
        textAlign: 'center',
        boxShadow: learnMode.authRequired
          ? '0 0 0 2px #f59e0b, 0 25px 50px -12px rgba(0,0,0,0.6)'
          : '0 25px 50px -12px rgba(0,0,0,0.5)',
        border: learnMode.authRequired ? '1px solid rgba(245,158,11,0.5)' : '1px solid transparent',
        pointerEvents: 'auto',
        transition: 'box-shadow 0.3s ease, border 0.3s ease',
      }}>
        {learnMode.authRequired ? (
          <>
            {/* Auth required — prominent lock icon */}
            <div style={{
              fontSize: '3.5rem',
              marginBottom: 12,
              animation: 'pulse 1.2s ease-in-out infinite',
            }}>
              🔐
            </div>

            {/* ACTION REQUIRED badge */}
            <div style={{
              display: 'inline-block',
              padding: '3px 10px',
              borderRadius: 20,
              backgroundColor: 'rgba(245,158,11,0.2)',
              border: '1px solid rgba(245,158,11,0.5)',
              color: '#fbbf24',
              fontSize: '0.7rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
              marginBottom: 14,
            }}>
              ⚠️ Action Required
            </div>

            <h3 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '1.3rem', fontWeight: 700 }}>
              Sign in to {learnMode.hostname || 'the site'}
            </h3>

            <p style={{
              margin: '0 0 20px 0',
              color: '#d1d5db',
              fontSize: '0.9rem',
              lineHeight: 1.6,
            }}>
              A browser window is open and waiting.<br />
              Sign in with Google, Apple, or email —<br />
              this panel updates automatically once you're in.
            </p>
          </>
        ) : learnMode.requiresDismissal ? (
          <>
            {/* Completion state — scan summary with Done button */}
            <h3 style={{ margin: '0 0 8px 0', color: '#fff', fontSize: '1.1rem' }}>
              ✨ {learnMode.scanStats?.skillsGenerated || 0} Skills Created
            </h3>

            <p style={{ margin: '0 0 16px 0', color: '#9ca3af', fontSize: '0.85rem' }}>
              {learnMode.message || `Agent finished exploring ${learnMode.hostname || 'the site'}`}
            </p>

            {/* Completion summary stats */}
            {learnMode.scanStats && (
              <div style={{
                margin: '16px 0',
                padding: '12px',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: 8,
                textAlign: 'left',
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px', fontSize: '0.75rem', color: '#9ca3af' }}>
                  <div>Skills: <span style={{ color: '#3b82f6', fontWeight: 600 }}>{learnMode.scanStats.skillsGenerated}</span></div>
                  <div>Elements: <span style={{ color: '#fff' }}>{learnMode.scanStats.totalElements}</span></div>
                  <div>Successful: <span style={{ color: '#10b981' }}>{learnMode.scanStats.successful}</span></div>
                  <div>Filtered: <span style={{ color: '#f59e0b' }}>{learnMode.scanStats.filtered}</span></div>
                  <div>Failed: <span style={{ color: '#ef4444' }}>{learnMode.scanStats.failed}</span></div>
                  <div>States: <span style={{ color: '#fff' }}>{learnMode.scanStats.states}</span></div>
                </div>
                <div style={{ marginTop: '8px', fontSize: '0.7rem', color: '#6b7280' }}>
                  Duration: {learnMode.scanStats.duration}s
                </div>
              </div>
            )}

            {/* Done button */}
            <button
              onClick={onDone}
              style={{
                padding: '8px 24px',
                borderRadius: 6,
                border: 'none',
                backgroundColor: '#10b981',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 500,
                cursor: 'pointer',
                marginTop: 8,
              }}
            >
              Done
            </button>
          </>
        ) : (
          <>
            {/* Scanning — robot icon */}
            <div style={{
              fontSize: '3rem',
              marginBottom: 20,
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>
              🤖
            </div>

            <h3 style={{ margin: '0 0 8px 0', color: '#fff', fontSize: '1.1rem' }}>
              Learning Mode Active
            </h3>

            <p style={{ margin: '0 0 16px 0', color: '#9ca3af', fontSize: '0.85rem' }}>
              Agent is exploring {learnMode.hostname || 'domain'}...
            </p>

            {/* Progress bar */}
            <div style={{
              width: '100%',
              height: 6,
              backgroundColor: 'rgba(255,255,255,0.1)',
              borderRadius: 3,
              overflow: 'hidden',
              marginBottom: 12,
            }}>
              <div style={{
                width: `${learnMode.progress}%`,
                height: '100%',
                backgroundColor: '#f59e0b',
                borderRadius: 3,
                transition: 'width 0.3s ease',
              }} />
            </div>

            {/* Status message */}
            <p style={{ margin: '0 0 20px 0', color: '#6b7280', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={learnMode.message}>
              {learnMode.message}
            </p>

            {/* Discovered states count */}
            {learnMode.discoveredStates.length > 0 && (
              <p style={{ margin: '0 0 16px 0', color: '#10b981', fontSize: '0.7rem' }}>
                Discovered {learnMode.discoveredStates.length} states
              </p>
            )}

            {/* Cancel button */}
            <button
              onClick={() => {
                if (learnMode.agentId) onCancel(learnMode.agentId);
              }}
              style={{
                padding: '8px 20px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.2)',
                backgroundColor: 'transparent',
                color: '#9ca3af',
                fontSize: '0.8rem',
                cursor: 'pointer',
                marginTop: 4,
              }}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export const LearnModeOverlay = React.memo(LearnModeOverlayImpl);
export default LearnModeOverlay;
