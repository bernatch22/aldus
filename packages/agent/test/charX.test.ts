/**
 * charX.test.ts — REGRESIÓN de la elipsis ancha (commit 35c9222) a través de la
 * EditSession. La elipsis U+2026 es UN carácter pero dibuja 3 puntos (~1em):
 * charXOf pesaba '…' como un '.' (0.45) y los campos sobre leaders de '…' quedaban
 * ENANOS y corridos ~50–70pt. Con el peso 1.4 (fuente única en core/layout/charX)
 * el borde queda a <25pt del real y el ancho dentro del ±20%.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EditSession } from '../src/session/EditSession.js';
import { graphOf, pdfWith } from './helpers.js';

describe('charXOf — elipsis U+2026 pesa como glifo ANCHO (regresión 35c9222)', () => {
  it('línea "Mr./Ms. ………" → el campo arranca donde arrancan los leaders y cubre su ancho', async () => {
    const leaders = '…'.repeat(14);
    const bytes = await pdfWith([500, 400], (page, f) => {
      page.drawText('Mr./Ms. ' + leaders, { x: 50, y: 300, size: 12, font: f.regular });
    });
    const doc = await graphOf(bytes);
    const seg = doc.pages[0]!.segments[0]!;
    expect(seg.text).toContain('…'); // la elipsis sobrevivió la extracción

    const session = new EditSession(doc);
    const msg = await session.placeholdersToFields(seg.id, [{ placeholder: '………', name: 'name' }]);
    expect(msg).toContain('✓');

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    expect(re.pages[0]!.widgets).toHaveLength(1);
    const w = re.pages[0]!.widgets[0]!;

    const lib = await PDFDocument.create();
    const helv = await lib.embedFont(StandardFonts.Helvetica);
    const trueX0 = 50 + helv.widthOfTextAtSize('Mr./Ms. ', 12); // ≈91.8
    const trueW = helv.widthOfTextAtSize(leaders, 12);           // ≈168 (1em c/u)

    // Con el peso VIEJO ('…' como '.') el campo arrancaba ~65pt a la derecha y
    // medía menos de la mitad. Con el fix la deriva queda acotada (~17pt hoy).
    expect(Math.abs(w.x - trueX0)).toBeLessThan(25);
    expect(w.width).toBeGreaterThan(trueW * 0.8); // no queda ENANO
    expect(w.width).toBeLessThan(trueW * 1.2);
    // …y el borde derecho del campo no se escapa del fin real de los leaders.
    expect(Math.abs(w.x + w.width - (trueX0 + trueW))).toBeLessThan(25);
  });
});
