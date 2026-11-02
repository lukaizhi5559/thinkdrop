/**
 * IssuesTab — recorded ThinkDrop-internal failures (infrastructure errors
 * surfaced via SystemFailureCard's "Report issue").
 *
 * Lists records from ~/.thinkdrop/issues/issues.jsonl via issues:list IPC.
 * Newest first; dismissed records collapse under a toggle. GitHub filing is
 * intentionally not wired yet — each record carries what fileOnGitHub needs.
 */
import { useCallback, useEffect, useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface IssueRecord {
  id: string;
  ts: string;
  title: string;
  summary: string;
  detail: Record<string, any>;
  status: 'recorded' | 'dismissed' | 'filed';
  dismissedAt?: string;
  githubUrl?: string;
  app?: { version?: string | null; platform?: string; arch?: string };
}

const STATUS_STYLE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  recorded:  { label: 'Recorded',  color: '#fbbf24', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)' },
  filed:     { label: 'Filed',     color: '#4ade80', bg: 'rgba(74,222,128,0.08)',  border: 'rgba(74,222,128,0.25)' },
  dismissed: { label: 'Dismissed', color: '#9ca3af', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.08)' },
};

function _timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(diff)) return '';
  if (diff < 60000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function IssueCard({ issue, onDismiss }: { issue: IssueRecord; onDismiss: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = STATUS_STYLE[issue.status] || STATUS_STYLE.recorded;
  const d = issue.detail || {};
  const infra = d.infra || {};

  return (
    <div style={{
      borderRadius: 9,
      backgroundColor: cfg.bg,
      border: `1px solid ${cfg.border}`,
      overflow: 'hidden',
      opacity: issue.status === 'dismissed' ? 0.55 : 1,
    }}>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: cfg.color, marginTop: 4, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ color: '#e5e7eb', fontSize: '0.76rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {issue.title}
              </div>
              <span style={{
                marginLeft: 'auto', flexShrink: 0,
                fontSize: '0.58rem', fontWeight: 700, textTransform: 'uppercase',
                color: cfg.color, padding: '1px 6px', borderRadius: 4,
                backgroundColor: 'rgba(0,0,0,0.2)', border: `1px solid ${cfg.border}`,
              }}>{cfg.label}</span>
            </div>
            <div style={{ color: '#9ca3af', fontSize: '0.64rem', marginTop: 2 }}>
              {_timeAgo(issue.ts)} · {issue.id}
            </div>
            {issue.summary && (
              <div style={{ color: '#d1d5db', fontSize: '0.7rem', lineHeight: 1.45, marginTop: 6 }}>
                {issue.summary}
              </div>
            )}
            {(infra.service || d.skill || d.prompt) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {infra.service && <Chip label={`service: ${infra.service}`} />}
                {infra.signature && <Chip label={infra.signature} />}
                {d.skill && <Chip label={`step: ${d.skill}`} />}
              </div>
            )}
            {d.prompt && (
              <div style={{ color: '#abafb8', fontSize: '0.66rem', marginTop: 6, fontStyle: 'italic' }}>
                Task: {d.prompt.length > 140 ? d.prompt.slice(0, 140) + '…' : d.prompt}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button
            onClick={() => setExpanded(v => !v)}
            style={{ background: 'transparent', border: 'none', color: '#7dd3fc', fontSize: '0.66rem', cursor: 'pointer', padding: 0 }}
          >
            {expanded ? '▾ Hide details' : '▸ Diagnostics'}
          </button>
          {issue.status === 'recorded' && (
            <button
              onClick={() => onDismiss(issue.id)}
              style={{
                marginLeft: 'auto', padding: '3px 10px', borderRadius: 6,
                fontSize: '0.64rem', fontWeight: 600, cursor: 'pointer',
                color: '#9ca3af', backgroundColor: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              Dismiss
            </button>
          )}
          {issue.status === 'filed' && issue.githubUrl && (
            <button
              onClick={() => ipcRenderer?.send('shell:open-url', issue.githubUrl)}
              style={{
                marginLeft: 'auto', padding: '3px 10px', borderRadius: 6,
                fontSize: '0.64rem', fontWeight: 600, cursor: 'pointer',
                color: '#4ade80', backgroundColor: 'rgba(74,222,128,0.08)',
                border: '1px solid rgba(74,222,128,0.3)',
              }}
            >
              Open GitHub issue ↗
            </button>
          )}
        </div>

        {expanded && (
          <pre style={{
            marginTop: 8, padding: '8px 10px', borderRadius: 6,
            backgroundColor: 'rgba(0,0,0,0.3)',
            fontSize: '0.62rem', lineHeight: 1.5, color: '#9ca3af',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            maxHeight: 220, overflowY: 'auto',
          }}>
            {JSON.stringify({ ts: issue.ts, detail: issue.detail, app: issue.app }, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span style={{
      fontSize: '0.6rem', fontFamily: 'monospace',
      color: '#a3a3a3', padding: '1px 6px', borderRadius: 4,
      backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
    }}>{label}</span>
  );
}

export function IssuesTab() {
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDismissed, setShowDismissed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ipcRenderer?.invoke?.('issues:list');
      setIssues(Array.isArray(res?.issues) ? res.issues : []);
    } catch {
      setIssues([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const dismiss = async (id: string) => {
    try { await ipcRenderer?.invoke?.('issues:dismiss', { id }); } catch { /* keep list as-is */ }
    load();
  };

  const active = issues.filter(i => i.status !== 'dismissed');
  const dismissed = issues.filter(i => i.status === 'dismissed');
  const shown = showDismissed ? issues : active;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: '#e5e7eb', fontSize: '0.82rem', fontWeight: 700 }}>Issues</div>
          <div style={{ color: '#9ca3af', fontSize: '0.64rem', marginTop: 1 }}>
            ThinkDrop-internal failures logged for review. Reporting to GitHub is coming soon.
          </div>
        </div>
        <button
          onClick={load}
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: '0.66rem', fontWeight: 600,
            color: '#7dd3fc', backgroundColor: 'rgba(56,189,248,0.08)',
            border: '1px solid rgba(56,189,248,0.25)', cursor: 'pointer',
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div style={{ color: '#9ca3af', fontSize: '0.72rem', padding: '14px 0', textAlign: 'center' }}>Loading…</div>
      ) : shown.length === 0 ? (
        <div style={{
          padding: '20px 14px', borderRadius: 9, textAlign: 'center',
          backgroundColor: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.1)',
        }}>
          <div style={{ color: '#9ca3af', fontSize: '0.74rem', fontWeight: 600 }}>No issues recorded</div>
          <div style={{ color: '#6b7280', fontSize: '0.66rem', marginTop: 4, lineHeight: 1.5 }}>
            When something breaks on our side, hit "Report issue" on the failure card and it lands here.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(issue => <IssueCard key={issue.id} issue={issue} onDismiss={dismiss} />)}
        </div>
      )}

      {/* Dismissed toggle */}
      {!loading && dismissed.length > 0 && (
        <button
          onClick={() => setShowDismissed(v => !v)}
          style={{ background: 'transparent', border: 'none', color: '#6b7280', fontSize: '0.64rem', cursor: 'pointer', padding: '2px 0', alignSelf: 'center' }}
        >
          {showDismissed ? '▾ Hide dismissed' : `▸ Show ${dismissed.length} dismissed`}
        </button>
      )}
    </div>
  );
}

export default IssuesTab;
