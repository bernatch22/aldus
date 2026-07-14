import { defineConfig } from 'tsup';

/**
 * La LIB de aldus-pdf: bundle de los dist YA TIPADOS de @aldus/core +
 * @aldus/agent (noExternal) con las deps de npm external (las instala el
 * consumidor). `dts.resolve` INLINEA los tipos de @aldus/* → dist/index.d.ts
 * autocontenido — muere el hack alias-por-prefijo de v1 (audit §3.6/§4.4) y
 * el paquete deja de publicarse sin tipos (§4.5).
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  dts: { resolve: [/^@aldus\//] },
  noExternal: [/^@aldus\//],
  external: ['pdf-lib', '@pdf-lib/fontkit', 'pdfjs-dist', '@anthropic-ai/claude-agent-sdk', 'zod', 'express', 'multer'],
  clean: false,
});
