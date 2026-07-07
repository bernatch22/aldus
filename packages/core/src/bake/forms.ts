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
  PDFArray, PDFDocument, PDFName, PDFRef, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFButton,
  type PDFField,
} from 'pdf-lib';
import type { WidgetKind } from '../model.js';

/** Rect de un widget del campo (puntos PDF, origen abajo-izq) + página 1-based.
 *  Un radio group tiene varios widgets → devolvemos uno por widget. */
export interface FieldRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Valor de exportación del widget (radio) — para saber qué rect es cada opción. */
  export?: string;
}

export interface FormField {
  name: string;
  type: WidgetKind;
  /** Valor actual: texto, opción seleccionada, 'On' (checkbox marcado) o lista. */
  value?: string | string[];
  /** Opciones disponibles (radio/select/list). */
  options?: string[];
  readOnly: boolean;
  /** Posición(es) del campo en el PDF: uno por widget (radio = varios). */
  rects: FieldRect[];
}

const nz = (s: string | undefined): string | undefined => (s ? s : undefined);

/** Mapa dict-de-widget → nº de página (1-based), escaneando /Annots de cada página. */
function widgetPages(doc: PDFDocument): Map<unknown, number> {
  const map = new Map<unknown, number>();
  doc.getPages().forEach((pg, i) => {
    const annots = pg.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) {
      const ref = annots.get(k);
      map.set(ref instanceof PDFRef ? doc.context.lookup(ref) : ref, i + 1);
    }
  });
  return map;
}

/** Rects (geometría + página) de todos los widgets de un campo. */
function rectsOf(field: PDFField, pageBy: Map<unknown, number>): FieldRect[] {
  const out: FieldRect[] = [];
  for (const w of field.acroField.getWidgets()) {
    try {
      const r = w.getRectangle();
      // /AS del widget = su valor de exportación (radio/checkbox) para mapear rect↔opción.
      const as = w.dict.get(PDFName.of('AS'));
      out.push({
        page: pageBy.get(w.dict) ?? 1,
        x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
        width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10,
        export: as instanceof PDFName && as.asString() !== '/Off' ? as.asString().slice(1) : undefined,
      });
    } catch { /* widget sin rect legible — lo salteamos */ }
  }
  return out;
}

/** Lee TODOS los campos del formulario con su valor actual y su geometría.
 *  `[]` si no hay AcroForm. */
export async function readFormFields(pdfBytes: Uint8Array): Promise<FormField[]> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  let form: ReturnType<PDFDocument['getForm']>;
  try { form = doc.getForm(); } catch { return []; }
  const pageBy = widgetPages(doc);
  const out: FormField[] = [];
  for (const f of form.getFields()) {
    const name = f.getName();
    const readOnly = f.isReadOnly();
    const rects = rectsOf(f, pageBy);
    if (f instanceof PDFTextField) out.push({ name, type: 'text', value: nz(f.getText() ?? undefined), readOnly, rects });
    else if (f instanceof PDFCheckBox) out.push({ name, type: 'checkbox', value: f.isChecked() ? 'On' : undefined, readOnly, rects });
    else if (f instanceof PDFRadioGroup) out.push({ name, type: 'radio', value: nz(f.getSelected() ?? undefined), options: f.getOptions(), readOnly, rects });
    else if (f instanceof PDFDropdown) out.push({ name, type: 'select', value: nz(f.getSelected()[0]), options: f.getOptions(), readOnly, rects });
    else if (f instanceof PDFOptionList) out.push({ name, type: 'list', value: f.getSelected().length ? f.getSelected() : undefined, options: f.getOptions(), readOnly, rects });
    else if (f instanceof PDFButton) out.push({ name, type: 'button', readOnly, rects });
    else out.push({ name, type: 'signature', readOnly, rects });
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
