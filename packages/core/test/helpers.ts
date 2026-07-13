/**
 * helpers.ts — utilidades compartidas por los tests que extraen grafos reales
 * (crear con pdf-lib, extraer con pdfjs legacy headless). No es un test.
 */
import type { PageGraph, SegmentNode } from '../src/index.js';
import { extractPageGraph, type PdfJsPage } from '../src/index.js';

/** Extrae el grafo de la página con pdfjs legacy (headless).
 *  ⚠️ `pdf.slice()`: pdf.js TRANSFIERE el buffer al worker. */
export async function graphOf(pdf: Uint8Array, pageNum = 1): Promise<PageGraph> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: pdf.slice(), verbosity: 0 });
  const doc = await task.promise;
  const page = (await doc.getPage(pageNum)) as unknown as PdfJsPage;
  const graph = await extractPageGraph(page);
  await doc.destroy();
  return graph;
}

export function segByText(g: PageGraph, text: string): SegmentNode {
  const seg = g.segments.find(s => s.text === text);
  if (!seg) throw new Error(`segmento "${text}" no encontrado en [${g.segments.map(s => s.text).join(' | ')}]`);
  return seg;
}
