import React, { useState } from 'react';
import type { ScreenOutput } from './types';

/**
 * AlertCurtain — full-screen severity chrome for kind:'alert'.
 *
 * The protection surface: an opaque curtain (black default, white for the
 * child-safety use-case), large severity icon, title, and message. When
 * `blocking` is set, the curtain is clickable to dismiss — main.js has
 * already lifted click-through — and a hint reminds the user Esc works too.
 * `block` severity adds a pulsing border; `info`/`warn` stay calmer.
 *
 * `locked` curtains (guardian passcode-gated blocks) replace the dismiss
 * affordances entirely: no click-out, no Esc chip, no "press Esc" hint — a
 * password field verified in main via rules:guardian:unlock is the only way
 * down. The hash never reaches the renderer.
 */

const ipcRenderer = (window as any).electron?.ipcRenderer;

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
  const locked = output.locked === true;

  return (
    <div
      onClick={blocking && !locked ? onDismiss : undefined}
      role={blocking && !locked ? 'button' : undefined}
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
        cursor: blocking && !locked ? 'pointer' : 'default',
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

      {locked
        ? <UnlockForm output={output} dark={dark} accent={sev.accent} />
        : blocking && (
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

/** Passcode form for locked curtains — the only dismissal path. Submits to
 *  main's rules:guardian:unlock which verifies the hash, stamps the re-arm
 *  grace and force-clears; this component only renders the outcome. */
function UnlockForm({ output, dark, accent }: { output: ScreenOutput; dark: boolean; accent: string }) {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !pass) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ipcRenderer?.invoke('rules:guardian:unlock', { id: output.id, pass });
      if (!res?.ok) {
        setError(res?.throttled ? 'Too many attempts — try again shortly.' : 'Incorrect passcode.');
        setPass('');
      }
      // ok → main force-clears the display; nothing to do here.
    } catch (_) {
      setError('Could not verify the passcode.');
    } finally {
      setBusy(false);
    }
  };

  const inputBg = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const inputFg = dark ? '#f3f4f6' : '#111827';
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        marginTop: 26,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ color: accent, fontSize: 15, fontWeight: 600, letterSpacing: '0.04em' }}>
        Guardian passcode required to dismiss
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <input
          type="password"
          autoFocus
          value={pass}
          disabled={busy}
          placeholder="Passcode"
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          style={{
            padding: '12px 18px',
            width: 240,
            borderRadius: 10,
            border: `1px solid ${accent}88`,
            background: inputBg,
            color: inputFg,
            fontSize: 16,
            outline: 'none',
            textAlign: 'center',
            letterSpacing: '0.1em',
          }}
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !pass}
          style={{
            padding: '12px 22px',
            borderRadius: 10,
            border: 'none',
            background: accent,
            color: '#0b0f14',
            fontSize: 15,
            fontWeight: 700,
            cursor: busy || !pass ? 'default' : 'pointer',
            opacity: busy || !pass ? 0.5 : 1,
          }}
        >
          {busy ? '…' : 'Unlock'}
        </button>
      </div>
      {error && (
        <div style={{ color: accent, fontSize: 14, fontWeight: 600 }}>{error}</div>
      )}
    </div>
  );
}
