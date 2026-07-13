/**
 * edit/merge.ts — construcción de ediciones pendientes a partir de un nodo +
 * un parche (Command): `merge*Edit(node, prev, patch)` acumula overrides;
 * `null` en el patch limpia el campo, `null` de retorno = noop (revert).
 *
 * ⚠️ TRASPLANTE VERBATIM de v1 edits.ts (misma semántica, mismo bug zombie de
 * mergeSegmentEdit). Es hogar TEMPORAL: F4 lo refactoriza al EditLedger con el
 * genérico `mergeRectEdit<T>` (audit-model, duplicación #4) y arregla el zombie
 * (documentado como it.skip en F1b). Vive acá para que la BIBLIA del bake
 * (bake.test.ts) y los tests de imagen/forma/highlight/link corran en F3.
 */
import type {
  FontBucket,
  HighlightNode,
  ImageNode,
  LinkNode,
  SegmentNode,
  ShapeNode,
  StyledRun,
  WidgetNode,
} from '../model/nodes.js';
import type {
  HighlightEdit,
  ImageEdit,
  LinkEdit,
  SegmentEdit,
  ShapeEdit,
  WidgetEdit,
} from '../model/edits.js';
import { originalStyledRuns, segmentOriginal, styledRunsEqual, styledText } from '../graph/segmentContent.js';

/** Parche parcial de un segmento: `undefined` = no tocar; `null` = limpiar. */
export interface SegmentPatch {
  text?: string;
  runs?: StyledRun[] | null;
  fontSize?: number | null;
  font?: FontBucket | null;
  x?: number | null;
  baseline?: number | null;
  remove?: boolean | null;
  charSpacing?: number | null;
  hScale?: number | null;
  color?: string | null;
  align?: 'left' | 'center' | 'right' | null;
}

const OVERRIDE_KEYS = ['fontSize', 'font', 'x', 'baseline', 'remove', 'charSpacing', 'hScale', 'color', 'align'] as const;

export function mergeSegmentEdit(
  seg: SegmentNode,
  prev: SegmentEdit | null,
  patch: SegmentPatch,
): SegmentEdit | null {
  const next: SegmentEdit = prev
    ? { ...prev }
    : {
        segmentId: seg.id,
        page: seg.page,
        text: seg.text,
        original: segmentOriginal(seg),
      };

  if (patch.runs !== undefined) {
    if (patch.runs === null) delete next.runs;
    else next.runs = patch.runs;
  }
  if (patch.text !== undefined) next.text = patch.text;
  // runs manda: el texto plano siempre es su aplanado.
  if (next.runs) {
    if (styledRunsEqual(next.runs, originalStyledRuns(seg))) delete next.runs;
    else next.text = styledText(next.runs);
  }
  for (const key of OVERRIDE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }

  const noop =
    next.text === seg.text &&
    next.runs === undefined &&
    OVERRIDE_KEYS.every(k => next[k] === undefined);
  return noop ? null : next;
}

/** Parche parcial de una imagen: `undefined` = no tocar; `null` = limpiar. */
export interface ImagePatch {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  remove?: boolean | null;
  zOrder?: 'front' | 'back' | null;
}

const IMAGE_KEYS = ['x', 'y', 'width', 'height', 'remove', 'zOrder'] as const;

export function mergeImageEdit(img: ImageNode, prev: ImageEdit | null, patch: ImagePatch): ImageEdit | null {
  const next: ImageEdit = prev
    ? { ...prev }
    : {
        imageId: img.id,
        page: img.page,
        original: { x: img.x, y: img.y, width: img.width, height: img.height },
      };
  for (const key of IMAGE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  return IMAGE_KEYS.every(k => next[k] === undefined) ? null : next;
}

/**
 * Al HORNEAR: las imágenes movidas/escaladas (sin zOrder explícito) se
 * promueven a zOrder 'front' — el bake reubica EN SU LUGAR, así que sin esto
 * podrían quedar tapadas por contenido posterior ("se mueven y desaparecen").
 * ÚNICA fuente de verdad de la regla: la usan el editor (Aplicar) y el agente
 * (EditSession.bake) — no la dupliques.
 */
export function promoteMovedImages(edits: ImageEdit[]): ImageEdit[] {
  return edits.map(e =>
    !e.remove && !e.zOrder && (e.x != null || e.y != null || e.width != null || e.height != null)
      ? { ...e, zOrder: 'front' as const }
      : e);
}

/** Parche parcial de una forma: `undefined` = no tocar; `null` = limpiar. */
export interface ShapePatch {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  remove?: boolean | null;
}
const SHAPE_KEYS = ['x', 'y', 'width', 'height', 'remove'] as const;

export function mergeShapeEdit(shape: ShapeNode, prev: ShapeEdit | null, patch: ShapePatch): ShapeEdit | null {
  const next: ShapeEdit = prev
    ? { ...prev }
    : { shapeId: shape.id, page: shape.page, original: { x: shape.x, y: shape.y, width: shape.width, height: shape.height } };
  for (const key of SHAPE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  return SHAPE_KEYS.every(k => next[k] === undefined) ? null : next;
}

/** Parche parcial de un widget: `undefined` = no tocar; `null` = limpiar. */
export interface WidgetPatch {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  remove?: boolean | null;
}

const WIDGET_KEYS = ['x', 'y', 'width', 'height', 'remove'] as const;

export function mergeWidgetEdit(w: WidgetNode, prev: WidgetEdit | null, patch: WidgetPatch): WidgetEdit | null {
  const next: WidgetEdit = prev
    ? { ...prev }
    : {
        widgetId: w.id,
        page: w.page,
        original: { fieldName: w.fieldName, x: w.x, y: w.y, width: w.width, height: w.height },
      };
  for (const key of WIDGET_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  return WIDGET_KEYS.every(k => next[k] === undefined) ? null : next;
}

/** Parche parcial de un resaltado: `undefined` = no tocar; `null` = limpiar. */
export interface HighlightPatch {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  color?: string | null;
  remove?: boolean | null;
}

const HIGHLIGHT_KEYS = ['x', 'y', 'width', 'height', 'color', 'remove'] as const;

export function mergeHighlightEdit(h: HighlightNode, prev: HighlightEdit | null, patch: HighlightPatch): HighlightEdit | null {
  const next: HighlightEdit = prev
    ? { ...prev }
    : {
        highlightId: h.id,
        page: h.page,
        original: { x: h.x, y: h.y, width: h.width, height: h.height, color: h.color },
      };
  for (const key of HIGHLIGHT_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  return HIGHLIGHT_KEYS.every(k => next[k] === undefined) ? null : next;
}

/** Parche parcial de un link: `undefined` = no tocar; `null` = limpiar. */
export interface LinkPatch {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  remove?: boolean | null;
}

const LINK_KEYS = ['x', 'y', 'width', 'height', 'remove'] as const;

export function mergeLinkEdit(l: LinkNode, prev: LinkEdit | null, patch: LinkPatch): LinkEdit | null {
  const next: LinkEdit = prev
    ? { ...prev }
    : {
        linkId: l.id,
        page: l.page,
        original: { url: l.url, x: l.x, y: l.y, width: l.width, height: l.height },
      };
  for (const key of LINK_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  return LINK_KEYS.every(k => next[k] === undefined) ? null : next;
}
