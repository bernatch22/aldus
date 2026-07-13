/**
 * imageZOrder.test.ts — REGRESIÓN: "enviar al fondo" una imagen NO debe
 * meterla antes del relleno blanco de la página (papel), que la taparía →
 * "todo blanco". El bloque va al primer BT (inicio del contenido), detrás del
 * texto pero delante del papel.
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, PDFArray, decodePDFRawStream, StandardFonts, rgb } from 'pdf-lib';
import { bakeSegmentEdits } from '../src/bake/index.js';
import { extractPageGraph, type ImageEdit, type PdfJsPage } from '../src/index.js';

// PNG 1×1 rojo.
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function makeBgPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawRectangle({ x: 0, y: 0, width: 300, height: 300, color: rgb(1, 1, 1) }); // papel blanco full-page
  const png = await doc.embedPng(RED_PNG);
  page.drawImage(png, { x: 0, y: 0, width: 300, height: 300 }); // fondo full-page
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Contenido encima', { x: 20, y: 150, size: 14, font: helv });
  return doc.save();
}

async function pageContentString(pdf: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(pdf.slice());
  const page = doc.getPage(0);
  const c = doc.context.lookup(page.node.get(PDFName.of('Contents')));
  let out = '';
  const one = (s: unknown) => { if (s instanceof PDFRawStream) out += new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()) + '\n'; };
  if (c instanceof PDFArray) c.asArray().forEach(r => one(doc.context.lookup(r)));
  else one(c);
  return out;
}

async function graphOf(pdf: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: pdf.slice(), verbosity: 0 }).promise;
  const g = await extractPageGraph((await doc.getPage(1)) as unknown as PdfJsPage);
  await doc.destroy();
  return g;
}

describe('imagen enviar al fondo', () => {
  it('no queda antes del relleno blanco de la página', async () => {
    const pdf = await makeBgPdf();
    const g = await graphOf(pdf);
    const img = g.images[0];
    expect(img).toBeTruthy();

    const edit: ImageEdit = {
      imageId: img.id, page: 1, zOrder: 'back',
      original: { x: img.x, y: img.y, width: img.width, height: img.height },
    };
    const { pdf: baked, applied } = await bakeSegmentEdits(pdf, [], [edit]);
    expect(applied.some(a => a.includes('al fondo'))).toBe(true);

    const s = await pageContentString(baked);
    const paperIdx = s.indexOf('1 1 1 rg'); // el papel blanco full-page
    const doIdx = s.indexOf(' Do');         // el Do de la imagen re-emitida
    const btIdx = s.indexOf('BT');          // inicio del contenido (texto)
    expect(paperIdx).toBeGreaterThanOrEqual(0);
    expect(doIdx).toBeGreaterThanOrEqual(0);
    expect(btIdx).toBeGreaterThanOrEqual(0);
    // La imagen queda DESPUÉS del papel blanco (no la tapa) y ANTES del texto.
    expect(doIdx).toBeGreaterThan(paperIdx);
    expect(doIdx).toBeLessThan(btIdx);

    // Round-trip: la matriz relativa al CTM del backstop la deja EXACTAMENTE
    // donde estaba (misma geometría al re-extraer).
    const g2 = await graphOf(baked);
    const img2 = g2.images[0];
    expect(img2).toBeTruthy();
    expect(img2.x).toBeCloseTo(img.x, 1);
    expect(img2.y).toBeCloseTo(img.y, 1);
    expect(img2.width).toBeCloseTo(img.width, 1);
    expect(img2.height).toBeCloseTo(img.height, 1);
  });
});
