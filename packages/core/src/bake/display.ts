/**
 * bake/display.ts — concerns de PREVIEW del editor (capa display, NO bake:
 * en v1 esto vivía en bake/highlights.ts; el audit lo marcó como Layer 4
 * metido en Layer 3 y acá vive aparte).
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';

/**
 * DISPLAY-ONLY copy for the editor: sets the Hidden flag (/F bit 2) on every
 * /Highlight annotation so pdf.js does NOT paint them on the canvas — the
 * editor draws them itself as movable HighlightBox overlays. The flag is set
 * on the PREVIEW bytes only, never on what the server persists. Crucially,
 * `getAnnotations()` still returns hidden annots, so the graph keeps its
 * HighlightNodes.
 *
 * ⚠️ NO hay fast-path por scan de bytes: pdf-lib guarda con OBJECT STREAMS
 * (los dicts van comprimidos) y el literal "/Highlight" no aparece en los
 * bytes crudos — el scan devolvía el PDF sin tocar y los resaltados se
 * pintaban DUPLICADOS (canvas + overlay box). El load es el precio; si no
 * hay ninguno (`!touched`) al menos ahorramos el save. PROHIBIDO
 * re-introducirlo (gotcha pagado; test hideHighlights lo clava).
 */
export async function hideHighlightAnnotations(pdfBytes: Uint8Array): Promise<Uint8Array> {
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
