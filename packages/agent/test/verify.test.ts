/**
 * verify.test.ts — overlapReport es geometría pura post-bake (def #16). Un campo
 * que PISA texto real → issue con el arreglo sugerido; un campo sobre un renglón
 * de plantilla ("____") es INTENCIONAL (así se hace fillable un PDF) → cero issues.
 * v2: verify consume el charXOf CANÓNICO de core (el charXMap naïve murió).
 */
import { describe, expect, it } from 'vitest';
import { EditSession } from '../src/session/EditSession.js';
import { overlapReport } from '../src/llm/verify.js';
import { graphOf, pdfWith } from './helpers.js';

describe('overlapReport (verificación geométrica determinística)', () => {
  it('campo que pisa texto real → ≥1 issue; campo sobre "____" → 0 issues', async () => {
    const bytes = await pdfWith([500, 400], (page, f, doc) => {
      page.drawText('Nombre del cliente titular', { x: 60, y: 300, size: 11, font: f.regular });
      page.drawText('____________________', { x: 60, y: 260, size: 11, font: f.regular });
      const form = doc.getForm();
      // "pisa": el rect cae sobre los glifos reales del texto de su renglón.
      form.createTextField('pisa').addToPage(page, { x: 70, y: 297, width: 100, height: 14 });
      // "ok": sobre el placeholder de guiones bajos — intencional, se ignora.
      form.createTextField('ok').addToPage(page, { x: 62, y: 257, width: 100, height: 14 });
    });
    const session = new EditSession(await graphOf(bytes));
    const issues = await overlapReport(session);

    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some(i => i.includes('"pisa"') && i.includes('PISA'))).toBe(true);
    expect(issues.some(i => i.includes('move_text'))).toBe(true); // trae el arreglo sugerido
    expect(issues.some(i => i.includes('"ok"'))).toBe(false);     // el "____" NO es solape
  });

  it('documento sin solapes → reporte vacío', async () => {
    const bytes = await pdfWith([500, 400], (page, f, doc) => {
      page.drawText('Nombre:', { x: 60, y: 300, size: 11, font: f.regular });
      const form = doc.getForm();
      // A la DERECHA del label, sin tocar glifos.
      form.createTextField('nombre').addToPage(page, { x: 120, y: 297, width: 100, height: 14 });
    });
    const session = new EditSession(await graphOf(bytes));
    expect(await overlapReport(session)).toEqual([]);
  });
});
