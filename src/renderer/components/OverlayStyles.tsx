/**
 * Overlay CSS animations — keyframes and glow ring styles for the unified overlay.
 * Extracted from UnifiedOverlay to reduce parent render cost.
 */
export function OverlayStyles() {
  return (
    <style>{`
      @keyframes prompt-border-sweep {
        to { --prompt-angle: 360deg; }
      }
      @property --prompt-angle {
        syntax: '<angle>';
        initial-value: 0deg;
        inherits: false;
      }
      @keyframes think-breathe {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }
      @keyframes drop-in {
        0%   { transform: translateY(-8px) scaleY(0.97); }
        55%  { transform: translateY(3px) scaleY(1.01); }
        75%  { transform: translateY(-1px) scaleY(0.998); }
        100% { transform: translateY(0) scaleY(1); }
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .drop-animate {
        animation: drop-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        transform-origin: top center;
      }
      .prompt-glow-ring {
        position: absolute;
        inset: -1px;
        border-radius: 13px;
        padding: 1.5px;
        background: conic-gradient(from var(--prompt-angle), transparent 65%, #3b82f6 82%, #60a5fa 88%, #3b82f6 94%, transparent);
        animation: prompt-border-sweep 2.4s linear infinite;
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        pointer-events: none;
        z-index: 10;
        opacity: 0;
        transition: opacity 0.4s ease;
      }
      .prompt-glow-ring.active {
        opacity: 1;
      }
      .prompt-glow-ring.ptt {
        background: conic-gradient(from var(--prompt-angle), transparent 60%, #10b981 78%, #34d399 86%, #10b981 93%, transparent);
        animation: prompt-border-sweep 1.4s linear infinite;
        opacity: 1;
      }
      .prompt-glow-ring.thinking {
        background: conic-gradient(from var(--prompt-angle), transparent 40%, #6366f1 65%, #a78bfa 78%, #818cf8 88%, #6366f1 95%, transparent);
        animation: prompt-border-sweep 3.2s linear infinite, think-breathe 1.6s ease-in-out infinite;
        opacity: 1;
      }
      .prompt-glow-ring.gathering {
        background: conic-gradient(from var(--prompt-angle), transparent 60%, #f59e0b 78%, #fbbf24 86%, #f59e0b 93%, transparent);
        animation: prompt-border-sweep 1.8s linear infinite;
        opacity: 1;
      }
      /* Cancel button hover glow - red variant */
      .cancel-glow-ring {
        position: absolute;
        inset: -2px;
        border-radius: 8px;
        padding: 2px;
        background: conic-gradient(from var(--prompt-angle), transparent 60%, #ef4444 78%, #f87171 86%, #ef4444 93%, transparent);
        animation: prompt-border-sweep 1.4s linear infinite;
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        pointer-events: none;
        z-index: 10;
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      .cancel-glow-ring.active {
        opacity: 1;
      }
      .drag-glow-ring {
        position: absolute;
        inset: -1px;
        border-radius: 13px;
        padding: 2px;
        background: conic-gradient(from var(--prompt-angle), transparent 60%, #3b82f6 75%, #60a5fa 85%, #3b82f6 95%, transparent);
        animation: prompt-border-sweep 1.5s linear infinite;
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        pointer-events: none;
        z-index: 10;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      .drag-glow-ring.active {
        opacity: 1;
      }
    `}</style>
  );
}

export default OverlayStyles;
