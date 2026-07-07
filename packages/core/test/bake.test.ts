/**
 * bake.test.ts — el ciclo completo contra un PDF REAL:
 * crear (pdf-lib) → extraer grafo (pdfjs) → bake (content stream) → re-extraer
 * y verificar que el resultado es el esperado, con geometría.
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib';
import { walkContent } from '../src/bake/index.js';
import {
  extractPageGraph,
  mergeSegmentEdit,
  mergeHighlightEdit,
  mergeLinkEdit,
  originalStyledRuns,
  type PageGraph,
  type PdfJsPage,
  type SegmentEdit,
} from '../src/index.js';
import { addFormField, addHighlight, addLink, addRadioOption, addText, addWatermark, bakeSegmentEdits, insertImage, removeLink, setFieldOptions } from '../src/bake/index.js';

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Nombre:', { x: 72, y: 700, size: 12, font: helv });
  page.drawText('Juan Perez', { x: 220, y: 700, size: 12, font: helv });
  page.drawText('Segunda linea de prueba', { x: 72, y: 680, size: 12, font: helv });
  return doc.save();
}

/** Un PDF cuyo contenido está envuelto en un CLIP rect (como los generadores
 *  que recortan la página): el texto vive dentro de `q <rect> W n … Q`. Mover
 *  un segmento FUERA de ese rect, con re-emisión in-place, lo recortaría a nada
 *  — el bake debe emitirlo al final del stream (CTM identidad, sin clip). */
