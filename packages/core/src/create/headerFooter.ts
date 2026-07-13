/**
 * create/headerFooter.ts — header/footer/numeración (VERBATIM v1). Texto de
 * contenido: re-extraído es editable como cualquier segmento.
 */
import { PDFDocument, rgb } from 'pdf-lib';
import { stdFontFor } from '../bake/fonts/fontService.js';

export async function addHeaderFooter(
  pdfBytes: Uint8Array,
  spec: { header?: string; footer?: string; pageNumbers?: boolean },
): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(stdFontFor('sans', false, false));
  const pages = doc.getPages();
  const gray = rgb(0.35, 0.35, 0.4);
  pages.forEach((page, i) => {
    const w = page.getWidth();
    const h = page.getHeight();
    if (spec.header) page.drawText(spec.header, { x: 40, y: h - 28, size: 9, font, color: gray });
    if (spec.footer) page.drawText(spec.footer, { x: 40, y: 18, size: 9, font, color: gray });
    if (spec.pageNumbers) {
      const label = `Página ${i + 1} de ${pages.length}`;
      const lw = font.widthOfTextAtSize(label, 9);
      page.drawText(label, { x: w - 40 - lw, y: 18, size: 9, font, color: gray });
    }
  });
  return { pdf: await doc.save() };
}
