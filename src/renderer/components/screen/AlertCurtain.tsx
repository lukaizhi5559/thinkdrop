import type { ScreenOutput } from './types';

/**
 * AlertCurtain — full-screen severity chrome for kind:'alert'.
 *
 * The protection surface: an opaque curtain (black default, white for the
 * child-safety use-case), large severity icon, title, and message. When
 * `blocking` is set, the curtain is clickable to dismiss — main.js has
 * already lifted click-through — and a hint reminds the user Esc works too.
 * `block` severity adds a pulsing border; `info`/`warn` stay calmer.
 */

const SEVERITY_STYLE = {
  info:  { accent: '#60a5fa', icon: 'ℹ️', label: 'Notice' },
  warn:  { accent: '#fbbf24', icon: '⚠️', label: 'Warning' },
  block: { accent: '#f87171', icon: '⛔', label: 'Blocked' },
} as const;

export function AlertCurtain({ output, onDismiss }: { output: ScreenOutput; onDismiss?: () => void }) {
  const sev = SEVERITY_STYLE[output.severity || 'warn'] || SEVERITY_STYLE.warn;
  const dark = output.scrim !== 'white';
  const fg = dark ? '#f3f4f6' : '#111827';
  const blocking = output.blocking === true;

  return (
    <div
      onClick={blocking ? onDismiss : undefined}
      role={blocking ? 'button' : undefined}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 22,
        padding: 48,
        textAlign: 'center',
        cursor: blocking ? 'pointer' : 'default',
        animation: output.severity === 'block' ? 'alertPulse 1.6s ease-in-out infinite' : undefined,
        // Self-contained keyframes injected below.
      }}
    >
      <style>{`
        @keyframes alertPulse {
          0%, 100% { box-shadow: inset 0 0 0 6px ${sev.accent}66; }
          50%      { box-shadow: inset 0 0 0 10px ${sev.accent}cc; }
        }
      `}</style>

      <div style={{ fontSize: 110, lineHeight: 1, filter: `drop-shadow(0 0 24px ${sev.accent}88)` }}>
        {output.emoji || sev.icon}
      </div>

      <div style={{
        fontSize: 18, fontWeight: 800, letterSpacing: '0.3em', textTransform: 'uppercase',
        color: sev.accent, fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        {sev.label}
      </div>

      {output.title && (
        <div style={{
          color: fg, fontSize: 46, fontWeight: 800, lineHeight: 1.15,
          fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '75vw',
        }}>
          {output.title}
        </div>
      )}

      {output.text && (
        <div style={{
          color: dark ? '#d1d5db' : '#374151', fontSize: 26, fontWeight: 500,
          lineHeight: 1.4, fontFamily: 'system-ui, -apple-system, sans-serif',
          maxWidth: '65vw', whiteSpace: 'pre-wrap',
        }}>
          {output.text}
        </div>
      )}

      {blocking && (
        <div style={{
          marginTop: 26, padding: '10px 26px', borderRadius: 999,
          border: `1px solid ${sev.accent}88`, color: sev.accent,
          fontSize: 15, fontWeight: 600, letterSpacing: '0.04em',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: dark ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.35)',
        }}>
          Click anywhere or press Esc to dismiss
        </div>
      )}
    </div>
  );
}
