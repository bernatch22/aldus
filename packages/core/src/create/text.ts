/**
 * create/text.ts — texto NUEVO (VERBATIM v1 createNodes.addText). Al
 * re-extraer se vuelve un segmento más del grafo → editable como cualquiera.
 */
import { PDFDocument, rgb } from 'pdf-lib';
import type { FontBucket } from '../model/nodes.js';
import { hexToRgbObj } from '../common/hex.js';
import { stdFontFor } from '../bake/fonts/fontService.js';

const hexToRgbLib = (hex: string) => {
  const c = hexToRgbObj(hex);
  return rgb(c.r, c.g, c.b);
};

export interface NewTextSpec {
  page: number;
  /** Punto del click = esquina superior-izquierda del texto. */
  x: number;
  y: number;
  text: string;
  size?: number;
  bucket?: FontBucket;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

/** Agrega un párrafo de texto nuevo (con wrap hasta el margen derecho). */
export async function addText(pdfBytes: Uint8Array, spec: NewTextSpec): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);
  const size = spec.size ?? 11;
  const font = await doc.embedFont(stdFontFor(spec.bucket ?? 'sans', spec.bold ?? false, spec.italic ?? false));
  page.drawText(spec.text, {
    x: spec.x,
    y: spec.y - size,
    size,
    font,
    color: spec.color ? hexToRgbLib(spec.color) : rgb(0, 0, 0),
    lineHeight: size * 1.35,
    maxWidth: Math.max(80, page.getWidth() - spec.x - 40),
  });
  return { pdf: await doc.save() };
}
