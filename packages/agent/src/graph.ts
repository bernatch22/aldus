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

/** Extrae el grafo de cada página desde los BYTES de un PDF (sin tocar disco). */
export async function graphFromBytes(bytes: Uint8Array, path = '(memoria)'): Promise<DocGraph> {
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

/** Lee un PDF del disco y extrae su grafo. */
export async function loadDoc(path: string): Promise<DocGraph> {
  return graphFromBytes(new Uint8Array(await readFile(path)), path);
}