async function makeClippedPdf(clip: [number, number, number, number]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('x', { x: 0, y: 0, size: 1, font: helv }); // registra el recurso de fuente
  const fonts = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
  const fontName = fonts.keys()[0].asString().slice(1); // "/F1-0" → "F1-0"
  const [cx, cy, cw, ch] = clip;
  const content = `q ${cx} ${cy} ${cw} ${ch} re W n BT /${fontName} 12 Tf 1 0 0 1 100 100 Tm (Recortame) Tj ET Q`;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
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

  it('mover una imagen preserva el Z-ORDER (una imagen de fondo sigue DEBAJO del texto)', async () => {
    // Fondo (imagen primero) + texto encima.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const png = await doc.embedPng(Buffer.from(PNG_1PX, 'base64'));
    page.drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
    page.drawText('Texto encima del fondo', { x: 72, y: 700, size: 12, font: helv });
    const pdf = await doc.save();

    const g = await graphOf(pdf);
    const img = g.images[0];
    const { pdf: baked, warnings } = await bakeSegmentEdits(pdf, [], [{
      imageId: img.id, page: 1, x: 50, y: 100, width: 300, height: 400,
      original: { x: img.x, y: img.y, width: img.width, height: img.height },
    }]);
    expect(warnings).toEqual([]);

    // En el stream horneado, el Do de la imagen sigue ANTES que el texto.
    const doc2 = await PDFDocument.load(baked);
    const page2 = doc2.getPages()[0];
    const raw = page2.node.get(PDFName.of('Contents'));
    const stream = raw instanceof PDFRef ? doc2.context.lookup(raw) : raw;
    if (!(stream instanceof PDFRawStream)) throw new Error('stream inesperado');
    const bytes = decodePDFRawStream(stream).decode();
    const walk = walkContent(bytes);
    expect(walk.xobjects.length).toBeGreaterThan(0);
    expect(walk.shows.length).toBeGreaterThan(0);
    expect(walk.xobjects[0].record.start).toBeLessThan(walk.shows[0].record.start);

    // Y la geometría nueva es exacta.
    const g2 = await graphOf(baked);
    expect(g2.images[0].x).toBeCloseTo(50, 0);
    expect(g2.images[0].width).toBeCloseTo(300, 0);
    expect(segByText(g2, 'Texto encima del fondo').x).toBeCloseTo(72, 0);
  });

  it('enviar al fondo reordena el op al principio del stream', async () => {
    // Texto primero, imagen después (la imagen quedó ARRIBA del texto).
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const png = await doc.embedPng(Buffer.from(PNG_1PX, 'base64'));
    page.drawText('Texto tapado', { x: 72, y: 700, size: 12, font: helv });
    page.drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
    const pdf = await doc.save();

    const g = await graphOf(pdf);
    const img = g.images[0];
    const { pdf: baked, warnings } = await bakeSegmentEdits(pdf, [], [{
      imageId: img.id, page: 1, zOrder: 'back',
      original: { x: img.x, y: img.y, width: img.width, height: img.height },
    }]);
    expect(warnings).toEqual([]);

    const doc2 = await PDFDocument.load(baked);
    const raw = doc2.getPages()[0].node.get(PDFName.of('Contents'));
    const stream = raw instanceof PDFRef ? doc2.context.lookup(raw) : raw;
    if (!(stream instanceof PDFRawStream)) throw new Error('stream inesperado');
    const walk = walkContent(decodePDFRawStream(stream).decode());
    // Ahora la imagen se dibuja ANTES que el texto (quedó de fondo).
    expect(walk.xobjects[0].record.start).toBeLessThan(walk.shows[0].record.start);
    const g2 = await graphOf(baked);
    expect(g2.images[0].width).toBeCloseTo(612, 0);
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

describe('widgets (AcroForm)', () => {
  async function makeFormPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const name = form.createTextField('cliente.nombre');
    name.addToPage(page, { x: 150, y: 600, width: 200, height: 20 });
    const check = form.createCheckBox('acepta');
    check.addToPage(page, { x: 150, y: 560, width: 14, height: 14 });
    return doc.save();
  }

  it('extrae los widgets con tipo y rect', async () => {
    const g = await graphOf(await makeFormPdf());
    expect(g.widgets).toHaveLength(2);
    const text = g.widgets.find(w => w.fieldName === 'cliente.nombre');
    const check = g.widgets.find(w => w.fieldName === 'acepta');
    expect(text?.widgetType).toBe('text');
    expect(check?.widgetType).toBe('checkbox');
    // pdf-lib escribe el /Rect con ±0.5pt de inset por el borde del widget.
    expect(Math.abs((text?.x ?? 0) - 150)).toBeLessThanOrEqual(1);
    expect(Math.abs((text?.width ?? 0) - 200)).toBeLessThanOrEqual(2);
  });

  it('mueve y escala un campo (reescribe /Rect)', async () => {
    const pdf = await makeFormPdf();
    const g = await graphOf(pdf);
    const w = g.widgets.find(x => x.fieldName === 'cliente.nombre');
    if (!w) throw new Error('widget no encontrado');
    const { pdf: baked, warnings } = await bakeSegmentEdits(pdf, [], [], [{
      widgetId: w.id, page: w.page, x: 300, y: 400, width: 120, height: 24,
      original: { fieldName: w.fieldName, x: w.x, y: w.y, width: w.width, height: w.height },
    }]);
    expect(warnings).toEqual([]);
    const g2 = await graphOf(baked);
    const moved = g2.widgets.find(x => x.fieldName === 'cliente.nombre');
    expect(Math.abs((moved?.x ?? 0) - 300)).toBeLessThanOrEqual(1);
    expect(Math.abs((moved?.y ?? 0) - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs((moved?.width ?? 0) - 120)).toBeLessThanOrEqual(2);
    expect(Math.abs((moved?.height ?? 0) - 24)).toBeLessThanOrEqual(2);
    // El otro campo no se movió.
    expect(Math.abs((g2.widgets.find(x => x.fieldName === 'acepta')?.x ?? 0) - 150)).toBeLessThanOrEqual(1);
  });

  it('elimina un campo', async () => {
    const pdf = await makeFormPdf();
    const g = await graphOf(pdf);
    const w = g.widgets.find(x => x.fieldName === 'acepta');
    if (!w) throw new Error('widget no encontrado');
    const { pdf: baked } = await bakeSegmentEdits(pdf, [], [], [{
      widgetId: w.id, page: w.page, remove: true,
      original: { fieldName: w.fieldName, x: w.x, y: w.y, width: w.width, height: w.height },
    }]);
    const g2 = await graphOf(baked);
    expect(g2.widgets).toHaveLength(1);
    expect(g2.widgets[0].fieldName).toBe('cliente.nombre');
  });
});

describe('crear nodos', () => {
  it('crea campos nuevos (texto, checkbox, firma) con nombre único', async () => {
    let pdf = await makePdf();
    ({ pdf } = await addFormField(pdf, { type: 'text', page: 1, x: 72, y: 500 }));
    ({ pdf } = await addFormField(pdf, { type: 'text', page: 1, x: 72, y: 470 }));
    ({ pdf } = await addFormField(pdf, { type: 'checkbox', page: 1, x: 72, y: 440 }));
    const sig = await addFormField(pdf, { type: 'signature', page: 1, x: 72, y: 380 });
    pdf = sig.pdf;
    expect(sig.name).toBe('firma_1');

    const g = await graphOf(pdf);
    const types = g.widgets.map(w => `${w.fieldName}:${w.widgetType}`).sort();
    expect(types).toEqual(['check_1:checkbox', 'firma_1:signature', 'texto_1:text', 'texto_2:text']);
    const firma = g.widgets.find(w => w.widgetType === 'signature');
    expect(Math.abs((firma?.width ?? 0) - 200)).toBeLessThanOrEqual(2);
  });

  it('setea opciones de un select y agrega opciones a un grupo de radios', async () => {
    let pdf = await makePdf();
    ({ pdf } = await addFormField(pdf, { type: 'select', page: 1, x: 72, y: 500 }));
    ({ pdf } = await addFormField(pdf, { type: 'radio', page: 1, x: 72, y: 460 }));
    ({ pdf } = await setFieldOptions(pdf, { fieldName: 'select_1', options: ['Rojo', 'Verde', 'Azul'] }));
    ({ pdf } = await addRadioOption(pdf, { fieldName: 'radio_1', page: 1, x: 72, y: 430 }));
    ({ pdf } = await addRadioOption(pdf, { fieldName: 'radio_1', page: 1, x: 72, y: 400 }));

    const g = await graphOf(pdf);
    // El grupo de radios tiene 3 widgets (la original + 2 opciones), mismo nombre.
    const radios = g.widgets.filter(w => w.fieldName === 'radio_1' && w.widgetType === 'radio');
    expect(radios).toHaveLength(3);
    // Y las opciones del select quedaron (verificable vía pdf-lib).
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getForm().getDropdown('select_1').getOptions()).toEqual(['Rojo', 'Verde', 'Azul']);
  });

  it('inserta una imagen en el punto clickeado (aspecto preservado)', async () => {
    const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const pdf = await makePdf();
    const { pdf: withImage, rect } = await insertImage(pdf, {
      page: 1, x: 100, y: 600, bytes: Buffer.from(PNG_1PX, 'base64'), mime: 'image/png', maxWidth: 120,
    });
    expect(rect.width).toBeLessThanOrEqual(120);
    const g = await graphOf(withImage);
    expect(g.images).toHaveLength(1);
    expect(g.images[0].x).toBeCloseTo(rect.x, 0);
    // El texto original sigue ahí.
    expect(segByText(g, 'Nombre:').x).toBeCloseTo(72, 0);
  });
});

describe('documento: texto nuevo, watermark, links', () => {
  it('agrega texto nuevo que vuelve como segmento editable', async () => {
    const pdf = await makePdf();
    const { pdf: withText } = await addText(pdf, { page: 1, x: 72, y: 400, text: 'Parrafo nuevo agregado' });
    const g = await graphOf(withText);
    const seg = segByText(g, 'Parrafo nuevo agregado');
    expect(seg.x).toBeCloseTo(72, 0);
    // Y es editable: moverlo con el bake normal.
    const edit = editFor(g, 'Parrafo nuevo agregado', { x: 200 });
    const { pdf: baked, warnings } = await bakeSegmentEdits(withText, [edit]);
    expect(warnings).toEqual([]);
    expect(segByText(await graphOf(baked), 'Parrafo nuevo agregado').x).toBeCloseTo(200, 0);
  });

  it('elimina un segmento (remove)', async () => {
    const pdf = await makePdf();
    const g = await graphOf(pdf);
    const edit = editFor(g, 'Juan Perez', { remove: true });
    const { pdf: baked } = await bakeSegmentEdits(pdf, [edit]);
    const g2 = await graphOf(baked);
    expect(g2.segments.some(s => s.text === 'Juan Perez')).toBe(false);
    expect(segByText(g2, 'Nombre:').x).toBeCloseTo(72, 0);
  });

  it('watermark en todas las páginas', async () => {
    const pdf = await makePdf();
    const { pdf: wm } = await addWatermark(pdf, { text: 'BORRADOR' });
    const g = await graphOf(wm);
    expect(g.segments.some(s => s.text.includes('BORRADOR'))).toBe(true);
  });

  it('crea y elimina un link', async () => {
    const pdf = await makePdf();
    const { pdf: withLink } = await addLink(pdf, { page: 1, x: 72, y: 690, width: 120, height: 16, url: 'https://aldus.dev' });
    const g = await graphOf(withLink);
    expect(g.links).toHaveLength(1);
    expect(g.links[0].url).toContain('aldus.dev'); // pdf.js normaliza con barra final
    const { pdf: without, removed } = await removeLink(withLink, { page: 1, x: g.links[0].x, y: g.links[0].y, width: g.links[0].width, height: g.links[0].height });
    expect(removed).toBe(true);
    expect((await graphOf(without)).links).toHaveLength(0);
  });

  it('mueve y elimina un link como EDICIÓN (/Annots, mismo pipeline que widgets)', async () => {
    const pdf = await makePdf();
    const { pdf: withLink } = await addLink(pdf, { page: 1, x: 72, y: 690, width: 120, height: 16, url: 'https://aldus.dev' });
    const g = await graphOf(withLink);
    const link = g.links[0];
    // Mover: reescribe /Rect preservando la acción URI.
    const move = mergeLinkEdit(link, null, { x: link.x + 50, y: link.y - 30 });
    const { pdf: moved, applied } = await bakeSegmentEdits(withLink, [], [], [], [], [move!]);
    expect(applied.some(a => a.includes('link reubicado'))).toBe(true);
    const g2 = await graphOf(moved);
    expect(Math.round(g2.links[0].x)).toBe(Math.round(link.x + 50));
    expect(g2.links[0].url).toContain('aldus.dev');
    // Eliminar como edición.
    const del = mergeLinkEdit(g2.links[0], null, { remove: true });
    const { pdf: gone } = await bakeSegmentEdits(moved, [], [], [], [], [del!]);
    expect((await graphOf(gone)).links).toHaveLength(0);
  });

  it('el watermark queda EDITABLE: es texto del grafo y se puede eliminar', async () => {
    const pdf = await makePdf();
    const { pdf: withWm } = await addWatermark(pdf, { text: 'BORRADOR' });
    const g = await graphOf(withWm);
    const wm = g.segments.find(s => s.text.includes('BORRADOR'));
    expect(wm).toBeTruthy();
    const del = mergeSegmentEdit(wm!, null, { remove: true });
    const { pdf: clean, warnings } = await bakeSegmentEdits(withWm, [del!]);
    expect(warnings).toHaveLength(0);
    const g2 = await graphOf(clean);
    expect(g2.segments.some(s => s.text.includes('BORRADOR'))).toBe(false);
    // El resto del contenido sigue intacto.
    expect(g2.segments.some(s => s.text.includes('Juan Perez'))).toBe(true);
  });

  it('el SUBRAYADO sigue a su texto: mover lo reubica, eliminar lo extirpa', async () => {
    const decodeStreams = async (bytes: Uint8Array): Promise<Uint8Array> => {
      const doc = await PDFDocument.load(bytes.slice());
      const resolve = (o: unknown) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
      const raw = resolve(doc.getPages()[0].node.get(PDFName.of('Contents')));
      const streams = raw instanceof PDFArray
        ? [...Array(raw.size()).keys()].map(i => resolve(raw.get(i)) as PDFRawStream)
        : [raw as PDFRawStream];
      const parts = streams.map(s => decodePDFRawStream(s).decode());
      const out = new Uint8Array(parts.reduce((a, p) => a + p.length + 1, 0));
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; out[off++] = 0x0a; }
      return out;
    };
    const thinRects = async (bytes: Uint8Array) =>
      walkContent(await decodeStreams(bytes)).fillRects.filter(r => r.height <= 2);

    const pdf = await makePdf();
    const g = await graphOf(pdf);
    const seg = segByText(g, 'Juan Perez');
    // 1) Subrayar (los runs llevan underline + w medido).
    const e1 = mergeSegmentEdit(seg, null, {
      runs: [{ text: seg.text, bold: false, italic: false, underline: true, dx: 0, w: seg.width }],
    });
    const { pdf: withUl } = await bakeSegmentEdits(pdf, [e1!]);
    const rects1 = await thinRects(withUl);
    expect(rects1.length).toBe(1);
    expect(Math.abs(rects1[0].x - seg.x)).toBeLessThan(3);

    // 2) MOVER el texto subrayado → el rect viejo se va, aparece uno en la
    //    posición nueva (antes quedaba huérfano: "la línea fantasma").
    const g2 = await graphOf(withUl);
    const seg2 = segByText(g2, 'Juan Perez');
    const e2 = mergeSegmentEdit(seg2, null, { x: seg2.x + 100, baseline: seg2.baseline - 40 });
    const { pdf: moved } = await bakeSegmentEdits(withUl, [e2!]);
    const rects2 = await thinRects(moved);
    expect(rects2.length).toBe(1);
    expect(Math.abs(rects2[0].x - (seg2.x + 100))).toBeLessThan(3);
    expect(Math.abs(rects2[0].y - (seg2.baseline - 40 - seg2.fontSize * 0.11))).toBeLessThan(2);

    // 3) ELIMINAR el texto → el subrayado se va con él.
    const g3 = await graphOf(moved);
    const seg3 = segByText(g3, 'Juan Perez');
    const e3 = mergeSegmentEdit(seg3, null, { remove: true });
    const { pdf: gone } = await bakeSegmentEdits(moved, [e3!]);
    expect((await thinRects(gone)).length).toBe(0);
  });

  it('crea, mueve y elimina un resaltado (/Annots, capa aparte del contenido)', async () => {
    const pdf = await makePdf();
    // Crear: anotación /Highlight (no se quema en el content stream).
    const { pdf: withHl } = await addHighlight(pdf, { page: 1, x: 220, y: 698, width: 70, height: 14, color: '#33ccff' });
    const g = await graphOf(withHl);
    expect(g.highlights).toHaveLength(1);
    const hl = g.highlights[0];
    expect(hl.color.toLowerCase()).toBe('#33ccff'); // /C round-trip exacto
    expect(Math.round(hl.x)).toBe(219);              // spec.x - 1
    expect(Math.round(hl.width)).toBe(72);           // spec.width + 2

    // Mover: editarlo actualiza /Rect + /QuadPoints (sigue siendo un objeto).
    const edit = mergeHighlightEdit(hl, null, { x: hl.x + 40, y: hl.y - 100 });
    expect(edit).not.toBeNull();
    const { pdf: moved } = await bakeSegmentEdits(withHl, [], [], [], [edit!]);
    const g2 = await graphOf(moved);
    expect(g2.highlights).toHaveLength(1);
    expect(Math.round(g2.highlights[0].x)).toBe(Math.round(hl.x + 40));
    expect(Math.round(g2.highlights[0].y)).toBe(Math.round(hl.y - 100));

    // Eliminar: sale de /Annots.
    const del = mergeHighlightEdit(g2.highlights[0], null, { remove: true });
    const { pdf: gone } = await bakeSegmentEdits(moved, [], [], [], [del!]);
    expect((await graphOf(gone)).highlights).toHaveLength(0);
  });

  it('GLUE: mover un texto resaltado mueve texto Y resaltado juntos (mismo bake)', async () => {
    // El repro del editor: highlight guardado sobre un texto → refrescar →
    // mover el texto. El editor manda EN EL MISMO /bake el SegmentEdit (move)
    // y el HighlightEdit sincronizado (mismo delta). Ni el texto ni el
    // resaltado pueden desaparecer, y ambos quedan en la posición nueva.
    const pdf = await makePdf();
    const g0 = await graphOf(pdf);
    const seg0 = segByText(g0, 'Juan Perez');
    const { pdf: withHl } = await addHighlight(pdf, {
      page: 1, x: seg0.x, y: seg0.y, width: seg0.width, height: seg0.height, color: '#ffd400',
    });

    const g = await graphOf(withHl);
    const seg = segByText(g, 'Juan Perez');
    const hl = g.highlights[0];
    expect(hl).toBeDefined();

    const dx = 30, dy = -50; // delta del drag (PDF: y baja)
    const segEdit = mergeSegmentEdit(seg, null, { x: seg.x + dx, baseline: seg.baseline + dy });
    const hlEdit = mergeHighlightEdit(hl, null, { x: hl.x + dx, y: hl.y + dy });
    const r = await bakeSegmentEdits(withHl, [segEdit!], [], [], [hlEdit!]);
    expect(r.warnings).toEqual([]);

    const g2 = await graphOf(r.pdf);
    const seg2 = segByText(g2, 'Juan Perez'); // el texto SIGUE existiendo
    expect(seg2.x).toBeCloseTo(seg.x + dx, 0);
    expect(seg2.baseline).toBeCloseTo(seg.baseline + dy, 0);
    expect(g2.highlights).toHaveLength(1); // ni duplicado ni desaparecido
    expect(Math.round(g2.highlights[0].x)).toBe(Math.round(hl.x + dx));
    expect(Math.round(g2.highlights[0].y)).toBe(Math.round(hl.y + dy));
  });

  it('CLIP: mover un texto FUERA del clip lo re-emite al final del stream (no lo recorta)', async () => {
    // Repro del doc real: el contenido va dentro de `q <rect> W n … Q`. El
    // texto está en y=100 (dentro); movido a y=500 escapa el clip [40..240 en y].
    const clip: [number, number, number, number] = [40, 40, 300, 200];
    const pdf = await makeClippedPdf(clip);

    // El walk trackea el clip activo en cada show (nueva capacidad de textWalk).
    const shows0 = walkContent(await decodeStreams(pdf)).shows.filter(s => s.op === 'Tj');
    expect(shows0).toHaveLength(1);
    expect(shows0[0].clip).not.toBeNull();
    expect(shows0[0].clip!.y).toBeCloseTo(40, 0);
    expect(shows0[0].clip!.height).toBeCloseTo(200, 0);

    const g = await graphOf(pdf);
    const seg = segByText(g, 'Recortame');
    const nb = 500; // FUERA del clip (240 es el borde superior)
    const { pdf: moved, warnings } = await bakeSegmentEdits(pdf, [mergeSegmentEdit(seg, null, { baseline: nb })!]);
    expect(warnings).toEqual([]);

    // Re-walk: el show movido NO puede quedar recortado por el clip — se emite
    // al final (clip null) o dentro de un clip que sí lo contiene. Antes del
    // fix quedaba dentro del q…W n…Q original (clip 40..240) → invisible.
    const shows1 = walkContent(await decodeStreams(moved)).shows.filter(s => s.op === 'Tj');
    expect(shows1).toHaveLength(1);
    const m = shows1[0];
    expect(m.y).toBeCloseTo(nb, 0);
    const cropped = m.clip && (m.y < m.clip.y || m.y > m.clip.y + m.clip.height);
    expect(cropped).toBeFalsy();
  });
});

/** Concatena y decodifica los content streams de la página 1 (para walkContent). */
async function decodeStreams(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice());
  const resolve = (o: unknown) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const raw = resolve(doc.getPages()[0].node.get(PDFName.of('Contents')));
  const streams = raw instanceof PDFArray
    ? [...Array(raw.size()).keys()].map(i => resolve(raw.get(i)) as PDFRawStream)
    : [raw as PDFRawStream];
  const parts = streams.map(s => decodePDFRawStream(s).decode());
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length + 1, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; out[off++] = 0x0a; }
  return out;
}

