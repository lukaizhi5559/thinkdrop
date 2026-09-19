/**
 * VoiceBars — animated voice lines for the overlay input area.
 *
 * Rendered in place of the textarea while a voice session is active:
 *   - listening  → bar height follows the live mic `level` (0..1)
 *   - speaking   → purple wave while the AI's TTS plays
 *   - processing → amber dim pulse
 *   - idle/ready → subtle blue idle wave
 */

interface VoiceBarsProps {
  state: string;      // 'ready' | 'listening' | 'speaking' | 'processing' | 'idle' | 'error'
  level?: number;     // 0..1 mic amplitude (listening only)
  count?: number;
}

const BAR_COUNT = 28;

// Deterministic per-bar factor so heights look organic, not uniform.
const barFactor = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return 0.35 + 0.65 * (x - Math.floor(x));
};

export default function VoiceBars({ state, level = 0, count = BAR_COUNT }: VoiceBarsProps) {
  const color =
    state === 'speaking' ? '#c084fc' :
    state === 'processing' ? '#fbbf24' :
    state === 'error' ? '#f87171' :
    '#60a5fa';

  const animated = state === 'speaking' || state === 'ready' || state === 'idle' || state === 'processing';

  return (
    <div
      aria-label={`voice-${state}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '3px',
        height: '28px',
        padding: '2px 4px',
        marginBottom: '4px',
      }}
    >
      {Array.from({ length: count }, (_, i) => {
        const f = barFactor(i);
        // Listening: live amplitude. Animated states: base height, CSS does the motion.
        const h = state === 'listening'
          ? 4 + Math.round(Math.min(1, level) * 20 * f)
          : 4 + Math.round(10 * f);
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              width: '3px',
              height: `${h}px`,
              borderRadius: '1.5px',
              backgroundColor: color,
              opacity: state === 'processing' ? 0.7 : 0.9,
              transition: 'height 90ms ease-out, background-color 0.2s',
              animation: animated
                ? `voicebar-wave ${state === 'speaking' ? 0.9 : 1.6}s ease-in-out ${i * 45}ms infinite`
                : 'none',
            }}
          />
        );
      })}
      <style>{`
        @keyframes voicebar-wave {
          0%, 100% { transform: scaleY(0.35); }
          50% { transform: scaleY(1); }
        }
      `}</style>
    </div>
  );
}
