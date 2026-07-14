import { defineConfig } from 'tsup';

/**
 * Config mínima ESM + d.ts. UNA entrada (la fachada pública `.`). El CLI (`aldus`)
 * corre con tsx desde src/ (bin/aldus.mjs) — no se bundlea acá; el paquete
 * distribuido (aldus-pdf, F7) arma su propio bundle del server+editor.
 * @anthropic-ai/claude-agent-sdk, pdfjs-dist y @aldus/core quedan external.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@aldus/core', '@anthropic-ai/claude-agent-sdk', 'pdfjs-dist', 'zod'],
});
