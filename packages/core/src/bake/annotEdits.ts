/**
 * Shared machinery for editing /Annots-layer objects (highlights, links):
 * locate the annotation on its page BY ITS ORIGINAL RECT (AnnotRectLocator —
 * never by index, same policy as the content-stream bake), then rewrite /Rect
 * or remove it. Template method: `onRect` deja que un subtype reescriba su
 * geometría extra (/QuadPoints del highlight) cuando el rect cambia.
 * Trasplante VERBATIM de v1 bake/annotEdits.ts sobre el locator unificado.
 */
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib';
import type { PDFDict } from 'pdf-lib';
import { AnnotRectLocator } from './locate/annotRectLocator.js';
import { BakeCodes, type BakeReport } from './report.js';

export interface AnnotRectEdit {
  /** Node id, for report messages. */
  id: string;
  page: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Subtype-specific extra (e.g. highlight recolor); handled by `onRect`. */
  color?: string;
  remove?: boolean;
  original: { x: number; y: number; width: number; height: number };
}

const locator = new AnnotRectLocator();

/**
 * Apply move/resize/remove edits to annotations of `subtype`. `label` is the
 * human noun for report messages (byte-idéntico v1).
 */
export function applyAnnotRectEdits(
  doc: PDFDocument,
  subtype: string,
  label: string,
  edits: AnnotRectEdit[],
  report: BakeReport,
  onRect?: (dict: PDFDict, nx: number, ny: number, nw: number, nh: number, edit: AnnotRectEdit) => void,
): void {
  if (!edits.length) return;
  for (const edit of edits) {
    const page = doc.getPages()[edit.page - 1];
    if (!page) {
      report.warning(BakeCodes.AnnotPageOutOfRange, edit.id, { page: edit.page });
      continue;
    }
    // lookupMaybe (NO lookup): la variante tipada de pdf-lib LANZA si /Annots
    // falta ("Expected instance of PDFArray, but got instance of undefined")
    // en páginas sin anotaciones — con Maybe las salteamos limpio (v1 verbatim).
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) {
      report.warning(BakeCodes.NoAnnots, edit.id);
      continue;
    }
    const found = locator.locate({ subtype, original: edit.original }, { doc, page });
    if (!found) {
      report.warning(BakeCodes.AnnotNotFound, edit.id);
      continue;
    }
    if (edit.remove) {
      found.annots.remove(found.index);
      report.applied(BakeCodes.AnnotRemoved, edit.id, { label });
    } else {
      const { x: rx, y: ry, width: rw, height: rh } = found.rect;
      const nx = edit.x ?? rx, ny = edit.y ?? ry, nw = edit.width ?? rw, nh = edit.height ?? rh;
      found.dict.set(PDFName.of('Rect'), doc.context.obj([nx, ny, nx + nw, ny + nh]));
      onRect?.(found.dict, nx, ny, nw, nh, edit);
      report.applied(BakeCodes.AnnotEdited, edit.id, { label, recolored: edit.color ? 1 : 0 });
    }
  }
}
