/**
 * fallbackFilter.test.ts — el filtro de CONTROL CHARS de drawFallbackTexts
 * (src/bake/fallback.ts).
 *
 * Un código sin entrada /ToUnicode llega del grafo como control char crudo
 * (U+0012 — el acento suelto de LibreOffice). La fuente estándar TIRA con él;
 * una custom lo dibuja como .notdef (cajita con X). El fallback los filtra
 * SIEMPRE antes de dibujar, con warning — es lo único entre ese acento y una
 * cajita con X en producción.
 *
 * (El control char se construye con fromCharCode: un U+0012 crudo en el
 * fuente se corrompe al editar — gotcha del propio CLAUDE.md sobre NBSP.)
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { drawFallbackTexts, type FallbackDraw } from '../src/bake/fonts/fallback.js';
import { BakeReport } from '../src/bake/report.js';
import { graphOf } from './helpers.js';

const U12 = String.fromCharCode(0x12);

const draw = (text: string): FallbackDraw => ({
  page: 1, text, x: 72, y: 700, size: 12, bucket: 'sans', bold: false, italic: false,
});

describe('drawFallbackTexts filtra control chars', () => {
  it('U+0012 en el medio: dibuja SIN el control char y avisa', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const report = new BakeReport();
    await drawFallbackTexts(doc, [draw(`Ho${U12}la`)], report);
    const { warnings, pdf } = report.finish(await doc.save());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('glifo sin identidad unicode');
    expect(warnings[0]).toContain('p1:');

    // El texto quedó dibujado LIMPIO (sin el artefacto) — la estándar habría
    // tirado con el control char adentro.
    const g = await graphOf(pdf);
    expect(g.segments.some(s => s.text === 'Hola')).toBe(true);
    expect(g.segments.some(s => s.text.includes(U12))).toBe(false);
  });

  it('texto que es SOLO control chars: no dibuja nada, pero avisa', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const report = new BakeReport();
    await drawFallbackTexts(doc, [draw(U12)], report);
    const { warnings, pdf } = report.finish(await doc.save());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('glifo sin identidad unicode');
    const g = await graphOf(pdf);
    expect(g.segments).toHaveLength(0);
  });

  it('texto limpio: dibuja sin warning', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const report = new BakeReport();
    await drawFallbackTexts(doc, [draw('Texto limpio')], report);
    const { warnings, pdf } = report.finish(await doc.save());
    expect(warnings).toEqual([]);
    expect((await graphOf(pdf)).segments.some(s => s.text === 'Texto limpio')).toBe(true);
  });
});
