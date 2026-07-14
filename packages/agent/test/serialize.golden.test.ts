/**
 * serialize.golden.test.ts — GOLDEN de serializeDoc: EL contrato entre el
 * documento y el LLM (audit-agent §3.5: "el más urgente y el más barato").
 * Tres fixtures reales (pdf-lib → grafo → serializeDoc) comparadas contra
 * .txt commiteados en test/goldens/. Cualquier cambio de formato se vuelve
 * un diff revisable. Los goldens son los MISMOS de v1 (el formato NO cambió).
 *
 * Regenerar: RESET_RESULTS=1 pnpm --filter @aldus/agent test
 */
import { describe, expect, it } from 'vitest';
import { rgb } from 'pdf-lib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeDoc } from '../src/llm/serialize.js';
import { graphOf, pdfWith } from './helpers.js';

const GOLDENS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'goldens');
const RESET = process.env.RESET_RESULTS === '1';

function expectGolden(name: string, actual: string): void {
  mkdirSync(GOLDENS, { recursive: true });
  const file = path.join(GOLDENS, name);
  if (RESET || !existsSync(file)) {
    writeFileSync(file, actual + '\n');
    return; // primera corrida / reset: el golden ES la salida actual
  }
  expect(actual + '\n').toBe(readFileSync(file, 'utf8'));
}

describe('serializeDoc — golden text (congela el contrato con el LLM)', () => {
  it('a) contrato con líneas de puntos (leaders)', async () => {
    const bytes = await pdfWith([500, 400], (page, f) => {
      page.drawText('CONTRATO DE SERVICIOS', { x: 60, y: 350, size: 16, font: f.bold });
      page.drawText('NOMBRE: ..............................', { x: 60, y: 310, size: 11, font: f.regular });
      page.drawText('Fecha: .............. Lugar: ..............', { x: 60, y: 292, size: 11, font: f.regular });
      page.drawText('Firma: ______________________', { x: 60, y: 274, size: 11, font: f.regular });
    });
    expectGolden('contract-leaders.txt', serializeDoc(await graphOf(bytes)));
  });

  it('b) AcroForm: text fields + checkbox + dropdown con labels cerca (incluye readingView [[field]])', async () => {
    const bytes = await pdfWith([500, 400], (page, f, doc) => {
      page.drawText('Nombre:', { x: 50, y: 331, size: 11, font: f.regular });
      page.drawText('____________', { x: 100, y: 331, size: 11, font: f.regular });
      const form = doc.getForm();
      form.createTextField('nombre').addToPage(page, { x: 100, y: 326, width: 120, height: 16 });
      form.createCheckBox('acepta').addToPage(page, { x: 50, y: 280, width: 12, height: 12 });
      page.drawText('Acepto los términos', { x: 68, y: 282, size: 10, font: f.regular });
      page.drawText('País:', { x: 50, y: 253, size: 10, font: f.regular });
      const dd = form.createDropdown('pais');
      dd.addOptions(['Uruguay', 'Argentina']);
      dd.addToPage(page, { x: 120, y: 250, width: 100, height: 16 });
    });
    const ser = serializeDoc(await graphOf(bytes));
    // El contrato clave del fill de forms: la vista de Lectura intercala [[id]].
    expect(ser).toContain('### Lectura');
    expect(ser).toMatch(/Nombre: \[\[p1-w\d+\]\]/);
    expectGolden('acroform-reading-view.txt', ser);
  });

  it('c) texto con tramos bold/italic/color', async () => {
    const bytes = await pdfWith([500, 300], (page, f) => {
      const y = 240;
      let x = 50;
      page.drawText('Total: ', { x, y, size: 12, font: f.regular });
      x += f.regular.widthOfTextAtSize('Total: ', 12);
      page.drawText('1.250 USD', { x, y, size: 12, font: f.bold });
      x += f.bold.widthOfTextAtSize('1.250 USD', 12);
      page.drawText(' al contado', { x, y, size: 12, font: f.oblique });
      page.drawText('Cláusula en rojo', { x: 50, y: 210, size: 12, font: f.regular, color: rgb(0.8, 0.1, 0.1) });
    });
    const ser = serializeDoc(await graphOf(bytes));
    expect(ser).toContain('tramos:'); // la geometría intra-nodo debe estar
    expect(ser).toContain('bold');
    expectGolden('styled-runs.txt', ser);
  });
});
