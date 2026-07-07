/**
 * Shared machinery for editing /Annots-layer objects (highlights, links):
 * locate the annotation on its page BY ITS ORIGINAL RECT (never by index —
 * same policy as the content-stream bake), then rewrite /Rect or remove it.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import type { BakeReport } from './report.js';

export interface AnnotRectEdit {
  /** Node id, for report messages. */
  id: string;
  page: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  remove?: boolean;
  original: { x: number; y: number; width: number; height: number };
}

const rectNums = (rect: PDFArray): [number, number, number, number] | null => {
  if (rect.size() !== 4) return null;
  const nums = [0, 1, 2, 3].map(k => Number((rect.get(k) as { asNumber?: () => number }).asNumber?.() ?? NaN));
  return nums.some(Number.isNaN) ? null : (nums as [number, number, number, number]);
};

/**
 * Apply move/resize/remove edits to annotations of `subtype`. `onRect` lets a
 * subtype rewrite its extra geometry (e.g. /QuadPoints for highlights) when
 * the rect changes. `label` is the human noun for report messages.
 */
export function applyAnnotRectEdits(
  doc: PDFDocument,
  subtype: string,
  label: string,
  edits: AnnotRectEdit[],
  report: BakeReport,
  onRect?: (dict: PDFDict, nx: number, ny: number, nw: number, nh: number) => void,
): void {
  if (!edits.length) return;
  const tol = 2;
  for (const edit of edits) {
    const page = doc.getPages()[edit.page - 1];
    if (!page) {
      report.warn(`${edit.id}: página ${edit.page} fuera de rango — sin cambios`);
      continue;
    }
    // lookupMaybe (NO lookup): la variante tipada de pdf-lib LANZA si /Annots
    // falta ("Expected instance of PDFArray, but got instance of undefined")
    // — el guard de abajo sería código muerto. Con lookupMaybe volvemos a un
    // undefined manejable en páginas sin anotaciones.
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) {
      report.warn(`${edit.id}: la página no tiene /Annots — sin cambios`);
      continue;
    }
    let done = false;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (!(dict instanceof PDFDict)) continue;
      if (dict.get(PDFName.of('Subtype')) !== PDFName.of(subtype)) continue;
      const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
      const nums = rect ? rectNums(rect) : null;
      if (!nums) continue;
      const [ax, ay, bx, by] = nums;
      const rx = Math.min(ax, bx), ry = Math.min(ay, by), rw = Math.abs(bx - ax), rh = Math.abs(by - ay);
      if (
        Math.abs(rx - edit.original.x) <= tol && Math.abs(ry - edit.original.y) <= tol &&
        Math.abs(rw - edit.original.width) <= tol && Math.abs(rh - edit.original.height) <= tol
      ) {
        if (edit.remove) {
          annots.remove(i);
          report.apply(`${edit.id}: ${label} eliminado`);
        } else {
          const nx = edit.x ?? rx, ny = edit.y ?? ry, nw = edit.width ?? rw, nh = edit.height ?? rh;
          dict.set(PDFName.of('Rect'), doc.context.obj([nx, ny, nx + nw, ny + nh]));
          onRect?.(dict, nx, ny, nw, nh);
          report.apply(`${edit.id}: ${label} reubicado/escalado`);
        }
        done = true;
        break;
      }
    }
    if (!done) report.warn(`${edit.id}: no se encontró la anotación en su rect original — sin cambios`);
  }
}
