/**
 * engineApi — la superficie que un host e-sign consume para la ceremonia:
 * flattenForm (tamper-evidence), insertImage con rect exacto (firma en su
 * box), readPdfInfo/isPdf/defaultSignaturePlacement, y locateText (ancla por
 * texto citado).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { flattenForm } from '../src/bake/index.js';
import { readPdfInfo, isPdf } from '../src/bake/index.js';
import { insertImage } from '../src/bake/index.js';
import { setFieldValues, readFormFields } from '../src/bake/index.js';
import { locateText, PageGraphService } from '../src/index.js';
import type { PageGraph, SegmentNode } from '../src/index.js';

// PNG 1×1 rojo (el mínimo válido).
const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
), c => c.charCodeAt(0));

async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Contrato de prueba', { x: 50, y: 750, size: 14, font });
  const form = doc.getForm();
  const tf = form.createTextField('sw.1.nombre');
  tf.addToPage(page, { x: 50, y: 700, width: 200, height: 18 });
  const cb = form.createCheckBox('sw.1.acepta');
  cb.addToPage(page, { x: 50, y: 670, width: 14, height: 14 });
  return doc.save();
}

describe('flattenForm', () => {
  it('llena → aplana: los widgets desaparecen y el PDF sobrevive', async () => {
    const pdf = await makeFormPdf();
    const filled = await setFieldValues(pdf, [
      { name: 'sw.1.nombre', value: 'Bernardo Castro' },
      { name: 'sw.1.acepta', value: 'true' },
    ]);
    const r = await flattenForm(filled.pdf);
    expect(r.warnings).toEqual([]);
    expect(r.flattened.sort()).toEqual(['sw.1.acepta', 'sw.1.nombre']);
    // Después de aplanar no quedan campos vivos.
    expect(await readFormFields(r.pdf)).toEqual([]);
    // Y el PDF sigue siendo cargable.
    expect((await readPdfInfo(r.pdf)).pageCount).toBe(1);
  });

  it('sin AcroForm: no-op honesto', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const r = await flattenForm(await doc.save());
    expect(r.flattened).toEqual([]);
  });
});

describe('insertImage con rect exacto (firma en su box)', () => {
  it('width+height fuerzan el rect pedido', async () => {
    const pdf = await makeFormPdf();
    const { rect } = await insertImage(pdf, {
      page: 1, x: 100, y: 300, bytes: PNG_1PX, mime: 'image/png', width: 180, height: 46,
    });
    expect(rect).toEqual({ x: 100, y: 300 - 46, width: 180, height: 46 });
  });

  it('solo width escala con aspecto', async () => {
    const pdf = await makeFormPdf();
    const { rect } = await insertImage(pdf, {
      page: 1, x: 0, y: 100, bytes: PNG_1PX, mime: 'image/png', width: 50,
    });
    expect(rect.width).toBe(50);
    expect(rect.height).toBe(50); // 1×1 → aspecto 1
  });
});

describe('readPdfInfo / isPdf', () => {
  it('info básica y magic bytes', async () => {
    const pdf = await makeFormPdf();
    const info = await readPdfInfo(pdf);
    expect(info.pageCount).toBe(1);
    expect(info.pages[0]).toEqual({ width: 600, height: 800 });
    expect(isPdf(pdf)).toBe(true);
    expect(isPdf(Uint8Array.from([1, 2, 3]))).toBe(false);
  });

  // TODO(host): `defaultSignaturePlacement` era POLÍTICA de producto e-sign
  // ("N-ésimo firmante apilado en la última página") — el audit la saca del
  // core del motor PDF y la manda al host e-sign. Su test ("firmantes apilados
  // en la última página") viaja con ella; no cruza a @aldus/core.
});

// ── locateText sobre un grafo sintético ─────────────────────────────────────
const seg = (id: string, text: string, x: number, baseline: number, width = 100): SegmentNode =>
  ({ id, kind: 'segment', page: 1, text, runs: [], x, baseline, y: baseline - 2, width, height: 12, fontSize: 10 } as unknown as SegmentNode);

const graph = (segments: SegmentNode[], page = 1): PageGraph =>
  // v2 ancla el TextAnchor en el `.page` del NODO (v1 usaba el de la PageGraph
  // contenedora). En un grafo real seg.page === graph.page; el helper `seg`
  // hardcodeaba page:1, así que acá lo estampamos para que coincida.
  ({ page, width: 600, height: 800, runs: [], lines: [], segments: segments.map(s => ({ ...s, page })), images: [], widgets: [], links: [], highlights: [], shapes: [] } as PageGraph);

/** v2: locateText consulta un IPageGraphService (v1 recibía PageGraph[]). El
 *  service se puebla con replace() por página — misma semántica. */
const svcOf = (...graphs: PageGraph[]): PageGraphService => {
  const svc = new PageGraphService();
  for (const g of graphs) svc.replace(g);
  return svc;
};

describe('locateText', () => {
  const g1 = graph([
    seg('a', 'PARTE DIVULGADORA', 50, 700),
    seg('b', 'La PARTE RECEPTORA se obliga a mantener la confidencialidad', 50, 650, 400),
    seg('c', 'PARTE RECEPTORA', 50, 200),
  ]);

  it('matchea normalizado (case/acentos) y prefiere el ancla más apretada', () => {
    const hit = locateText(svcOf(g1), 'parte receptora');
    expect(hit?.segmentId).toBe('c'); // el segmento corto gana a la frase larga
  });

  it("prefer:'first' devuelve el de arriba (orden de lectura)", () => {
    const hit = locateText(svcOf(g1), 'parte receptora', { prefer: 'first' });
    expect(hit?.segmentId).toBe('b');
  });

  it('pageHint prioriza esa página; acentos citados de memoria matchean', () => {
    const g2 = graph([seg('d', 'firmó en representación', 50, 100)], 2);
    const hit = locateText(svcOf(g1, g2), 'FIRMO EN REPRESENTACION', { pageHint: 2 });
    expect(hit?.page).toBe(2);
    expect(hit?.segmentId).toBe('d');
  });

  it('sin match → null (nunca adivina)', () => {
    expect(locateText(svcOf(g1), 'texto inexistente')).toBeNull();
  });
});
