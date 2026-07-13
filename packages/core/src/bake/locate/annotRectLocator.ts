/**
 * Localizadores de la capa /Annots, unificados bajo ILocator:
 *
 *  - {@link AnnotRectLocator}: la anotación de un subtype por su /Rect
 *    original (el loop de v1 annotEdits.ts, verbatim, tol 2pt). Lo consumen
 *    los appliers de highlight/link Y create/link.removeLink (que en v1
 *    duplicaba este loop casi línea a línea — duplicación #4 del audit).
 *  - {@link WidgetLocator}: el par campo+widget AcroForm por nombre + rect
 *    (el loop inline de v1 widgets.ts, verbatim, tol 2.5pt).
 *
 * Gotcha pagado (v1): `lookupMaybe(/Annots)` — la variante tipada de pdf-lib
 * LANZA si /Annots falta ("Expected instance of PDFArray, but got instance of
 * undefined") en páginas sin anotaciones.
 */
import { PDFArray, PDFDict, PDFDocument, PDFField, PDFName, PDFPage, PDFRef, PDFWidgetAnnotation } from 'pdf-lib';
import type { ILocator } from './types.js';

/** pt — tolerancia del match /Rect de una anotación (highlight/link). */
export const ANNOT_MATCH_TOL_PT = 2;
/** pt — tolerancia del match rect de un widget AcroForm. */
export const WIDGET_MATCH_TOL_PT = 2.5;

export interface AnnotRectQuery {
  subtype: string;
  original: { x: number; y: number; width: number; height: number };
}

export interface FoundAnnot {
  /** El array /Annots que la contiene y el índice (para remove). */
  annots: PDFArray;
  index: number;
  dict: PDFDict;
  /** Rect actual normalizado (x, y = esquina inferior-izquierda). */
  rect: { x: number; y: number; width: number; height: number };
}

const rectNums = (rect: PDFArray): [number, number, number, number] | null => {
  if (rect.size() !== 4) return null;
  const nums = [0, 1, 2, 3].map(k => Number((rect.get(k) as { asNumber?: () => number }).asNumber?.() ?? NaN));
  return nums.some(Number.isNaN) ? null : (nums as [number, number, number, number]);
};

export class AnnotRectLocator implements ILocator<AnnotRectQuery, { doc: PDFDocument; page: PDFPage }, FoundAnnot> {
  locate(q: AnnotRectQuery, ctx: { doc: PDFDocument; page: PDFPage }): FoundAnnot | null {
    const annots = ctx.page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return null;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = raw instanceof PDFRef ? ctx.doc.context.lookup(raw) : raw;
      if (!(dict instanceof PDFDict)) continue;
      if (dict.get(PDFName.of('Subtype')) !== PDFName.of(q.subtype)) continue;
      const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
      const nums = rect ? rectNums(rect) : null;
      if (!nums) continue;
      const [ax, ay, bx, by] = nums;
      const rx = Math.min(ax, bx), ry = Math.min(ay, by), rw = Math.abs(bx - ax), rh = Math.abs(by - ay);
      if (
        Math.abs(rx - q.original.x) <= ANNOT_MATCH_TOL_PT && Math.abs(ry - q.original.y) <= ANNOT_MATCH_TOL_PT &&
        Math.abs(rw - q.original.width) <= ANNOT_MATCH_TOL_PT && Math.abs(rh - q.original.height) <= ANNOT_MATCH_TOL_PT
      ) {
        return { annots, index: i, dict, rect: { x: rx, y: ry, width: rw, height: rh } };
      }
    }
    return null;
  }
}

export interface WidgetQuery {
  fieldName: string;
  original: { x: number; y: number; width: number; height: number };
}

export interface FoundWidget {
  field: PDFField;
  widget: PDFWidgetAnnotation;
}

export class WidgetLocator implements ILocator<WidgetQuery, ReturnType<PDFDocument['getForm']>, FoundWidget> {
  locate(q: WidgetQuery, form: ReturnType<PDFDocument['getForm']>): FoundWidget | null {
    const tol = WIDGET_MATCH_TOL_PT;
    for (const field of form.getFields()) {
      if (field.getName() !== q.fieldName) continue;
      for (const widget of field.acroField.getWidgets()) {
        const r = widget.getRectangle();
        if (
          Math.abs(r.x - q.original.x) <= tol && Math.abs(r.y - q.original.y) <= tol &&
          Math.abs(r.width - q.original.width) <= tol && Math.abs(r.height - q.original.height) <= tol
        ) {
          return { field, widget };
        }
      }
    }
    return null;
  }
}
