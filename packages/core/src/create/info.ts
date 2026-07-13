/**
 * create/info.ts — metadatos baratos de un PDF sin extraer el grafo: conteo y
 * tamaño de páginas, título, magic bytes. VERBATIM v1 bake/info.ts.
 *
 * Sin hashing acá: el hash del documento es dominio del consumidor (auditoría,
 * cifrado) — el motor no impone su crypto.
 *
 * TODO(host): `defaultSignaturePlacement` (la heurística "N-ésimo firmante
 * apilado en la última página") NO cruzó a v2 — es política de producto
 * e-sign, no de motor (audit: violación de capas). Vive en el host (signwax).
 */
import { PDFDocument } from 'pdf-lib';

export interface PdfInfo {
  pageCount: number;
  /** Tamaño de cada página en puntos PDF. */
  pages: Array<{ width: number; height: number }>;
  title: string | null;
  byteSize: number;
}

export async function readPdfInfo(pdfBytes: Uint8Array): Promise<PdfInfo> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages().map(p => {
    const { width, height } = p.getSize();
    return { width, height };
  });
  return { pageCount: pages.length, pages, title: doc.getTitle() ?? null, byteSize: pdfBytes.length };
}

/** ¿Los bytes son un PDF? (magic `%PDF-`). */
export function isPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}
