/**
 * coords.ts — LA conversión entre espacio PDF (puntos, origen abajo-izquierda)
 * y espacio CSS (px, origen arriba-izquierda). Nadie más hace esta cuenta.
 */

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function pdfRectToCss(r: PdfRect, pageHeight: number, scale: number): CssRect {
  return {
    left: r.x * scale,
    top: (pageHeight - r.y - r.height) * scale,
    width: r.width * scale,
    height: r.height * scale,
  };
}

/** Punto CSS (px relativos a la página renderizada) → punto PDF. */
export function cssPointToPdf(px: number, py: number, pageHeight: number, scale: number): { x: number; y: number } {
  return { x: px / scale, y: pageHeight - py / scale };
}
