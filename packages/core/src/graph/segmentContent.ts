/**
 * graph/segmentContent.ts — semántica de LECTURA del contenido de un segmento
 * (Layer 1). Trasplante verbatim de la parte de lectura de v1 edits.ts:
 * runLines / originalStyledRuns / styledRunsEqual / styledText /
 * segmentOriginal. La MUTACIÓN (applyTextDiff, toggles, list-markers, ledger)
 * llega en F4 (edit/).
 */

import type { SegmentEdit } from '../model/edits.js';
import type { SegmentNode, StyledRun, TextRunNode } from '../model/nodes.js';
import { classifyGap } from './tokens.js';

/**
 * El umbral super/subíndice: una caída de baseline MENOR a este factor × el
 * fontSize máximo del segmento NO abre línea nueva. Única fuente de verdad —
 * la comparten {@link runLines} y la proyección a buckets de
 * PageGraphService.segmentsAt (que por discretizar un umbral continuo DEBE
 * chequear bucket±1). Valor sagrado (regla dura #2 del plan): 0.55.
 */
export const SUPERSCRIPT_BREAK_FACTOR = 0.55;

/** Agrupa los runs de un segmento en LÍNEAS visuales. Un run cuya baseline está
 *  dentro de un umbral de super/subíndice (≈0.55× el fontSize máximo) NO abre
 *  línea nueva — un "1" superíndice o un marcador de lista es la MISMA línea. Solo
 *  una caída ≥ ese umbral (line-height real) abre línea. Orden: de arriba hacia
 *  abajo, izquierda a derecha dentro de cada línea. ÚNICA fuente de verdad del
 *  agrupado en líneas — la comparten seg.text, originalStyledRuns y el editor. */
export function runLines(seg: Pick<SegmentNode, 'runs'>): TextRunNode[][] {
  const maxFs = Math.max(1, ...seg.runs.map(r => r.fontSize));
  const brk = maxFs * SUPERSCRIPT_BREAK_FACTOR;
  const ordered = [...seg.runs].sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  const lines: TextRunNode[][] = [];
  for (const r of ordered) {
    const line = lines[lines.length - 1];
    if (line && line[0]!.baseline - r.baseline < brk) line.push(r);
    else lines.push([r]);
  }
  return lines.map(l => [...l].sort((a, b) => a.x - b.x));
}

/** El contenido del segmento SIN editar, como runs estilados (tramos por
 *  estilo, con los espacios de palabra inferidos y su dx real). */
export function originalStyledRuns(seg: SegmentNode): StyledRun[] {
  // Bloque MULTILÍNEA: los runs se agrupan por LÍNEA VISUAL (runLines: un
  // super/subíndice NO abre línea) y las líneas se unen con '\n' — seg.text usa
  // la misma regla.
  const lines = runLines(seg);
  const out: StyledRun[] = [];
  for (let li = 0; li < lines.length; li++) {
    const runs = lines[li]!;
    if (li > 0 && out.length) out[out.length - 1]!.text += '\n';
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!;
      let space = '';
      if (i > 0) {
        const prev = runs[i - 1]!;
        const gap = r.x - (prev.x + prev.width);
        if (classifyGap(gap, prev, r) === 'space' && !out[out.length - 1]?.text.endsWith(' ') && !r.text.startsWith(' ')) {
          space = ' ';
        }
      }
      const last = out[out.length - 1];
      if (last && last.bold === r.font.bold && last.italic === r.font.italic && last.color === r.color && !!last.underline === !!r.underline) {
        last.text += space + r.text;
      } else {
        if (last && space) last.text += space;
        out.push({ text: r.text, bold: r.font.bold, italic: r.font.italic, color: r.color, ...(r.underline ? { underline: true, w: Math.round(r.width * 10) / 10 } : {}), dx: r.x - seg.x });
      }
    }
  }
  return out;
}

export function styledRunsEqual(a: StyledRun[], b: StyledRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.text !== b[i]!.text || a[i]!.bold !== b[i]!.bold || a[i]!.italic !== b[i]!.italic || a[i]!.color !== b[i]!.color || !!a[i]!.underline !== !!b[i]!.underline) return false;
  }
  return true;
}

export const styledText = (runs: StyledRun[]): string => runs.map(r => r.text).join('');

/** Snapshot inmutable del estado ORIGINAL de un segmento (lo que el bake usa
 *  para localizar sus ops por geometría). */
export function segmentOriginal(seg: SegmentNode): SegmentEdit['original'] {
  const dom = seg.runs.reduce((a, b) => (b.width > a.width ? b : a));
  // Bloque multilínea: baselines únicas de los runs (desc = orden de lectura).
  const baselines = [...new Set(seg.runs.map(r => Math.round(r.baseline * 10) / 10))].sort((a, b) => b - a);
  return {
    text: seg.text, x: seg.x, baseline: seg.baseline, width: seg.width, fontSize: seg.fontSize,
    bucket: dom.font.bucket, bold: dom.font.bold, italic: dom.font.italic,
    runs: [...seg.runs].sort((a, b) => a.x - b.x).map(r => ({ x: r.x, bold: r.font.bold, italic: r.font.italic })),
    ...(baselines.length > 1 ? { baselines } : {}),
  };
}
