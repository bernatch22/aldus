/**
 * bake.test.ts — el ciclo completo contra un PDF REAL:
 * crear (pdf-lib) → extraer grafo (pdfjs) → bake (content stream) → re-extraer
 * y verificar que el resultado es el esperado, con geometría.
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  extractPageGraph,
  mergeSegmentEdit,
  originalStyledRuns,
  type PageGraph,
  type PdfJsPage,
  type SegmentEdit,
} from '../src/index.js';
import { bakeSegmentEdits } from '../src/bake/index.js';

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Nombre:', { x: 72, y: 700, size: 12, font: helv });
  page.drawText('Juan Perez', { x: 220, y: 700, size: 12, font: helv });
  page.drawText('Segunda linea de prueba', { x: 72, y: 680, size: 12, font: helv });
  return doc.save();
}

async function graphOf(pdf: Uint8Array): Promise<PageGraph> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: pdf.slice(), verbosity: 0 });
  const doc = await task.promise;
  const page = (await doc.getPage(1)) as unknown as PdfJsPage;
  const graph = await extractPageGraph(page);
  await doc.destroy();
  return graph;
}

function segByText(g: PageGraph, text: string) {
  const seg = g.segments.find(s => s.text === text);
  if (!seg) throw new Error(`segmento "${text}" no encontrado en [${g.segments.map(s => s.text).join(' | ')}]`);
  return seg;
}

function editFor(g: PageGraph, text: string, patch: Partial<SegmentEdit>): SegmentEdit {
  const seg = segByText(g, text);
  return {
    segmentId: seg.id,
    page: seg.page,
    text: seg.text,
    original: {
      text: seg.text, x: seg.x, baseline: seg.baseline, width: seg.width, fontSize: seg.fontSize,
      bucket: 'sans', bold: false, italic: false,
    },
    ...patch,
  };
}

describe('extracción', () => {
  it('separa la línea label/valor en dos segmentos anclados', async () => {
    const g = await graphOf(await makePdf());
    expect(g.segments.map(s => s.text)).toContain('Nombre:');
    expect(g.segments.map(s => s.text)).toContain('Juan Perez');
    const label = segByText(g, 'Nombre:');
    const value = segByText(g, 'Juan Perez');
    expect(label.baseline).toBeCloseTo(700, 0);
    expect(value.x).toBeCloseTo(220, 0);
  });
});

describe('imágenes', () => {
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  async function makePdfWithImage(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const png = await doc.embedPng(Buffer.from(PNG_1PX, 'base64'));
    page.drawText('Con imagen', { x: 72, y: 720, size: 12, font: helv });
    page.drawImage(png, { x: 100, y: 500, width: 120, height: 80 });
    return doc.save();
  }

  it('extrae la imagen con su rect', async () => {
    const g = await graphOf(await makePdfWithImage());
    expect(g.images).toHaveLength(1);
    expect(g.images[0].x).toBeCloseTo(100, 0);
    expect(g.images[0].y).toBeCloseTo(500, 0);
    expect(g.images[0].width).toBeCloseTo(120, 0);
    expect(g.images[0].height).toBeCloseTo(80, 0);
  });

  it('mueve y escala la imagen en el content stream', async () => {
    const pdf = await makePdfWithImage();
    const g = await graphOf(pdf);
    const img = g.images[0];
    const { pdf: baked, warnings } = await bakeSegmentEdits(pdf, [], [{
      imageId: img.id, page: img.page, x: 300, y: 400, width: 60, height: 40,
      original: { x: img.x, y: img.y, width: img.width, height: img.height },
    }]);
    expect(warnings).toEqual([]);
    const g2 = await graphOf(baked);
    expect(g2.images).toHaveLength(1);
    expect(g2.images[0].x).toBeCloseTo(300, 0);
    expect(g2.images[0].y).toBeCloseTo(400, 0);
    expect(g2.images[0].width).toBeCloseTo(60, 0);
    expect(g2.images[0].height).toBeCloseTo(40, 0);
    // El texto de la página no se tocó.
    expect(segByText(g2, 'Con imagen').x).toBeCloseTo(72, 0);
  });

  it('elimina la imagen', async () => {
    const pdf = await makePdfWithImage();
    const g = await graphOf(pdf);
    const img = g.images[0];
    const { pdf: baked } = await bakeSegmentEdits(pdf, [], [{
      imageId: img.id, page: img.page, remove: true,
      original: { x: img.x, y: img.y, width: img.width, height: img.height },
    }]);
    const g2 = await graphOf(baked);
    expect(g2.images).toHaveLength(0);
    expect(segByText(g2, 'Con imagen').x).toBeCloseTo(72, 0);
  });
});

describe('bake', () => {
  it('mueve un segmento sin tocar el resto (caso A: verbatim reubicado)', async () => {
    const pdf = await makePdf();
    const g = await graphOf(pdf);
    const edit = editFor(g, 'Juan Perez', { x: 320, baseline: 650 });
    const { pdf: baked, applied, warnings } = await bakeSegmentEdits(pdf, [edit]);
    expect(warnings).toEqual([]);
    expect(applied).toHaveLength(1);

    const g2 = await graphOf(baked);
    const moved = segByText(g2, 'Juan Perez');
    expect(moved.x).toBeCloseTo(320, 0);
    expect(moved.baseline).toBeCloseTo(650, 0);
    // El vecino no se movió y no quedó nada en la posición vieja.
    expect(segByText(g2, 'Nombre:').x).toBeCloseTo(72, 0);
    expect(g2.segments.filter(s => s.text === 'Juan Perez')).toHaveLength(1);
  });

  it('reescribe el texto en su lugar (fuente estándar → sustitución OK)', async () => {
    const pdf = await makePdf();
    const g = await graphOf(pdf);
    const edit = editFor(g, 'Juan Perez', { text: 'Maria Lopez' });
    const { pdf: baked } = await bakeSegmentEdits(pdf, [edit]);

    const g2 = await graphOf(baked);
    const rewritten = segByText(g2, 'Maria Lopez');
    expect(rewritten.x).toBeCloseTo(220, 0);
    expect(rewritten.baseline).toBeCloseTo(700, 0);
    expect(g2.segments.some(s => s.text === 'Juan Perez')).toBe(false);
    expect(segByText(g2, 'Nombre:').x).toBeCloseTo(72, 0);
  });

  it('escala el tamaño (fontSize override)', async () => {
    const pdf = await makePdf();
    const g = await graphOf(pdf);
    const edit = editFor(g, 'Nombre:', { fontSize: 18 });
    const { pdf: baked, warnings } = await bakeSegmentEdits(pdf, [edit]);
    expect(warnings).toEqual([]);

    const g2 = await graphOf(baked);
    const resized = segByText(g2, 'Nombre:');
    expect(resized.fontSize).toBeCloseTo(18, 0);
    expect(resized.x).toBeCloseTo(72, 0);
    expect(resized.baseline).toBeCloseTo(700, 0);
  });

  it('quita la negrita a UNA parte sin tocar el resto (estilo por tramo)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
    page.drawText('Total:', { x: 72, y: 700, size: 12, font: helvBold });
    page.drawText('125.00', { x: 110, y: 700, size: 12, font: helv });
    const pdf = await doc.save();

    const g = await graphOf(pdf);
    const seg = g.segments.find(s => s.text.includes('Total:'));
    if (!seg) throw new Error('segmento no encontrado');
    expect(seg.text).toContain('125.00'); // un solo segmento, dos estilos
    const styled = originalStyledRuns(seg);
    expect(styled.map(r => r.bold)).toEqual([true, false]);

    // Quitar la negrita SOLO del primer tramo.
    const runs = styled.map((r, i) => (i === 0 ? { ...r, bold: false } : r));
    const edit = mergeSegmentEdit(seg, null, { runs });
    if (!edit) throw new Error('la edición no debería ser noop');
    const { pdf: baked } = await bakeSegmentEdits(pdf, [edit]);

    const g2 = await graphOf(baked);
    const seg2 = g2.segments.find(s => s.text.includes('Total:'));
    if (!seg2) throw new Error('segmento horneado no encontrado');
    expect(seg2.runs.every(r => !r.font.bold)).toBe(true);
    expect(seg2.text).toContain('125.00');
    // Y el caso inverso implícito: el tramo regular jamás se volvió bold.
    const value = seg2.runs.find(r => r.text.includes('125'));
    expect(value?.font.bold).toBe(false);
  });

  it('un segmento ilocalizable se salta con warning y el PDF queda intacto', async () => {
    const pdf = await makePdf();
    const g = await graphOf(pdf);
    const edit = editFor(g, 'Nombre:', { text: 'X' });
    edit.original.baseline = 50; // en el vacío
    const { pdf: baked, applied, warnings } = await bakeSegmentEdits(pdf, [edit]);
    expect(applied).toEqual([]);
    expect(warnings).toHaveLength(1);
    const g2 = await graphOf(baked);
    expect(segByText(g2, 'Nombre:').x).toBeCloseTo(72, 0);
  });
});
