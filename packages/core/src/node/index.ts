/**
 * @aldus/core/node — providers con I/O (font providers de sistema/descarga) y
 * el composition root Node. SOLO este subpath importa node:fs — el bundle
 * browser jamás lo arrastra (regla dura #5 del plan).
 */
export { SystemFontProvider, MetricTwinProvider, registerNodeFontProviders } from './fontsNode.js';
export { createNodeContainer } from './composition.node.js';
