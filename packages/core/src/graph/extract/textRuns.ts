/**
 * graph/extract/textRuns.ts — los TextRunNode desde el textContent de pdf.js.
 * Mates verbatim de v1 extractGraph.ts:
 *  - baseline = f de la text matrix [a b c d e f] (la y exacta del texto).
 *  - fontSize = |columna y| = hypot(c, d) — sobrevive a texto escalado.
 *  - angle = atan2(b, a).
 * Filtra items vacíos/whitespace-only (v1: `str.trim().length === 0`) — es un
 * FILTRO de items, nunca una mutación del texto conservado.
 */

import type { PageGraph, TextRunNode } from '../../model/nodes.js';
import { runIdOf } from './factory.js';
import type { ExtractContext, IGraphExtractor, PdfJsPage } from './types.js';

export class TextRunExtractor implements IGraphExtractor {
  extract(_page: PdfJsPage, ctx: ExtractContext): Partial<PageGraph> {
    const runs: TextRunNode[] = [];
    let i = 0;
    for (const item of ctx.items) {
      if (typeof item.str !== 'string' || item.str.trim().length === 0) continue;
      const [a, b, c, d, e, f] = item.transform as [number, number, number, number, number, number];
      runs.push({
        id: runIdOf(ctx.page, i++),
        kind: 'text',
        page: ctx.page,
        text: item.str,
        x: e - ctx.x0,
        baseline: f - ctx.y0,
        width: item.width,
        fontSize: Math.hypot(c, d),
        angle: Math.atan2(b, a),
        font: ctx.fontInfoFor(item.fontName),
      });
    }
    return { runs };
  }
}
