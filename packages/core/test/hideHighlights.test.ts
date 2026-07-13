/**
 * hideHighlights.test.ts — hideHighlightAnnotations (src/bake/highlights.ts).
 *
 * El gotcha pagado con sangre: pdf-lib guarda con OBJECT STREAMS, así que el
 * literal "/Highlight" NO aparece en los bytes crudos — un fast-path por scan
 * de bytes devolvía el PDF sin tocar y los resaltados se pintaban DUPLICADOS
 * (canvas + overlay). El test clava: flag Hidden seteado, CERO duplicación de
 * anotaciones, el grafo sigue viendo el highlight, y el PDF re-abre limpio.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, StandardFonts } from 'pdf-lib';
import { addHighlight } from '../src/bake/index.js';
import { hideHighlightAnnotations } from '../src/bake/index.js';
import { graphOf, segByText } from './helpers.js';

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Texto resaltable', { x: 72, y: 700, size: 12, font: helv });
  return doc.save();
}

/** Annots /Highlight de la página 1, resueltos (soporta refs y object streams). */
async function highlightDicts(bytes: Uint8Array): Promise<PDFDict[]> {
  const doc = await PDFDocument.load(bytes.slice());
  const annots = doc.getPages()[0].node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return [];
  const out: PDFDict[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    if (dict instanceof PDFDict && dict.get(PDFName.of('Subtype')) === PDFName.of('Highlight')) out.push(dict);
  }
  return out;
}

describe('hideHighlightAnnotations', () => {
  it('setea el flag Hidden (/F bit 2) sin duplicar anotaciones', async () => {
    const { pdf: withHl } = await addHighlight(await makePdf(), { page: 1, x: 72, y: 698, width: 100, height: 14, color: '#ffd400' });
    expect((await highlightDicts(withHl)).length).toBe(1);

    const hidden = await hideHighlightAnnotations(withHl);
    const dicts = await highlightDicts(hidden);
    expect(dicts).toHaveLength(1); // NO se duplicó (el bug del fast-path por bytes)
    const f = dicts[0].lookup(PDFName.of('F'));
    expect(f).toBeInstanceOf(PDFNumber);
    expect(((f as PDFNumber).asNumber() & 2)).toBe(2);
  });

  it('el grafo SIGUE viendo el highlight oculto (getAnnotations devuelve hidden) y el PDF re-abre limpio', async () => {
    const { pdf: withHl } = await addHighlight(await makePdf(), { page: 1, x: 72, y: 698, width: 100, height: 14, color: '#33ccff' });
    const hidden = await hideHighlightAnnotations(withHl);

    const g = await graphOf(hidden);
    expect(g.highlights).toHaveLength(1); // el editor lo dibuja como overlay
    expect(g.highlights[0].color.toLowerCase()).toBe('#33ccff');
    expect(segByText(g, 'Texto resaltable').x).toBeCloseTo(72, 0); // contenido intacto
  });

  it('preserva otros bits de /F ya presentes', async () => {
    const { pdf: withHl } = await addHighlight(await makePdf(), { page: 1, x: 72, y: 698, width: 100, height: 14, color: '#ffd400' });
    // Pre-setear /F = 4 (Print) en la annot.
    const doc = await PDFDocument.load(withHl.slice());
    const annots = doc.getPages()[0].node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (dict instanceof PDFDict && dict.get(PDFName.of('Subtype')) === PDFName.of('Highlight')) {
        dict.set(PDFName.of('F'), PDFNumber.of(4));
      }
    }
    const hidden = await hideHighlightAnnotations(await doc.save());
    const dicts = await highlightDicts(hidden);
    expect((dicts[0].lookup(PDFName.of('F')) as PDFNumber).asNumber()).toBe(4 | 2);
  });

  it('sin resaltados: devuelve los MISMOS bytes (ahorra el save)', async () => {
    const pdf = await makePdf();
    expect(await hideHighlightAnnotations(pdf)).toBe(pdf);
  });
});
