/**
 * edits.ts — la semántica de editar un segmento, en UN lugar.
 *
 * Un SegmentEdit se construye SIEMPRE por acumulación de parches sobre el nodo
 * original (mergeSegmentEdit). Si el resultado queda idéntico al original
 * (mismo texto, mismo estilo por run, cero overrides) devuelve null: la
 * edición se revierte sola — el caller borra la entrada en vez de guardar un
 * no-op.
 *
 * El estilo (bold/italic) vive a nivel de RUN (`edit.runs`), nunca del
 * segmento: quitar la negrita a una parte no toca el resto.
 */

import type { FontBucket, SegmentEdit, SegmentNode, StyledRun } from './model.js';
import { classifyGap } from './tokens.js';

/** Un parche parcial: `undefined` = no tocar; `null` = LIMPIAR el override
 *  (volver al valor original del PDF). */
export interface SegmentPatch {
  text?: string;
  runs?: StyledRun[] | null;
  fontSize?: number | null;
  font?: FontBucket | null;
  x?: number | null;
  baseline?: number | null;
}

const OVERRIDE_KEYS = ['fontSize', 'font', 'x', 'baseline'] as const;

/** El contenido del segmento SIN editar, como runs estilados (tramos por
 *  estilo, con los espacios de palabra inferidos y su dx real). */
export function originalStyledRuns(seg: SegmentNode): StyledRun[] {
  const runs = [...seg.runs].sort((a, b) => a.x - b.x);
  const out: StyledRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    let space = '';
    if (i > 0) {
      const prev = runs[i - 1];
      const gap = r.x - (prev.x + prev.width);
      if (classifyGap(gap, prev, r) === 'space' && !out[out.length - 1]?.text.endsWith(' ') && !r.text.startsWith(' ')) {
        space = ' ';
      }
    }
    const last = out[out.length - 1];
    if (last && last.bold === r.font.bold && last.italic === r.font.italic) {
      last.text += space + r.text;
    } else {
      if (last && space) last.text += space;
      out.push({ text: r.text, bold: r.font.bold, italic: r.font.italic, dx: r.x - seg.x });
    }
  }
  return out;
}

export function styledRunsEqual(a: StyledRun[], b: StyledRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || a[i].bold !== b[i].bold || a[i].italic !== b[i].italic) return false;
  }
  return true;
}

export const styledText = (runs: StyledRun[]): string => runs.map(r => r.text).join('');

export function mergeSegmentEdit(
  seg: SegmentNode,
  prev: SegmentEdit | null,
  patch: SegmentPatch,
): SegmentEdit | null {
  const dom = seg.runs.reduce((a, b) => (b.width > a.width ? b : a));
  const next: SegmentEdit = prev
    ? { ...prev }
    : {
        segmentId: seg.id,
        page: seg.page,
        text: seg.text,
        original: {
          text: seg.text, x: seg.x, baseline: seg.baseline, width: seg.width, fontSize: seg.fontSize,
          bucket: dom.font.bucket, bold: dom.font.bold, italic: dom.font.italic,
          runs: [...seg.runs].sort((a, b) => a.x - b.x).map(r => ({ x: r.x, bold: r.font.bold, italic: r.font.italic })),
        },
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
    else (next as Record<string, unknown>)[key] = value;
  }

  const noop =
    next.text === seg.text &&
    next.runs === undefined &&
    OVERRIDE_KEYS.every(k => next[k] === undefined);
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
