/**
 * widthFit.test.ts — WIDTH FITTING: un run re-emitido/fallback con SLOT
 * geométrico conocido (ancla del run siguiente − la propia, dx reales del
 * edit) se ENCAJA en el slot vía Tz (bake/widthFit.ts).
 *
 * El bug real (doc del usuario): bold sobre "empresa" dentro de un run itálico
 * — la cara bold del fallback es más ANCHA que el hueco entre anclas
 * (42.9pt vs 39.8pt) y la "a" final invadía el "]" del run siguiente ("a]"
 * pegado). Con el fit, el texto termina EXACTO en la ancla siguiente.
 *
 * Clamp de cordura (sagrado, widthFit.ts): fuera de 65%–135% NO se ajusta —
 * texto deforme es peor que un solape leve.
 */
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFFont, PDFName, StandardFonts } from 'pdf-lib';
import { mergeSegmentEdit, type SegmentNode, type StyledRun } from '../src/index.js';
import { bakeSegmentEdits } from '../src/bake/index.js';
import { fitHScale } from '../src/bake/widthFit.js';
import { graphOf, patchSimpleFonts } from './helpers.js';

const SIZE = 12;
const X0 = 60;
const PRE = 'denominacion social de la ';
const WORD = 'empresa';
const POST = '], con domicilio';

/** Un doc de una línea Helvetica (regular) — el perfil del caso real: la
 *  variante BOLD no existe como recurso del PDF (→ fallback). */
async function oneLineDoc(): Promise<{ bytes: Uint8Array; helv: PDFFont; bold: PDFFont }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(PRE + WORD + POST, { x: X0, y: 700, size: SIZE, font: helv });
  // patchSimpleFonts: FirstChar/LastChar → los runs regulares van por path B
  // (re-encode con la fuente original), como en un PDF de Word/Quartz.
  return { bytes: await patchSimpleFonts(await doc.save()), helv, bold };
}

/** Completa /Widths en los font dicts (desde las métricas del PDFFont) para
 *  que FontService.widthOfBytes tenga anchos CONFIABLES (path B fitting). */
async function patchWidths(bytes: Uint8Array, metrics: PDFFont): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice());
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (!fonts) continue;
    for (const key of fonts.keys()) {
      const fd = fonts.lookup(key);
      if (!(fd instanceof PDFDict)) continue;
      const widths: number[] = [];
      for (let code = 32; code <= 255; code++) {
        let w = 0;
        try {
          w = metrics.widthOfTextAtSize(String.fromCharCode(code), 1000);
        } catch {
          w = 0;
        }
        widths.push(w);
      }
      fd.set(PDFName.of('Widths'), doc.context.obj(widths));
    }
  }
  return doc.save();
}

const segOf = (segments: SegmentNode[], contains: string): SegmentNode => {
  const seg = segments.find(s => s.text.includes(contains));
  if (!seg) throw new Error(`segmento con "${contains}" no encontrado en [${segments.map(s => s.text).join(' | ')}]`);
  return seg;
};

/** Los tres runs anclados del caso real: PRE regular + WORD bold + POST
 *  regular, con dx REALES (métricas de la fuente original — el contrato de
 *  restyleFromGraph) salvo que `slotOverride` estire el hueco del bold. */
function makeRuns(helv: PDFFont, slotOverride?: number): { runs: StyledRun[]; dxWord: number; dxPost: number } {
  const dxWord = helv.widthOfTextAtSize(PRE, SIZE);
  const dxPost = dxWord + (slotOverride ?? helv.widthOfTextAtSize(WORD, SIZE));
  const runs: StyledRun[] = [
    { text: PRE, bold: false, italic: false, dx: 0 },
    { text: WORD, bold: true, italic: false, dx: dxWord },
    { text: POST, bold: false, italic: false, dx: dxPost },
  ];
  return { runs, dxWord, dxPost };
}

