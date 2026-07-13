/**
 * @aldus/core — public surface (F2: Layer 0 + model + graph).
 *
 * Barrel CURADO (audit-model: v1 exportaba 35+ símbolos sin curaduría):
 *  - common: selectivo (lo que consumen hosts/editor; sin internals).
 *  - model + graph: el vocabulario público del grafo y su lectura.
 *  - pdf/ NO se exporta: es protocolo interno — solo el subpath ./bake (F3)
 *    lo consume. pageContent importa pdf-lib y jamás debe entrar al bundle
 *    browser por `.`.
 *  - Muertos de v1 que NO cruzan: walkTextOps, splitSegments/avgCharWidth
 *    (internos de tokens), hasBulletMarker.
 */

// common — Layer 0 (selectivo)
export { fmt, latin1, toBytes, hexString } from './common/bytes.js';
export * from './common/cancellation.js';
export * from './common/coords.js';
export * from './common/disposable.js';
export * from './common/events.js';
export * from './common/log.js';
export * from './common/mapUsingProjection.js';
export { IDENTITY, mul, invert, type Matrix } from './common/matrix.js';
export * from './common/once.js';
export { parseRawFill, toRgb, isWhite, type ParsedFill } from './common/rawFill.js';
export { normalize } from './common/text.js';

// ioc + errors
export * from './ioc/container.js';
export * from './errors.js';

// model — Layer 0.5 (solo tipos)
export * from './model/nodes.js';
export * from './model/edits.js';

// graph — Layer 1-2
export { avgCharWidth, classifyGap, segmentText, type GapClass } from './graph/tokens.js';
export {
  runLines,
  originalStyledRuns,
  styledRunsEqual,
  styledText,
  segmentOriginal,
  SUPERSCRIPT_BREAK_FACTOR,
} from './graph/segmentContent.js';
export { Segment } from './graph/segment.js';
export * from './graph/extract/index.js';
export {
  PageGraphService,
  IPageGraphService,
  GEOMETRY_TOL_PT,
  type PdfRect,
} from './graph/pageGraphService.js';
export { locateText, type TextAnchor } from './graph/locateText.js';
