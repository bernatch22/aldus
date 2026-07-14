/**
 * pipeline.test.ts — integración REAL del pipeline del agente, sin mocks:
 * PDF real (armado con pdf-lib) → grafo (pdf.js legacy + @aldus/core) →
 * serialización → EditSession → bake (@aldus/core) → re-extracción → asserts.
 *
 * Es determinístico y no toca la red ni el LLM. El turno CON LLM va aparte,
 * opt-in (ver el describe.skipIf del final).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { graphFromBytes } from '../src/graph.js';
import { serializeDoc } from '../src/llm/serialize.js';
import { EditSession } from '../src/session/EditSession.js';
import { runTurn } from '../src/llm/runTurn.js';

// PNG 1×1 rojo.
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Un PDF chico y conocido: dos textos + una imagen. */
async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('CONTRATO DE PRUEBA', { x: 50, y: 250, size: 20, font });
  page.drawText('Cliente Acme Corp', { x: 50, y: 210, size: 12, font });
  const png = await doc.embedPng(RED_PNG);
  page.drawImage(png, { x: 300, y: 240, width: 40, height: 40 });
  return doc.save();
}

const textOf = (doc: Awaited<ReturnType<typeof graphFromBytes>>) =>
  doc.pages[0]!.segments.map(s => s.text).join(' ');

describe('agent pipeline (integración real, sin LLM)', () => {
  it('extrae el grafo con los textos y la imagen', async () => {
    const doc = await graphFromBytes(await makePdf());
    expect(doc.pages).toHaveLength(1);
    expect(textOf(doc)).toContain('CONTRATO DE PRUEBA');
    expect(doc.pages[0]!.images).toHaveLength(1);
  });

  it('serializeDoc incluye el texto y el id del nodo', async () => {
    const doc = await graphFromBytes(await makePdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('CONTRATO'))!;
    const ser = serializeDoc(doc);
    expect(ser).toContain('CONTRATO DE PRUEBA');
    expect(ser).toContain(seg.id);
    expect(ser).toContain(doc.pages[0]!.images[0]!.id);
  });

  it('editText → bake → re-extrae con el texto NUEVO', async () => {
    const doc = await graphFromBytes(await makePdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('CONTRATO'))!;
    const session = new EditSession(doc);
    expect(await session.editText(seg.id, 'CONTRATO FIRMADO')).toContain('✓');
    expect(session.count).toBe(1);

    const { pdf, applied } = await session.bake();
    expect(applied.some(a => a.includes(seg.id))).toBe(true);

    const re = await graphFromBytes(pdf);
    expect(textOf(re)).toContain('CONTRATO FIRMADO');
    expect(textOf(re)).not.toContain('CONTRATO DE PRUEBA');
  });

  it('moveImage → bake → la imagen queda en la posición nueva', async () => {
    const doc = await graphFromBytes(await makePdf());
    const img = doc.pages[0]!.images[0]!;
    const session = new EditSession(doc);
    session.moveImage(img.id, { x: img.x - 100 });

    const { pdf } = await session.bake();
    const re = await graphFromBytes(pdf);
    expect(re.pages[0]!.images).toHaveLength(1);
    expect(re.pages[0]!.images[0]!.x).toBeCloseTo(img.x - 100, 0);
  });

  it('un id inexistente NO rompe: devuelve aviso y no acumula edición', async () => {
    const doc = await graphFromBytes(await makePdf());
    const session = new EditSession(doc);
    expect(await session.editText('p1-noexiste', 'x')).toContain('⚠️');
    expect(session.count).toBe(0);
  });

  it('seed + getEdits: continúa desde ediciones existentes (multi-turno)', async () => {
    const doc = await graphFromBytes(await makePdf());
    const segs = doc.pages[0]!.segments;
    const a = segs.find(s => s.text.includes('CONTRATO'))!;
    const b = segs.find(s => s.text.includes('Acme'))!;
    const session = new EditSession(doc);
    // seed: una edición previa (como el editor manda sus pendientes).
    session.seed(
      [{ segmentId: a.id, page: 1, text: 'X', original: { text: a.text, x: a.x, baseline: a.baseline, width: a.width, fontSize: a.fontSize } }],
      [],
    );
    await session.editText(b.id, 'Segundo cambio');
    const out = session.getEdits();
    expect(out.edits.map(e => e.segmentId).sort()).toEqual([a.id, b.id].sort());
  });
});

// ── Turno CON LLM (real, opt-in) ──
// Requiere la SUSCRIPCIÓN de Claude Code: correr con
//   env -u ANTHROPIC_API_KEY ALDUS_LLM_TEST=1 pnpm --filter @aldus/agent test
const LLM = process.env.ALDUS_LLM_TEST === '1';
describe.skipIf(!LLM)('agent LLM (integración real, requiere suscripción)', () => {
  it('edita el texto que se le pide', async () => {
    const doc = await graphFromBytes(await makePdf());
    const session = new EditSession(doc);
    const { toolCalls } = await runTurn({
      doc, session,
      prompt: 'Cambiá el texto "CONTRATO DE PRUEBA" por "ACUERDO FINAL".',
    });
    expect(toolCalls).toBeGreaterThan(0);
    const out = session.getEdits();
    expect(out.edits.length).toBeGreaterThan(0);
    const { pdf } = await session.bake();
    const re = await graphFromBytes(pdf);
    expect(textOf(re)).toContain('ACUERDO');
  }, 90_000);
});
