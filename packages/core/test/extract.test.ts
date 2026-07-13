/**
 * extract.test.ts — dos invariantes del extractor (portado de F1a con UNA
 * adaptación: en v1 el caso "ids estables" removía el nodo con el BAKE; el
 * bake llega en F3, así que acá se construyen DOS PDFs con pdf-lib — uno sin
 * el nodo del medio — y se comparan los ids de los nodos comunes. El
 * invariante probado es el mismo: el id sale de la GEOMETRÍA, no del índice).
 *
 * TODO(F3): re-agregar la variante vía bake (remove de "Beta" + re-extract)
 * cuando bakeSegmentEdits/bake exista en v2.
 *
 * (a) IDS ESTABLES POR GEOMETRÍA: el id de un segmento sale de su baseline/x
 *     redondeados (`p1-y700-x72`), no de un índice — remover OTRO nodo no
 *     puede cambiar los ids de los que quedan (el preview local depende de
 *     esto: con ids por índice, el mapa de ediciones se rompía).
 *
 * (b) mergeBlockSegments: un bloque multilínea emitido como lo emite el bake
 *     (una línea de UN segmento, misma x ±0.5, mismo tamaño ±0.1, leading
 *     1.2×size ±0.06×size) se re-fusiona en UN segmento con '\n'.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
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
});
