/**
 * forms.test.ts — leer y completar formularios AcroForm (determinístico).
 * Round-trip real: crear un form → leer vacío → completar → releer con valores.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFormFields, setFieldValues } from '../src/bake/index.js';

async function makeForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  form.createTextField('nombre').addToPage(page, { x: 100, y: 700, width: 200, height: 20, font });
  form.createCheckBox('acepta').addToPage(page, { x: 100, y: 670, width: 14, height: 14 });
  const plan = form.createDropdown('plan');
  plan.addOptions(['Basico', 'Pro', 'Enterprise']);
  plan.addToPage(page, { x: 100, y: 640, width: 140, height: 20, font });
  const ro = form.createTextField('folio');
  ro.addToPage(page, { x: 100, y: 610, width: 100, height: 20, font });
  ro.enableReadOnly();
  return doc.save();
}

describe('formularios (leer + completar)', () => {
  it('lee los campos vacíos con su tipo y opciones', async () => {
    const fields = await readFormFields(await makeForm());
    expect(fields.map(f => f.name).sort()).toEqual(['acepta', 'folio', 'nombre', 'plan']);
    const plan = fields.find(f => f.name === 'plan')!;
    expect(plan.type).toBe('select');
    expect(plan.options).toEqual(['Basico', 'Pro', 'Enterprise']);
    expect(fields.every(f => f.value === undefined)).toBe(true); // todos vacíos
    expect(fields.find(f => f.name === 'folio')!.readOnly).toBe(true);
  });

  it('completa por nombre y el valor se relee (texto/checkbox/select)', async () => {
    const pdf0 = await makeForm();
    const { pdf, applied, warnings } = await setFieldValues(pdf0, {
      nombre: 'Ana Gómez', acepta: true, plan: 'Pro',
      inexistente: 'x', // → aviso, no rompe
    });
    expect(applied.length).toBe(3);
    expect(warnings.some(w => w.includes('inexistente'))).toBe(true);

    const fields = await readFormFields(pdf);
    expect(fields.find(f => f.name === 'nombre')!.value).toBe('Ana Gómez');
    expect(fields.find(f => f.name === 'acepta')!.value).toBe('On');
    expect(fields.find(f => f.name === 'plan')!.value).toBe('Pro');
  });

  it('respeta read-only y avisa una opción de select inválida', async () => {
    const { applied, warnings } = await setFieldValues(await makeForm(), { folio: 'F-1', plan: 'Inexistente' });
    expect(applied.length).toBe(0);
    expect(warnings.some(w => w.includes('folio') && w.includes('read-only'))).toBe(true);
    expect(warnings.some(w => w.includes('plan'))).toBe(true); // opción inválida → aviso, no crash
  });

  it('un radio SIN selección expone el export de CADA opción (vía /AP /N, no /AS)', async () => {
    // /AS de una opción no seleccionada es /Off — si export saliera de ahí, un
    // radio recién creado no permitiría mapear rect↔opción (regresión que
    // rompería el posicionamiento de opciones en un host e-sign).
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const radio = doc.getForm().createRadioGroup('tipo');
    radio.addOptionToPage('Persona', page, { x: 100, y: 700, width: 14, height: 14 });
    radio.addOptionToPage('Empresa', page, { x: 100, y: 670, width: 14, height: 14 });
    const fields = await readFormFields(await doc.save());
    const tipo = fields.find(f => f.name === 'tipo')!;
    expect(tipo.value).toBeUndefined(); // nada seleccionado
    expect(tipo.rects.map(r => r.export).sort()).toEqual(['Empresa', 'Persona']);
    // Y las posiciones siguen distinguibles por opción (Persona arriba de Empresa).
    const persona = tipo.rects.find(r => r.export === 'Persona')!;
    const empresa = tipo.rects.find(r => r.export === 'Empresa')!;
    expect(persona.y).toBeGreaterThan(empresa.y);
  });

  it('un PDF sin formulario devuelve [] y un aviso al completar', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const bytes = await doc.save();
    expect(await readFormFields(bytes)).toEqual([]);
    const { applied, warnings } = await setFieldValues(bytes, { x: '1' });
    expect(applied.length).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
