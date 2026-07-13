import { describe, expect, it } from 'vitest';
import { cssPointToPdf, pdfRectToCss, type PdfRect } from './coords.js';

// Página carta US: 612×792 puntos.
const PAGE_H = 792;

describe('coords', () => {
  it('pdfRectToCss with known values (origin flip + scale)', () => {
    const rect: PdfRect = { x: 72, y: 700, width: 100, height: 20 };
    expect(pdfRectToCss(rect, PAGE_H, 2)).toEqual({
      left: 144,
      top: (792 - 700 - 20) * 2, // 144 — CSS top is the rect's TOP edge
      width: 200,
      height: 40,
    });
  });

  it('cssPointToPdf inverts the CSS top-left corner to the PDF TOP edge (y + height)', () => {
    const rect: PdfRect = { x: 72, y: 700, width: 100, height: 20 };
    const css = pdfRectToCss(rect, PAGE_H, 2);
    const back = cssPointToPdf(css.left, css.top, PAGE_H, 2);
    expect(back.x).toBeCloseTo(rect.x, 10);
    expect(back.y).toBeCloseTo(rect.y + rect.height, 10); // top edge, NOT the baseline y
  });

  it('round-trip css → pdf → css is the identity for any point', () => {
    for (const [px, py, scale] of [[0, 0, 1], [123.4, 567.8, 1.5], [610, 790, 0.75]] as const) {
      const pdf = cssPointToPdf(px, py, PAGE_H, scale);
      // Reproyectar el punto como rect de tamaño 0.
      const css = pdfRectToCss({ x: pdf.x, y: pdf.y, width: 0, height: 0 }, PAGE_H, scale);
      expect(css.left).toBeCloseTo(px, 10);
      expect(css.top).toBeCloseTo(py, 10);
    }
  });
});
