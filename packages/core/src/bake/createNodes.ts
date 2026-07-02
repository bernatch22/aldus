/**
 * createNodes.ts — creación de nodos NUEVOS: campos de formulario e imágenes.
 *
 * Campos: pdf-lib high-level (text/checkbox/radio/dropdown) + firma armada a
 * mano a nivel de diccionario (FT /Sig — pdf-lib no la trae). Imágenes:
 * embedPng/embedJpg + drawImage (se dibuja al final del stream = al frente,
 * lo esperable para un objeto recién insertado).
 */

import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFString,
  type PDFPage,
} from 'pdf-lib';
import { FIELD_DEFAULT_SIZE, type WidgetKind } from '../model.js';
export { FIELD_DEFAULT_SIZE };

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

/** Campo de FIRMA a mano: field dict FT /Sig que es a la vez su widget. */
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
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray) ?? ctx.obj([]);
  annots.push(ref);
  page.node.set(PDFName.of('Annots'), annots);

  // …y en /Fields del AcroForm (getForm crea el AcroForm si falta).
  const form = doc.getForm();
  form.acroForm.addField(ref);
}

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
  const rect = { x: spec.x, y: spec.y, width, height };

  switch (spec.type) {
    case 'text': {
      const f = form.createTextField(name);
      f.addToPage(page, rect);
      break;
    }
    case 'checkbox': {
      const f = form.createCheckBox(name);
      f.addToPage(page, rect);
      break;
    }
    case 'radio': {
      const f = form.createRadioGroup(name);
      f.addOptionToPage('opcion_1', page, rect);
      break;
    }
    case 'select': {
      const f = form.createDropdown(name);
      f.addOptions(['Opción 1']);
      f.addToPage(page, rect);
      break;
    }
    case 'list': {
      const f = form.createOptionList(name);
      f.addOptions(['Opción 1']);
      f.addToPage(page, rect);
      break;
    }
    case 'button': {
      const f = form.createButton(name);
      f.addToPage(name, page, rect);
      break;
    }
    case 'signature': {
      addSignatureField(doc, page, name, [spec.x, spec.y, spec.x + width, spec.y + height]);
      break;
    }
  }

  try {
    form.updateFieldAppearances();
  } catch {
    /* el viewer regenera */
  }
  return { pdf: await doc.save(), name };
}

export interface NewImageSpec {
  page: number;
  /** Punto de colocación (esquina superior-izquierda del click), en puntos PDF. */
  x: number;
  y: number;
  bytes: Uint8Array;
  mime: string;
  /** Ancho máximo al insertar (se preserva el aspecto). */
  maxWidth?: number;
}

/** Inserta una imagen (PNG/JPEG). Devuelve el PDF nuevo y el rect usado. */
export async function insertImage(pdfBytes: Uint8Array, spec: NewImageSpec): Promise<{ pdf: Uint8Array; rect: { x: number; y: number; width: number; height: number } }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);

  const image = /png$/i.test(spec.mime)
    ? await doc.embedPng(spec.bytes)
    : await doc.embedJpg(spec.bytes);

  const maxW = spec.maxWidth ?? 240;
  const ratio = image.width > maxW ? maxW / image.width : 1;
  const width = image.width * ratio;
  const height = image.height * ratio;
  // El click marca la esquina SUPERIOR-izquierda (natural al apuntar).
  const rect = { x: spec.x, y: spec.y - height, width, height };
  page.drawImage(image, rect);
  return { pdf: await doc.save(), rect };
}
