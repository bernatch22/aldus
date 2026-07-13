/**
 * editLedger.test.ts — el EditLedger (F4): patch→revert→snapshot vacío, restore
 * (Memento), toBakeInput con promoteMovedImages, y EL BUG ZOMBIE AHORA VERDE.
 *
 * El caso zombie es el assert del `it.skip` de v1 (agent/test/ledger.test.ts)
 * SIN el skip: revertir un edit_text al texto ORIGINAL deja —en v1— una entrada
 * con el texto ANTERIOR ("Beta") y el bake lo re-emite. El fix vive en
 * mergeSegmentEdit (sincroniza next.text al borrar runs por igualdad).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EditLedger } from './editLedger.js';
import { applyTextDiff, originalStyledRuns } from '../index.js';
import type { ImageNode } from '../model/nodes.js';
import { bake } from '../bake/index.js';
import { graphOf } from '../../test/helpers.js';

const simplePdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Cliente Acme Corp', { x: 50, y: 200, size: 12, font: f });
  page.drawText('Monto: 1000 USD', { x: 50, y: 180, size: 12, font: f });
  return doc.save();
};

const img = (over: Partial<ImageNode> = {}): ImageNode => ({
  id: 'p1-img0', kind: 'image', page: 1, x: 40, y: 40, width: 100, height: 60, rotated: false, ...over,
});

describe('EditLedger — patch / revert / Memento', () => {
  it('patchSegment acumula; revert al ORIGINAL limpia la entrada (snapshot vacío)', async () => {
    const g = await graphOf(await simplePdf());
    const seg = g.segments.find(s => s.text.includes('Acme'))!;
    const ledger = new EditLedger();
    const orig = originalStyledRuns(seg);

    ledger.patchSegment(seg, { runs: applyTextDiff(orig, 'Cliente Beta Corp') });
    expect(ledger.size).toBe(1);
    expect(ledger.segmentEdit(seg.id)?.text).toBe('Cliente Beta Corp');

    // revert EXACTO al original → la entrada se limpia (merge devuelve null).
    ledger.patchSegment(seg, { runs: applyTextDiff(orig, seg.text) });
    expect(ledger.size).toBe(0);
    expect(ledger.isEmpty).toBe(true);
  });

  it('BUG ZOMBIE — revertir al texto original NO deja "Beta" en el PDF (fix verde)', async () => {
    const bytes = await simplePdf();
    const g = await graphOf(bytes);
    const seg = g.segments.find(s => s.text.includes('Acme'))!;
    const ledger = new EditLedger();
    const orig = originalStyledRuns(seg);

    ledger.patchSegment(seg, { runs: applyTextDiff(orig, 'Cliente Beta Corp') });
    ledger.patchSegment(seg, { runs: applyTextDiff(orig, seg.text) }); // revert exacto

    expect(ledger.toBakeInput()).toHaveLength(0); // sin entrada zombie
    const { pdf } = await bake(bytes.slice(), ledger.toBakeInput());
    const re = await graphOf(pdf);
    const text = re.segments.map(s => s.text).join(' ');
    expect(text).toContain('Cliente Acme Corp'); // v1 (bug): decía "Beta"
    expect(text).not.toContain('Beta');
  });

  it('snapshot()/restore() = Memento (abort+restore de un ledger sucio)', () => {
    const ledger = new EditLedger();
    const clean = ledger.snapshot();
    ledger.patchRect(img(), { x: 60, y: 55 });
    expect(ledger.size).toBe(1);
    ledger.restore(clean); // vuelve al estado limpio
    expect(ledger.isEmpty).toBe(true);

    // Y al revés: una edición congelada se puede re-aplicar.
    ledger.patchRect(img(), { x: 60 });
    const dirty = ledger.snapshot();
    ledger.clear();
    expect(ledger.isEmpty).toBe(true);
    ledger.restore(dirty);
    expect(ledger.size).toBe(1);
  });

  it('onDidChange se dispara en cada mutación', () => {
    const ledger = new EditLedger();
    let fired = 0;
    ledger.onDidChange(() => fired++);
    ledger.patchRect(img(), { x: 60 });
    ledger.revert(img());
    ledger.clear();
    expect(fired).toBe(3);
  });
});

describe('EditLedger — toBakeInput', () => {
  it('promoteMovedImages ADENTRO: imagen movida sin zOrder → "front"', () => {
    const ledger = new EditLedger();
    ledger.patchRect(img(), { x: 200 }); // movida, sin zOrder explícito
    const input = ledger.toBakeInput();
    const image = input.find(e => e.kind === 'image');
    expect(image).toBeDefined();
    expect((image as { zOrder?: string }).zOrder).toBe('front');
  });

  it('imagen SOLO borrada NO se promueve a front', () => {
    const ledger = new EditLedger();
    ledger.patchRect(img(), { remove: true });
    const image = ledger.toBakeInput().find(e => e.kind === 'image');
    expect((image as { zOrder?: string }).zOrder).toBeUndefined();
  });

  it('agrupa por kind con `kind` explícito para el despacho del bake', async () => {
    const g = await graphOf(await simplePdf());
    const seg = g.segments.find(s => s.text.includes('Monto'))!;
    const ledger = new EditLedger();
    ledger.patchSegment(seg, { remove: true });
    ledger.patchRect(img(), { x: 200 });
    const kinds = ledger.toBakeInput().map(e => e.kind).sort();
    expect(kinds).toEqual(['image', 'segment']);
  });
});
