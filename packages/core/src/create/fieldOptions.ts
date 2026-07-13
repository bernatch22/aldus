/**
 * create/fieldOptions.ts — mutar OPCIONES de campos existentes (VERBATIM v1
 * createNodes.ts): reemplazar las opciones de un select/list y agregar una
 * opción a un grupo de radios.
 */
import { PDFDocument } from 'pdf-lib';
import { FIELD_DEFAULT_SIZE, MODERN_WIDGET } from './fields.js';

/** Reemplaza las opciones de un dropdown/list box. */
export async function setFieldOptions(pdfBytes: Uint8Array, spec: { fieldName: string; options: string[] }): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const field = form.getFields().find(f => f.getName() === spec.fieldName);
  if (!field) throw new Error(`campo "${spec.fieldName}" no encontrado`);
  const options = spec.options.map(o => o.trim()).filter(Boolean);
  if (!options.length) throw new Error('la lista de opciones no puede quedar vacía');
  const anyField = field as unknown as { setOptions?: (o: string[]) => void };
  if (typeof anyField.setOptions !== 'function') throw new Error(`"${spec.fieldName}" no es un select/lista`);
  anyField.setOptions(options);
  try {
    form.updateFieldAppearances();
  } catch {
    /* el viewer regenera */
  }
  return { pdf: await doc.save() };
}

/** Agrega una OPCIÓN a un grupo de radios existente (mismo nombre de campo =
 *  mismo grupo; se selecciona una sola a la vez). */
export async function addRadioOption(
  pdfBytes: Uint8Array,
  spec: { fieldName: string; page: number; x: number; y: number; value?: string },
): Promise<{ pdf: Uint8Array; value: string }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);
  const form = doc.getForm();
  const group = form.getRadioGroup(spec.fieldName);
  const existing = new Set(group.getOptions());
  let value = spec.value ?? '';
  if (!value || existing.has(value)) {
    let n = existing.size + 1;
    while (existing.has(`opcion_${n}`)) n++;
    value = `opcion_${n}`;
  }
  const size = FIELD_DEFAULT_SIZE.radio;
  group.addOptionToPage(value, page, { x: spec.x, y: spec.y, width: size.width, height: size.height, ...MODERN_WIDGET });
  try {
    form.updateFieldAppearances();
  } catch {
    /* el viewer regenera */
  }
  return { pdf: await doc.save(), value };
}
