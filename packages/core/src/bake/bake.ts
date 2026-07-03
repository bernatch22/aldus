/**
 * bake.ts — aplica SegmentEdits AL CONTENT STREAM del PDF. Sin paint-over:
 * los operadores de texto originales se EXTIRPAN del stream y el contenido se
 * re-emite (reubicado/escalado/reescrito) al final del stream de la página.
 *
 * Estrategia por edición (de más fiel a menos, nunca adivinando):
 *  A) Solo mover/escalar → cada show-op extirpado se re-emite VERBATIM (mismos
 *     bytes, misma fuente, mismo color, kerning TJ intacto) con su matriz
 *     reubicada/escalada. Pixel-perfect.
 *  B) Texto nuevo, misma fuente → re-codificar con la fuente ORIGINAL vía el
 *     mapa inverso de su /ToUnicode. Si algún carácter no está en el subset
 *     → cae a C con warning.
 *  C) Cambio de familia/estilo, o subset insuficiente → fuente estándar
 *     embebida (pdf-lib), imitando bucket/bold/italic. Sustitución EXPLÍCITA,
 *     reportada — la política Acrobat.
 *
 * Si un segmento no se puede localizar sin ambigüedad (ops con posición
 * encadenada sin widths, o ningún op en su bbox) se salta con warning: nunca
 * se toca lo que no se entiende.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFField,
  PDFFont,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFWidgetAnnotation,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from 'pdf-lib';
import type { FontBucket, ImageEdit, SegmentEdit, StyledRun, WidgetEdit } from '../model.js';
import { invert, mul, walkContent, type Matrix, type ShowOp, type XObjectOp } from './textWalk.js';
import { parseToUnicode, type ReverseEncoder } from './toUnicode.js';

export interface BakeResult {
  pdf: Uint8Array;
  /** Qué se aplicó, por segmento. */
  applied: string[];
  /** Qué se saltó o degradó, y por qué. */
  warnings: string[];
}

const fmt = (v: number): string => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

const latin1 = (bytes: Uint8Array, a: number, b: number): string => {
  let s = '';
  for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

const toBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

const hexString = (bytes: Uint8Array): string =>
  `<${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}>`;

// ── contenido de página ──────────────────────────────────────────────────────

function pageContentBytes(doc: PDFDocument, page: ReturnType<PDFDocument['getPages']>[number]): Uint8Array {
  const ctx = doc.context;
  const resolve = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const contents = resolve(page.node.get(PDFName.of('Contents')));
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = resolve(contents.get(i));
      if (s instanceof PDFRawStream) streams.push(s);
      else throw new Error('Content stream no soportado (no es PDFRawStream).');
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  } else if (contents != null) {
    throw new Error('Content stream no soportado.');
  }
  const parts = streams.map(s => decodePDFRawStream(s).decode());
  const total = parts.reduce((a, p) => a + p.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
    out[off++] = 0x0a;
  }
  return out;
}

function setPageContents(doc: PDFDocument, page: ReturnType<PDFDocument['getPages']>[number], bytes: Uint8Array): void {
  const stream = doc.context.stream(bytes);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
}

// ── fuentes ──────────────────────────────────────────────────────────────────

function encoderForFont(
  doc: PDFDocument,
  page: ReturnType<PDFDocument['getPages']>[number],
  fontName: string,
  cache: Map<string, ReverseEncoder | null>,
): ReverseEncoder | null {
  const hit = cache.get(fontName);
  if (hit !== undefined) return hit;
  let enc: ReverseEncoder | null = null;
  try {
    const res = page.node.Resources();
    const fonts = res?.lookup(PDFName.of('Font'));
    const fdict = fonts instanceof PDFDict ? fonts.lookup(PDFName.of(fontName)) : null;
    const tu = fdict instanceof PDFDict ? fdict.lookup(PDFName.of('ToUnicode')) : null;
    if (tu instanceof PDFRawStream) {
      const decoded = decodePDFRawStream(tu).decode();
      enc = parseToUnicode(latin1(decoded, 0, decoded.length));
    }
  } catch {
    enc = null;
  }
  cache.set(fontName, enc);
  return enc;
}

