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

/** ¿El widget PISA algún run de texto de su renglón? (modo rewrite: los campos
 *  van sobre GAPS en blanco acotados por los runs vecinos — jamás tapan texto). */
const overlapsText = (page: Awaited<ReturnType<typeof graphOf>>['pages'][0], w: { x: number; y: number; width: number }): boolean =>
  page.segments.flatMap(s => s.runs).some(r =>
    Math.abs(r.baseline - (w.y + 2)) < 5 && r.x < w.x + w.width - 1 && r.x + r.width > w.x + 1);

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

  it('1b. replace_paragraph TAMBIÉN rechaza "convertir" placeholders a etiquetas (escape visto en Sonnet)', async () => {
    const bytes = await pdfWith([500, 400], (page, f) => {
      page.drawText('regirá desde el XX de XXXXXX de XXXX en adelante.', { x: 60, y: 300, size: 11, font: f.regular });
    });
    const doc = await graphOf(bytes);
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('regirá'))!;
    const session = new EditSession(doc);
    // El modelo intenta reescribir el párrafo con etiquetas "[Día inicio]" — parece
    // un hueco pero NO es un campo. Debe rebotar y redirigir a placeholders_to_fields.
    const msg = await session.replaceParagraph(seg.id, 'regirá desde el [Día inicio] de [Mes inicio] de [Año inicio] en adelante.');
    expect(msg).toContain('⚠️');
    expect(msg).toContain('placeholders_to_fields');
    expect(session.count).toBe(0); // no acumuló NADA
  });

  it('6. relleno XXXX → se REESCRIBE como hueco EN BLANCO (las X desaparecen) y el campo NO pisa texto', async () => {
    const bytes = await pdfWith([500, 400], (page, f) => {
      page.drawText('regirá desde el XX de XXXXXX de XXXX en adelante.', { x: 60, y: 300, size: 11, font: f.regular });
      page.drawText('Texto inferior que puede correrse.', { x: 60, y: 280, size: 11, font: f.regular });
    });
    const doc = await graphOf(bytes);
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('regirá'))!;
    const session = new EditSession(doc);
    const msg = await session.placeholdersToFields(seg.id, [
      { placeholder: 'XX', name: 'dia' },
      { placeholder: 'XXXXXX', name: 'mes' },
      { placeholder: 'XXXX', name: 'anio' },
    ]);
    expect(msg).toContain('✓');
    expect(msg).toContain('reescritos');

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    const text = re.pages[0]!.segments.map(s => s.text).join(' ');
    expect(text).not.toMatch(/XX/);         // el relleno DESAPARECIÓ del documento
    expect(text).toContain('en adelante.'); // el resto del párrafo sobrevive

    // 3 campos EN BLANCO: ancho ÚTIL (ya no el del "XX" impreso ~12pt) y
    // NINGUNO pisa texto (van sobre gaps acotados por los runs vecinos).
    const widgets = [...re.pages[0]!.widgets].sort((a, b) => a.x - b.x);
    expect(widgets).toHaveLength(3);
    for (const w of widgets) {
      expect(w.width).toBeGreaterThanOrEqual(20);
      expect(overlapsText(re.pages[0]!, w)).toBe(false);
    }

    // Anti-recall: una SEGUNDA llamada sobre el párrafo ya reescrito devuelve ↩︎.
    const second = await session.placeholdersToFields(seg.id, [{ placeholder: 'XX', name: 'dia' }]);
    expect(second).toContain('↩︎');
    expect(re.pages[0]!.widgets).toHaveLength(3);
  });

  it('7. split defensivo vía sesión: la FRASE como UN field → 3 campos, los "de" sobreviven', async () => {
    const bytes = await pdfWith([500, 400], (page, f) => {
      page.drawText('regirá desde el XX de XXXXXX de XXXX en adelante.', { x: 60, y: 300, size: 11, font: f.regular });
      page.drawText('Texto inferior que puede correrse.', { x: 60, y: 280, size: 11, font: f.regular });
    });
    const doc = await graphOf(bytes);
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('regirá'))!;
    const session = new EditSession(doc);
    const msg = await session.placeholdersToFields(seg.id, [
      { placeholder: 'XX de XXXXXX de XXXX', name: 'fecha_inicio' },
    ]);
    expect(msg).toContain('✓');

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    const text = re.pages[0]!.segments.map(s => s.text).join(' ').replace(/\n/g, ' ');
    expect(text).not.toMatch(/XX/);
    // las palabras del medio se CONSERVAN (un solo hueco gigante se las tragaría)
    expect(text.split(/\s+/).filter(w => w === 'de').length).toBeGreaterThanOrEqual(2);
    expect(re.pages[0]!.widgets).toHaveLength(3); // un campo POR RUN, no uno gigante
    const names = re.pages[0]!.widgets.map(w => w.fieldName).sort();
    expect(names).toEqual(['fecha_inicio', 'fecha_inicio_2', 'fecha_inicio_3']);
    for (const w of re.pages[0]!.widgets) expect(overlapsText(re.pages[0]!, w)).toBe(false);
  });

  it('9. campos PENDIENTES son operables: fill/move/delete por nombre antes del bake (Sonnet los buscaba y no existían)', async () => {
    const bytes = await pdfWith([500, 400], (page, f) => {
      page.drawText('NOMBRE: ..............................', { x: 60, y: 300, size: 11, font: f.regular });
      page.drawText('Fecha: .............. Lugar: ..............', { x: 60, y: 280, size: 11, font: f.regular });
    });
    const doc = await graphOf(bytes);
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('NOMBRE'))!;
    const session = new EditSession(doc);
    await session.placeholdersToFields(seg.id, [{ placeholder: '.....', name: 'nombre' }]);

    // fill sobre el campo PENDIENTE (aún no horneado) → el bake escribe el valor.
    expect(session.fillField('nombre', 'Acme S.A.')).toContain('✓');
    // mover el pendiente → muta el create.
    expect(session.moveField('nombre', undefined, 250)).toContain('✓');
    // un nombre inexistente lista los DISPONIBLES (feedback accionable, no "no existe" seco).
    const miss = session.fillField('fantasma', 'x');
    expect(miss).toContain('⚠️');
    expect(miss).toContain('nombre'); // el disponible aparece en el mensaje

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    const w = re.pages[0]!.widgets.find(x => x.fieldName === 'nombre')!;
    expect(w.value).toBe('Acme S.A.');          // el fill llegó al PDF
    expect(Math.abs(w.y - 250)).toBeLessThanOrEqual(1); // el move llegó al PDF

    // delete de un pendiente lo saca de la cola (y su fill muere con él).
    const doc2 = await graphOf(bytes);
    const session2 = new EditSession(doc2);
    const segB = doc2.pages[0]!.segments.find(s => s.text.includes('NOMBRE'))!;
    await session2.placeholdersToFields(segB.id, [{ placeholder: '.....', name: 'nombre' }]);
    session2.fillField('nombre', 'X');
    expect(session2.deleteField('nombre')).toContain('descartado');
    const { pdf: pdf2 } = await session2.bake();
    const re2 = await graphOf(pdf2);
    expect(re2.pages[0]!.widgets.find(x => x.fieldName === 'nombre')).toBeUndefined();
  });

  it('8. barrido de rellenos vía sesión: se pasa UN xxxx → TODOS los runs x/X se convierten', async () => {
    const bytes = await pdfWith([500, 400], (page, f) => {
      page.drawText('Nombre: XXXXXXXX y documento xxxxxx del titular.', { x: 60, y: 300, size: 11, font: f.regular });
      page.drawText('Texto inferior que puede correrse.', { x: 60, y: 280, size: 11, font: f.regular });
    });
    const doc = await graphOf(bytes);
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('Nombre'))!;
    const session = new EditSession(doc);
    const msg = await session.placeholdersToFields(seg.id, [{ placeholder: 'XXXXXXXX', name: 'nombre' }]);
    expect(msg).toContain('✓');

    const { pdf } = await session.bake();
    const re = await graphOf(pdf);
    const text = re.pages[0]!.segments.map(s => s.text).join(' ');
    expect(text).not.toMatch(/[xX]{2,}/);   // NINGÚN relleno quedó suelto
    expect(text).toContain('y documento');  // las palabras reales sobreviven
    // orden de LECTURA (baseline desc, luego x): el 2º hueco puede caer en un
    // renglón extra — sortear por x puro mezcla filas.
    const widgets = [...re.pages[0]!.widgets].sort((a, b) => b.y - a.y || a.x - b.x);
    expect(widgets).toHaveLength(2);
    expect(widgets[0]!.fieldName).toBe('nombre');
    expect(widgets[1]!.fieldName).toMatch(/^campo_/); // el huérfano, auto-nombrado
    for (const w of widgets) expect(overlapsText(re.pages[0]!, w)).toBe(false);
  });
});
