/**
 * extract.test.ts — invariantes del extractor. La variante "ids estables" se
 * prueba de DOS formas equivalentes: con dos PDFs construidos a mano (portado
 * de F1a) Y — ahora que el bake existe (F3) — removiendo el nodo del medio con
 * el BAKE y re-extrayendo (la forma ORIGINAL de v1, resuelto el TODO(F3)).
 *
 * (a) IDS ESTABLES POR GEOMETRÍA: el id de un segmento sale de su baseline/x
 *     redondeados (`p1-y700-x72`), no de un índice — remover OTRO nodo no
 *     puede cambiar los ids de los que quedan (el preview local depende de
 *     esto: con ids por índice, el mapa de ediciones se rompía).
 *
 * (b) mergeBlockSegments: un bloque multilínea emitido como lo emite el bake
 *     (una línea de UN segmento, misma x ±0.5, mismo tamaño ±0.1, leading
 *     1.2×size ±0.06×size) se re-fusiona en UN segmento con '\n'. Se prueba
 *     también el ROUND-TRIP real: bake de un texto con '\n' → re-extract → un
 *     solo segmento con '\n' (el bake emite exactamente esa firma).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mergeSegmentEdit } from '../src/index.js';
import { bakeSegmentEdits } from '../src/bake/index.js';
import { graphOf, segByText } from './helpers.js';

async function makeLines(lines: Array<{ text: string; x: number; y: number }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (const l of lines) page.drawText(l.text, { x: l.x, y: l.y, size: 12, font: helv });
  return doc.save();
}

describe('ids estables por geometría', () => {
  it('un documento SIN el nodo del medio conserva los ids de los demás', async () => {
    const withBeta = await graphOf(await makeLines([
      { text: 'Alpha', x: 72, y: 700 },
      { text: 'Beta', x: 72, y: 660 },
      { text: 'Gamma', x: 72, y: 620 },
    ]));
    const withoutBeta = await graphOf(await makeLines([
      { text: 'Alpha', x: 72, y: 700 },
      { text: 'Gamma', x: 72, y: 620 },
    ]));

    expect(withoutBeta.segments.some(s => s.text === 'Beta')).toBe(false);
    expect(segByText(withoutBeta, 'Alpha').id).toBe(segByText(withBeta, 'Alpha').id);
    expect(segByText(withoutBeta, 'Gamma').id).toBe(segByText(withBeta, 'Gamma').id);
  });

  it('el id codifica la geometría (y redondeada + x redondeada)', async () => {
    const g = await graphOf(await makeLines([
      { text: 'Alpha', x: 72, y: 700 },
      { text: 'Beta', x: 72, y: 660 },
    ]));
    expect(segByText(g, 'Alpha').id).toBe('p1-y700-x72');
    expect(segByText(g, 'Beta').id).toBe('p1-y660-x72');
  });

  it('vía BAKE (remove de "Beta" + re-extract): los ids de Alpha/Gamma no cambian', async () => {
    // La forma ORIGINAL de v1 (resuelto el TODO(F3)): remover el nodo del medio
    // con el bake real y re-extraer. Si los ids salieran de un índice, borrar
    // Beta correría los de Gamma.
    const pdf = await makeLines([
      { text: 'Alpha', x: 72, y: 700 },
      { text: 'Beta', x: 72, y: 660 },
      { text: 'Gamma', x: 72, y: 620 },
    ]);
    const g = await graphOf(pdf);
    const del = mergeSegmentEdit(segByText(g, 'Beta'), null, { remove: true });
    const { pdf: baked, warnings } = await bakeSegmentEdits(pdf, [del!]);
    expect(warnings).toEqual([]);
    const g2 = await graphOf(baked);
    expect(g2.segments.some(s => s.text === 'Beta')).toBe(false);
    expect(segByText(g2, 'Alpha').id).toBe(segByText(g, 'Alpha').id);
    expect(segByText(g2, 'Gamma').id).toBe(segByText(g, 'Gamma').id);
  });
});

describe('mergeBlockSegments — el bloque del bake se re-fusiona', () => {
  it('tres líneas con la firma del bake (misma x, leading 1.2×fs) = UN segmento con \\n', async () => {
    const size = 12;
    const lead = size * 1.2; // 14.4 — exactamente lo que emite el bake para '\n'
    const g = await graphOf(await makeLines([
      { text: 'linea uno', x: 72, y: 700 },
      { text: 'linea dos', x: 72, y: 700 - lead },
      { text: 'linea tres', x: 72, y: 700 - 2 * lead },
    ]));

    const block = segByText(g, 'linea uno\nlinea dos\nlinea tres');
    expect(block.x).toBeCloseTo(72, 0);
    expect(block.baseline).toBeCloseTo(700, 0);
    // Y no quedaron las líneas sueltas como segmentos aparte.
    expect(g.segments.filter(s => s.text.startsWith('linea'))).toHaveLength(1);
  });

  it('un leading que NO es 1.2×fs no se fusiona (no es un bloque del bake)', async () => {
    const g = await graphOf(await makeLines([
      { text: 'suelta uno', x: 72, y: 700 },
      { text: 'suelta dos', x: 72, y: 680 }, // step 20 ≠ 14.4
    ]));
    expect(segByText(g, 'suelta uno').text).toBe('suelta uno');
    expect(segByText(g, 'suelta dos').text).toBe('suelta dos');
  });

  it('con x distinta tampoco se fusiona', async () => {
    const g = await graphOf(await makeLines([
      { text: 'indentada uno', x: 72, y: 700 },
      { text: 'indentada dos', x: 90, y: 700 - 14.4 },
    ]));
    expect(g.segments.filter(s => s.text.startsWith('indentada'))).toHaveLength(2);
  });

  it('ROUND-TRIP: bake de un texto con \\n → re-extract lo devuelve como UN segmento', async () => {
    // El bake emite cada línea del '\n' bajando leading = 1.2×fs, misma x — la
    // firma EXACTA que mergeBlockSegments re-fusiona. Round-trip real bake→extract.
    const pdf = await makeLines([{ text: 'una sola linea', x: 72, y: 700 }]);
    const g = await graphOf(pdf);
    const seg = segByText(g, 'una sola linea');
    const edit = mergeSegmentEdit(seg, null, { text: 'primera\nsegunda\ntercera' });
    // (La fuente estándar de pdf-lib no trae ToUnicode → el rewrite cae a
    // sustitución con warning; irrelevante para el invariante del '\n'.)
    const { pdf: baked } = await bakeSegmentEdits(pdf, [edit!]);
    const g2 = await graphOf(baked);
    const block = segByText(g2, 'primera\nsegunda\ntercera');
    expect(block.x).toBeCloseTo(72, 0);
    expect(block.baseline).toBeCloseTo(700, 0);
    expect(g2.segments.filter(s => /primera|segunda|tercera/.test(s.text))).toHaveLength(1);
  });
});