const STD_FONTS: Record<FontBucket, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

export function stdFontFor(bucket: FontBucket, bold: boolean, italic: boolean): StandardFonts {
  return STD_FONTS[bucket][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

// ── localización ─────────────────────────────────────────────────────────────

const Y_TOL = 1.8;
const X_TOL = 1.8;

/** Bounding box del unit square transformado por la CTM de un Do. */
function xobjectRect(m: [number, number, number, number, number, number]) {
  const [a, b, c, d, e, f] = m;
  const xs = [e, a + e, c + e, a + c + e];
  const ys = [f, b + f, d + f, b + d + f];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, rotated: Math.abs(b) > 0.01 || Math.abs(c) > 0.01 };
}

/** Nombres de recursos XObject de la página que son IMÁGENES (Subtype /Image).
 *  Un `Do` puede invocar también un Form XObject (que envuelve CONTENIDO —
 *  extirparlo por error borraría todo lo que contiene): jamás se matchea. */
function imageResourceNames(doc: PDFDocument, page: ReturnType<PDFDocument['getPages']>[number]): Set<string> {
  const out = new Set<string>();
  try {
    const res = page.node.Resources();
    const xo = res?.lookup(PDFName.of('XObject'));
    if (!(xo instanceof PDFDict)) return out;
    for (const [key, val] of xo.entries()) {
      const obj = val instanceof PDFRef ? doc.context.lookup(val) : val;
      const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      if (dict?.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
        out.add(key.toString().replace(/^\//, ''));
      }
    }
  } catch {
    /* sin recursos → sin imágenes */
  }
  return out;
}

function matchImage(xobjects: XObjectOp[], orig: ImageEdit['original']): XObjectOp | null {
  const tol = Math.max(2, orig.width * 0.02, orig.height * 0.02);
  return xobjects.find(o => {
    const r = xobjectRect(o.matrix);
    return Math.abs(r.x - orig.x) <= tol && Math.abs(r.y - orig.y) <= tol &&
      Math.abs(r.width - orig.width) <= tol && Math.abs(r.height - orig.height) <= tol;
  }) ?? null;
}

function matchOps(
  shows: ShowOp[],
  orig: SegmentEdit['original'],
): { ops: ShowOp[]; conflict: string | null } {
  const inLine = shows.filter(s => Math.abs(s.y - orig.baseline) <= Y_TOL);
  if (inLine.some(s => s.stale)) {
    return { ops: [], conflict: 'la línea tiene shows encadenados sin reposicionar (x desconocida sin widths)' };
  }
  const inside = inLine.filter(s => s.x >= orig.x - X_TOL && s.x <= orig.x + orig.width + X_TOL);
  if (!inside.length) {
    return { ops: [], conflict: 'ningún operador de texto arranca dentro del segmento (¿un TJ de otra columna lo contiene?)' };
  }
  return { ops: inside, conflict: null };
}

// ── re-emisión ───────────────────────────────────────────────────────────────

/** Matriz de texto RELATIVA al CTM del punto de inserción: la re-emisión es
 *  in-place (dentro de los q/cm originales), así que hay que compensarlos. */
function relTm(o: ShowOp, ratio: number, x: number, y: number): Matrix | null {
  const m = o.matrix;
  const abs: Matrix = [m[0] * ratio, m[1] * ratio, m[2] * ratio, m[3] * ratio, x, y];
  const inv = invert(o.ctm);
  return inv ? mul(abs, inv) : null;
}

/** Overrides de estilo del segmento aplicables a nivel de operadores. */
interface TextStyleOverrides {
  /** Tc en puntos (el "AV" de Acrobat). */
  charSpacing?: number;
  /** Tz en % (el "T↔" de Acrobat). */
  hScale?: number;
  /** Operador de color de relleno ("r g b rg"). */
  colorRaw?: string;
}

export function hexToRg(hex: string): string | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const v = parseInt(m[1], 16);
  const c = (n: number) => fmt(n / 255);
  return `${c((v >> 16) & 0xff)} ${c((v >> 8) & 0xff)} ${c(v & 0xff)} rg`;
}

/** Parsea el operador de color de relleno original ("R G B rg", "G g",
 *  "C M Y K k", o sc/scn con 1/3 números) a rgb 0..1. null si no se entiende. */
function rawFillToRgb(raw: string | undefined): { r: number; g: number; b: number } | null {
  if (!raw) return null;
  const nums = (raw.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  if (/\brg\b/.test(raw) && nums.length >= 3) return { r: nums[0], g: nums[1], b: nums[2] };
  if (/\bg\b/.test(raw) && !/\brg\b/.test(raw) && nums.length >= 1) return { r: nums[0], g: nums[0], b: nums[0] };
  if (/\bk\b/.test(raw) && nums.length >= 4) {
    const [c, m, y, kk] = nums;
    return { r: (1 - c) * (1 - kk), g: (1 - m) * (1 - kk), b: (1 - y) * (1 - kk) };
  }
  // sc/scn sin operador de color reconocido: 3 números = rgb, 1 = gris.
  if (nums.length >= 3) return { r: nums[nums.length - 3], g: nums[nums.length - 2], b: nums[nums.length - 1] };
  if (nums.length === 1) return { r: nums[0], g: nums[0], b: nums[0] };
  return null;
}

const hexToRgbObj = (hex: string): { r: number; g: number; b: number } => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0;
  return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255 };
};

/** Bloque que re-emite UN show-op verbatim, reubicado/escalado/re-estilado. */
function reemitBlock(o: ShowOp, src: Uint8Array, ratio: number, x: number, y: number, ov: TextStyleOverrides = {}): string | null {
  const show =
    o.op === 'Tj' || o.op === 'TJ'
      ? latin1(src, o.record.start, o.record.end)
      : o.op === "'"
        ? `${o.record.operands[0]?.raw ?? '()'} Tj`
        : `${o.record.operands[2]?.raw ?? '()'} Tj`;
  const t = relTm(o, ratio, x, y);
  if (!t) return null;
  const colorRaw = ov.colorRaw ?? o.fillColorRaw;
  const color = colorRaw ? `${colorRaw} ` : '';
  const tc = ov.charSpacing ?? o.charSpacing * ratio;
  const tz = ov.hScale ?? o.hScale;
  return (
    `q BT ${color}/${o.fontName} ${fmt(o.fontSize)} Tf ` +
    `${fmt(tc)} Tc ${fmt(o.wordSpacing * ratio)} Tw ${fmt(tz)} Tz ` +
    `${fmt(t[0])} ${fmt(t[1])} ${fmt(t[2])} ${fmt(t[3])} ${fmt(t[4])} ${fmt(t[5])} Tm ` +
    `${show} ET Q`
  );
}

/** Bloque de texto NUEVO re-codificado con la fuente original. */
function newTextBlock(o: ShowOp, ratio: number, x: number, y: number, bytes: Uint8Array, ov: TextStyleOverrides = {}): string | null {
  const t = relTm(o, ratio, x, y);
  if (!t) return null;
  const colorRaw = ov.colorRaw ?? o.fillColorRaw;
  const color = colorRaw ? `${colorRaw} ` : '';
  const tc = ov.charSpacing ?? 0;
  const tz = ov.hScale ?? o.hScale;
  return (
    `q BT ${color}/${o.fontName} ${fmt(o.fontSize)} Tf ${fmt(tc)} Tc 0 Tw ${fmt(tz)} Tz ` +
    `${fmt(t[0])} ${fmt(t[1])} ${fmt(t[2])} ${fmt(t[3])} ${fmt(t[4])} ${fmt(t[5])} Tm ` +
    `${hexString(bytes)} Tj ET Q`
  );
}

/** Un reemplazo in-place en el stream: [start, end) → text ('' = solo borrar).
 *  Reemplazar EN EL LUGAR (no extirpar + append) preserva el Z-ORDER: lo
 *  re-emitido se dibuja en el mismo turno que el original — una imagen de
 *  fondo movida sigue quedando DEBAJO del texto. */
interface Splice {
  start: number;
  end: number;
  text: string;
}

function rebuild(src: Uint8Array, splices: Splice[], prepend = '', append = ''): Uint8Array {
  // Con el MISMO start, una inserción pura (start==end) va ANTES que un
  // reemplazo/extirpación — si no, el skip de solapados se la comería (caso:
  // "al fondo" de una imagen que ya es el primer op de contenido).
  const sorted = [...splices].sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  let out = prepend ? `${prepend}\n` : '';
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) continue; // solapado (defensivo): el primero gana
    out += latin1(src, pos, s.start);
    if (s.text) out += `\n${s.text}\n`;
    pos = s.end;
  }
  out += latin1(src, pos, src.length);
  if (append) out += `\n${append}\n`;
  return toBytes(out);
}

