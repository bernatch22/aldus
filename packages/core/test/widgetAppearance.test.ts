/**
 * widgetAppearance.test.ts — REGRESIÓN: un bake que NO edita campos no debe
 * tocar la apariencia de los widgets AcroForm (ni /AP, ni /DA, ni el valor).
 * El bug real: al arrastrar texto en un PDF con text fields, los campos
 * cambiaban de color y contenido en el preview.
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib';
import { bakeSegmentEdits } from '../src/bake/index.js';
import type { SegmentEdit } from '../src/index.js';

/** PDF con un texto suelto + un text field CON valor, color y apariencia propia. */
async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Titulo movible', { x: 72, y: 700, size: 12, font: helv });
  const form = doc.getForm();
  const field = form.createTextField('nombre');
  field.setText('Juan Perez');
  field.addToPage(page, { x: 72, y: 600, width: 200, height: 24, textColor: rgb(0.8, 0.1, 0.1), font: helv });
  return doc.save();
}

/** Bytes del appearance stream normal (/AP /N) + /DA + /V del primer widget del campo. */
async function fieldFingerprint(pdf: Uint8Array): Promise<{ ap: string; da: string; v: string }> {
  const doc = await PDFDocument.load(pdf.slice());
  const field = doc.getForm().getTextField('nombre');
  const widget = field.acroField.getWidgets()[0];
  const apRef = widget.dict.get(PDFName.of('AP')) as PDFDict | PDFRef | undefined;
  const apDict = apRef instanceof PDFRef ? (doc.context.lookup(apRef) as PDFDict) : apRef;
  const nRef = apDict?.get(PDFName.of('N'));
  const nStream = nRef instanceof PDFRef ? doc.context.lookup(nRef) : nRef;
  let ap = '';
  if (nStream instanceof PDFRawStream) {
    ap = new TextDecoder('latin1').decode(decodePDFRawStream(nStream).decode());
  } else if (nStream) {
    ap = nStream.toString();
  }
  const da = String(field.acroField.dict.get(PDFName.of('DA')) ?? doc.getForm().acroForm.dict.get(PDFName.of('DA')) ?? '');
  const v = String(field.acroField.dict.get(PDFName.of('V')) ?? '');
  return { ap, da, v };
}

describe('bake sin ediciones de widgets', () => {
  it('extirpar un texto NO altera la apariencia ni el valor de un text field', async () => {
    const pdf = await makeFormPdf();
    const before = await fieldFingerprint(pdf);
    expect(before.ap).toContain('Tj'); // el appearance dibuja el valor

    const removal: SegmentEdit = {
      segmentId: 's1',
      page: 1,
      text: 'Titulo movible',
      remove: true,
      original: {
        text: 'Titulo movible', x: 72, baseline: 700, width: 80, fontSize: 12,
        bucket: 'sans', bold: false, italic: false,
      },
    };
    const { pdf: baked, applied } = await bakeSegmentEdits(pdf, [removal]);
    expect(applied.some(a => a.includes('eliminado'))).toBe(true);

    const after = await fieldFingerprint(baked);
    expect(after.v).toBe(before.v);
    expect(after.da).toBe(before.da);
    expect(after.ap).toBe(before.ap);
  });
});
