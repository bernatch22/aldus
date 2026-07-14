import { defineConfig } from 'tsup';

/**
 * Config mínima ESM + d.ts. DOS entradas:
 *  - `index` — la fachada pública `.` (lo que consume un host / aldus-pdf).
 *  - `cli` — el binario `aldus` YA COMPILADO: aldus-pdf (F7) bundlea
 *    dist/cli.js contra los dist tipados (muere el alias-a-source de v1).
 *    El bin del monorepo (bin/aldus.mjs) sigue corriendo src/cli.ts con tsx.
 * @anthropic-ai/claude-agent-sdk, pdfjs-dist y @aldus/core quedan external.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@aldus/core', '@anthropic-ai/claude-agent-sdk', 'pdfjs-dist', 'zod'],
});
