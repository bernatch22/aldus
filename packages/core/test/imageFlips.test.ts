/**
 * imageFlips.test.ts — mover una imagen con matriz ESPEJADA (a negativo)
 * preserva el flip (src/bake/images.ts: "the sign of a/d is kept; the bbox
 * anchor is corrected when the scale is negative"). Riesgo #6 del audit
 * (flips SIN test).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { walkContent } from '../src/pdf/contentWalk.js';
import { bakeSegmentEdits } from '../src/bake/index.js';
import { decodeStreams, graphOf } from './helpers.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Imagen espejada horizontalmente: `cm` con a = -120 (bbox 100..220 × 500..580). */
async function makeFlippedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const png = await doc.embedPng(Buffer.from(PNG_1PX, 'base64'));
  // Registra el XObject en los Resources de la página.
  page.drawImage(png, { x: 0, y: 0, width: 1, height: 1 });
  const xobjs = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const name = xobjs.keys()[0].asString().slice(1);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(
    `q -120 0 0 80 220 500 cm /${name} Do Q`,
  )));
  return doc.save();
}

describe('imagen espejada (a negativo)', () => {
  it('extract da el bbox normalizado, sin marcar rotación', async () => {
    const g = await graphOf(await makeFlippedPdf());
    expect(g.images).toHaveLength(1);
    const img = g.images[0];
    expect(img.x).toBeCloseTo(100, 0);
    expect(img.y).toBeCloseTo(500, 0);
    expect(img.width).toBeCloseTo(120, 0);
    expect(img.height).toBeCloseTo(80, 0);
    expect(img.rotated).toBe(false);
  });

  it('move preserva el flip: el bbox se mueve, la matriz sigue con a NEGATIVO', async () => {
    const pdf = await makeFlippedPdf();
    const g = await graphOf(pdf);
    const img = g.images[0];
    const { pdf: baked, warnings } = await bakeSegmentEdits(pdf, [], [{
      imageId: img.id, page: 1, x: 300, y: 400,
      original: { x: img.x, y: img.y, width: img.width, height: img.height },
    }]);
    expect(warnings).toEqual([]);

    // Re-extract: bbox movido, dimensiones y orientación intactas.
    const g2 = await graphOf(baked);
    expect(g2.images).toHaveLength(1);
    expect(g2.images[0].x).toBeCloseTo(300, 0);
    expect(g2.images[0].y).toBeCloseTo(400, 0);
    expect(g2.images[0].width).toBeCloseTo(120, 0);
    expect(g2.images[0].height).toBeCloseTo(80, 0);
    expect(g2.images[0].rotated).toBe(false);

    // Y el stream horneado conserva el ESPEJO: matriz absoluta con a < 0.
    const walk = walkContent(await decodeStreams(baked));
    expect(walk.xobjects).toHaveLength(1);
    const m = walk.xobjects[0].matrix;
    expect(m[0]).toBeCloseTo(-120, 1);
    expect(m[3]).toBeCloseTo(80, 1);
    // e corregido por el ancla del flip: x - min(0, a) = 300 + 120.
    expect(m[4]).toBeCloseTo(420, 1);
    expect(m[5]).toBeCloseTo(400, 1);
  });

  it('escalar una imagen espejada mantiene el signo', async () => {
    const pdf = await makeFlippedPdf();
    const g = await graphOf(pdf);
    const img = g.images[0];
    const { pdf: baked, warnings } = await bakeSegmentEdits(pdf, [], [{
      imageId: img.id, page: 1, x: 100, y: 500, width: 60, height: 40,
      original: { x: img.x, y: img.y, width: img.width, height: img.height },
    }]);
    expect(warnings).toEqual([]);
    const g2 = await graphOf(baked);
    expect(g2.images[0].width).toBeCloseTo(60, 0);
    expect(g2.images[0].height).toBeCloseTo(40, 0);
    const m = walkContent(await decodeStreams(baked)).xobjects[0].matrix;
    expect(m[0]).toBeCloseTo(-60, 1);
  });
});