// ── el bake ──────────────────────────────────────────────────────────────────

interface FallbackDraw {
  page: number;
  text: string;
  x: number;
  y: number;
  size: number;
  bucket: FontBucket;
  bold: boolean;
  italic: boolean;
  /** Color del texto (0..1). Ausente = negro. */
  color?: { r: number; g: number; b: number };
}

/** Widgets AcroForm: viven en /Annots, no en el content stream — mover/escalar
 *  es reescribir el /Rect del widget; eliminar es sacar el campo del form. */
function applyWidgetEdits(doc: PDFDocument, edits: WidgetEdit[], applied: string[], warnings: string[]): void {
  if (!edits.length) return;
  let form: ReturnType<PDFDocument['getForm']>;
  try {
    form = doc.getForm();
  } catch {
    warnings.push('el documento no tiene AcroForm — ediciones de campos saltadas');
    return;
  }
  let touched = false;
  for (const edit of edits) {
    const tol = 2.5;
    let matchedField: PDFField | null = null;
    let matchedWidget: PDFWidgetAnnotation | null = null;
    for (const field of form.getFields()) {
      if (field.getName() !== edit.original.fieldName) continue;
      for (const widget of field.acroField.getWidgets()) {
        const r = widget.getRectangle();
        if (
          Math.abs(r.x - edit.original.x) <= tol && Math.abs(r.y - edit.original.y) <= tol &&
          Math.abs(r.width - edit.original.width) <= tol && Math.abs(r.height - edit.original.height) <= tol
        ) {
          matchedField = field;
          matchedWidget = widget;
          break;
        }
      }
      if (matchedField) break;
    }
    if (!matchedField || !matchedWidget) {
      warnings.push(`${edit.widgetId}: campo "${edit.original.fieldName}" no encontrado en su rect — sin cambios`);
      continue;
    }
    if (edit.remove) {
      try {
        form.removeField(matchedField);
        applied.push(`${edit.widgetId}: campo "${edit.original.fieldName}" eliminado`);
        touched = true;
      } catch (err) {
        warnings.push(`${edit.widgetId}: no se pudo eliminar (${err instanceof Error ? err.message : 'error'})`);
      }
      continue;
    }
    matchedWidget.setRectangle({
      x: edit.x ?? edit.original.x,
      y: edit.y ?? edit.original.y,
      width: edit.width ?? edit.original.width,
      height: edit.height ?? edit.original.height,
    });
    applied.push(`${edit.widgetId}: campo "${edit.original.fieldName}" reubicado/escalado`);
    touched = true;
  }
  if (touched) {
    try {
      form.updateFieldAppearances();
    } catch {
      /* apariencias: el viewer las regenera */
    }
  }
}

