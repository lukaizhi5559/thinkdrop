import type { ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';

/**
 * EmojiGlyph — the big emotive glyph.
 *
 * Used standalone for kind:'emoji' (a solo 🙂 fading in/out — "emotion as
 * output") and as the accent emoji alongside text/image/alert content.
 * Glows in the mood accent color.
 */
export function EmojiGlyph({ emoji, accent, size = 160, animateClass = '' }: {
  emoji: string;
  accent: string;
  size?: number;
  animateClass?: string;
}) {
  return (
    <div
      className={animateClass}
      style={{
        fontSize: size,
        lineHeight: 1,
        filter: `drop-shadow(0 0 24px ${accent}88) drop-shadow(0 0 60px ${accent}44)`,
        userSelect: 'none',
      }}
    >
      {emoji}
    </div>
  );
}

/**
 * EmojiScreen — kind:'emoji' full display: hero glyph + optional caption.
 */
export function EmojiScreen({ output, animateClass }: { output: ScreenOutput; animateClass: string }) {
  const accent = MOOD_ACCENT[output.mood] || MOOD_ACCENT.neutral;
  return (
    <div className={animateClass} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
      <EmojiGlyph emoji={output.emoji!} accent={accent} size={200} />
      {output.text && (
        <div
          style={{
            color: '#e5e7eb',
            fontSize: 22,
            fontWeight: 600,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            textShadow: `0 0 16px ${accent}55`,
            maxWidth: '70vw',
            textAlign: 'center',
          }}
        >
          {output.text}
        </div>
      )}
      {output.title && !output.text && (
        <div style={{ color: '#e5e7eb', fontSize: 22, fontWeight: 600, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          {output.title}
        </div>
      )}
    </div>
  );
}
