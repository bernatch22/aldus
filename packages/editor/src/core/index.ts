/**
 * editor-core — barrel del checkpoint 1 (F6): sin React, testeable en jsdom.
 * `react/` (checkpoint 2) construye sobre esto (INodeKind registry,
 * composition root, boxes).
 */

// helpers compartidos del overlay (logger, containerStyle, clamp).
export { clampX, clampY, containerStyle, dbgStyles, log, type ContainerStyle } from './helpers.js';

// text — puente modelo↔DOM, registro de fuentes, y el editor de texto.
export {
  activeEditingBox,
  applyAlign,
  applySelectionColor,
  applySelectionStyle,
  bucketFallback,
  dominantRun,
  esc,
  family,
  fitLetterSpacing,
  flatOffsets,
  measureFontFor,
  measureWidth,
  NBSP,
  restoreSelection,
  round1,
  runsToHtml,
  runStyle,
  seedHtml,
  selectionStyle,
  serializeStyled,
  styledSpanStyle,
} from './text/styledDom.js';
export { FontRegistryService, stableFontFamily, type FontSourcePage } from './text/fontRegistry.js';
export {
  styleAtRange,
  TextEditController,
  type EditSession,
  type StyleAction,
  type StyleState,
  type TextEditControllerOptions,
} from './text/textEditController.js';

// canvas — muestreo de color (puro, Map) y píxeles de imagen (cache disposable).
export { ColorSampler, runKey, segColor } from './canvas/sampleColor.js';
export { ImagePixelCache, type PixelSourcePage } from './canvas/imagePixels.js';

// ledger — el adaptador fino sobre @aldus/core EditLedger.
export {
  EditLedgerAdapter,
  type HighlightSyncAction,
  type HistoryCommand,
  type PendingHighlight,
} from './ledger/editLedgerAdapter.js';

// preview/lift — servicios suscriptos al ledger (sin deps de React que envenenar).
export { PreviewService, type PreviewServiceOptions } from './preview/previewService.js';
export { LiftService, type LiftEntry, type LiftPhase, type LiftServiceOptions } from './preview/liftService.js';

// api — el cliente del wire, inyectable (fix del bug de capture.ts en v1).
export { AldusApi, type AgentDone, type AgentEvent, type AgentRole, type AldusApiOptions, type DocMeta } from './api/aldusApi.js';
export { readNdjson } from './api/ndjson.js';
