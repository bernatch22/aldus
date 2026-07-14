/**
 * ledger.test.ts — EditSession como LEDGER de ediciones (sobre el EditLedger de
 * core, el MISMO contrato del editor UI: null = noop → revert).
 *
 * Incluye la REGRESIÓN descubierta en F1 (ver el it.skip): revertir un edit_text
 * al texto ORIGINAL deja una entrada zombie con el texto ANTERIOR y el bake la
 * re-aplica (bug de core/mergeSegmentEdit, no del agente).
 */
import { describe, expect, it } from 'vitest';
import { EditSession } from '../src/session/EditSession.js';
import { graphOf, pdfWith, textOf } from './helpers.js';

const simplePdf = () =>
  pdfWith([400, 300], (page, f) => {
    page.drawText('Cliente Acme Corp', { x: 50, y: 200, size: 12, font: f.regular });
    page.drawText('Monto: 1000 USD', { x: 50, y: 180, size: 12, font: f.regular });
  });

describe('EditSession — ledger de ediciones', () => {
  it('editText → getEdits refleja la edición (texto + runs + snapshot original)', async () => {
    const doc = await graphOf(await simplePdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('Acme'))!;
    const session = new EditSession(doc);
    await session.editText(seg.id, 'Cliente Beta Corp');

    const { edits } = session.getEdits();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.segmentId).toBe(seg.id);
    expect(edits[0]!.text).toBe('Cliente Beta Corp');
    expect(edits[0]!.runs?.map(r => r.text).join('')).toBe('Cliente Beta Corp');
    expect(edits[0]!.original.text).toBe('Cliente Acme Corp'); // snapshot para el locate por geometría
    expect(session.count).toBe(1);
  });

  // BUG (heredado de v1, NO arreglado — reportar, no tocar): mergeSegmentEdit
  // borra `runs` cuando el revert los deja idénticos al original (styledRunsEqual)
  // pero NO restaura `next.text` → el chequeo de noop nunca da null, la entrada
  // zombie {text:'Cliente Beta Corp', sin runs} sobrevive y el bake RE-APLICA el
  // texto viejo. Fix esperado en core/edit/mergeEdits.
  it.skip('editText de vuelta al texto ORIGINAL → la entrada se limpia (revert = null)', async () => {
    const doc = await graphOf(await simplePdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('Acme'))!;
    const session = new EditSession(doc);
    await session.editText(seg.id, 'Cliente Beta Corp');
    await session.editText(seg.id, 'Cliente Acme Corp'); // revert exacto

    expect(session.getEdits().edits).toHaveLength(0);
    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    expect(textOf(re)).toContain('Cliente Acme Corp');
    expect(textOf(re)).not.toContain('Beta');
  });

  it('seed() round-trip: las ediciones sembradas vuelven por getEdits y componen con nuevas', async () => {
    const doc = await graphOf(await simplePdf());
    const a = doc.pages[0]!.segments.find(s => s.text.includes('Acme'))!;
    const b = doc.pages[0]!.segments.find(s => s.text.includes('Monto'))!;

    // Sesión 1: una edición → getEdits (lo que el editor manda como pendientes).
    const s1 = new EditSession(doc);
    await s1.editText(a.id, 'Cliente Beta Corp');
    const pending = s1.getEdits();

    // Sesión 2 (turno nuevo): seed + una edición más.
    const s2 = new EditSession(doc);
    s2.seed(pending.edits, pending.imageEdits);
    expect(s2.getEdits().edits).toEqual(pending.edits); // round-trip exacto
    await s2.editText(b.id, 'Monto: 2000 USD');
    expect(s2.getEdits().edits.map(e => e.segmentId).sort()).toEqual([a.id, b.id].sort());

    // Y el bake aplica AMBAS.
    const { pdf } = await s2.bake();
    const re = await graphOf(pdf);
    expect(textOf(re)).toContain('Cliente Beta Corp');
    expect(textOf(re)).toContain('Monto: 2000 USD');
  });

  it('deleteText y su noop: merge devuelve entrada con remove; id inexistente no acumula', async () => {
    const doc = await graphOf(await simplePdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('Monto'))!;
    const session = new EditSession(doc);
    session.deleteText(seg.id);
    expect(session.getEdits().edits[0]?.remove).toBe(true);
    expect(session.deleteText('p9-noexiste')).toContain('⚠️');
    expect(session.count).toBe(1);
  });
});
