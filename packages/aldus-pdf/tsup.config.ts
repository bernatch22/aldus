import { defineConfig } from 'tsup';

/**
 * La LIB de aldus-pdf: bundle de los dist YA TIPADOS de @aldus/core +
 * @aldus/agent (noExternal) con las deps de npm external (las instala el
 * consumidor). SOLO el runtime (index.js) — el `.d.ts` NO se genera acá:
 * `tsup`/`dts-bundle-generator` no logran aplanar los tipos de @aldus/* (el
 * `dts.resolve` daba un re-export de 30 bytes a `@aldus/agent` que el
 * consumidor no puede resolver). En su lugar `build.mjs` ENSAMBLA un set de
 * `.d.ts` relativos autocontenidos desde los dist tipados de core + agent
 * (paso `assembleTypes`). Por eso acá `dts: false`.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  dts: false,
  noExternal: [/^@aldus\//],
  external: ['pdf-lib', '@pdf-lib/fontkit', 'pdfjs-dist', '@anthropic-ai/claude-agent-sdk', 'zod', 'express', 'multer'],
  clean: false,
});