async function bakeRestyle(bytes: Uint8Array, runs: StyledRun[]): Promise<SegmentNode[]> {
  const graph = await graphOf(bytes);
  const seg = segOf(graph.segments, WORD);
  const edit = mergeSegmentEdit(seg, null, { runs });
  expect(edit).not.toBeNull();
  const { pdf, warnings } = await bakeSegmentEdits(bytes, [edit!]);
  expect(warnings.filter(w => w.includes('geometría'))).toHaveLength(0);
  return (await graphOf(pdf)).segments;
}

describe('fitHScale (la regla, una sola fuente)', () => {
  it('encaja dentro del clamp; respeta tolerancia y cordura', () => {
    expect(fitHScale(42.9, 39.8)).toBeCloseTo((39.8 / 42.9) * 100, 5); // el caso real
    expect(fitHScale(40, 40.1)).toBeUndefined(); // ≤ 0.2pt: ruido, no ensuciar
    expect(fitHScale(40, 20)).toBeUndefined(); // 50% < 65%: deforme, mejor solape
    expect(fitHScale(40, 80)).toBeUndefined(); // 200% > 135%
    expect(fitHScale(0, 10)).toBeUndefined();
    expect(fitHScale(NaN, 10)).toBeUndefined();
    expect(fitHScale(10, -1)).toBeUndefined();
  });
});

