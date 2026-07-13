/**
 * graph/tokens.ts — clasificación de gaps y segmentación de una línea.
 *
 * Umbrales de la industria (pdfminer char_margin / PDFBox spacingTolerance),
 * RELATIVOS al ancho medio de carácter de los runs vecinos — no al fontSize:
 *  - gap > 2.0 × charW  → FRONTERA DE SEGMENTO (columna/tab; el "char_margin"
 *                          de pdfminer). El gap no se almacena: queda derivado
 *                          de las x de anclaje de los dos segmentos.
 *  - gap > 0.5 × charW  → un espacio de palabra real (carácter editable).
 *  - menor              → ruido de kerning / ajuste TJ de justificado: nada.
 *
 * Estos umbrales viven SOLO acá — única fuente de verdad de la segmentación.
 * Los comparten la extracción (browser y Node), la lectura estilada del grafo
 * (segmentContent) y el editor (styledDom). El BAKE no los usa: localiza por
 * GEOMETRÍA (locate, ~1.8pt), nunca clasifica gaps — v1 CLAUDE.md decía
 * "extract + bake" y era literalmente falso (audit-model lo probó).
 *
 * Trasplante VERBATIM de v1 tokens.ts (valores sagrados: 2.0 / 0.5 / 0.12 /
 * piso 0.2×fs).
 */

import type { TextRunNode } from '../model/nodes.js';

export function avgCharWidth(run: TextRunNode): number {
  const w = run.width / Math.max(1, run.text.length);
  // Piso defensivo: un run degenerado (un punto, un glifo raro) no puede
  // hacer que cualquier gap parezca una columna.
  return Math.max(w, run.fontSize * 0.2);
}

export type GapClass = 'none' | 'space' | 'column';

export function classifyGap(gap: number, prev: TextRunNode, next: TextRunNode): GapClass {
  if (gap <= 0) return 'none';
  const aw = avgCharWidth(prev);
  const bw = avgCharWidth(next);
  // COLUMNA (frontera estructural): se mide contra el char width MAYOR de los
  // vecinos. Un token corto (marcador de lista "i)"/"a)"/"•") tiene un
  // avgCharWidth diminuto; con el PROMEDIO arrastraba el umbral hacia abajo y un
  // simple espacio después del marcador se leía como columna → el marcador
  // quedaba de nodo suelto (inconsistente: "i)" partido pero "ii)" no). Con el
  // max, una columna real (gap grande) sigue partiendo; el espacio no.
  if (gap > 2.0 * Math.max(aw, bw)) return 'column';
  // ESPACIO de palabra: el promedio va bien (no lo tocamos).
  if (gap > 0.5 * ((aw + bw) / 2)) return 'space';
  // ESPACIO COMPRIMIDO: el texto justificado aprieta el espacio muy por debajo
  // de 0.5×charW ("Siel número deRUC": gaps de 1.5-2pt con charW 4.7). Un gap
  // >0.12×fontSize (~1.4pt en 11.3pt) sigue siendo palabra: el kerning entre
  // glifos casi nunca supera ~0.08em. Relativo al fontSize, no al charW (que en
  // runs cortos se degenera).
  const fs = (prev.fontSize + next.fontSize) / 2;
  if (gap > 0.12 * fs) return 'space';
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
    const prev = current[current.length - 1]!;
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
    const run = runsSorted[i]!;
    if (i > 0) {
      const prev = runsSorted[i - 1]!;
      const gap = run.x - (prev.x + prev.width);
      if (classifyGap(gap, prev, run) === 'space' && !text.endsWith(' ') && !run.text.startsWith(' ')) {
        text += ' ';
      }
    }
    text += run.text;
  }
  return text;
}