describe('color al editar', () => {
  function streamText(doc: PDFDocument, obj: unknown): string {
    const s = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
    const bytes = decodePDFRawStream(s as PDFRawStream).decode();
    let out = ''; for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
  function pageStreams(pdf: Uint8Array): Promise<string> {
    return PDFDocument.load(pdf).then(doc => {
      const raw = doc.getPages()[0].node.get(PDFName.of('Contents'));
      if (raw instanceof PDFArray) {
        let s = ''; for (let i = 0; i < raw.size(); i++) s += streamText(doc, raw.get(i));
        return s;
      }
      return streamText(doc, raw);
    });
  }

  it('editar el TEXTO conserva el color original (fallback ya no pinta negro)', async () => {
    // Texto ROJO con fuente estándar → editar el contenido cae al fallback.
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 100]);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    page.drawText('Titulo', { x: 20, y: 60, size: 16, font, color: rgb(0.85, 0.1, 0.1) });
    const pdf = await doc.save();

    const g = await graphOf(pdf);
    const seg = g.segments.find(s => s.text.includes('Titulo'));
    if (!seg) throw new Error('segmento no encontrado');
    const edit = mergeSegmentEdit(seg, null, { text: 'Titulo Nuevo' });
    if (!edit) throw new Error('edición vacía');
    const { pdf: baked } = await bakeSegmentEdits(pdf, [edit]);

    const s = await pageStreams(baked);
    // El bloque del fallback debe emitir el rojo original (no "0 0 0 rg").
    expect(/0\.8[0-9]* 0\.[01][0-9]* 0\.[01][0-9]* rg/.test(s)).toBe(true);
    // El nuevo texto está.
    const g2 = await graphOf(baked);
    expect(g2.segments.some(x => x.text.includes('Titulo Nuevo'))).toBe(true);
  });

  it('solo mover NO cambia el color (path verbatim conserva todo)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 100]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Azul', { x: 20, y: 60, size: 14, font, color: rgb(0, 0, 0.9) });
    const pdf = await doc.save();
    const g = await graphOf(pdf);
    const seg = g.segments.find(s => s.text.includes('Azul'))!;
    const edit = mergeSegmentEdit(seg, null, { x: 100 })!;
    const { pdf: baked } = await bakeSegmentEdits(pdf, [edit]);
    const s = await pageStreams(baked);
    expect(/0 0 0\.9[0-9]* rg/.test(s)).toBe(true);
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

  it('un grafo con BREAKLINE (\\n): cada línea baja 1.2×size, misma x', async () => {
    const pdf = await makePdf();
    const g = await graphOf(pdf);
    const seg = segByText(g, 'Juan Perez');
    const edit = editFor(g, 'Juan Perez', { text: 'Juan Perez\nSegunda linea\nTercera' });
    const { pdf: baked } = await bakeSegmentEdits(pdf, [edit]);
    const g2 = await graphOf(baked);
    const l1 = segByText(g2, 'Juan Perez');
    const l2 = segByText(g2, 'Segunda linea');
    const l3 = segByText(g2, 'Tercera');
    expect(l1.baseline).toBeCloseTo(seg.baseline, 0);
    expect(l2.baseline).toBeCloseTo(seg.baseline - seg.fontSize * 1.2, 0);
    expect(l3.baseline).toBeCloseTo(seg.baseline - seg.fontSize * 2.4, 0);
    expect(l2.x).toBeCloseTo(l1.x, 0);
    expect(l3.x).toBeCloseTo(l1.x, 0);
  });
});
