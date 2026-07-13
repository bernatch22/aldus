/**
 * FillRectLocator — la forma vectorial (banner/caja) entre los `fillRects` que
 * trackeó el walk. Trasplante VERBATIM de v1 shapes.matchRect: NEAREST
 * neighbor por distancia manhattan, aceptado solo dentro de la tolerancia.
 */
import type { ShapeEdit } from '../../model/edits.js';
import type { FillRectOp } from '../../pdf/contentWalk.js';
import type { ILocator } from './types.js';

/** pt — tolerancia para casar la forma con su fillRect (manhattan ≤ TOL×4). */
export const SHAPE_MATCH_TOL_PT = 2.0;

export class FillRectLocator implements ILocator<ShapeEdit['original'], FillRectOp[], FillRectOp> {
  locate(o: ShapeEdit['original'], rects: FillRectOp[]): FillRectOp | null {
    let best: FillRectOp | null = null;
    let bestD = Infinity;
    for (const r of rects) {
      const d = Math.abs(r.x - o.x) + Math.abs(r.y - o.y) + Math.abs(r.width - o.width) + Math.abs(r.height - o.height);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best && bestD <= SHAPE_MATCH_TOL_PT * 4 ? best : null;
  }
}
