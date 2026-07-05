/**
 * graph.ts — carga un PDF en Node y extrae su grafo COMPLETO (todas las páginas)
 * reusando @aldus/core. Mismo pipeline que el editor, pero headless: pdf.js
 * legacy en vez del build de browser, sin canvas (los colores por muestreo no
 * están — al agente solo le importan texto + geometría).
 */
import { readFile } from 'node:fs/promises';
import { extractPageGraph, type PageGraph, type PdfJsPage } from '@aldus/core';

export interface DocGraph {
  /** Ruta del archivo original. */
  path: string;
  /** Bytes originales del PDF (intactos — el bake hornea sobre estos). */
  bytes: Uint8Array;
  pages: PageGraph[];
}

/** Lee un PDF del disco y extrae el grafo de cada página. */
export async function loadDoc(path: string): Promise<DocGraph> {
  const bytes = new Uint8Array(await readFile(path));
  // pdf.js transfiere el ArrayBuffer al parsear → le pasamos una copia y
  // conservamos `bytes` para hornear después.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages: PageGraph[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    pages.push(await extractPageGraph(page as unknown as PdfJsPage));
  }
  await doc.destroy();
  return { path, bytes, pages };
}
