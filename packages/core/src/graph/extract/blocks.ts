/**
 * graph/extract/blocks.ts — agrupado runs → líneas → segmentos, y la
 * re-fusión de bloques multilínea del bake. Trasplante verbatim de v1
 * extractGraph.ts (groupIntoLines + mergeBlockSegments).
 *
 * DEBE correr después de VectorRectExtractor (los runs ya llevan `underline`
 * marcado cuando se congela el contenido estilado del segmento).
 */

import type { LineNode, PageGraph, SegmentNode, TextRunNode } from '../../model/nodes.js';
import type { Segment } from '../segment.js';
import { lineFromRuns, makeMergedBlock } from './factory.js';
import type { ExtractContext, IGraphExtractor, PdfJsPage } from './types.js';

/** Agrupa runs horizontales por baseline (tolerancia relativa al tamaño);
 *  los rotados quedan como líneas de un solo run. */
export function groupIntoLines(runs: TextRunNode[], page: number): LineNode[] {
  const horizontal = runs.filter(r => Math.abs(r.angle) < 0.01);
  const rotated = runs.filter(r => Math.abs(r.angle) >= 0.01);
  const sorted = [...horizontal].sort((p, q) => q.baseline - p.baseline || p.x - q.x);
  const groups: TextRunNode[][] = [];
  for (const r of sorted) {
    const current = groups[groups.length - 1];
    const tol = Math.max(1, r.fontSize * 0.35);
    if (current && Math.abs(current[0]!.baseline - r.baseline) <= tol) current.push(r);
    else groups.push([r]);
  }
  for (const r of rotated) groups.push([r]);
  return groups.map(g => lineFromRuns(g, page));
}

/** Re-agrupa en UN segmento multilínea las líneas consecutivas que llevan la
 *  firma de un BLOQUE de Aldus: línea de un solo segmento, misma x (±0.5pt),
 *  mismo tamaño (±0.1) y leading 1.2×size (±0.06×size) — el que escribe el
 *  bake para los breaklines. Sin esto, guardar un bloque lo desintegraba en
 *  un grafo por línea. `text` une las líneas con '\n' (regla del modelo).
 *  ⚠️ Los números (0.5 / 0.1 / 1.2 / 0.06) son la firma EXACTA de lo que emite
 *  el bake — cambiar uno sin el otro rompe el roundtrip bake→extract. */
export function mergeBlockSegments(lines: LineNode[]): SegmentNode[] {
  const out: SegmentNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.segments.length !== 1) {
      out.push(...line.segments);
      i++;
      continue;
    }
    const chain: SegmentNode[] = [line.segments[0]!];
    let j = i + 1;
    while (j < lines.length) {
      const prev = chain[chain.length - 1]!;
      const next = lines[j]!.segments.length === 1 ? lines[j]!.segments[0]! : null;
      if (!next) break;
      const step = prev.baseline - next.baseline;
      const lead = prev.fontSize * 1.2;
      const match = Math.abs(next.x - prev.x) <= 0.5
        && Math.abs(next.fontSize - prev.fontSize) <= 0.1
        && Math.abs(step - lead) <= prev.fontSize * 0.06;
      if (!match) break;
      chain.push(next);
      j++;
    }
    if (chain.length === 1) {
      out.push(chain[0]!);
    } else {
      out.push(makeMergedBlock(chain as Segment[]));
    }
    i = j;
  }
  return out;
}

export class BlockExtractor implements IGraphExtractor {
  extract(_page: PdfJsPage, ctx: ExtractContext): Partial<PageGraph> {
    const lines = groupIntoLines(ctx.draft.runs ?? [], ctx.page);
    return { lines, segments: mergeBlockSegments(lines) };
  }
}
