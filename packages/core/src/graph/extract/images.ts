/**
 * graph/extract/images.ts — imágenes de la página desde el operator list de
 * pdf.js: cada paint de XObject con su CTM → bounding box del unit square
 * transformado. Trasplante verbatim de v1 extractGraph.ts (extractImages).
 */

import { mul, type Matrix } from '../../common/matrix.js';
import type { ImageNode, PageGraph } from '../../model/nodes.js';
import { imageIdOf } from './factory.js';
import type { ExtractContext, IGraphExtractor, PdfJsPage } from './types.js';

// Valores estables de pdfjs OPS (src/shared/util.js).
const OP_SAVE = 10;
const OP_RESTORE = 11;
const OP_TRANSFORM = 12;
const OP_PAINT_IMAGE = 85;
const OP_PAINT_INLINE_IMAGE = 86;
const OP_PAINT_IMAGE_MASK = 83;
const OP_PAINT_IMAGE_REPEAT = 88;
const PAINT_OPS = new Set([OP_PAINT_IMAGE, OP_PAINT_INLINE_IMAGE, OP_PAINT_IMAGE_MASK, OP_PAINT_IMAGE_REPEAT]);

export function extractImages(fnArray: number[], argsArray: unknown[][], page: number, x0: number, y0: number): ImageNode[] {
  const images: ImageNode[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  // ID ESTABLE por objId del XObject (no por índice en el stream): mover una
  // imagen "al frente" re-emite su Do al final → su índice cambiaría y el ID
  // posicional saltaría a otra imagen. El objId es invariante al reorden. Un
  // contador por objId desambigua el caso raro de la misma imagen pintada N veces.
  const seen = new Map<string, number>();
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === OP_SAVE) stack.push(ctm);
    else if (fn === OP_RESTORE) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OP_TRANSFORM) {
      const a = argsArray[i] as number[];
      ctm = mul([a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!], ctm);
    } else if (PAINT_OPS.has(fn!)) {
      const [a, b, c, d, e, f] = ctm;
      const xs = [e, a + e, c + e, a + c + e];
      const ys = [f, b + f, d + f, b + d + f];
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      // objId: paintImageXObject/Repeat pasan [objId, w, h] (string en args[0]);
      // máscaras / inline images llevan el data object directo → sin objId.
      const arg0 = (argsArray[i] as unknown[])[0];
      const objId = (fn === OP_PAINT_IMAGE || fn === OP_PAINT_IMAGE_REPEAT) && typeof arg0 === 'string' ? arg0 : undefined;
      images.push({
        id: imageIdOf(page, objId, seen, images.length),
        kind: 'image',
        page,
        x: minX - x0,
        y: minY - y0,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
        rotated: Math.abs(b) > 0.01 || Math.abs(c) > 0.01,
        objId,
      });
    }
  }
  return images;
}

export class ImageExtractor implements IGraphExtractor {
  extract(_page: PdfJsPage, ctx: ExtractContext): Partial<PageGraph> {
    return { images: extractImages(ctx.opList.fnArray, ctx.opList.argsArray, ctx.page, ctx.x0, ctx.y0) };
  }
}
