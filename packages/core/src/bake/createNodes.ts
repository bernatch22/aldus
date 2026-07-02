/**
 * createNodes.ts — creación de nodos NUEVOS: campos de formulario e imágenes.
 *
 * Campos: pdf-lib high-level (text/checkbox/radio/dropdown) + firma armada a
 * mano a nivel de diccionario (FT /Sig — pdf-lib no la trae). Imágenes:
 * embedPng/embedJpg + drawImage (se dibuja al final del stream = al frente,
 * lo esperable para un objeto recién insertado).
 */

import {
  BlendMode,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFString,
  degrees,
  rgb,
  type PDFPage,
} from 'pdf-lib';
import { FIELD_DEFAULT_SIZE, type FontBucket, type WidgetKind } from '../model.js';
import { stdFontFor } from './bake.js';
export { FIELD_DEFAULT_SIZE };

const hexToRgb = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0;
  return rgb(((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255);
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
  group.addOptionToPage(value, page, { x: spec.x, y: spec.y, width: size.width, height: size.height });
  try {
    form.updateFieldAppearances();
  } catch {
    /* el viewer regenera */
  }
  return { pdf: await doc.save(), value };
}

// ── texto nuevo ──────────────────────────────────────────────────────────────

export interface NewTextSpec {
  page: number;
  /** Punto del click = esquina superior-izquierda del texto. */
  x: number;
  y: number;
  text: string;
  size?: number;
  bucket?: FontBucket;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

/** Agrega un párrafo de texto nuevo (con wrap hasta el margen derecho). Al
 *  re-extraer se vuelve un segmento más del grafo → editable como cualquiera. */
export async function addText(pdfBytes: Uint8Array, spec: NewTextSpec): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);
  const size = spec.size ?? 11;
  const font = await doc.embedFont(stdFontFor(spec.bucket ?? 'sans', spec.bold ?? false, spec.italic ?? false));
  page.drawText(spec.text, {
    x: spec.x,
    y: spec.y - size,
    size,
    font,
    color: spec.color ? hexToRgb(spec.color) : rgb(0, 0, 0),
    lineHeight: size * 1.35,
    maxWidth: Math.max(80, page.getWidth() - spec.x - 40),
  });
  return { pdf: await doc.save() };
}

// ── watermark / header / footer ─────────────────────────────────────────────

export async function addWatermark(pdfBytes: Uint8Array, spec: { text: string; opacity?: number; color?: string }): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(stdFontFor('sans', true, false));
  for (const page of doc.getPages()) {
    const w = page.getWidth();
    const h = page.getHeight();
    const size = Math.min(84, (w * 1.1) / Math.max(4, spec.text.length) / 0.55);
    page.drawText(spec.text, {
      x: w * 0.14,
      y: h * 0.28,
      size,
      font,
      rotate: degrees(38),
      opacity: spec.opacity ?? 0.14,
      color: spec.color ? hexToRgb(spec.color) : rgb(0.4, 0.4, 0.45),
    });
  }
  return { pdf: await doc.save() };
}

export async function addHeaderFooter(
  pdfBytes: Uint8Array,
  spec: { header?: string; footer?: string; pageNumbers?: boolean },
): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(stdFontFor('sans', false, false));
  const pages = doc.getPages();
  const gray = rgb(0.35, 0.35, 0.4);
  pages.forEach((page, i) => {
    const w = page.getWidth();
    const h = page.getHeight();
    if (spec.header) page.drawText(spec.header, { x: 40, y: h - 28, size: 9, font, color: gray });
    if (spec.footer) page.drawText(spec.footer, { x: 40, y: 18, size: 9, font, color: gray });
    if (spec.pageNumbers) {
      const label = `Página ${i + 1} de ${pages.length}`;
      const lw = font.widthOfTextAtSize(label, 9);
      page.drawText(label, { x: w - 40 - lw, y: 18, size: 9, font, color: gray });
    }
  });
  return { pdf: await doc.save() };
}

// ── highlight ────────────────────────────────────────────────────────────────

/** Resalta un rect como un marcador: blend Multiply (el texto de arriba sigue
 *  legible) + color saturado a 0.55 de opacidad para que se vea de verdad. */
export async function addHighlight(
  pdfBytes: Uint8Array,
  spec: { page: number; x: number; y: number; width: number; height: number; color?: string },
): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);
  page.drawRectangle({
    x: spec.x - 1,
    y: spec.y - 1,
    width: spec.width + 2,
    height: spec.height + 2,
    color: spec.color ? hexToRgb(spec.color) : rgb(1, 0.84, 0), // amarillo marcador saturado
    opacity: 0.55,
    blendMode: BlendMode.Multiply,
  });
  return { pdf: await doc.save() };
}

// ── links ────────────────────────────────────────────────────────────────────

export async function addLink(
  pdfBytes: Uint8Array,
  spec: { page: number; x: number; y: number; width: number; height: number; url: string },
): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);
  const ctx = doc.context;
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [spec.x, spec.y, spec.x + spec.width, spec.y + spec.height],
    Border: [0, 0, 0],
    A: ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(spec.url) }),
  });
  const ref = ctx.register(dict);
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray) ?? ctx.obj([]);
  annots.push(ref);
  page.node.set(PDFName.of('Annots'), annots);
  return { pdf: await doc.save() };
}

export async function removeLink(
  pdfBytes: Uint8Array,
  spec: { page: number; x: number; y: number; width: number; height: number },
): Promise<{ pdf: Uint8Array; removed: boolean }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
  if (!annots) return { pdf: pdfBytes, removed: false };
  const tol = 2;
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    if (!(dict instanceof PDFDict)) continue;
    if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Link')) continue;
    const rect = dict.lookup(PDFName.of('Rect'), PDFArray);
    if (!rect || rect.size() !== 4) continue;
    const nums = [0, 1, 2, 3].map(k => Number((rect.get(k) as { asNumber?: () => number }).asNumber?.() ?? NaN));
    if (nums.some(Number.isNaN)) continue;
    const [ax, ay, bx, by] = nums;
    if (
      Math.abs(Math.min(ax, bx) - spec.x) <= tol && Math.abs(Math.min(ay, by) - spec.y) <= tol &&
      Math.abs(Math.abs(bx - ax) - spec.width) <= tol && Math.abs(Math.abs(by - ay) - spec.height) <= tol
    ) {
      annots.remove(i);
      return { pdf: await doc.save(), removed: true };
    }
  }
  return { pdf: pdfBytes, removed: false };
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
