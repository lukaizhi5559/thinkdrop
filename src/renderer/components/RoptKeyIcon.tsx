/**
 * RoptKeyIcon — visual cue for the global Option-key gesture model.
 *
 * Two variants:
 *  - keycap (default <28px / detail:'icon'): single lit keycap with a real ⌥
 *    glyph + an R/L corner badge — legible at legend/pill sizes.
 *  - deck   (detail:'full' or size ≥28): mini keyboard bottom row with the
 *    chosen Option key lit — the onboarding/empty-state art.
 *
 * tone:   'blue' idle hint · 'amber' held/active PTT
 * pulse:  animated ring while PTT is held
 * side:   'right' = action key (default) · 'left' = cancel key
 * mod:    'option' = ⌥ keycap (default) · 'shift' = ⇧ keycap (expand/history modifier)
 */

interface RoptKeyIconProps {
  size?: number;
  tone?: 'blue' | 'amber';
  pulse?: boolean;
  detail?: 'auto' | 'icon' | 'full';
  side?: 'right' | 'left';
  mod?: 'option' | 'shift';
}

const TONES = {
  blue:  { keyFill: 'rgba(59,130,246,0.35)',  keyStroke: '#60a5fa', glow: 'rgba(59,130,246,0.45)' },
  amber: { keyFill: 'rgba(251,191,36,0.35)',  keyStroke: '#fbbf24', glow: 'rgba(251,191,36,0.45)' },
};

export default function RoptKeyIcon({ size = 22, tone = 'blue', pulse = false, detail = 'auto', side = 'right', mod = 'option' }: RoptKeyIconProps) {
  const t = TONES[tone];
  const deck = detail === 'full' || (detail === 'auto' && size >= 28);
  const h = deck ? (size * 36) / 56 : (size * 18) / 24;
  const glyph = side === 'right' ? 'R' : 'L';
  const modGlyph = mod === 'shift' ? '⇧' : '⌥';
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: size, height: h, flexShrink: 0 }}>
      {pulse && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: -3,
            borderRadius: 8,
            border: `1.5px solid ${t.glow}`,
            animation: 'ropt-pulse 1.1s ease-in-out infinite',
          }}
        />
      )}
      {deck ? (
        <svg width={size} height={h} viewBox="0 0 56 36" fill="none" aria-hidden="true">
          {/* keyboard deck */}
          <rect x="1" y="1" width="54" height="34" rx="7"
            fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.14)" />
          {/* faint top row */}
          <rect x="7"     y="6.5" width="7" height="6" rx="2" fill="rgba(255,255,255,0.05)" />
          <rect x="16.75" y="6.5" width="7" height="6" rx="2" fill="rgba(255,255,255,0.05)" />
          <rect x="26.5"  y="6.5" width="7" height="6" rx="2" fill="rgba(255,255,255,0.05)" />
          <rect x="36.25" y="6.5" width="7" height="6" rx="2" fill="rgba(255,255,255,0.05)" />
          <rect x="46"    y="6.5" width="7" height="6" rx="2" fill="rgba(255,255,255,0.05)" />
          {/* bottom row: spacebar dim, the chosen Option key lit */}
          <rect x="7"  y="17" width="10" height="13" rx="3"
            fill={side === 'right' ? 'none' : t.keyFill}
            stroke={side === 'right' ? 'rgba(255,255,255,0.18)' : t.keyStroke} />
          <rect x="20" y="21" width="16" height="6"  rx="2.5" fill="none" stroke="rgba(255,255,255,0.18)" />
          <rect x="39" y="17" width="10" height="13" rx="3"
            fill={side === 'right' ? t.keyFill : 'none'}
            stroke={side === 'right' ? t.keyStroke : 'rgba(255,255,255,0.18)'} />
          <path d={side === 'right' ? "M41.5 25.5h2l1.5-4h2" : "M9.5 25.5h2l1.5-4h2"}
            stroke="#fff" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width={size} height={h} viewBox="0 0 24 18" fill="none" aria-hidden="true">
          {/* single lit keycap: ⌥/⇧ glyph + R/L badge */}
          <rect x="0.5" y="0.5" width="23" height="17" rx="4" fill={t.keyFill} stroke={t.keyStroke} />
          <text x="9.5" y="13" textAnchor="middle" fontSize="12" fill="#fff"
            fontFamily="system-ui, -apple-system, sans-serif">{modGlyph}</text>
          <text x="18.8" y="7.5" textAnchor="middle" fontSize="7.5" fontWeight="700" fill={t.keyStroke}
            fontFamily="system-ui, -apple-system, sans-serif">{glyph}</text>
        </svg>
      )}
      <style>{`
        @keyframes ropt-pulse {
          0%, 100% { opacity: 0.35; transform: scale(1); }
          50% { opacity: 0.9; transform: scale(1.05); }
        }
      `}</style>
    </span>
  );
}
