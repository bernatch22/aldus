/**
 * placeholders.test.ts — las defensas de placeholders_to_fields pagadas con
 * sangre (audit-agent §4), ahora VÍA la EditSession fachada sobre matchPlaceholders
 * de core (resuelve el TODO(F5)/it.skip que F1b dejó en placeholderMatch.test.ts).
 *
 *  1. guardrail XXXX: edit_text rechaza reescribir leaders con relleno (def #1)
 *  2. leader elástico + expansión + colocación directa (defs #2, #4, #7, #8)
 *  3. idempotencia: segunda llamada = ↩︎, creates no crece (def #7)
 *  4. barrido de leaders huérfanos: pasa 1, se crean 2 (def #5)
 *  5. placeholder mixto multi-línea con guion de corte Word: match único,
 *     label dropped, campo en la línea del run largo (defs #3, #6)
 */
import { describe, expect, it } from 'vitest';
import { StandardFonts, PDFDocument } from 'pdf-lib';
import { EditSession } from '../src/session/EditSession.js';
import { graphOf, pdfWith } from './helpers.js';

/** Contrato con leaders: una línea de puntos larga y otra con DOS runs. */
const leadersPdf = () =>
  pdfWith([500, 400], (page, f) => {
    page.drawText('NOMBRE: ..............................', { x: 60, y: 300, size: 11, font: f.regular });
    page.drawText('Fecha: .............. Lugar: ..............', { x: 60, y: 280, size: 11, font: f.regular });
  });

describe('placeholders_to_fields — defensas §4 del audit (vía EditSession)', () => {
  it('1. edit_text RECHAZA reescribir un placeholder de leaders con relleno (guardrail)', async () => {
    const doc = await graphOf(await leadersPdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('NOMBRE'))!;
    const session = new EditSession(doc);
    const msg = await session.editText(seg.id, 'NOMBRE: Juan Pérez');
    expect(msg).toContain('⚠️');
    expect(msg).toContain('placeholders_to_fields'); // redirige a la tool correcta
    expect(session.count).toBe(0); // no acumuló NADA
  });

  it('2. leader elástico + expansión: 5 puntos pasados → campo sobre el rect REAL del run (±2pt)', async () => {
    const doc = await graphOf(await leadersPdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('NOMBRE'))!;
    const session = new EditSession(doc);
    // El LLM jamás copia el conteo: pasa 5 puntos contra 30 reales.
    const msg = await session.placeholdersToFields(seg.id, [{ placeholder: '.....', name: 'nombre' }]);
    expect(msg).toContain('✓');
    expect(msg).toContain('sin reflow');

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    expect(re.pages[0]!.widgets).toHaveLength(1);
    const w = re.pages[0]!.widgets[0]!;
    expect(w.fieldName).toBe('nombre');

    // Ground truth por métricas Helvetica: los puntos arrancan tras "NOMBRE: ".
    const lib = await PDFDocument.create();
    const helv = await lib.embedFont(StandardFonts.Helvetica);
    const trueX0 = 60 + helv.widthOfTextAtSize('NOMBRE: ', 11);
    const trueW = helv.widthOfTextAtSize('.'.repeat(30), 11);
    expect(Math.abs(w.x - trueX0)).toBeLessThanOrEqual(2);
    expect(Math.abs(w.width - trueW)).toBeLessThanOrEqual(2);
    // El texto quedó INTACTO (colocación directa, cero reflow).
    expect(re.pages[0]!.segments.find(s => s.text.includes('NOMBRE'))!.text).toBe(seg.text);
  });

  it('3. idempotencia: segunda llamada idéntica → ↩︎ salteado y creates NO crece', async () => {
    const doc = await graphOf(await leadersPdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('NOMBRE'))!;
    const session = new EditSession(doc);
    const first = await session.placeholdersToFields(seg.id, [{ placeholder: '.....', name: 'nombre' }]);
    expect(first).toContain('✓');
    const countAfterFirst = session.count;

    const second = await session.placeholdersToFields(seg.id, [{ placeholder: '.....', name: 'nombre' }]);
    expect(second).toContain('↩︎');
    expect(second).toContain('No repitas');
    expect(session.count).toBe(countAfterFirst);

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    expect(re.pages[0]!.widgets).toHaveLength(1); // un solo campo, no dos
  });

  it('4. barrido: párrafo con DOS runs de leaders, se pasa UNO → se crean DOS campos', async () => {
    const doc = await graphOf(await leadersPdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('Fecha'))!;
    const session = new EditSession(doc);
    const msg = await session.placeholdersToFields(seg.id, [{ placeholder: '.....', name: 'fecha' }]);
    expect(msg).toContain('2 campo(s)');

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    const widgets = [...re.pages[0]!.widgets].sort((a, b) => a.x - b.x);
    expect(widgets).toHaveLength(2);
    expect(widgets[0]!.fieldName).toBe('fecha');      // el nombrado por el LLM
    expect(widgets[1]!.fieldName).toMatch(/^campo_/); // el huérfano, auto-nombrado
    // Los dos sobre la MISMA línea (baseline 280 → y = baseline − 2, rect exacto ±1).
    for (const w of widgets) expect(Math.abs(w.y - 278)).toBeLessThanOrEqual(1);
  });

  it('5. placeholder mixto multi-línea "..... [company legal name]" con guion Word → match único, label dropped', async () => {
    const bytes = await pdfWith([500, 400], (page, f) => {
      page.drawText('entered into by and between ........................... [company le-', { x: 60, y: 300, size: 10, font: f.regular });
      page.drawText('gal name], a company duly incorporated under the laws.', { x: 60, y: 287, size: 10, font: f.regular });
    });
    const doc = await graphOf(bytes);
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('between'))!;
    const session = new EditSession(doc);
    const msg = await session.placeholdersToFields(seg.id, [
      { placeholder: '..... [company legal name]', name: 'company_legal_name' },
    ]);
    expect(msg).toContain('✓');
    expect(msg).toContain('1 campo(s)'); // UN solo match — el label no genera un segundo campo

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    expect(re.pages[0]!.widgets).toHaveLength(1);
    const w = re.pages[0]!.widgets[0]!;
    expect(w.fieldName).toBe('company_legal_name');
    // El campo cae en la LÍNEA del run largo de leaders (la primera, baseline 300).
    expect(Math.abs(w.y - (300 - 2))).toBeLessThanOrEqual(1);
    // …y arranca donde arrancan los puntos (ground truth Helvetica, ±10pt:
    // charXOf estima por pesos de clase de glifo, no por métricas exactas).
    const lib = await PDFDocument.create();
    const helv = await lib.embedFont(StandardFonts.Helvetica);
    const trueX0 = 60 + helv.widthOfTextAtSize('entered into by and between ', 10);
    expect(Math.abs(w.x - trueX0)).toBeLessThanOrEqual(10);
    // El texto (incluido el label partido con guion) quedó intacto en la página.
    expect(re.pages[0]!.segments.map(s => s.text).join('\n')).toContain('[company le-');
  });
});
