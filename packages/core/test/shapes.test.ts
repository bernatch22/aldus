/**
 * shapes.test.ts — el pipeline completo de formas vectoriales (SIN NINGÚN test
 * hasta ahora, riesgo #6 del audit):
 *
 *  - extract: un rect relleno grande (banner) sale como ShapeNode.
 *  - ShapeEdit move/resize → re-extract muestra el rect movido (in-place,
 *    color intacto).
 *  - remove → desaparece.
 *  - matchRect (nearest con tolerancia TOL×4 manhattan): via
 *    applyShapeEditsToPage con FillRectOps sintéticos (la función es privada).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mergeShapeEdit } from '../src/index.js';
import { bakeSegmentEdits } from '../src/bake/index.js';
import { ShapeEditApplier } from '../src/bake/appliers/shapeApplier.js';
import { PageBakeContext } from '../src/bake/context.js';
import type { AnyEdit } from '../src/model/edits.js';
import type { FillRectOp } from '../src/pdf/contentWalk.js';
import type { Splice } from '../src/pdf/splice.js';
import { BakeReport } from '../src/bake/report.js';
import { graphOf, segByText } from './helpers.js';

/** Corre el ShapeEditApplier con un PageBakeContext mínimo (solo lo que lee:
 *  splices, report, usedFillRects, walk.fillRects) — reemplaza el
 *  applyShapeEditsToPage({bag}) posicional de v1. */
function runShapeApplier(
  pageShapeEdits: Array<{ shapeId: string; page: number; remove?: boolean; original: { x: number; y: number; width: number; height: number } }>,
  fillRects: FillRectOp[],
  splices: Splice[],
  report: BakeReport,
): void {
  const ctx = { splices, report, usedFillRects: new Set<FillRectOp>(), walk: { fillRects } } as unknown as PageBakeContext;
  new ShapeEditApplier().apply(pageShapeEdits.map(e => ({ kind: 'shape', ...e }) as AnyEdit), ctx);
}

async function makeBannerPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 100, y: 600, width: 200, height: 50, color: rgb(0.2, 0.4, 0.8) });
  page.drawText('Texto vecino', { x: 100, y: 500, size: 12, font: helv });
  return doc.save();
}

describe('shapes — extract + bake', () => {
  it('extract ve el banner como ShapeNode con su rect', async () => {
    const g = await graphOf(await makeBannerPdf());
    expect(g.shapes).toHaveLength(1);
    const s = g.shapes[0];
    expect(s.x).toBeCloseTo(100, 0);
    expect(s.y).toBeCloseTo(600, 0);
    expect(s.width).toBeCloseTo(200, 0);
    expect(s.height).toBeCloseTo(50, 0);
  });

  it('ShapeEdit move/resize → re-extract muestra el rect movido; el texto no se toca', async () => {
    const pdf = await makeBannerPdf();
    const g = await graphOf(pdf);
    const s = g.shapes[0];
    const edit = mergeShapeEdit(s, null, { x: 150, y: 450, width: 120, height: 30 });
    const { pdf: baked, applied, warnings } = await bakeSegmentEdits(pdf, [], [], [], [], [], [edit!]);
    expect(warnings).toEqual([]);
    expect(applied.some(a => a.includes('movida/redimensionada'))).toBe(true);

    const g2 = await graphOf(baked);
    expect(g2.shapes).toHaveLength(1);
    expect(g2.shapes[0].x).toBeCloseTo(150, 0);
    expect(g2.shapes[0].y).toBeCloseTo(450, 0);
    expect(g2.shapes[0].width).toBeCloseTo(120, 0);
    expect(g2.shapes[0].height).toBeCloseTo(30, 0);
    expect(segByText(g2, 'Texto vecino').x).toBeCloseTo(100, 0);
  });

  it('ShapeEdit remove → la forma desaparece', async () => {
    const pdf = await makeBannerPdf();
    const g = await graphOf(pdf);
    const edit = mergeShapeEdit(g.shapes[0], null, { remove: true });
    const { pdf: baked, applied } = await bakeSegmentEdits(pdf, [], [], [], [], [], [edit!]);
    expect(applied.some(a => a.includes('eliminada'))).toBe(true);
    const g2 = await graphOf(baked);
    expect(g2.shapes).toHaveLength(0);
    expect(segByText(g2, 'Texto vecino').x).toBeCloseTo(100, 0);
  });
});

describe('matchRect (via applyShapeEditsToPage con fillRects sintéticos)', () => {
  const rect = (start: number, x: number, y: number, w = 200, h = 50): FillRectOp =>
    ({ start, end: start + 10, x, y, width: w, height: h, fillColorRaw: '1 0 0 rg', ctm: [1, 0, 0, 1, 0, 0] });
  const edit = (original: { x: number; y: number; width: number; height: number }) => ({
    shapeId: 'p1-shape0', page: 1, remove: true, original,
  });

  it('matchea el más CERCANO dentro de la tolerancia (manhattan ≤ 8)', () => {
    const r1 = rect(0, 100, 600);
    const r2 = rect(50, 300, 600);
    const splices: Splice[] = [];
    const report = new BakeReport();
    // Original a 3pt de r2 y lejísimos de r1 → gana r2.
    runShapeApplier([edit({ x: 303, y: 600, width: 200, height: 50 })], [r1, r2], splices, report);
    expect(splices).toHaveLength(1);
    expect(splices[0].start).toBe(50);
    expect(report.finish(new Uint8Array()).warnings).toEqual([]);
  });

  it('fuera de tolerancia → warning y NO toca nada (nunca adivinar)', () => {
    const splices: Splice[] = [];
    const report = new BakeReport();
    runShapeApplier([edit({ x: 120, y: 600, width: 200, height: 50 })], [rect(0, 100, 600)], splices, report);
    expect(splices).toHaveLength(0);
    const { warnings } = report.finish(new Uint8Array());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no se encontró la forma');
  });

  it('cada rect se usa UNA vez (dos edits no colapsan al mismo op)', () => {
    const r1 = rect(0, 100, 600);
    const r2 = rect(50, 102, 600); // casi gemelo
    const splices: Splice[] = [];
    const report = new BakeReport();
    runShapeApplier(
      [
        edit({ x: 100, y: 600, width: 200, height: 50 }),
        edit({ x: 102, y: 600, width: 200, height: 50 }),
      ],
      [r1, r2], splices, report,
    );
    expect(splices.map(s => s.start).sort((a, b) => a - b)).toEqual([0, 50]);
  });
});
