import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist-renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  server: {
    port: 5173,
    headers: {
      // Required for SharedArrayBuffer (ONNX Runtime multi-threaded WASM)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // kokoro-js + @huggingface/transformers load WASM workers dynamically;
  // exclude from Vite pre-bundling so the WASM paths resolve correctly.
  optimizeDeps: {
    exclude: ['kokoro-js', '@huggingface/transformers', 'onnxruntime-web'],
  },
});
