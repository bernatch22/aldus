/**
 * edit/mergeEdits.ts — construcción de ediciones pendientes (Command): un
 * `merge*Edit(node, prev, patch)` acumula overrides; `null` en el patch limpia
 * el campo, `null` de retorno = noop (revert → el caller borra la entrada).
 *
 * Fuente ÚNICA de la semántica de merge (audit-model §3, duplicación #4): los
 * CINCO edits rect-like (image/shape/widget/highlight/link) colapsan al genérico
 * {@link mergeRectEdit}; solo {@link mergeSegmentEdit} tiene semántica propia
 * ("runs manda", revert por `styledRunsEqual`) — Y con el FIX del bug zombie
 * (ver abajo). El {@link EditLedger} usa estas funciones internamente; siguen
 * exportadas del barrel porque la biblia (bake.test) y los tests F1a las
 * consumen como funciones libres.
 *
 * Reemplaza el `edit/merge.ts` TEMPORAL de F3 (que era un trasplante verbatim de
 * v1 CON el bug zombie intacto): mismos resultados, una sola fuente, zombie fixed.
 */

import type {
  HighlightEdit,
  ImageEdit,
  LinkEdit,
  RectEdit,
  SegmentEdit,
  ShapeEdit,
  WidgetEdit,
} from '../model/edits.js';
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
import { originalStyledRuns, segmentOriginal, styledRunsEqual, styledText } from '../graph/segmentContent.js';

/** Parche parcial de un segmento: `undefined` = no tocar; `null` = LIMPIAR el
 *  override (volver al valor original del PDF). */
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

/**
 * mergeSegmentEdit — la semántica de editar un segmento, en UN lugar.
 *
 * `runs` MANDA sobre `text`: si hay runs, el texto plano siempre es su aplanado.
 * Si el resultado queda idéntico al original (mismo texto, sin runs, cero
 * overrides) devuelve `null`: la edición se revierte sola.
 *
 * ⚠️ FIX del bug zombie (documentado como it.skip en v1 ledger.test): al borrar
 * `runs` por igualdad con el original (`styledRunsEqual`) hay que SINCRONIZAR
 * `next.text = seg.text`. Sin esto, el texto del edit ANTERIOR sobrevive, el
 * noop-check (`next.text === seg.text`) nunca da null, y el bake re-emite el
 * texto viejo (revertir "Beta" → "Acme" dejaba "Beta" en el PDF). Es la ÚNICA
 * corrección de comportamiento del trasplante (regla dura #2 del plan).
 */
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
    if (styledRunsEqual(next.runs, originalStyledRuns(seg))) {
      delete next.runs;
      next.text = seg.text; // FIX zombie: sin esto sobrevive el texto del edit anterior.
    } else next.text = styledText(next.runs);
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

/**
 * Genérico de las ediciones rect-like (audit-model §3): clonar-o-crear con el
 * snapshot `original`, loop sobre `keys` (`null`→delete), noop (todas las keys
 * ausentes)→null. Los 5 wrappers de abajo solo aportan su base + su lista de keys.
 */
function mergeRectEdit<E extends { page: number; original: unknown }>(
  base: () => E,
  prev: E | null,
  patch: Record<string, unknown>,
  keys: readonly string[],
): E | null {
  const next = prev ? { ...prev } : base();
  const mut = next as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete mut[key];
    else mut[key] = value;
  }
  return keys.every(k => mut[k] === undefined) ? null : next;
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
  return mergeRectEdit<ImageEdit>(
    () => ({ imageId: img.id, page: img.page, original: { x: img.x, y: img.y, width: img.width, height: img.height } }),
    prev,
    patch as Record<string, unknown>,
    IMAGE_KEYS,
  );
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
  return mergeRectEdit<ShapeEdit>(
    () => ({ shapeId: shape.id, page: shape.page, original: { x: shape.x, y: shape.y, width: shape.width, height: shape.height } }),
    prev,
    patch as Record<string, unknown>,
    SHAPE_KEYS,
  );
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
  return mergeRectEdit<WidgetEdit>(
    () => ({ widgetId: w.id, page: w.page, original: { fieldName: w.fieldName, x: w.x, y: w.y, width: w.width, height: w.height } }),
    prev,
    patch as Record<string, unknown>,
    WIDGET_KEYS,
  );
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
  return mergeRectEdit<HighlightEdit>(
    () => ({ highlightId: h.id, page: h.page, original: { x: h.x, y: h.y, width: h.width, height: h.height, color: h.color } }),
    prev,
    patch as Record<string, unknown>,
    HIGHLIGHT_KEYS,
  );
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
  return mergeRectEdit<LinkEdit>(
    () => ({ linkId: l.id, page: l.page, original: { url: l.url, x: l.x, y: l.y, width: l.width, height: l.height } }),
    prev,
    patch as Record<string, unknown>,
    LINK_KEYS,
  );
}

/**
 * Al HORNEAR: las imágenes movidas/escaladas (sin zOrder explícito) se
 * promueven a zOrder 'front' — el bake reubica EN SU LUGAR, así que sin esto
 * podrían quedar tapadas por contenido posterior ("se mueven y desaparecen").
 * ÚNICA fuente de verdad de la regla: en v2 vive DENTRO de `EditLedger.toBakeInput()`
 * (único sitio) — esta función libre queda para el shim de compat.
 */
export function promoteMovedImages(edits: ImageEdit[]): ImageEdit[] {
  return edits.map(e =>
    !e.remove && !e.zOrder && (e.x != null || e.y != null || e.width != null || e.height != null)
      ? { ...e, zOrder: 'front' as const }
      : e);
}

/** Rect EFECTIVO de un nodo rect-like con su edición aplicada. `color` se
 *  incluye si el edit lo trae (resaltados). */
export interface EffectiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  removed: boolean;
  moved: boolean;
}
export function effectiveRect(
  node: { x: number; y: number; width: number; height: number; color?: string },
  edit: (RectEdit<unknown> & { color?: string }) | null,
): EffectiveRect {
  return {
    x: edit?.x ?? node.x,
    y: edit?.y ?? node.y,
    width: edit?.width ?? node.width,
    height: edit?.height ?? node.height,
    ...(node.color !== undefined || edit?.color !== undefined ? { color: edit?.color ?? node.color } : {}),
    removed: edit?.remove === true,
    moved: edit?.x !== undefined || edit?.y !== undefined || edit?.width !== undefined || edit?.height !== undefined,
  };
}

/** Geometría/tamaño EFECTIVOS de un segmento con su edición aplicada.
 *  Cambiar el tamaño escala el alto del box alrededor de la baseline. */
export interface EffectiveGeometry {
  x: number;
  baseline: number;
  fontSize: number;
  y: number;
  height: number;
  width: number;
  moved: boolean;
}
export function effectiveGeometry(seg: SegmentNode, edit: SegmentEdit | null): EffectiveGeometry {
  const fontSize = edit?.fontSize ?? seg.fontSize;
  const ratio = fontSize / seg.fontSize;
  const x = edit?.x ?? seg.x;
  const baseline = edit?.baseline ?? seg.baseline;
  return {
    x,
    baseline,
    fontSize,
    y: baseline + (seg.y - seg.baseline) * ratio,
    height: seg.height * ratio,
    width: seg.width,
    moved: edit?.x !== undefined || edit?.baseline !== undefined,
  };
}
