/**
 * aldus-editor — public surface.
 *
 * F6: `core/` (editor-core, SIN React — ledger adapter sobre `@aldus/core`,
 * preview/lift services, textEditController, styledDom, fontRegistry,
 * sampleColor/imagePixels, la API del wire) + `react/` (INodeKind registry,
 * boxes, composition root `AldusEditor`). `demo/` es la app de ejemplo (nunca
 * se publica). El entry de la LIB npm es `react/lib.ts` (build vite → dist-lib).
 */
export * from './core/index.js';