export async function bakeSegmentEdits(
  pdfBytes: Uint8Array,
  edits: SegmentEdit[],
  imageEdits: ImageEdit[] = [],
  widgetEdits: WidgetEdit[] = [],
): Promise<BakeResult> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const applied: string[] = [];
  const warnings: string[] = [];
  const fallbackDraws: FallbackDraw[] = [];

  applyWidgetEdits(doc, widgetEdits, applied, warnings);

  const byPage = new Map<number, SegmentEdit[]>();
  for (const e of edits) byPage.set(e.page, [...(byPage.get(e.page) ?? []), e]);
  const imgByPage = new Map<number, ImageEdit[]>();
  for (const e of imageEdits) imgByPage.set(e.page, [...(imgByPage.get(e.page) ?? []), e]);

  const allPages = new Set([...byPage.keys(), ...imgByPage.keys()]);
  for (const pageNum of allPages) {
    const pageEdits = byPage.get(pageNum) ?? [];
    const pageImgEdits = imgByPage.get(pageNum) ?? [];
    const page = pages[pageNum - 1];
    if (!page) {
      warnings.push(`página ${pageNum} fuera de rango — ediciones saltadas`);
      continue;
    }
    let src: Uint8Array;
    try {
      src = pageContentBytes(doc, page);
    } catch (err) {
      warnings.push(`página ${pageNum}: ${err instanceof Error ? err.message : 'stream ilegible'}`);
      continue;
    }
    const { shows, xobjects, backstop } = walkContent(src);
    const encCache = new Map<string, ReverseEncoder | null>();
    const splices: Splice[] = [];
    // "Al frente" = bloque al FINAL del stream (CTM identidad ahí → matriz
    // absoluta). "Al fondo" NO va al byte 0: ahí quedaría ANTES del relleno
    // blanco full-page que muchos PDFs (JotForm) dibujan como papel — y ese
    // blanco opaco taparía la imagen ("todo blanco"). Va al `backstop`: justo
    // antes del primer op de contenido real, con matriz RELATIVA a su CTM.
    const appendBlocks: string[] = [];

    // ── imágenes: mover/escalar REEMPLAZA el Do en su lugar por
    //    `q cm /Nombre Do Q` (z-order intacto); eliminar solo lo borra ──
    const imgNames = pageImgEdits.length ? imageResourceNames(doc, page) : new Set<string>();
    const imageOps = xobjects.filter(o => imgNames.has(o.name));
    for (const edit of pageImgEdits) {
      const op = matchImage(imageOps, edit.original);
      if (!op) {
        warnings.push(`${edit.imageId}: no se encontró el XObject en la posición original — sin cambios`);
        continue;
      }
      if (edit.remove) {
        splices.push({ start: op.record.start, end: op.record.end, text: '' });
        applied.push(`${edit.imageId}: eliminada`);
        continue;
      }
      const r = xobjectRect(op.matrix);
      if (r.rotated) {
        warnings.push(`${edit.imageId}: la imagen tiene rotación — mover/escalar no soportado aún, queda intacta`);
        continue;
      }
      const [a, , , d] = op.matrix;
      const newW = edit.width ?? r.width;
      const newH = edit.height ?? r.height;
      const newX = edit.x ?? r.x;
      const newY = edit.y ?? r.y;
      // Preservar flips: el signo de a/d se mantiene; el ancla del bbox se
      // corrige si la escala es negativa.
      const na = a * (newW / r.width);
      const nd = d * (newH / r.height);
      const ne = newX - Math.min(0, na);
      const nf = newY - Math.min(0, nd);
      const abs: [number, number, number, number, number, number] = [na, 0, 0, nd, ne, nf];

      if (edit.zOrder) {
        // Reordenar: extirpar el op y re-emitirlo en el borde del contenido.
        splices.push({ start: op.record.start, end: op.record.end, text: '' });
        if (edit.zOrder === 'back') {
          // En el backstop rige su CTM → compensar (M_rel = M_abs × inv(ctm)).
          const binv = invert(backstop.ctm);
          const m = binv ? mul(abs, binv) : abs;
          const block = `q ${fmt(m[0])} ${fmt(m[1])} ${fmt(m[2])} ${fmt(m[3])} ${fmt(m[4])} ${fmt(m[5])} cm /${op.name} Do Q`;
          splices.push({ start: backstop.offset, end: backstop.offset, text: block });
        } else {
          // Final del stream: CTM identidad → matriz absoluta directa.
          appendBlocks.push(`q ${fmt(abs[0])} ${fmt(abs[1])} ${fmt(abs[2])} ${fmt(abs[3])} ${fmt(abs[4])} ${fmt(abs[5])} cm /${op.name} Do Q`);
        }
        applied.push(`${edit.imageId}: enviada ${edit.zOrder === 'back' ? 'al fondo' : 'al frente'}`);
        continue;
      }

      // La matriz emitida es RELATIVA al CTM vigente en el Do (el q/cm original
      // sigue en el stream alrededor del reemplazo).
      const inv = invert(op.matrix);
      if (!inv) {
        warnings.push(`${edit.imageId}: matriz degenerada — sin cambios`);
        continue;
      }
      const rel = mul(abs, inv);
      splices.push({
        start: op.record.start,
        end: op.record.end,
        text: `q ${fmt(rel[0])} ${fmt(rel[1])} ${fmt(rel[2])} ${fmt(rel[3])} ${fmt(rel[4])} ${fmt(rel[5])} cm /${op.name} Do Q`,
      });
      applied.push(`${edit.imageId}: reubicada/escalada`);
    }

    for (const edit of pageEdits) {
      const { ops, conflict } = matchOps(shows, edit.original);
      if (conflict) {
        warnings.push(`${edit.segmentId}: ${conflict} — sin cambios`);
        continue;
      }
      // ELIMINAR: extirpar todos los ops del segmento y listo.
      if (edit.remove) {
        for (const o of ops) splices.push({ start: o.record.start, end: o.record.end, text: '' });
        applied.push(`${edit.segmentId}: eliminado`);
        continue;
      }

      const ratio = (edit.fontSize ?? edit.original.fontSize) / edit.original.fontSize;
      const newX = edit.x ?? edit.original.x;
      const newBaseline = edit.baseline ?? edit.original.baseline;
      const textChanged = edit.text !== edit.original.text;
      const familyChanged = edit.font !== undefined;
      const styleOv: TextStyleOverrides = {
        charSpacing: edit.charSpacing,
        hScale: edit.hScale,
        colorRaw: edit.color ? hexToRg(edit.color) : undefined,
      };

      if (!textChanged && !familyChanged && !edit.runs) {
        // A: mover/escalar/re-estilar — cada op verbatim reubicado EN SU LUGAR.
        const editSplices: Splice[] = [];
        let degenerate = false;
        for (const o of ops) {
          const block = reemitBlock(o, src, ratio,
            newX + (o.x - edit.original.x) * ratio,
            newBaseline + (o.y - edit.original.baseline) * ratio,
            styleOv);
          if (!block) { degenerate = true; break; }
          editSplices.push({ start: o.record.start, end: o.record.end, text: block });
        }
        if (degenerate) {
          warnings.push(`${edit.segmentId}: matriz degenerada — sin cambios`);
          continue;
        }
        splices.push(...editSplices);
        applied.push(`${edit.segmentId}: reubicado/escalado (${ops.length} op${ops.length > 1 ? 's' : ''})`);
        continue;
      }

      // Los ops del segmento se vacían; el contenido nuevo entra EN EL LUGAR
      // del primero (z-order intacto).
      for (const o of ops.slice(1)) splices.push({ start: o.record.start, end: o.record.end, text: '' });
      const firstOp = ops[0];
      const inlineBlocks: string[] = [];

      // B/C: contenido o estilo nuevos — SIEMPRE por run estilado. El estilo de
      // cada tramo decide la FUENTE: el mapa estilo→recurso sale de los runs
      // originales (x + bold/italic) matcheados contra los ops del stream — el
      // PDF ya tiene la variante bold y la regular como recursos propios.
      const runsToEmit: StyledRun[] = edit.runs ?? [{
        text: edit.text,
        bold: edit.original.bold ?? false,
        italic: edit.original.italic ?? false,
        dx: 0,
      }];
      const fontForStyle = new Map<string, string>();
      for (const or of edit.original.runs ?? []) {
        const op = ops.find(o => Math.abs(o.x - or.x) <= 2.5);
        const key = `${or.bold}|${or.italic}`;
        if (op && !fontForStyle.has(key)) fontForStyle.set(key, op.fontName);
      }

      // Un grafo PUEDE tener breaklines: el texto se parte en LÍNEAS por '\n'
      // y cada una baja `leading` (1.2×size, tipográficamente estándar). El dx
      // de cada tramo es RELATIVO a su línea (el editor lo computa así).
      const lineRuns: StyledRun[][] = [[]];
      for (const sr of runsToEmit) {
        const parts = sr.text.split('\n');
        parts.forEach((p, i) => {
          if (i > 0) lineRuns.push([]);
          if (p) lineRuns[lineRuns.length - 1].push({ ...sr, text: p });
        });
      }
      const leading = (edit.fontSize ?? edit.original.fontSize) * 1.2;

      let substituted = 0;
      for (let li = 0; li < lineRuns.length; li++) {
        const lineBase = newBaseline - li * leading;
        for (const sr of lineRuns[li]) {
        if (!sr.text) continue;
        const x = newX + sr.dx * ratio;
        const fontName = familyChanged ? undefined : fontForStyle.get(`${sr.bold}|${sr.italic}`);
        const bytes = fontName ? encoderForFont(doc, page, fontName, encCache)?.encode(sr.text) ?? null : null;
        // Color POR TRAMO (selección) > override del segmento > el del op original.
        const runOv: TextStyleOverrides = {
          ...styleOv,
          colorRaw: sr.color ? hexToRg(sr.color) : styleOv.colorRaw,
        };
        const inlineBlock = fontName && bytes
          ? newTextBlock(ops.find(o => o.fontName === fontName) ?? firstOp, ratio, x, lineBase, bytes, runOv)
          : null;
        if (inlineBlock) {
          inlineBlocks.push(inlineBlock);
        } else {
          if (!/^\s+$/.test(sr.text)) {
            // Preservar el COLOR original (del op) salvo override explícito —
            // sin esto la sustitución de fuente pintaba todo en negro.
            const srcOp = ops.find(o => o.fontName === fontName) ?? firstOp;
            const color = sr.color
              ? hexToRgbObj(sr.color)
              : edit.color
                ? hexToRgbObj(edit.color)
                : rawFillToRgb(srcOp?.fillColorRaw) ?? undefined;
            fallbackDraws.push({
              page: pageNum,
              text: sr.text,
              x,
              y: lineBase,
              size: edit.fontSize ?? edit.original.fontSize,
              bucket: edit.font ?? edit.original.bucket ?? 'sans',
              bold: sr.bold,
              italic: sr.italic,
              color: color ?? undefined,
            });
          }
          substituted++;
        }
        }
      }
      splices.push({ start: firstOp.record.start, end: firstOp.record.end, text: inlineBlocks.join('\n') });
      if (substituted && !familyChanged) {
        warnings.push(`${edit.segmentId}: ${substituted} tramo${substituted > 1 ? 's' : ''} sin fuente original disponible (estilo nuevo o subset insuficiente) — sustituido por estándar`);
      }
      applied.push(familyChanged
        ? `${edit.segmentId}: redibujado con fuente estándar (cambio de familia)`
        : `${edit.segmentId}: reescrito por tramos (${runsToEmit.length})`);
    }

    if (splices.length || appendBlocks.length) {
      setPageContents(doc, page, rebuild(src, splices, '', appendBlocks.join('\n')));
    }
  }

  if (fallbackDraws.length) {
    const fontCache = new Map<string, PDFFont>();
    for (const d of fallbackDraws) {
      const key = `${d.bucket}|${d.bold}|${d.italic}`;
      let font = fontCache.get(key);
      if (!font) {
        font = await doc.embedFont(stdFontFor(d.bucket, d.bold, d.italic));
        fontCache.set(key, font);
      }
      const page = pages[d.page - 1];
      const color = d.color ? rgb(d.color.r, d.color.g, d.color.b) : rgb(0, 0, 0);
      try {
        page.drawText(d.text, { x: d.x, y: d.y, size: d.size, font, color });
      } catch {
        // Caracteres fuera de WinAnsi: filtrarlos e informar (nunca romper el PDF).
        const clean = [...d.text].filter(c => c.charCodeAt(0) <= 0xff).join('');
        try {
          page.drawText(clean, { x: d.x, y: d.y, size: d.size, font, color });
          warnings.push(`p${d.page}: caracteres no representables descartados en "${d.text.slice(0, 24)}…"`);
        } catch {
          warnings.push(`p${d.page}: no se pudo dibujar el reemplazo "${d.text.slice(0, 24)}…"`);
        }
      }
    }
  }

  const pdf = await doc.save();
  return { pdf, applied, warnings };
}