describe('width fitting en el bake (slot geométrico → Tz)', () => {
  it('CASO REAL: bold (fallback) más ancho que su slot → se encaja, sin solape', async () => {
    const { bytes, helv, bold } = await oneLineDoc();
    const { runs, dxWord, dxPost } = makeRuns(helv);
    // Precondición del bug: la cara bold NO entra en el hueco.
    expect(bold.widthOfTextAtSize(WORD, SIZE)).toBeGreaterThan(dxPost - dxWord + 0.5);

    const segments = await bakeRestyle(bytes, runs);
    // (a) UN solo segmento — el fit no deja hueco ni solape que lo parta.
    const seg = segOf(segments, WORD);
    expect(seg.text).toBe(PRE + WORD + POST);
    expect(segments.filter(s => Math.abs(s.baseline - 700) < 2)).toHaveLength(1);
    // (b) el run siguiente arranca en su ancla exacta.
    const post = seg.runs.find(r => r.text.startsWith(']'))!;
    expect(post.x).toBeCloseTo(X0 + dxPost, 0);
    expect(Math.abs(post.x - (X0 + dxPost))).toBeLessThanOrEqual(0.5);
    // (c) el bold termina DENTRO del slot: end ≤ ancla siguiente + 0.5pt.
    const boldRun = seg.runs.find(r => r.font.bold)!;
    expect(boldRun.text).toBe(WORD);
    expect(boldRun.x + boldRun.width).toBeLessThanOrEqual(X0 + dxPost + 0.5);
  });

  it('slot MÁS ANCHO que el natural (dentro del clamp): el texto se ESTIRA al slot', async () => {
    // Comportamiento elegido: dentro del clamp 65–135% el run se estira hasta
    // la ancla siguiente (sin agujero que el re-extract clasifique espacio).
    const { bytes, helv, bold } = await oneLineDoc();
    const natural = bold.widthOfTextAtSize(WORD, SIZE);
    const { runs, dxPost } = makeRuns(helv, natural * 1.2); // Tz = 120% ∈ clamp
    const segments = await bakeRestyle(bytes, runs);
    const seg = segOf(segments, WORD);
    const boldRun = seg.runs.find(r => r.font.bold)!;
    expect(Math.abs(boldRun.x + boldRun.width - (X0 + dxPost))).toBeLessThanOrEqual(0.5);
  });

  it('fuera del clamp de cordura (slot = 2× natural): NO se ajusta — ancho natural', async () => {
    const { bytes, helv, bold } = await oneLineDoc();
    const natural = bold.widthOfTextAtSize(WORD, SIZE);
    const { runs, dxWord } = makeRuns(helv, natural * 2); // Tz sería 200% → jamás
    const segments = await bakeRestyle(bytes, runs);
    const boldRun = segments.flatMap(s => s.runs).find(r => r.font.bold)!;
    expect(boldRun.x).toBeCloseTo(X0 + dxWord, 0);
    expect(Math.abs(boldRun.width - natural)).toBeLessThanOrEqual(0.7);
  });

  it('sin slot conocido (último run de la línea): comportamiento intacto (ancho natural)', async () => {
    const { bytes, helv, bold } = await oneLineDoc();
    const dxWord = helv.widthOfTextAtSize(PRE, SIZE);
    const runs: StyledRun[] = [
      { text: PRE, bold: false, italic: false, dx: 0 },
      { text: WORD + POST, bold: true, italic: false, dx: dxWord }, // último: sin ancla siguiente
    ];
    const segments = await bakeRestyle(bytes, runs);
    const boldRun = segments.flatMap(s => s.runs).find(r => r.font.bold)!;
    expect(boldRun.x).toBeCloseTo(X0 + dxWord, 0);
    expect(Math.abs(boldRun.width - bold.widthOfTextAtSize(WORD + POST, SIZE))).toBeLessThanOrEqual(0.7);
  });

  it('path B (re-encode con la fuente ORIGINAL, /Widths confiables): también encaja', async () => {
    // Texto NUEVO más largo anclado en el mismo slot ("empresa" → "empresas"),
    // mismo estilo → path B. Con /Widths el natural es medible y el Tz encaja.
    const { bytes: base, helv } = await oneLineDoc();
    const bytes = await patchWidths(base, helv);
    const dxWord = helv.widthOfTextAtSize(PRE, SIZE);
    const dxPost = dxWord + helv.widthOfTextAtSize(WORD, SIZE); // el slot ORIGINAL
    const runs: StyledRun[] = [
      { text: PRE, bold: false, italic: false, dx: 0 },
      { text: 'empresas', bold: false, italic: false, dx: dxWord },
      { text: POST, bold: false, italic: false, dx: dxPost },
    ];
    const natural = helv.widthOfTextAtSize('empresas', SIZE);
    expect(natural).toBeGreaterThan(dxPost - dxWord + 0.5);

    const graph = await graphOf(bytes);
    const seg0 = segOf(graph.segments, WORD);
    const edit = mergeSegmentEdit(seg0, null, { runs })!;
    const { pdf, warnings } = await bakeSegmentEdits(bytes, [edit]);
    // Sin sustitución: los tres tramos van por path B (la fuente original).
    expect(warnings).toHaveLength(0);

    // El stream emite el Tz del encaje (slot/natural — ≈88%, no 100).
    const { decodeStreams } = await import('./helpers.js');
    const stream = new TextDecoder('latin1').decode(await decodeStreams(pdf));
    const tzs = [...stream.matchAll(/([\d.]+) Tz/g)].map(m => Number(m[1]));
    const expected = ((dxPost - dxWord) / natural) * 100;
    expect(tzs.some(v => Math.abs(v - expected) < 0.5)).toBe(true);

    // Y el re-extract ve UNA pieza contigua: pdf.js solo funde ítems cuando
    // cada uno arranca EXACTO donde terminó el anterior — el nuevo texto
    // termina en la ancla de POST (sin solape ni agujero) y el final absoluto
    // queda donde el original: ancla POST + ancho de POST.
    const segments = (await graphOf(pdf)).segments;
    const seg = segOf(segments, 'empresas');
    expect(seg.text).toBe(PRE + 'empresas' + POST);
    expect(segments.filter(s => Math.abs(s.baseline - 700) < 2)).toHaveLength(1);
    expect(Math.abs(seg.x + seg.width - (X0 + dxPost + helv.widthOfTextAtSize(POST, SIZE)))).toBeLessThanOrEqual(0.7);
  });
});
