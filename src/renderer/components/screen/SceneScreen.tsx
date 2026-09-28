import { useMemo, useRef, useState, useEffect } from 'react';
import type { ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';

/**
 * SceneScreen — kind:'scene': generated markup/code in a sandboxed iframe.
 *
 * The escape hatch for generative visuals (LLM-produced three.js scenes,
 * arbitrary animated markup). The iframe runs `sandbox="allow-scripts"` on
 * an opaque origin — generated code cannot touch the parent DOM, cookies,
 * or app state. Remote code is already stripped at normalize time; vendor
 * libraries (three.js) are injected here as absolute module URLs served by
 * the overlay server (/screen/vendor/*), so scenes never fetch remote code.
 *
 * three.js harness contract for scene.js (libs includes 'three'):
 *   the code is the body of `function build(THREE, ctx)` where
 *   ctx = { scene, camera, renderer, width, height }; build may return
 *   { tick(t) } — tick is called per frame with elapsed seconds.
 */

const VENDOR_BASE = 'http://127.0.0.1:3010/screen/vendor';
const LIB_MODULES: Record<string, string> = {
  three: `${VENDOR_BASE}/three.module.js`,
};

const THREE_HARNESS = `
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(0, 0, 6);
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(3, 4, 6);
scene.add(key);
function fit(){ renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); }
fit(); addEventListener('resize', fit);
let api = {};
try {
  const build = new Function('THREE', 'ctx', __GENERATED__);
  api = build(THREE, { scene, camera, renderer, width: innerWidth, height: innerHeight }) || {};
} catch (e) {
  console.error('[scene] build failed:', e);
  document.title = 'scene-error';
  try { parent.postMessage('td-scene-error', '*'); } catch (_) {}
}
const t0 = performance.now();
let frames = 0;
(function loop(){
  try { api.tick && api.tick((performance.now() - t0) / 1000); } catch (e) {}
  renderer.render(scene, camera);
  // Heartbeat after real frames — the opaque sandbox hides the canvas from
  // parent DOM probes, so rendering is confirmed over postMessage instead.
  if (++frames === 3) { try { parent.postMessage('td-scene-rendered', '*'); } catch (_) {} }
  requestAnimationFrame(loop);
})();
`;

function buildSrcDoc(output: ScreenOutput): string {
  const scene = output.scene || {};
  const libs = (scene.libs || []).filter(l => LIB_MODULES[l]);
  const imports = libs.map(l => `import * as ${l === 'three' ? 'THREE' : l} from '${LIB_MODULES[l]}';`).join('\n');
  const userCode = String(scene.js || '');

  // The generated body is injected as a JSON string literal into
  // `new Function('THREE','ctx', …)` — no template/quote escaping needed.
  // Non-three scenes run as a module body directly; both paths heartbeat
  // 'td-scene-rendered' so tests can confirm the frame actually painted.
  const moduleBody = libs.includes('three')
    ? imports + '\n' + THREE_HARNESS.replace('__GENERATED__', JSON.stringify(userCode))
    : imports + '\ntry {\n' + userCode +
      "\ntry { parent.postMessage('td-scene-rendered', '*'); } catch (_) {}\n" +
      "} catch (e) { try { parent.postMessage('td-scene-error', '*'); } catch (_) {} }";

  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
#c{position:fixed;inset:0;width:100%;height:100%;display:block}
${scene.css || ''}
</style></head><body>
<canvas id="c"></canvas>
${scene.html || ''}
<script type="module">${moduleBody}</script>
</body></html>`;
}

export function SceneScreen({ output }: { output: ScreenOutput }) {
  const accent = MOOD_ACCENT[output.mood] || MOOD_ACCENT.neutral;
  const srcDoc = useMemo(() => buildSrcDoc(output), [output]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'rendered' | 'error'>('loading');

  // Scene heartbeat — the sandbox is opaque to DOM probes; the iframe reports
  // 'td-scene-rendered' after 3 real frames / 'td-scene-error' on build failure.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      if (e.data === 'td-scene-rendered') setStatus('rendered');
      else if (e.data === 'td-scene-error') setStatus('error');
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  return (
    <div style={{ position: 'absolute', inset: 0 }} data-scene-status={status}>
      <iframe
        ref={frameRef}
        title={output.title || 'generated scene'}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          border: 'none', background: 'transparent',
          // Inside a blocking display the wrapper already lifts pointer
          // events; non-blocking scenes stay click-through.
          pointerEvents: output.blocking ? 'auto' : 'none',
        }}
      />
      {output.title && (
        <div style={{
          position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)',
          padding: '10px 20px', borderRadius: 999,
          background: 'rgba(10,14,22,0.7)', border: `1px solid ${accent}44`,
          color: '#e5e7eb', fontSize: 15, fontWeight: 600,
          fontFamily: 'system-ui, -apple-system, sans-serif', pointerEvents: 'none',
        }}>
          {output.title}
        </div>
      )}
    </div>
  );
}
