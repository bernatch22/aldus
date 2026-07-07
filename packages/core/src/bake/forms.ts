/**
 * forms.ts — leer y COMPLETAR formularios AcroForm de forma DETERMINÍSTICA (sin
 * LLM), vía la API de alto nivel de pdf-lib. Es la fuente de verdad del llenado:
 * la usan la API programática (`readFormFields`/`setFieldValues`), el CLI
 * (`--fields`/`--fill`) y el agente (tool `fill_field`).
 *
 * El VALOR de cada campo (/V) NO vive en el grafo de edición (WidgetNode lo
 * expone para mostrarlo/serializarlo, pero el bake nunca lo toca): completar es
 * una operación aparte que reescribe /V + regenera las apariencias.
 */
import {
  PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFButton,
} from 'pdf-lib';
import type { WidgetKind } from '../model.js';

export interface FormField {
  name: string;
  type: WidgetKind;
  /** Valor actual: texto, opción seleccionada, 'On' (checkbox marcado) o lista. */
  value?: string | string[];
  /** Opciones disponibles (radio/select/list). */
  options?: string[];
  readOnly: boolean;
}

const nz = (s: string | undefined): string | undefined => (s ? s : undefined);

/** Lee TODOS los campos del formulario con su valor actual. `[]` si no hay AcroForm. */
export async function readFormFields(pdfBytes: Uint8Array): Promise<FormField[]> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  let form: ReturnType<PDFDocument['getForm']>;
  try { form = doc.getForm(); } catch { return []; }
  const out: FormField[] = [];
  for (const f of form.getFields()) {
    const name = f.getName();
    const readOnly = f.isReadOnly();
    if (f instanceof PDFTextField) out.push({ name, type: 'text', value: nz(f.getText() ?? undefined), readOnly });
    else if (f instanceof PDFCheckBox) out.push({ name, type: 'checkbox', value: f.isChecked() ? 'On' : undefined, readOnly });
    else if (f instanceof PDFRadioGroup) out.push({ name, type: 'radio', value: nz(f.getSelected() ?? undefined), options: f.getOptions(), readOnly });
    else if (f instanceof PDFDropdown) out.push({ name, type: 'select', value: nz(f.getSelected()[0]), options: f.getOptions(), readOnly });
    else if (f instanceof PDFOptionList) out.push({ name, type: 'list', value: f.getSelected().length ? f.getSelected() : undefined, options: f.getOptions(), readOnly });
    else if (f instanceof PDFButton) out.push({ name, type: 'button', readOnly });
    else out.push({ name, type: 'signature', readOnly });
  }
  return out;
}

/** ¿Un valor cuenta como "marcado" para un checkbox? */
const isChecked = (v: unknown): boolean =>
  v === true || (typeof v === 'string' && ['on', 'true', 'yes', 'si', 'sí', '1', 'x', 'checked'].includes(v.trim().toLowerCase()));

/**
 * COMPLETA campos por nombre. `values` = { nombreCampo: valor } — texto para
 * text/select/radio, booleano/'On'/'x' para checkbox, array para list múltiple.
 * Devuelve el PDF nuevo + qué se aplicó + avisos (campo inexistente, opción
 * inválida, campo no llenable). Determinístico: no adivina nombres.
 */
export async function setFieldValues(
  pdfBytes: Uint8Array,
  values: Record<string, string | boolean | string[]>,
): Promise<{ pdf: Uint8Array; applied: string[]; warnings: string[] }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const applied: string[] = [];
  const warnings: string[] = [];
  let form: ReturnType<PDFDocument['getForm']>;
  try { form = doc.getForm(); } catch { return { pdf: pdfBytes, applied, warnings: ['el documento no tiene formulario (AcroForm)'] }; }
  const byName = new Map(form.getFields().map(f => [f.getName(), f]));
  for (const [name, value] of Object.entries(values)) {
    const field = byName.get(name);
    if (!field) { warnings.push(`campo "${name}" no existe`); continue; }
    if (field.isReadOnly()) { warnings.push(`campo "${name}" es read-only — saltado`); continue; }
    // Validar opciones (radio/select/list): pdf-lib acepta valores fuera de la
    // lista en silencio → chequeamos nosotros y avisamos en vez de meter basura.
    const badOption = (opts: string[]): string | null => {
      const want = Array.isArray(value) ? value.map(String) : [String(value)];
      const invalid = want.filter(v => !opts.includes(v));
      return invalid.length ? `opción(es) inválida(s) [${invalid.join(', ')}] — válidas: [${opts.join(', ')}]` : null;
    };
    try {
      if (field instanceof PDFTextField) field.setText(String(value));
      else if (field instanceof PDFCheckBox) { if (isChecked(value)) field.check(); else field.uncheck(); }
      else if (field instanceof PDFRadioGroup) { const b = badOption(field.getOptions()); if (b) { warnings.push(`${name}: ${b}`); continue; } field.select(String(value)); }
      else if (field instanceof PDFDropdown) { const b = badOption(field.getOptions()); if (b) { warnings.push(`${name}: ${b}`); continue; } field.select(String(value)); }
      else if (field instanceof PDFOptionList) { const b = badOption(field.getOptions()); if (b) { warnings.push(`${name}: ${b}`); continue; } field.select(Array.isArray(value) ? value : String(value)); }
      else { warnings.push(`campo "${name}" (${field.constructor.name}) no admite valor`); continue; }
      applied.push(`${name} = ${JSON.stringify(value)}`);
    } catch (err) {
      warnings.push(`${name}: ${err instanceof Error ? err.message : 'no se pudo completar'}`);
    }
  }
  if (applied.length) { try { form.updateFieldAppearances(); } catch { /* el viewer regenera */ } }
  return { pdf: await doc.save(), applied, warnings };
}
