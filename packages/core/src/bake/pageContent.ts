/**
 * Reading and writing a page's content stream bytes via pdf-lib.
 */
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFPage,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';

/** Decode and concatenate every content stream of the page (newline-joined). */
export function pageContentBytes(doc: PDFDocument, page: PDFPage): Uint8Array {
  const ctx = doc.context;
  const resolve = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const contents = resolve(page.node.get(PDFName.of('Contents')));
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = resolve(contents.get(i));
      if (s instanceof PDFRawStream) streams.push(s);
      else throw new Error('Content stream no soportado (no es PDFRawStream).');
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  } else if (contents != null) {
    throw new Error('Content stream no soportado.');
  }
  const parts = streams.map(s => decodePDFRawStream(s).decode());
  const total = parts.reduce((a, p) => a + p.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
    out[off++] = 0x0a;
  }
  return out;
}

/** Replace the page's contents with a single new stream. */
export function setPageContents(doc: PDFDocument, page: PDFPage, bytes: Uint8Array): void {
  const stream = doc.context.stream(bytes);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
}
