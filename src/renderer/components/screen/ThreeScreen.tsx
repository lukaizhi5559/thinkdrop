import { useEffect, useRef, useState } from 'react';
import type { ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';

const ipcRenderer = (window as any).electron?.ipcRenderer;

/**
 * ThreeScreen — preset three.js/WebGL scenes (kind:'three').
 *
 * three.js is lazy-imported inside the effect so the ~600KB bundle only
 * ships when a 3D display fires. Presets are deterministic parameterized
 * scenes (starfield, particles, wave, cube, knot, globe) — generative
 * 3D markup stays behind the sandboxed 'scene' kind.
 *
 * `speed` (0–2) scales rotation/drift, `density` (0.1–1) scales point
 * counts and geometry resolution, `color` overrides the mood accent,
 * `text` renders a caption chip over the canvas.
 *
 * Interactivity: when the display is `blocking` (interactive phrasing in the
 * prompt) or ⌘⇧K control mode is on, the canvas gets real pointer input —
 * drag to orbit, wheel/trackpad to zoom. Keyboard (capability-driven global
 * shortcuts → 'screen:three-key' DOM events): arrows orbit, +/− zoom,
 * Space pauses, R resets, E opens the prompt bar to iterate the scene.
 */

const VIEW = { yaw: 0, pitch: 0, dist: 400, distMin: 120, distMax: 900 };

export function ThreeScreen({ output }: { output: ScreenOutput }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ctrlMode, setCtrlMode] = useState(false);
  const interactive = output.blocking === true;
  const accent = output.three?.color || MOOD_ACCENT[output.mood] || '#94a3b8';

  // Shared view state — mutated by pointer/key handlers, consumed by tick.
  const view = useRef({ ...VIEW });
  const paused = useRef(false);
  const tOffset = useRef(0);
  const pauseStart = useRef(0);

  // Report key capabilities while the display lives — arrows orbit ambient,
  // ⌘⇧K arms the printable-key cluster, ⌘E opens the prompt loop.
  useEffect(() => {
    const keys = ['left', 'right', 'up', 'down', 'edit', 'controlable'];
    try {
      ipcRenderer?.send('ghostlayer:display-capabilities', { id: output.id, keys });
    } catch (_) {}
    return () => {
      try { ipcRenderer?.send('ghostlayer:display-capabilities', { id: output.id, keys: [] }); } catch (_) {}
    };
  }, [output.id]);

  // Keyboard — rebroadcast by ScreenStage as 'screen:three-key'.
  useEffect(() => {
    const onKey = (e: Event) => {
      const key = (e as CustomEvent).detail?.key;
      const v = view.current;
      switch (key) {
        case 'prev': v.yaw -= 0.25; break;         // ←
        case 'next': v.yaw += 0.25; break;         // →
        case 'up':   v.pitch = Math.min(1.4, v.pitch + 0.18); break;
        case 'down': v.pitch = Math.max(-1.4, v.pitch - 0.18); break;
        case 'zoom_in':  v.dist = Math.max(VIEW.distMin, v.dist - 40); break;
        case 'zoom_out': v.dist = Math.min(VIEW.distMax, v.dist + 40); break;
        case 'zoom_reset':
        case 'reset': Object.assign(view.current, VIEW); break;
        case 'play': paused.current = !paused.current; break;
        case 'preset_prev': case 'preset_next': break; // presets fixed per payload — no-op
        case 'control_mode': setCtrlMode(c => !c); break;
        case 'edit':
          try { ipcRenderer?.send('ghostlayer:open-scene-prompt', {}); } catch (_) {}
          break;
      }
    };
    window.addEventListener('screen:three-key', onKey);
    return () => window.removeEventListener('screen:three-key', onKey);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      let THREE: any;
      try {
        THREE = await import('three');
      } catch {
        if (!disposed) setFailed(true);
        return;
      }
      if (disposed) return;

      const spec = output.three || { scene: 'starfield', speed: 1, density: 0.5 };
      const accent = spec.color || MOOD_ACCENT[output.mood] || '#94a3b8';
      const speed = spec.speed ?? 1;
      const density = spec.density ?? 0.5;

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      host.appendChild(canvas);

      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setClearColor(0x000000, 0);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      renderer.setPixelRatio(dpr);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
      camera.position.z = VIEW.dist;

      // ── Pointer interaction — drag to orbit, wheel to zoom. Events only
      // arrive while the window captures input (blocking display or ⌘⇧K
      // control mode), so handlers are always attached and safe.
      const applyView = () => {
        const v = view.current;
        camera.position.set(
          v.dist * Math.sin(v.yaw) * Math.cos(v.pitch),
          v.dist * Math.sin(v.pitch),
          v.dist * Math.cos(v.yaw) * Math.cos(v.pitch),
        );
        camera.lookAt(0, 0, 0);
      };
      let dragging = false;
      let lx = 0, ly = 0;
      const onDown = (e: PointerEvent) => {
        dragging = true;
        lx = e.clientX; ly = e.clientY;
        canvas.style.cursor = 'grabbing';
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      };
      const onMove = (e: PointerEvent) => {
        if (!dragging) return;
        const v = view.current;
        v.yaw += (e.clientX - lx) * 0.006;
        v.pitch = Math.max(-1.4, Math.min(1.4, v.pitch + (e.clientY - ly) * 0.006));
        lx = e.clientX; ly = e.clientY;
      };
      const onUp = () => { dragging = false; canvas.style.cursor = 'grab'; };
      const onWheel = (e: WheelEvent) => {
        const v = view.current;
        v.dist = Math.max(VIEW.distMin, Math.min(VIEW.distMax, v.dist + e.deltaY * 0.5));
        e.preventDefault();
      };
      canvas.style.cursor = 'grab';
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });

      const disposables: { dispose(): void }[] = [];
      const mat = (opts: any) => {
        const m = spec.scene === 'particles' || spec.scene === 'starfield' || spec.scene === 'wave'
          ? new THREE.PointsMaterial(opts)
          : new THREE.MeshBasicMaterial({ wireframe: true, ...opts });
        disposables.push(m);
        return m;
      };
      const geo = (g: any) => { disposables.push(g); return g; };

      const key = accent;
      let update: ((t: number) => void) | null = null;

      if (spec.scene === 'starfield' || spec.scene === 'particles') {
        const n = Math.round((spec.scene === 'starfield' ? 2400 : 900) * (0.3 + density));
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          positions[i * 3] = (Math.random() - 0.5) * 1600;
          positions[i * 3 + 1] = spec.scene === 'starfield'
            ? (Math.random() - 0.5) * 1600
            : Math.random() * 1000 - 500;
          positions[i * 3 + 2] = (Math.random() - 0.5) * 1200;
        }
        const g = geo(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const m = mat({ color: spec.scene === 'starfield' ? '#ffffff' : key, size: spec.scene === 'starfield' ? 1.6 : 3, transparent: true, opacity: 0.9 });
        const pts = new THREE.Points(g, m);
        scene.add(pts);
        update = (t) => {
          if (spec.scene === 'starfield') {
            pts.rotation.y = t * 0.00005 * speed;
            pts.rotation.x = Math.sin(t * 0.00003) * 0.15;
          } else {
            const arr = g.attributes.position.array as Float32Array;
            for (let i = 0; i < arr.length; i += 3) {
              arr[i + 1] += 0.6 * speed;
              arr[i] += Math.sin(t * 0.001 + i) * 0.3;
              if (arr[i + 1] > 520) arr[i + 1] = -520;
            }
            g.attributes.position.needsUpdate = true;
          }
        };
      } else if (spec.scene === 'wave') {
        const segs = Math.round(60 * (0.4 + density)) + 12;
        const g = geo(new THREE.PlaneGeometry(1200, 1200, segs, segs));
        const m = mat({ color: key, size: 2, transparent: true, opacity: 0.85 });
        const pts = new THREE.Points(g, m);
        pts.rotation.x = -Math.PI / 2.4;
        pts.position.y = -120;
        scene.add(pts);
        const base = (g.attributes.position.array as Float32Array).slice();
        update = (t) => {
          const arr = g.attributes.position.array as Float32Array;
          for (let i = 0; i < arr.length; i += 3) {
            arr[i + 2] = Math.sin(base[i] / 90 + t * 0.0012 * speed) * 34
              + Math.cos(base[i + 1] / 110 + t * 0.0009 * speed) * 26;
          }
          g.attributes.position.needsUpdate = true;
        };
      } else {
        // Solid-ish wireframe bodies: cube | knot | globe.
        const g = spec.scene === 'knot'
          ? geo(new THREE.TorusKnotGeometry(120, 36, Math.round(200 * density) + 40, 18))
          : spec.scene === 'globe'
            ? geo(new THREE.SphereGeometry(170, Math.round(24 * density) + 8, Math.round(16 * density) + 6))
            : geo(new THREE.BoxGeometry(200, 200, 200));
        const m = mat({ color: key, transparent: true, opacity: 0.9 });
        const mesh = new THREE.Mesh(g, m);
        scene.add(mesh);
        update = (t) => {
          mesh.rotation.y = t * 0.0008 * speed;
          mesh.rotation.x = t * 0.00045 * speed;
        };
      }

      const resize = () => {
        const w = host.clientWidth || window.innerWidth;
        const h = host.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      window.addEventListener('resize', resize);

      // Pause freezes the t handed to update (accumulated offset) so the
      // scene holds its frame but orbit/zoom still respond live.
      let raf = 0;
      const tick = (t: number) => {
        if (paused.current && !pauseStart.current) pauseStart.current = t;
        if (!paused.current && pauseStart.current) {
          tOffset.current += t - pauseStart.current;
          pauseStart.current = 0;
        }
        const te = paused.current ? pauseStart.current - tOffset.current : t - tOffset.current;
        applyView();
        update?.(te);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('wheel', onWheel);
        for (const d of disposables) d.dispose();
        renderer.dispose();
        canvas.remove();
      };
    })().catch(() => { if (!disposed) setFailed(true); });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [output.three?.scene, output.three?.speed, output.three?.density, output.three?.color, output.mood]);

  const hint = ctrlMode || interactive
    ? 'Drag orbit · scroll zoom · Space pause · R reset · E edit · ⌘⇧K release · Esc exit'
    : 'Arrows orbit · ⌘⇧K grab control · ⌘E edit scene · Esc exit';

  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute', inset: 0,
        // The canvas needs real pointer events only when the display is
        // interactive or ⌘⇧K control mode is armed — ambient scenes stay
        // fully click-through.
        pointerEvents: (interactive || ctrlMode) ? 'auto' : 'none',
      }}
    >
      {failed && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 18 }}>
          3D scene unavailable
        </div>
      )}
      {!failed && output.three?.text && (
        <div style={{
          position: 'absolute', left: '50%', bottom: '12%', transform: 'translateX(-50%)',
          padding: '10px 22px', borderRadius: 999, fontSize: 20, fontWeight: 600,
          color: '#fff', background: 'rgba(15,23,42,0.55)', border: `1px solid ${accent}`,
          backdropFilter: 'blur(8px)', whiteSpace: 'nowrap', pointerEvents: 'none',
        }}>
          {output.three.text}
        </div>
      )}
      {!failed && (
        <div style={{
          position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)',
          padding: '6px 14px', borderRadius: 999, fontSize: 11, fontWeight: 600,
          letterSpacing: '0.04em',
          color: ctrlMode || interactive ? accent : '#94a3b8',
          background: 'rgba(10,14,22,0.72)',
          border: `1px solid ${ctrlMode || interactive ? accent + '88' : 'rgba(148,163,184,0.3)'}`,
          backdropFilter: 'blur(8px)', whiteSpace: 'nowrap', pointerEvents: 'none',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          {ctrlMode ? `🎮 ${hint}` : hint}
        </div>
      )}
    </div>
  );
}
