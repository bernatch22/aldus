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
import type { WidgetKind } from '../model/nodes.js';

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
  /** /Ff Required — la UX de un host e-sign lo necesita para exigir inputs. */
  required: boolean;
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

/** Estado "on" del widget (radio/checkbox): la clave de su diccionario de
 *  apariencias /AP /N que no es Off. A diferencia de /AS (el estado ACTUAL,
 *  que en una opción no seleccionada es /Off), /AP /N existe SIEMPRE — es lo
 *  que permite mapear rect↔opción aun sin selección. */
function widgetOnState(w: ReturnType<PDFField['acroField']['getWidgets']>[number]): string | undefined {
  try {
    const normal = w.getAppearances?.()?.normal;
    if (normal && typeof (normal as { keys?: unknown }).keys === 'function') {
      for (const k of (normal as { keys(): Iterable<{ asString?: () => string }> }).keys()) {
        const name = (typeof k.asString === 'function' ? k.asString() : String(k)).replace(/^\//, '');
        if (name && name.toLowerCase() !== 'off') return name;
      }
    }
  } catch { /* sin estados de apariencia */ }
  return undefined;
}

/** Rects (geometría + página) de todos los widgets de un campo. */
function rectsOf(field: PDFField, pageBy: Map<unknown, number>): FieldRect[] {
  const out: FieldRect[] = [];
  // Algunos escritores (pdf-lib incluido) guardan el estado de apariencia como
  // ÍNDICE (/0, /1) dentro del array /Opt del campo — resolvemos a la etiqueta.
  const options: string[] | undefined = (field as { getOptions?: () => string[] }).getOptions?.();
  const resolve = (name: string | undefined): string | undefined =>
    name !== undefined && /^\d+$/.test(name) && options?.[Number(name)] !== undefined ? options[Number(name)] : name;
  for (const w of field.acroField.getWidgets()) {
    try {
      const r = w.getRectangle();
      // Valor de exportación del widget: /AP /N primero (existe aunque la opción
      // no esté seleccionada); /AS como fallback para widgets sin apariencias.
      const as = w.dict.get(PDFName.of('AS'));
      const fromAs = as instanceof PDFName && as.asString() !== '/Off' ? as.asString().slice(1) : undefined;
      out.push({
        page: pageBy.get(w.dict) ?? 1,
        x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
        width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10,
        export: resolve(widgetOnState(w) ?? fromAs),
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
    const required = f.isRequired();
    const rects = rectsOf(f, pageBy);
    if (f instanceof PDFTextField) out.push({ name, type: 'text', value: nz(f.getText() ?? undefined), readOnly, required, rects });
    else if (f instanceof PDFCheckBox) out.push({ name, type: 'checkbox', value: f.isChecked() ? 'On' : undefined, readOnly, required, rects });
    else if (f instanceof PDFRadioGroup) out.push({ name, type: 'radio', value: nz(f.getSelected() ?? undefined), options: f.getOptions(), readOnly, required, rects });
    else if (f instanceof PDFDropdown) out.push({ name, type: 'select', value: nz(f.getSelected()[0]), options: f.getOptions(), readOnly, required, rects });
    else if (f instanceof PDFOptionList) out.push({ name, type: 'list', value: f.getSelected().length ? f.getSelected() : undefined, options: f.getOptions(), readOnly, required, rects });
    else if (f instanceof PDFButton) out.push({ name, type: 'button', readOnly, required, rects });
    else out.push({ name, type: 'signature', readOnly, required, rects });
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
