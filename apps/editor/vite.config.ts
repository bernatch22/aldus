import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Base configurable (VITE_BASE) para servir el editor bajo un subpath — el
  // demo embebido en bernardocastro.dev/aldus-app/. Default '/' (dev/standalone).
  base: process.env.VITE_BASE || '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5190,
    proxy: {
      '/api': 'http://localhost:4100',
    },
  },
});
