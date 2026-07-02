/**
 * tokens.ts — clasificación de gaps y segmentación de una línea.
 *
 * Umbrales de la industria (pdfminer char_margin / PDFBox spacingTolerance),
 * RELATIVOS al ancho medio de carácter de los runs vecinos — no al fontSize:
 *  - gap > 2.0 × charW  → FRONTERA DE SEGMENTO (columna/tab; el "char_margin"
 *                          de pdfminer). El gap no se almacena: queda derivado
 *                          de las x de anclaje de los dos segmentos.
 *  - gap > 0.5 × charW  → un espacio de palabra real (carácter editable).
 *  - menor              → ruido de kerning / ajuste TJ de justificado: nada.
 *
 * Estos umbrales viven SOLO acá; los usan la extracción (browser) y el bake
 * (server) para que ambos vean los mismos segmentos.
 */

import type { TextRunNode } from './model.js';

export function avgCharWidth(run: TextRunNode): number {
  const w = run.width / Math.max(1, run.text.length);
  // Piso defensivo: un run degenerado (un punto, un glifo raro) no puede
  // hacer que cualquier gap parezca una columna.
  return Math.max(w, run.fontSize * 0.2);
}

export type GapClass = 'none' | 'space' | 'column';

export function classifyGap(gap: number, prev: TextRunNode, next: TextRunNode): GapClass {
  if (gap <= 0) return 'none';
  const ref = (avgCharWidth(prev) + avgCharWidth(next)) / 2;
  if (gap > 2.0 * ref) return 'column';
  if (gap > 0.5 * ref) return 'space';
  return 'none';
}

/** Parte los runs (ya ordenados por x, misma baseline) en segmentos:
 *  cada gap de columna abre uno nuevo. */
export function splitSegments(runsSorted: TextRunNode[]): TextRunNode[][] {
  const segments: TextRunNode[][] = [];
  let current: TextRunNode[] = [];
  for (const run of runsSorted) {
    if (current.length === 0) {
      current.push(run);
      continue;
    }
    const prev = current[current.length - 1];
    const gap = run.x - (prev.x + prev.width);
    if (classifyGap(gap, prev, run) === 'column') {
      segments.push(current);
      current = [run];
    } else {
      current.push(run);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

/** El texto de un segmento: runs concatenados con los espacios de palabra
 *  inferidos (los gaps sub-espacio son render, no contenido). */
export function segmentText(runsSorted: TextRunNode[]): string {
  let text = '';
  for (let i = 0; i < runsSorted.length; i++) {
    const run = runsSorted[i];
    if (i > 0) {
      const prev = runsSorted[i - 1];
      const gap = run.x - (prev.x + prev.width);
      if (classifyGap(gap, prev, run) === 'space' && !text.endsWith(' ') && !run.text.startsWith(' ')) {
        text += ' ';
      }
    }
    text += run.text;
  }
  return text;
}
