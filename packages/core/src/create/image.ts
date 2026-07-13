/**
 * create/image.ts — insertar imágenes (VERBATIM v1 createNodes.insertImage):
 * embedPng/embedJpg + drawImage al final del stream (= al frente, lo esperable
 * para un objeto recién insertado).
 */
import { PDFDocument } from 'pdf-lib';

export interface NewImageSpec {
  page: number;
  /** Punto de colocación (esquina superior-izquierda del click), en puntos PDF. */
  x: number;
  y: number;
  bytes: Uint8Array;
  mime: string;
  /** Ancho máximo al insertar (se preserva el aspecto). */
  maxWidth?: number;
  /** Rect EXACTO (p.ej. la firma dibujada estampada en el box de su signer):
   *  width+height ajustan la imagen a ese rect (sin preservar aspecto);
   *  solo width escala con aspecto. Ignoran maxWidth. */
  width?: number;
  height?: number;
}

/** Inserta una imagen (PNG/JPEG). Devuelve el PDF nuevo y el rect usado. */
export async function insertImage(pdfBytes: Uint8Array, spec: NewImageSpec): Promise<{ pdf: Uint8Array; rect: { x: number; y: number; width: number; height: number } }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);

  const image = /png$/i.test(spec.mime)
    ? await doc.embedPng(spec.bytes)
    : await doc.embedJpg(spec.bytes);

  let width: number, height: number;
  if (spec.width !== undefined && spec.height !== undefined) {
    // Fit EXACTO al rect pedido (firma en su box) — sin preservar aspecto.
    width = spec.width;
    height = spec.height;
  } else if (spec.width !== undefined) {
    width = spec.width;
    height = image.height * (spec.width / image.width);
  } else {
    const maxW = spec.maxWidth ?? 240;
    const ratio = image.width > maxW ? maxW / image.width : 1;
    width = image.width * ratio;
    height = image.height * ratio;
  }
  // El click marca la esquina SUPERIOR-izquierda (natural al apuntar).
  const rect = { x: spec.x, y: spec.y - height, width, height };
  page.drawImage(image, rect);
  return { pdf: await doc.save(), rect };
}
