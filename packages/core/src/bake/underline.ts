/**
 * bake/underline.ts — LA FUENTE ÚNICA de la geometría del subrayado
 * (duplicación #5 del plan / riesgo #3 del audit: la tríada vivía en TRES
 * lugares — el filtro de text.ts, la emisión de StyledRunsReemit y el
 * drawUnderline de fallback.ts — acoplados sin nada que lo hiciera cumplir;
 * si divergen, el filtro deja de encontrar lo que la emisión dibuja →
 * subrayados huérfanos, "la línea fantasma").
 *
 * Acá viven EMISIÓN y PREDICADO juntos, con test de consistencia colocado:
 * lo que {@link underlineRectFor} emite, {@link underlineRectsFor} lo
 * encuentra. Los VALORES no se tocan (regla dura #2).
 */
import type { SegmentEdit } from '../model/edits.js';
import type { FillRectOp } from '../pdf/contentWalk.js';

/** y del rect = baseline − size × DROP. */
export const UNDERLINE_DROP_FACTOR = 0.11;
/** alto del rect = size × HEIGHT. */
export const UNDERLINE_HEIGHT_FACTOR = 0.055;
/** Filtro: un rect es "fino" si height ≤ max(1.5, size × MAX_HEIGHT_FACTOR). */
export const UNDERLINE_MAX_HEIGHT_FLOOR_PT = 1.5;
export const UNDERLINE_MAX_HEIGHT_FACTOR = 0.12;
/** Filtro: |y − (baseline − size×DROP)| ≤ size × Y_TOL_FACTOR. */
export const UNDERLINE_Y_TOL_FACTOR = 0.2;
/** Filtro: margen horizontal (pt) alrededor del segmento. */
export const UNDERLINE_X_SLACK_PT = 2;

/** EMISIÓN: el rect del subrayado de un tramo (coords absolutas). */
export function underlineRectFor(x: number, baseline: number, size: number, width: number): {
  x: number; y: number; width: number; height: number;
} {
  return { x, y: baseline - size * UNDERLINE_DROP_FACTOR, width, height: size * UNDERLINE_HEIGHT_FACTOR };
}

/**
 * PREDICADO/FILTRO: los subrayados que PERTENECEN a un segmento — rects
 * rellenos finos justo bajo una de sus baselines, horizontalmente adentro.
 * El bake los emite como `y = baseline - size*0.11, h = size*0.055` — este
 * filtro es su espejo. Deben SEGUIR a su texto: reubicados al mover (path A),
 * extirpados al eliminar y en rewrites (B/C re-emiten frescos desde los runs).
 * Trasplante VERBATIM de v1 text.ts underlineRectsFor.
 */
export function underlineRectsFor(edit: SegmentEdit, fillRects: FillRectOp[]): FillRectOp[] {
  const size = edit.original.fontSize;
  const lines = edit.original.baselines?.length ? edit.original.baselines : [edit.original.baseline];
  const x0 = edit.original.x - UNDERLINE_X_SLACK_PT;
  const x1 = edit.original.x + edit.original.width + UNDERLINE_X_SLACK_PT;
  return fillRects.filter(r =>
    r.height <= Math.max(UNDERLINE_MAX_HEIGHT_FLOOR_PT, size * UNDERLINE_MAX_HEIGHT_FACTOR) &&
    r.x < x1 && r.x + r.width > x0 &&
    lines.some(b => Math.abs(r.y - (b - size * UNDERLINE_DROP_FACTOR)) <= size * UNDERLINE_Y_TOL_FACTOR),
  );
}
