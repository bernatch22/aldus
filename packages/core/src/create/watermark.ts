/**
 * create/watermark.ts — watermark en todas las páginas (VERBATIM v1). Se
 * dibuja como TEXTO de contenido → re-extraído es un segmento normal
 * (editable/eliminable, gotcha documentado del CLAUDE.md).
 */
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { hexToRgbObj } from '../common/hex.js';
import { stdFontFor } from '../bake/fonts/fontService.js';

const hexToRgbLib = (hex: string) => {
  const c = hexToRgbObj(hex);
  return rgb(c.r, c.g, c.b);
};

export async function addWatermark(pdfBytes: Uint8Array, spec: { text: string; opacity?: number; color?: string }): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(stdFontFor('sans', true, false));
  for (const page of doc.getPages()) {
    const w = page.getWidth();
    const h = page.getHeight();
    const size = Math.min(84, (w * 1.1) / Math.max(4, spec.text.length) / 0.55);
    page.drawText(spec.text, {
      x: w * 0.14,
      y: h * 0.28,
      size,
      font,
      rotate: degrees(38),
      opacity: spec.opacity ?? 0.14,
      color: spec.color ? hexToRgbLib(spec.color) : rgb(0.4, 0.4, 0.45),
    });
  }
  return { pdf: await doc.save() };
}
