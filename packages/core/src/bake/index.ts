/**
 * @aldus/core/bake — Layer 3, EL CEREBRO. Barrel del subpath ./bake: la
 * superficie pública del pipeline de bake + la creación de nodos. Importa
 * pdf-lib, por eso NUNCA entra al barrel raíz `.` (browser-safe) — el editor
 * lo consume por dynamic import (useLocalPreview).
 *
 * Curaduría vs v1 (audit §2): SIN `walkTextOps` (muerto). `bake(edits)` es la
 * API v2; `bakeSegmentEdits(...)` queda como shim deprecado.
 */

// EL coordinador + su shim + el modelo de eventos.
export { bake, bakeSegmentEdits, defaultEditAppliers, type BakeOptions } from './bake.js';
export { BakeReport, BakeCodes, formatBakeEvent } from './report.js';
export type { BakeResult, BakeEvent, BakeCode, BakeSeverity } from './report.js';

// El contrato estrella + los contextos + las estrategias de texto (extensión).
export { IEditApplier, byKind } from './appliers/types.js';
export { PageBakeContext } from './context.js';
export type { DocBakeContext } from './context.js';
export { textEmitStrategies } from './text.js';
export type { ITextEmitStrategy, SegmentEmitContext } from './text.js';

// Fuentes: estándar, sustitución y el registry de providers (+ shim npm).
export { FontService, stdFontFor, baseFontFamilyOf } from './fonts/fontService.js';
export { registerFallbackFontProvider, resolveFallbackFont, IFallbackFontProvider } from './fonts/fontProviders.js';
export type { FallbackFontRequest, ResolvedFallbackFont } from './fonts/fontProviders.js';

// Preview del editor (display-only): ocultar los /Highlight en la copia visible.
export { hideHighlightAnnotations } from './display.js';

// Creación de nodos NUEVOS + ops deterministas (create/): el registry abierto
// ICreateOp, los creadores, y forms/flatten/info.
export {
  ICreateOp,
  bindCreateOps,
  defaultCreateOps,
  appendAnnot,
  addFormField,
  FIELD_DEFAULT_SIZE,
  MODERN_WIDGET,
  setFieldOptions,
  addRadioOption,
  addText,
  addWatermark,
  addHeaderFooter,
  addHighlight,
  highlightAppearance,
  addLink,
  removeLink,
  insertImage,
  readFormFields,
  setFieldValues,
  flattenForm,
  readPdfInfo,
  isPdf,
} from '../create/index.js';
export type {
  IFieldCreator,
  NewFieldSpec,
  NewTextSpec,
  NewImageSpec,
  FormField,
  FieldRect,
  FlattenResult,
  PdfInfo,
} from '../create/index.js';
