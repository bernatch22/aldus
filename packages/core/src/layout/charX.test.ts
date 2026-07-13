/**
 * charX.test.ts — REGRESIÓN de la elipsis ancha (commit 35c9222). La elipsis
 * U+2026 es UN carácter pero dibuja 3 puntos (~1em): con el peso VIEJO (como un
 * '.', 0.45) el borde del leader caía ~50–70pt corrido y el campo quedaba enano.
 * Con el peso 1.4, charXOf clava el borde donde el PDF REAL lo dibuja.
 *
 * Ground truth: métricas Helvetica reales (widthOfTextAtSize de pdf-lib). Acá se
 * prueba charXOf DIRECTO (pura), sin EditSession ni bake.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { charXOf } from './charX.js';
import { graphOf } from '../../test/helpers.js';

describe('charXOf — la elipsis U+2026 pesa como glifo ANCHO (35c9222)', () => {
  it('línea "Mr./Ms. ………" → el borde del leader cae donde arranca en el PDF', async () => {
    const leaders = '…'.repeat(14);
    const doc = await PDFDocument.create();
    const page = doc.addPage([500, 400]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Mr./Ms. ' + leaders, { x: 50, y: 300, size: 12, font: helv });
    const g = await graphOf(await doc.save());

    const seg = g.segments[0]!;
    expect(seg.text).toContain('…'); // la elipsis sobrevivió la extracción

    const cx = charXOf({ text: seg.text, runs: seg.runs, x: seg.x });
    const leaderStart = seg.text.indexOf('…');
    const leaderEnd = leaderStart + leaders.length;

    const trueX0 = 50 + helv.widthOfTextAtSize('Mr./Ms. ', 12); // ≈91.8
    const trueW = helv.widthOfTextAtSize(leaders, 12);          // ≈168 (1em c/u)

    // Con el peso VIEJO el borde arrancaba ~65pt a la derecha y medía < la mitad.
    // Con el fix la deriva queda acotada (<25pt) y el ancho dentro del ±20%.
    expect(Math.abs(cx[leaderStart]! - trueX0)).toBeLessThan(25);
    const w = cx[leaderEnd]! - cx[leaderStart]!;
    expect(w).toBeGreaterThan(trueW * 0.8); // no queda ENANO
    expect(w).toBeLessThan(trueW * 1.2);
    expect(Math.abs(cx[leaderEnd]! - (trueX0 + trueW))).toBeLessThan(25);
  });
});
