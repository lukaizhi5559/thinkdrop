import type { ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';
import { EmojiGlyph } from './EmojiGlyph';

/**
 * ImageScreen — kind:'image': a centered image card + caption on a scrim.
 * Sources: url (http/s) or dataUrl (local paths are converted to data URLs
 * by main.js before the payload arrives).
 */
export function ImageScreen({ output, animateClass }: { output: ScreenOutput; animateClass: string }) {
  const accent = MOOD_ACCENT[output.mood] || MOOD_ACCENT.neutral;
  const src = output.dataUrl || output.url;
  if (!src) return null;

  return (
    <div
      className={animateClass}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 20,
        maxWidth: '86vw',
        padding: 28,
        borderRadius: 24,
        background: 'rgba(8, 12, 20, 0.55)',
        border: `1px solid ${accent}44`,
        boxShadow: `0 8px 60px rgba(0,0,0,0.5), 0 0 40px ${accent}22`,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
    >
      {output.emoji && <EmojiGlyph emoji={output.emoji} accent={accent} size={64} />}
      <img
        src={src}
        alt={output.caption || output.title || ''}
        style={{
          maxWidth: '80vw',
          maxHeight: '72vh',
          objectFit: output.fit === 'cover' ? 'cover' : 'contain',
          borderRadius: 16,
          boxShadow: '0 4px 40px rgba(0,0,0,0.55)',
        }}
      />
      {(output.caption || output.title) && (
        <div
          style={{
            color: '#e5e7eb',
            fontSize: 20,
            fontWeight: 600,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            textAlign: 'center',
            maxWidth: '70vw',
          }}
        >
          {output.caption || output.title}
        </div>
      )}
    </div>
  );
}
