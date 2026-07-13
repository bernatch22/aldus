/**
 * bakeStructure.test.ts — tests ESTRUCTURALES nuevos de la arquitectura F3
 * (audit §3.2): el contrato IEditApplier (probing + orden de fases) y el
 * registry ICreateOp. No prueban geometría (eso lo hace bake.test.ts) sino la
 * MECÁNICA de extensión: un edit de kind desconocido no rompe, la fase
 * 'document' corre antes que la 'page', y una capacidad de creación se resuelve
 * por su kind en el registry.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { bake, defaultEditAppliers, defaultCreateOps, BakeCodes } from '../src/bake/index.js';
import type { AnyEdit } from '../src/index.js';
import type { IEditApplier } from '../src/bake/appliers/types.js';
import type { DocBakeContext, PageBakeContext } from '../src/bake/context.js';

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Hola', { x: 72, y: 700, size: 12, font: helv });
  return doc.save();
}

describe('IEditApplier — probing', () => {
  it('un edit de kind DESCONOCIDO: nadie lo reclama → warning UnclaimedEdit, NO throw', async () => {
    const pdf = await makePdf();
    // Un edit con un kind fuera de la unión (simula un tipo nuevo sin applier).
    const bogus = { kind: 'sticker', stickerId: 'x1', page: 1 } as unknown as AnyEdit;
    const r = await bake(pdf, [bogus]);
    expect(r.warnings.some(w => w.includes('ningún applier'))).toBe(true);
    expect(r.events.some(e => e.code === BakeCodes.UnclaimedEdit)).toBe(true);
    // El PDF sobrevive intacto (lo que no se entiende, no se toca).
    expect(r.pdf.length).toBeGreaterThan(0);
  });

  it('defaultEditAppliers: 3 document + 3 page, en ese orden de bind', () => {
    const appliers = defaultEditAppliers();
    expect(appliers.map(a => a.phase)).toEqual(['document', 'document', 'document', 'page', 'page', 'page']);
  });
});

describe('IEditApplier — orden document→page', () => {
  it('la fase document corre ENTERA antes que la primera fase page', async () => {
    const pdf = await makePdf();
    const order: string[] = [];
    const spy = (phase: 'document' | 'page', tag: string): IEditApplier => ({
      phase,
      canHandle: () => true,
      apply: (_edits: AnyEdit[], _ctx: DocBakeContext | PageBakeContext) => { order.push(`${phase}:${tag}`); },
    });
    // Un solo edit page-phase para que exista una página que procesar.
    const edit = { kind: 'shape', shapeId: 's', page: 1, remove: true, original: { x: 0, y: 0, width: 1, height: 1 } } as AnyEdit;
    await bake(pdf, [edit], { appliers: [spy('page', 'P'), spy('document', 'D')] });
    // Aunque el applier document se registró SEGUNDO, corre primero.
    expect(order).toEqual(['document:D', 'page:P']);
  });
});

describe('ICreateOp — registry lookup por kind', () => {
  it('cada capacidad de creación se resuelve por su kind (sin switch a mano)', () => {
    const ops = defaultCreateOps();
    const kinds = ops.map(o => o.kind);
    for (const k of ['addFormField', 'addText', 'addWatermark', 'addHighlight', 'addLink', 'insertImage']) {
      expect(kinds).toContain(k);
    }
    // El lookup por kind es único y devuelve un op con run().
    const addText = ops.find(o => o.kind === 'addText');
    expect(typeof addText?.run).toBe('function');
  });
});
