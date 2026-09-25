import { useEffect, useRef } from 'react';
import type { ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';

/**
 * EffectScreen — canvas particle effects (kind:'effect').
 *
 * One fullscreen <canvas>, a requestAnimationFrame loop, and per-effect
 * particle systems. Zero dependencies. `intensity` (0.05–1) scales both
 * particle count and fall speed. `emoji` supplies the glyph for emoji-rain;
 * `mood` tints confetti/fireworks palettes.
 */

const CONFETTI_COLORS = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#f472b6', '#facc15'];
const FIREWORK_PALETTES = [
  ['#fbbf24', '#f59e0b', '#fde68a'],
  ['#f87171', '#fb7185', '#fecdd3'],
  ['#60a5fa', '#818cf8', '#c7d2fe'],
  ['#34d399', '#6ee7b7', '#a7f3d0'],
  ['#f472b6', '#e879f9', '#f5d0fe'],
];

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  size: number;
  rot: number; vr: number;
  color: string;
  life: number; maxLife: number;
  sway: number; phase: number;
  glyph: string;
  burst: boolean;
}

function rand(a: number, b: number) { return a + Math.random() * (b - a); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

export function EffectScreen({ output }: { output: ScreenOutput }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0, h = 0;
    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const effect = output.effect || 'rain';
    const intensity = output.intensity ?? 0.5;
    const accent = MOOD_ACCENT[output.mood] || '#facc15';
    const glyph = output.emoji || pick(['✨', '🎉', '⭐', '💫']);
    const particles: Particle[] = [];
    const rockets: Particle[] = [];

    const base: Particle = {
      x: 0, y: 0, vx: 0, vy: 0, size: 4, rot: 0, vr: 0,
      color: accent, life: 0, maxLife: 1, sway: 0, phase: rand(0, Math.PI * 2),
      glyph, burst: false,
    };

    const spawn = (initial = false): Particle => {
      const p = { ...base };
      switch (effect) {
        case 'rain':
          p.x = rand(-40, w + 40); p.y = initial ? rand(-h, 0) : rand(-60, -10);
          p.vx = rand(1, 2.5); p.vy = rand(9, 15) * (0.5 + intensity);
          p.size = rand(10, 22); p.color = 'rgba(147,197,253,0.55)';
          break;
        case 'snow':
          p.x = rand(0, w); p.y = initial ? rand(-h, 0) : rand(-40, -10);
          p.vy = rand(0.8, 2.2) * (0.5 + intensity); p.sway = rand(0.5, 1.6);
          p.size = rand(2, 6); p.color = 'rgba(255,255,255,0.9)';
          break;
        case 'confetti':
          p.x = rand(0, w); p.y = initial ? rand(-h, 0) : rand(-40, -10);
          p.vy = rand(2, 4.5) * (0.5 + intensity); p.vx = rand(-1, 1);
          p.sway = rand(1, 2.5); p.rot = rand(0, Math.PI * 2); p.vr = rand(-0.15, 0.15);
          p.size = rand(6, 12); p.color = pick(CONFETTI_COLORS);
          break;
        case 'emoji-rain':
          p.x = rand(0, w); p.y = initial ? rand(-h, 0) : rand(-50, -20);
          p.vy = rand(2.5, 5) * (0.5 + intensity); p.sway = rand(0.5, 1.5);
          p.rot = rand(-0.4, 0.4); p.size = rand(22, 40);
          break;
        default:
          break;
      }
      return p;
    };

    const baseCount = ({ rain: 220, snow: 160, confetti: 130, 'emoji-rain': 45, fireworks: 0 } as Record<string, number>)[effect] ?? 120;
    const targetCount = Math.round(baseCount * (0.4 + intensity));
    for (let i = 0; i < targetCount; i++) particles.push(spawn(true));

    // Fireworks state: launch cadence scales with intensity.
    let lastLaunch = 0;
    const launchInterval = Math.max(350, 1400 - intensity * 1000);

    const spawnRocket = (): Particle => {
      const p = { ...base };
      p.x = rand(w * 0.15, w * 0.85); p.y = h + 10;
      p.vy = -rand(9, 12); p.vx = rand(-0.6, 0.6);
      p.size = 3; p.color = '#fef3c7'; p.maxLife = rand(0.9, 1.5);
      return p;
    };
    const explode = (r: Particle) => {
      const palette = pick(FIREWORK_PALETTES);
      const n = Math.round(40 + intensity * 50);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.1, 0.1);
        const sp = rand(1.5, 5.5);
        particles.push({
          ...base,
          x: r.x, y: r.y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          size: rand(1.5, 3.5), color: pick(palette),
          life: 0, maxLife: rand(50, 110), burst: true,
        });
      }
    };

    let raf = 0;
    const tick = (t: number) => {
      ctx.clearRect(0, 0, w, h);

      if (effect === 'fireworks') {
        if (t - lastLaunch > launchInterval && rockets.length < 6) {
          rockets.push(spawnRocket());
          lastLaunch = t;
        }
        for (let i = rockets.length - 1; i >= 0; i--) {
          const r = rockets[i];
          r.x += r.vx; r.y += r.vy; r.vy += 0.12; r.life += 1 / 60;
          ctx.fillStyle = r.color;
          ctx.beginPath(); ctx.arc(r.x, r.y, r.size, 0, Math.PI * 2); ctx.fill();
          if (r.vy > -1.5 || r.life > r.maxLife) { explode(r); rockets.splice(i, 1); }
        }
        // Burst particles: gravity + fade, removed at end of life.
        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i];
          p.life++; p.x += p.vx; p.y += p.vy; p.vy += 0.06; p.vx *= 0.985;
          const a = Math.max(0, 1 - p.life / p.maxLife);
          ctx.globalAlpha = a;
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
          if (p.life > p.maxLife) particles.splice(i, 1);
        }
      } else {
        for (const p of particles) {
          p.phase += 0.02;
          p.x += p.vx + Math.sin(p.phase) * p.sway;
          p.y += p.vy;
          p.rot += p.vr;
          if (p.y > h + 30) Object.assign(p, spawn(false));

          if (effect === 'rain') {
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.vx * 1.6, p.y - p.size);
            ctx.stroke();
          } else if (effect === 'snow') {
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
          } else if (effect === 'confetti') {
            ctx.save();
            ctx.translate(p.x, p.y); ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            ctx.restore();
          } else if (effect === 'emoji-rain') {
            ctx.save();
            ctx.translate(p.x, p.y); ctx.rotate(p.rot);
            ctx.font = `${p.size}px system-ui`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(p.glyph, 0, 0);
            ctx.restore();
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [output.effect, output.intensity, output.emoji, output.mood]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    />
  );
}
