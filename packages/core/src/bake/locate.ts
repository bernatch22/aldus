/**
 * Locating the original operators of an edit inside the content stream —
 * always BY GEOMETRY against the edit's `original` snapshot, never by index
 * (indexes shift; geometry is what the user actually edited).
 *
 * If a segment can't be located unambiguously, the caller gets a `conflict`
 * string and MUST skip the edit with a warning: never touch what you don't
 * understand.
 */
import { PDFDict, PDFDocument, PDFName, PDFPage, PDFRawStream, PDFRef } from 'pdf-lib';
import type { ImageEdit, SegmentEdit } from '../model.js';
import type { ShowOp, XObjectOp } from './textWalk.js';

/** Geometry tolerance (pt) when matching text ops to a segment snapshot. */
export const Y_TOL = 1.8;
export const X_TOL = 1.8;

/** Bounding box of the unit square transformed by a Do's CTM. */
export function xobjectRect(m: [number, number, number, number, number, number]) {
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

/** Find the image Do whose rect matches the edit's original snapshot. */
export function matchImage(xobjects: XObjectOp[], orig: ImageEdit['original']): XObjectOp | null {
  const tol = Math.max(2, orig.width * 0.02, orig.height * 0.02);
  return xobjects.find(o => {
    const r = xobjectRect(o.matrix);
    return Math.abs(r.x - orig.x) <= tol && Math.abs(r.y - orig.y) <= tol &&
      Math.abs(r.width - orig.width) <= tol && Math.abs(r.height - orig.height) <= tol;
  }) ?? null;
}

/**
 * All show ops belonging to a segment snapshot (multi-line blocks match every
 * baseline). Returns a `conflict` reason instead of ops when the match would
 * be a guess (stale chained shows, or no op starting inside the segment).
 */
export function matchOps(
  shows: ShowOp[],
  orig: SegmentEdit['original'],
): { ops: ShowOp[]; conflict: string | null } {
  const lines = orig.baselines?.length ? orig.baselines : [orig.baseline];
  const inLine = shows.filter(s => lines.some(b => Math.abs(s.y - b) <= Y_TOL));
  if (inLine.some(s => s.stale)) {
    return { ops: [], conflict: 'la línea tiene shows encadenados sin reposicionar (x desconocida sin widths)' };
  }
  const inside = inLine.filter(s => s.x >= orig.x - X_TOL && s.x <= orig.x + orig.width + X_TOL);
  if (!inside.length) {
    return { ops: [], conflict: 'ningún operador de texto arranca dentro del segmento (¿un TJ de otra columna lo contiene?)' };
  }
  return { ops: inside, conflict: null };
}
