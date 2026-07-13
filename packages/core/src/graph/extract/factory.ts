/**
 * graph/extract/factory.ts — la FACTORY de nodos: la generación de IDs y la
 * creación de Segment/LineNode viven en UN solo lugar.
 *
 * INVARIANTE (con test en test/extract.test.ts): los ids salen de la
 * GEOMETRÍA (`p{n}-y{baseline}-x{x}` redondeadas), NUNCA de un índice —
 * estables aunque otros nodos desaparezcan (el preview local extirpa los ops
 * de segmentos editados: con ids por índice, todos los ids posteriores se
 * corrían y rompían el mapa de ediciones). Las imágenes usan el objId de
 * pdf.js (+ contador `seen` si la misma imagen se pinta N veces): mover una
 * imagen "al frente" re-emite su Do al final → su índice cambiaría, el objId
 * es invariante al reorden.
 *
 * REGLA DURA: la factory NO normaliza/trimea texto jamás — U+0012 viaja
 * intacto (los acentos LibreOffice mueren si no).
 */

import type { LineNode, TextRunNode } from '../../model/nodes.js';
import { Segment } from '../segment.js';
import { segmentText, splitSegments } from '../tokens.js';

/** Id de run: el ÚNICO id posicional (los runs no sobreviven a re-extracts;
 *  nadie les cuelga ediciones). */
export const runIdOf = (page: number, index: number): string => `p${page}-r${index}`;

/** Id de línea por GEOMETRÍA (baseline redondeada). */
export const lineIdOf = (page: number, baseline: number): string => `p${page}-y${Math.round(baseline)}`;

/** Id de segmento por GEOMETRÍA (línea + x redondeada). */
export const segmentIdOf = (lineId: string, x: number): string => `${lineId}-x${Math.round(x)}`;

/** Id de imagen: por objId (estable al reorden), con contador para repintadas;
 *  sin objId (máscaras/inline), cae al índice — v1 verbatim. */
export const imageIdOf = (page: number, objId: string | undefined, seen: Map<string, number>, index: number): string => {
  if (!objId) return `p${page}-img${index}`;
  const n = seen.get(objId) ?? 0;
  seen.set(objId, n + 1);
  return n === 0 ? `p${page}-${objId}` : `p${page}-${objId}#${n}`;
};

/** Ids de anotaciones/shapes: por índice DENTRO de su colección (v1 verbatim —
 *  las anotaciones viven en /Annots, el preview no las extirpa del stream). */
export const annotIdOf = (page: number, prefix: 'w' | 'link' | 'hl' | 'shape', index: number): string =>
  `p${page}-${prefix}${index}`;

/** Geometría compartida de un grupo de runs (segmento o línea entera). */
export function bboxOf(runs: TextRunNode[]) {
  const x = runs[0]!.x;
  const right = Math.max(...runs.map(r => r.x + r.width));
  const baseline = runs[0]!.baseline;
  const fontSize = Math.max(...runs.map(r => r.fontSize));
  const ascent = Math.max(...runs.map(r => r.font.ascent * r.fontSize));
  const descent = Math.min(...runs.map(r => r.font.descent * r.fontSize));
  return { x, baseline, width: right - x, y: baseline + descent, height: ascent - descent, fontSize };
}

/** Un segmento desde sus runs (ya ordenados por x, misma línea). */
export function makeSegment(page: number, lineId: string, segRuns: TextRunNode[]): Segment {
  const b = bboxOf(segRuns);
  return new Segment(
    segmentIdOf(lineId, segRuns[0]!.x),
    page,
    segRuns,
    b.x, b.baseline, b.width, b.y, b.height, b.fontSize,
    segmentText(segRuns),
  );
}

/** Un bloque MULTILÍNEA re-fusionado (mergeBlockSegments): conserva id/x/
 *  baseline/fontSize del PRIMER segmento de la cadena (v1 spread `...first`),
 *  ancho = máximo de la cadena, alto = de la primera a la última línea,
 *  texto = líneas unidas con '\n' (regla del modelo). */
export function makeMergedBlock(chain: Segment[]): Segment {
  const first = chain[0]!;
  const last = chain[chain.length - 1]!;
  return new Segment(
    first.id,
    first.page,
    chain.flatMap(s => s.runs),
    first.x,
    first.baseline,
    Math.max(...chain.map(s => s.width)),
    last.y,
    first.y + first.height - last.y,
    first.fontSize,
    chain.map(s => s.text).join('\n'),
  );
}

/** Una línea desde su grupo de runs: parte en segmentos por gap de columna. */
export function lineFromRuns(group: TextRunNode[], page: number): LineNode {
  const runs = [...group].sort((a, b) => a.x - b.x);
  // Id por GEOMETRÍA (no por índice): estable aunque otras líneas desaparezcan.
  const lineId = lineIdOf(page, runs[0]!.baseline);
  const segments = splitSegments(runs).map(segRuns => makeSegment(page, lineId, segRuns));
  return {
    id: lineId,
    kind: 'line',
    page,
    text: segments.map(s => s.text).join(' '),
    segments,
    ...bboxOf(runs),
  };
}
