/**
 * Fallback text drawing (path C): when the original font can't render the new
 * text (insufficient subset, or a family/style change), the text is drawn
 * with an embedded STANDARD font — an explicit, reported substitution that
 * preserves the original color. Never guessed, never silent.
 */
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';
import type { FontBucket } from '../model.js';
import { stdFontFor } from './fonts.js';
import type { BakeReport } from './report.js';

/** One queued standard-font draw (accumulated across pages, drawn at the end). */
export interface FallbackDraw {
  page: number;
  text: string;
  x: number;
  y: number;
  size: number;
  bucket: FontBucket;
  bold: boolean;
  italic: boolean;
  /** Text color (0..1). Absent = black. */
  color?: { r: number; g: number; b: number };
  /** Underline: drawn as a thin rect under the text. */
  underline?: boolean;
}

/** Draw every queued fallback, embedding each standard font at most once. */
export async function drawFallbackTexts(doc: PDFDocument, draws: FallbackDraw[], report: BakeReport): Promise<void> {
  if (!draws.length) return;
  const pages = doc.getPages();
  const fontCache = new Map<string, PDFFont>();
  for (const d of draws) {
    const key = `${d.bucket}|${d.bold}|${d.italic}`;
    let font = fontCache.get(key);
    if (!font) {
      font = await doc.embedFont(stdFontFor(d.bucket, d.bold, d.italic));
      fontCache.set(key, font);
    }
    const page = pages[d.page - 1];
    const color = d.color ? rgb(d.color.r, d.color.g, d.color.b) : rgb(0, 0, 0);
    const drawUnderline = () => {
      if (!d.underline || !font) return;
      const w = font.widthOfTextAtSize(d.text, d.size);
      page.drawRectangle({ x: d.x, y: d.y - d.size * 0.11, width: w, height: d.size * 0.055, color });
    };
    try {
      page.drawText(d.text, { x: d.x, y: d.y, size: d.size, font, color });
      drawUnderline();
    } catch {
      // Characters outside WinAnsi: filter them out and report (never break the PDF).
      const clean = [...d.text].filter(c => c.charCodeAt(0) <= 0xff).join('');
      try {
        page.drawText(clean, { x: d.x, y: d.y, size: d.size, font, color });
        report.warn(`p${d.page}: caracteres no representables descartados en "${d.text.slice(0, 24)}…"`);
      } catch {
        report.warn(`p${d.page}: no se pudo dibujar el reemplazo "${d.text.slice(0, 24)}…"`);
      }
    }
  }
}
