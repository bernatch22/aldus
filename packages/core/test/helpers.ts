/**
 * helpers.ts — utilidades compartidas por los tests que extraen grafos reales
 * (crear con pdf-lib, extraer con pdfjs legacy headless). No es un test.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
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

/** Concatena y decodifica los content streams de la página (para walkContent). */
export async function decodeStreams(bytes: Uint8Array, pageNum = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice());
  const resolve = (o: unknown) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const raw = resolve(doc.getPages()[pageNum - 1]!.node.get(PDFName.of('Contents')));
  const streams = raw instanceof PDFArray
    ? [...Array(raw.size()).keys()].map(i => resolve(raw.get(i)) as PDFRawStream)
    : [raw as PDFRawStream];
  const parts = streams.map(s => decodePDFRawStream(s).decode());
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length + 1, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; out[off++] = 0x0a; }
  return out;
}

/**
 * Completa los font dicts de fuentes ESTÁNDAR de pdf-lib (Type1 +
 * /WinAnsiEncoding, SIN FirstChar/LastChar) con FirstChar/LastChar, para que
 * `encoderForFont` tome el camino simple-encoding (path B: re-encodear con la
 * fuente ORIGINAL) — el perfil de un PDF de Word/Quartz. Sin esto, cualquier
 * rewrite sobre fuente estándar cae a sustitución (path C).
 */
export async function patchSimpleFonts(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice());
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (!fonts) continue;
    for (const key of fonts.keys()) {
      const fd = fonts.lookup(key);
      if (!(fd instanceof PDFDict)) continue;
      fd.set(PDFName.of('FirstChar'), doc.context.obj(32));
      fd.set(PDFName.of('LastChar'), doc.context.obj(255));
    }
  }
  return doc.save();
}
