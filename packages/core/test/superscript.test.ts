/**
 * superscript.test.ts — la defensa `dominant` de StyledRunsReemit (src/bake/text.ts).
 *
 * Un segmento puede mezclar el CUERPO (fontSize nominal) con un superíndice
 * CHICO ("API¹", footnotes). Al reescribir el texto, el op que gana la key de
 * estilo debe ser el de tamaño más cercano al NOMINAL — si ganara el
 * superíndice, TODO el texto nuevo saldría con su fuente chica ("todo el
 * grafo pequeñito"). Se verifica por re-extract: el fontSize del texto nuevo
 * es ≈ el dominante, no el del superíndice.
 *
 * El PDF usa fuentes estándar parchadas a simple-encoding (patchSimpleFonts)
 * para que el rewrite tome el path B (re-encodear con la fuente original vía
 * el op elegido) — el camino donde vive la defensa.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mergeSegmentEdit } from '../src/index.js';
import { bakeSegmentEdits } from '../src/bake/index.js';
import { graphOf, patchSimpleFonts } from './helpers.js';

async function makeSuperscriptPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  // Superíndice: '1' chico (7pt) 3pt por encima de la baseline del cuerpo (12pt).
  // Δbaseline 3 < 0.55×12 → runLines lo deja en la MISMA línea → UN segmento.
  page.drawText('1', { x: 72, y: 703, size: 7, font: helv });
  page.drawText('Una API grande', { x: 77, y: 700, size: 12, font: helv });
  return patchSimpleFonts(await doc.save());
}

describe('rewrite de un segmento con superíndice', () => {
  it('extracción previa: superíndice + cuerpo = UN segmento con fontSize nominal 12', async () => {
    const g = await graphOf(await makeSuperscriptPdf());
    const seg = g.segments.find(s => s.text.includes('Una API'));
    expect(seg).toBeTruthy();
    expect(seg!.text).toBe('1Una API grande');
    expect(seg!.fontSize).toBeCloseTo(12, 0);
    expect(seg!.runs.map(r => Math.round(r.fontSize)).sort()).toEqual([12, 7].sort());
  });

  it('el texto reescrito sale con la fuente DOMINANTE (12pt), no la chica del superíndice', async () => {
    const pdf = await makeSuperscriptPdf();
    const g = await graphOf(pdf);
    const seg = g.segments.find(s => s.text.includes('Una API'))!;
    const edit = mergeSegmentEdit(seg, null, { text: 'Una API renombrada' });
    const { pdf: baked, applied, warnings } = await bakeSegmentEdits(pdf, [edit!]);
    expect(applied.some(a => a.includes('reescrito por tramos'))).toBe(true);
    // Path B (fuente original): sin sustitución.
    expect(warnings).toEqual([]);

    const g2 = await graphOf(baked);
    const rewritten = g2.segments.find(s => s.text.includes('Una API renombrada'));
    expect(rewritten).toBeTruthy();
    // LA defensa: si el op del superíndice hubiera ganado la key de estilo,
    // el cuerpo re-emitido tendría fontSize ≈ 7. Debe ser ≈ 12.
    for (const r of rewritten!.runs) expect(r.fontSize).toBeCloseTo(12, 0);
  });
});
