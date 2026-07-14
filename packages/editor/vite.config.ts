/** Vite de la app de EJEMPLO (demo/) — nunca se publica. */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'demo',
  // Base configurable (VITE_BASE) para servir el editor bajo un subpath — el
  // demo embebido en bernardocastro.dev/aldus-app/. Default '/' (dev/standalone).
  base: process.env.VITE_BASE || '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist-demo',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // El worker de pdf.js sale como asset `.mjs`; muchos nginx sin `mjs` en
        // mime.types lo sirven como application/octet-stream y el module worker
        // MUERE por strict MIME checking. Emitirlo `.js` (mismo contenido ESM)
        // lo hace servible por cualquier server sin tocar infra.
        assetFileNames: (info) =>
          info.names?.some(n => n.endsWith('.mjs'))
            ? 'assets/[name]-[hash].js'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5190,
    proxy: {
      '/api': 'http://localhost:4100',
    },
  },
});
