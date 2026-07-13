/**
 * graph/extract/vectorRects.ts — rects vectoriales (paths rellenos) del
 * operator list. Trasplante verbatim de v1 extractGraph.ts
 * (extractVectorRects + applyVectorRects).
 *
 * Un constructPath puede traer MUCHOS sub-paths (todos los subrayados de la
 * página en un solo eoFill). Se descompone en sub-paths y cada uno rect-oso
 * (sin curvas, ≤5 puntos, o un `rectangle` op) da su bbox. De ahí salen:
 *  - SUBRAYADOS: rect fino justo bajo la baseline de un run → run.underline.
 *  - SHAPES: rects grandes (banners/fondos) → PageGraph.shapes.
 *
 * DEBE correr DESPUÉS de TextRunExtractor (lee ctx.draft.runs y les marca
 * `underline`) y ANTES de BlockExtractor (originalStyledRuns lee underline).
 */

import { mul, type Matrix } from '../../common/matrix.js';
import type { PageGraph, ShapeNode, TextRunNode } from '../../model/nodes.js';
import { annotIdOf } from './factory.js';
import type { ExtractContext, IGraphExtractor, PdfJsPage } from './types.js';

// Valores estables de pdfjs OPS (src/shared/util.js) — el único acople a
// pdf.js que core necesita para leer el operator list sin importarlo.
const OP_SAVE = 10;
const OP_RESTORE = 11;
const OP_TRANSFORM = 12;
const OP_CONSTRUCT_PATH = 91;
const OP_MOVETO = 13, OP_LINETO = 14, OP_CURVETO = 15, OP_CURVETO2 = 16, OP_CURVETO3 = 17, OP_CLOSEPATH = 18, OP_RECTANGLE = 19;
const OP_SET_FILL_RGB = 59;
const FILL_OPS = new Set([20, 21, 22, 23, 24, 25]); // stroke/closeStroke/fill/eoFill/fillStroke/eoFillStroke

export interface VectorRect { x: number; y: number; w: number; h: number; color?: string }

export function extractVectorRects(fnArray: number[], argsArray: unknown[][], x0: number, y0: number): VectorRect[] {
  const out: VectorRect[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let fill: string | undefined;
  let pending: { ops: number[]; coords: number[] } | null = null;
  const tx = (x: number, y: number): [number, number] => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === OP_SAVE) stack.push(ctm);
    else if (fn === OP_RESTORE) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OP_TRANSFORM) {
      const a = argsArray[i] as number[];
      ctm = mul([a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!], ctm);
    } else if (fn === OP_SET_FILL_RGB) {
      const a = argsArray[i] as number[];
      fill = `#${[a[0]!, a[1]!, a[2]!].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    } else if (fn === OP_CONSTRUCT_PATH) {
      const a = argsArray[i] as unknown[];
      pending = { ops: a[0] as number[], coords: Array.from(a[1] as ArrayLike<number>) };
    } else if (FILL_OPS.has(fn!)) {
      if (!pending) continue;
      // Descomponer en sub-paths: moveTo/rectangle abren uno nuevo.
      let k = 0;
      let cur: { xs: number[]; ys: number[]; pts: number; curved: boolean; isRectOp: boolean } | null = null;
      const flush = () => {
        if (!cur || cur.curved || (!cur.isRectOp && cur.pts > 5) || cur.xs.length < 2) { cur = null; return; }
        const minX = Math.min(...cur.xs), maxX = Math.max(...cur.xs);
        const minY = Math.min(...cur.ys), maxY = Math.max(...cur.ys);
        out.push({ x: minX - x0, y: minY - y0, w: maxX - minX, h: maxY - minY, color: fill });
        cur = null;
      };
      for (const op of pending.ops) {
        if (op === OP_MOVETO) {
          flush();
          const [px, py] = tx(pending.coords[k]!, pending.coords[k + 1]!); k += 2;
          cur = { xs: [px], ys: [py], pts: 1, curved: false, isRectOp: false };
        } else if (op === OP_LINETO) {
          const [px, py] = tx(pending.coords[k]!, pending.coords[k + 1]!); k += 2;
          if (cur) { cur.xs.push(px); cur.ys.push(py); cur.pts++; }
        } else if (op === OP_RECTANGLE) {
          flush();
          const [rx, ry, rw, rh] = [pending.coords[k]!, pending.coords[k + 1]!, pending.coords[k + 2]!, pending.coords[k + 3]!]; k += 4;
          const corners = [tx(rx, ry), tx(rx + rw, ry), tx(rx, ry + rh), tx(rx + rw, ry + rh)];
          cur = { xs: corners.map(c => c[0]), ys: corners.map(c => c[1]), pts: 4, curved: false, isRectOp: true };
          flush();
        } else if (op === OP_CURVETO) { k += 6; if (cur) cur.curved = true; }
        else if (op === OP_CURVETO2 || op === OP_CURVETO3) { k += 4; if (cur) cur.curved = true; }
        else if (op === OP_CLOSEPATH) { /* no-op para el bbox */ }
      }
      flush();
      pending = null;
    }
  }
  return out;
}

/** Marca `underline` en los runs que tienen un rect fino justo bajo su baseline,
 *  y devuelve los rects GRANDES (banners/fondos) como ShapeNode. */
export function applyVectorRects(rects: VectorRect[], runs: TextRunNode[], page: number, pageW: number, pageH: number): ShapeNode[] {
  const shapes: ShapeNode[] = [];
  let si = 0;
  for (const vr of rects) {
    if (vr.h <= 2.8 && vr.w >= 3) {
      // UNDERLINE: solape horizontal ≥60% del run y el techo del rect a ≤0.35×fs
      // bajo la baseline (un tachado queda ARRIBA de la baseline → dy negativo → no).
      for (const r of runs) {
        if (r.angle !== 0) continue;
        const overlap = Math.min(r.x + r.width, vr.x + vr.w) - Math.max(r.x, vr.x);
        if (overlap < 0.6 * Math.min(r.width, vr.w)) continue;
        const dy = r.baseline - (vr.y + vr.h);
        if (dy >= -0.5 && dy <= 0.35 * r.fontSize) r.underline = true;
      }
    } else if (vr.w >= 6 && vr.h >= 6 && vr.w * vr.h >= 400 && vr.w * vr.h < 0.85 * pageW * pageH) {
      shapes.push({ id: annotIdOf(page, 'shape', si++), kind: 'shape', page, x: vr.x, y: vr.y, width: vr.w, height: vr.h, color: vr.color });
    }
  }
  return shapes;
}

export class VectorRectExtractor implements IGraphExtractor {
  extract(_page: PdfJsPage, ctx: ExtractContext): Partial<PageGraph> {
    const rects = extractVectorRects(ctx.opList.fnArray, ctx.opList.argsArray, ctx.x0, ctx.y0);
    const shapes = applyVectorRects(rects, ctx.draft.runs ?? [], ctx.page, ctx.width, ctx.height);
    return { shapes };
  }
}
