/**
 * simpleEncoding.test.ts — el camino simple-encoding de `encoderForFont`
 * (src/bake/fonts.ts → src/bake/toUnicode.ts encoderFromSimpleEncoding).
 *
 * Perfil Word/Quartz: fuente simple (Type1/TrueType) con /Encoding
 * WinAnsiEncoding o MacRomanEncoding y SIN /ToUnicode — el encoding estándar
 * YA define el mapa unicode→byte. Sin este camino, cualquier rewrite caía a
 * fuente estándar (sustitución) aunque la original renderizara perfecto.
 *
 * Unit: encoderFromSimpleEncoding directo (bytes exactos para á é ñ).
 * Integrado: pdf-lib no emite FirstChar/LastChar en fuentes estándar, así que
 * el fixture los agrega (patchSimpleFonts) — con eso el dict dispara
 * exactamente el camino simpleEncodingEncoder de fonts.ts.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mergeSegmentEdit } from '../src/index.js';
import { bakeSegmentEdits } from '../src/bake/index.js';
import { encoderFromSimpleEncoding } from '../src/pdf/toUnicode.js';
import { graphOf, patchSimpleFonts, segByText } from './helpers.js';

describe('encoderFromSimpleEncoding (unit)', () => {
  it('WinAnsi: acentos latinos → bytes cp1252 exactos', () => {
    const enc = encoderFromSimpleEncoding('WinAnsiEncoding', 32, 255, null);
    expect(Array.from(enc.encode('áéñ')!)).toEqual([0xe1, 0xe9, 0xf1]);
    expect(Array.from(enc.encode('Hola')!)).toEqual([0x48, 0x6f, 0x6c, 0x61]);
    // Los especiales cp1252 del rango 0x80–0x9F.
    expect(Array.from(enc.encode('€')!)).toEqual([0x80]);
    expect(Array.from(enc.encode('“”')!)).toEqual([0x93, 0x94]);
  });

  it('MacRoman: acentos → bytes de la tabla de Apple', () => {
    const enc = encoderFromSimpleEncoding('MacRomanEncoding', 32, 255, null);
    expect(Array.from(enc.encode('á')!)).toEqual([0x87]);
    expect(Array.from(enc.encode('é')!)).toEqual([0x8e]);
    expect(Array.from(enc.encode('ñ')!)).toEqual([0x96]);
  });

  it('fuera del encoding → null (nunca adivinar)', () => {
    const enc = encoderFromSimpleEncoding('WinAnsiEncoding', 32, 255, null);
    expect(enc.encode('日本')).toBeNull();
  });

  it('el subset manda: FirstChar/LastChar acotan y width 0 delata glifo ausente', () => {
    // Subset [65..90] (mayúsculas): 'a' queda fuera.
    const narrow = encoderFromSimpleEncoding('WinAnsiEncoding', 65, 90, null);
    expect(narrow.encode('AZ')).not.toBeNull();
    expect(narrow.encode('a')).toBeNull();
    // Widths con un 0 en 'B' (código 66): glifo ausente aunque esté en rango.
    const widths = [500, 0, 500]; // A, B, C
    const gated = encoderFromSimpleEncoding('WinAnsiEncoding', 65, 67, widths);
    expect(gated.encode('A')).not.toBeNull();
    expect(gated.encode('B')).toBeNull();
  });
});

describe('encoderForFont camino simple-encoding (integrado)', () => {
  async function makeWinAnsiPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Nombre completo', { x: 72, y: 700, size: 12, font: helv });
    return patchSimpleFonts(await doc.save());
  }

  it('rewrite con acentos usa la fuente ORIGINAL (path B): sin sustitución, texto exacto', async () => {
    const pdf = await makeWinAnsiPdf();
    const g = await graphOf(pdf);
    const seg = segByText(g, 'Nombre completo');
    const edit = mergeSegmentEdit(seg, null, { text: 'Añadir más café' });
    const { pdf: baked, applied, warnings } = await bakeSegmentEdits(pdf, [edit!]);

    // NADA cayó a fuente sustituta (ni provider ni estándar).
    expect(warnings).toEqual([]);
    expect(applied.some(a => a.includes('fuente sustituta') || a.includes('fuente estándar'))).toBe(false);
    expect(applied.some(a => a.includes('reescrito por tramos'))).toBe(true);

    const g2 = await graphOf(baked);
    const rewritten = segByText(g2, 'Añadir más café');
    expect(rewritten.x).toBeCloseTo(seg.x, 0);
    expect(rewritten.baseline).toBeCloseTo(seg.baseline, 0);
    expect(rewritten.fontSize).toBeCloseTo(12, 0);
  });
});
