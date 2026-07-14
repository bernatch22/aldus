/**
 * vite.lib.config.ts — la build de LIBRERÍA de `aldus-editor` (dist-lib/):
 * el editor como componente React embebible. Externals: react/react-dom y
 * pdfjs-dist (peers — el host trae los suyos y fija el worker); TODO lo demás
 * va adentro (@aldus/core, pdf-lib para el preview local, lucide, etc.).
 * react-router-dom queda FUERA por tree-shaking: lib.ts no exporta la ruta demo.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    lib: {
      entry: 'src/react/lib.ts',
      formats: ['es'],
      fileName: 'index',
      cssFileName: 'styles',
    },
    outDir: 'dist-lib',
    cssCodeSplit: false,
    rollupOptions: {
      external: [
        'react', 'react-dom', 'react/jsx-runtime', 'react-dom/client',
        /^pdfjs-dist/,
        'react-router-dom',
      ],
      // UNA sola salida (sin chunks hermanos) — LOAD-BEARING (audit §4 riesgo
      // 8): los `import('@aldus/core/bake')` lazy generaban chunks con import()
      // dinámico ENTRE ellos (`lib-*.js` → `index-*.js` + `.then(D => D.i)`).
      // Cuando un host (signwax) re-bundlea la lib, Rollup re-escribe mal ese
      // namespace access (destructura del namespace Y le aplica `.i`) →
      // "Cannot destructure 'bakeSegmentEdits' of undefined" en runtime.
      // Inline = import estático = nada que re-escribir; el host hace su
      // propio code-splitting igual.
      output: { inlineDynamicImports: true },
    },
  },
});
