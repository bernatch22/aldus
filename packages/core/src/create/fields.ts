/**
 * create/fields.ts — creación de campos de formulario nuevos.
 *
 * pdf-lib high-level (text/checkbox/radio/dropdown/list/button) + firma armada
 * a MANO a nivel de diccionario (FT /Sig — pdf-lib no la trae; VERBATIM de
 * v1). El switch de WidgetKind de v1 es un registry {@link IFieldCreator}:
 * un tipo de campo nuevo = una entrada, no un caso más en el switch.
 */
import { PDFDocument, PDFString, rgb, type PDFPage } from 'pdf-lib';
import type { WidgetKind } from '../model/nodes.js';
import { appendAnnot } from './registry.js';

/** Tamaño default de cada tipo de widget al CREARLO (dato de creación/UI —
 *  vivía en v1 model.ts; el TODO(F3) de model/nodes.ts muere acá). */
export const FIELD_DEFAULT_SIZE: Record<WidgetKind, { width: number; height: number }> = {
  text: { width: 160, height: 20 },
  checkbox: { width: 14, height: 14 },
  radio: { width: 14, height: 14 },
  select: { width: 140, height: 20 },
  list: { width: 140, height: 60 },
  button: { width: 90, height: 24 },
  signature: { width: 200, height: 50 },
};

export interface NewFieldSpec {
  type: WidgetKind;
  page: number;
  /** Punto de colocación (esquina inferior-izquierda), en puntos PDF. */
  x: number;
  y: number;
  width?: number;
  height?: number;
  name?: string;
}

const FIELD_BASE_NAME: Record<WidgetKind, string> = {
  text: 'texto', checkbox: 'check', radio: 'radio', select: 'select',
  list: 'lista', button: 'boton', signature: 'firma',
};

function uniqueName(existing: Set<string>, base: string): string {
  let n = 1;
  while (existing.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Apariencia MODERNA para los widgets creados (como los templates actuales):
 *  borde fino gris-azulado + fondo apenas tintado — nada de la caja negra
 *  default de pdf-lib. */
export const MODERN_WIDGET = {
  borderWidth: 1,
  borderColor: rgb(0.72, 0.77, 0.85),
  backgroundColor: rgb(0.955, 0.965, 0.985),
} as const;

/** Campo de FIRMA a mano: field dict FT /Sig que es a la vez su widget.
 *  VERBATIM v1 — el dict a mano, T como PDFString. */
function addSignatureField(doc: PDFDocument, page: PDFPage, name: string, rect: [number, number, number, number]): void {
  const ctx = doc.context;
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFString.of(name), // string, no name — pdf.js lee el fieldName de acá
    Rect: rect,
    F: 4, // print
    P: page.ref,
  });
  const ref = ctx.register(dict);

  // Alta en /Annots de la página…
  appendAnnot(ctx, page, ref);

  // …y en /Fields del AcroForm (getForm crea el AcroForm si falta).
  const form = doc.getForm();
  form.acroForm.addField(ref);
}

/** Un creador por WidgetKind — el switch de v1, abierto (OCP). */
export interface IFieldCreator {
  create(args: {
    doc: PDFDocument;
    page: PDFPage;
    form: ReturnType<PDFDocument['getForm']>;
    name: string;
    /** rect + estilo MODERN_WIDGET, listo para addToPage. */
    styled: { x: number; y: number; width: number; height: number } & typeof MODERN_WIDGET;
    spec: NewFieldSpec;
  }): void;
}

const FIELD_CREATORS: Record<WidgetKind, IFieldCreator> = {
  text: {
    create({ form, page, name, styled }) {
      const f = form.createTextField(name);
      f.addToPage(page, styled);
      try { f.setFontSize(10); } catch { /* auto-size */ }
    },
  },
  checkbox: {
    create({ form, page, name, styled }) {
      form.createCheckBox(name).addToPage(page, styled);
    },
  },
  radio: {
    create({ form, page, name, styled }) {
      form.createRadioGroup(name).addOptionToPage('opcion_1', page, styled);
    },
  },
  select: {
    create({ form, page, name, styled }) {
      const f = form.createDropdown(name);
      f.addOptions(['Opción 1']);
      f.addToPage(page, styled);
    },
  },
  list: {
    create({ form, page, name, styled }) {
      const f = form.createOptionList(name);
      f.addOptions(['Opción 1']);
      f.addToPage(page, styled);
    },
  },
  button: {
    create({ form, page, name, styled }) {
      form.createButton(name).addToPage(name, page, styled);
    },
  },
  signature: {
    create({ doc, page, name, styled }) {
      addSignatureField(doc, page, name, [styled.x, styled.y, styled.x + styled.width, styled.y + styled.height]);
    },
  },
};

/** Crea un campo nuevo. Devuelve el PDF nuevo y el nombre asignado. */
export async function addFormField(pdfBytes: Uint8Array, spec: NewFieldSpec): Promise<{ pdf: Uint8Array; name: string }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);

  const form = doc.getForm();
  const existing = new Set(form.getFields().map(f => f.getName()));
  const name = spec.name && !existing.has(spec.name) ? spec.name : uniqueName(existing, FIELD_BASE_NAME[spec.type]);
  const size = FIELD_DEFAULT_SIZE[spec.type];
  const width = spec.width ?? size.width;
  const height = spec.height ?? size.height;
  const styled = { x: spec.x, y: spec.y, width, height, ...MODERN_WIDGET };

  FIELD_CREATORS[spec.type].create({ doc, page, form, name, styled, spec });

  try {
    form.updateFieldAppearances();
  } catch {
    /* el viewer regenera */
  }
  return { pdf: await doc.save(), name };
}
