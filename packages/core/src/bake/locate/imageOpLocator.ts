/**
 * ImageOpLocator — el `Do` de imagen cuyo rect matchea el snapshot original.
 * Trasplante VERBATIM de v1 locate.{matchImage, imageResourceNames,
 * xobjectRect}. Solo XObjects Subtype /Image se matchean JAMÁS un Form
 * XObject (envuelve contenido: extirparlo por error borraría todo lo de
 * adentro).
 */
import { PDFDict, PDFDocument, PDFName, PDFPage, PDFRawStream, PDFRef } from 'pdf-lib';
import type { ImageEdit } from '../../model/edits.js';
import type { Matrix } from '../../common/matrix.js';
import type { XObjectOp } from '../../pdf/contentWalk.js';
import type { ILocator } from './types.js';

/** Tolerancia proporcional al matchear el rect de un Do (mínimo 2pt, 2%). */
export const IMAGE_MATCH_TOL_MIN_PT = 2;
export const IMAGE_MATCH_TOL_RATIO = 0.02;

/** Bounding box of the unit square transformed by a Do's CTM. */
export function xobjectRect(m: Matrix) {
  const [a, b, c, d, e, f] = m;
  const xs = [e, a + e, c + e, a + c + e];
  const ys = [f, b + f, d + f, b + d + f];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, rotated: Math.abs(b) > 0.01 || Math.abs(c) > 0.01 };
}

/**
 * Names of the page's XObject resources that are IMAGES (Subtype /Image).
 * A `Do` can also invoke a Form XObject — which WRAPS content, so splicing it
 * out by mistake would delete everything inside: those are never matched.
 */
export function imageResourceNames(doc: PDFDocument, page: PDFPage): Set<string> {
  const out = new Set<string>();
  try {
    const res = page.node.Resources();
    const xo = res?.lookup(PDFName.of('XObject'));
    if (!(xo instanceof PDFDict)) return out;
    for (const [key, val] of xo.entries()) {
      const obj = val instanceof PDFRef ? doc.context.lookup(val) : val;
      const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      if (dict?.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
        out.add(key.toString().replace(/^\//, ''));
      }
    }
  } catch {
    /* no resources → no images */
  }
  return out;
}

export class ImageOpLocator implements ILocator<ImageEdit['original'], XObjectOp[], XObjectOp> {
  /** `imageOps` ya viene filtrado a Subtype /Image (el applier cruza
   *  `walk.xobjects` con {@link imageResourceNames}). */
  locate(orig: ImageEdit['original'], imageOps: XObjectOp[]): XObjectOp | null {
    const tol = Math.max(IMAGE_MATCH_TOL_MIN_PT, orig.width * IMAGE_MATCH_TOL_RATIO, orig.height * IMAGE_MATCH_TOL_RATIO);
    return imageOps.find(o => {
      const r = xobjectRect(o.matrix);
      return Math.abs(r.x - orig.x) <= tol && Math.abs(r.y - orig.y) <= tol &&
        Math.abs(r.width - orig.width) <= tol && Math.abs(r.height - orig.height) <= tol;
    }) ?? null;
  }
}
