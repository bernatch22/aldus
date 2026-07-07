/**
 * Highlights live in /Annots (Subtype /Highlight), NOT in the content stream:
 * an edit rewrites /Rect + /QuadPoints (the appearance stream is a Form
 * XObject with BBox, scaled to /Rect by the viewer — no AP regeneration
 * needed), a remove pulls the annotation. Creation lives in createNodes.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import type { HighlightEdit } from '../model.js';
import { applyAnnotRectEdits } from './annotEdits.js';
import type { BakeReport } from './report.js';

export function applyHighlightEdits(doc: PDFDocument, edits: HighlightEdit[], report: BakeReport): void {
  applyAnnotRectEdits(
    doc,
    'Highlight',
    'resaltado',
    edits.map(e => ({ id: e.highlightId, page: e.page, x: e.x, y: e.y, width: e.width, height: e.height, remove: e.remove, original: e.original })),
    report,
    (dict, nx, ny, nw, nh) => {
      // QuadPoints ISO 32000: UL UR LL LR (y crece hacia arriba).
      dict.set(PDFName.of('QuadPoints'), doc.context.obj([nx, ny + nh, nx + nw, ny + nh, nx, ny, nx + nw, ny]));
    },
  );
}

/**
 * DISPLAY-ONLY copy for the editor: sets the Hidden flag (/F bit 2) on every
 * /Highlight annotation so pdf.js does NOT paint them on the canvas — the
 * editor draws them itself as movable HighlightBox overlays. The flag is set
 * on the PREVIEW bytes only, never on what the server persists. Crucially,
 * `getAnnotations()` still returns hidden annots, so the graph keeps its
 * HighlightNodes. Fast path: bytes without "/Highlight" return untouched.
 */
export async function hideHighlightAnnotations(pdfBytes: Uint8Array): Promise<Uint8Array> {
  // ⚠️ NO hay fast-path por scan de bytes: pdf-lib guarda con OBJECT STREAMS
  // (los dicts van comprimidos) y el literal "/Highlight" no aparece en los
  // bytes crudos — el scan devolvía el PDF sin tocar y los resaltados se
  // pintaban DUPLICADOS (canvas + overlay box). El load es el precio; si no
  // hay ninguno (`!touched`) al menos ahorramos el save.
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  let touched = false;
  for (const page of doc.getPages()) {
    // lookupMaybe: la variante tipada LANZA si /Annots falta (páginas sin
    // anotaciones) — ver annotEdits.ts. Con Maybe la salteamos limpio.
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (!(dict instanceof PDFDict)) continue;
      if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Highlight')) continue;
      const f = dict.lookup(PDFName.of('F'));
      const cur = f instanceof PDFNumber ? f.asNumber() : 0;
      dict.set(PDFName.of('F'), PDFNumber.of(cur | 2));
      touched = true;
    }
  }
  return touched ? doc.save() : pdfBytes;
}
