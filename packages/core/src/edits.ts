/**
 * edits.ts — la semántica de editar un segmento, en UN lugar.
 *
 * Un SegmentEdit se construye SIEMPRE por acumulación de parches sobre el nodo
 * original (mergeSegmentEdit). Si el resultado queda idéntico al original
 * (mismo texto, cero overrides) devuelve null: la edición se revierte sola —
 * el caller borra la entrada en vez de guardar un no-op.
 */

import type { FontBucket, SegmentEdit, SegmentNode } from './model.js';

/** Un parche parcial: `undefined` = no tocar; `null` = LIMPIAR el override
 *  (volver al valor original del PDF). */
export interface SegmentPatch {
  text?: string;
  bold?: boolean | null;
  italic?: boolean | null;
  fontSize?: number | null;
  font?: FontBucket | null;
  x?: number | null;
  baseline?: number | null;
}

const OVERRIDE_KEYS = ['bold', 'italic', 'fontSize', 'font', 'x', 'baseline'] as const;

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
        original: { text: seg.text, x: seg.x, baseline: seg.baseline, width: seg.width, fontSize: seg.fontSize },
      };

  if (patch.text !== undefined) next.text = patch.text;
  for (const key of OVERRIDE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }

  const noop = next.text === seg.text && OVERRIDE_KEYS.every(k => next[k] === undefined);
  return noop ? null : next;
}

/** Geometría/tamaño EFECTIVOS de un segmento con su edición aplicada.
 *  Cambiar el tamaño escala el alto del box alrededor de la baseline. */
export function effectiveGeometry(seg: SegmentNode, edit: SegmentEdit | null) {
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
