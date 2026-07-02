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

function stdFontFor(bucket: FontBucket, bold: boolean, italic: boolean): StandardFonts {
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

/** Bloque que re-emite UN show-op verbatim, reubicado/escalado. */
function reemitBlock(o: ShowOp, src: Uint8Array, ratio: number, x: number, y: number): string | null {
  const show =
    o.op === 'Tj' || o.op === 'TJ'
      ? latin1(src, o.record.start, o.record.end)
      : o.op === "'"
        ? `${o.record.operands[0]?.raw ?? '()'} Tj`
        : `${o.record.operands[2]?.raw ?? '()'} Tj`;
  const t = relTm(o, ratio, x, y);
  if (!t) return null;
  const color = o.fillColorRaw ? `${o.fillColorRaw} ` : '';
  return (
    `q BT ${color}/${o.fontName} ${fmt(o.fontSize)} Tf ` +
    `${fmt(o.charSpacing * ratio)} Tc ${fmt(o.wordSpacing * ratio)} Tw ${fmt(o.hScale)} Tz ` +
    `${fmt(t[0])} ${fmt(t[1])} ${fmt(t[2])} ${fmt(t[3])} ${fmt(t[4])} ${fmt(t[5])} Tm ` +
    `${show} ET Q`
  );
}

/** Bloque de texto NUEVO re-codificado con la fuente original. */
function newTextBlock(o: ShowOp, ratio: number, x: number, y: number, bytes: Uint8Array): string | null {
  const t = relTm(o, ratio, x, y);
  if (!t) return null;
  const color = o.fillColorRaw ? `${o.fillColorRaw} ` : '';
  return (
    `q BT ${color}/${o.fontName} ${fmt(o.fontSize)} Tf 0 Tc 0 Tw ${fmt(o.hScale)} Tz ` +
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

function rebuild(src: Uint8Array, splices: Splice[]): Uint8Array {
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) continue; // solapado (defensivo): el primero gana
    out += latin1(src, pos, s.start);
    if (s.text) out += `\n${s.text}\n`;
    pos = s.end;
  }
  out += latin1(src, pos, src.length);
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
    const { shows, xobjects } = walkContent(src);
    const encCache = new Map<string, ReverseEncoder | null>();
    const splices: Splice[] = [];

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
      // La matriz emitida es RELATIVA al CTM vigente en el Do (el q/cm original
      // sigue en el stream alrededor del reemplazo).
      const inv = invert(op.matrix);
      if (!inv) {
        warnings.push(`${edit.imageId}: matriz degenerada — sin cambios`);
        continue;
      }
      const rel = mul([na, 0, 0, nd, ne, nf], inv);
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
      const ratio = (edit.fontSize ?? edit.original.fontSize) / edit.original.fontSize;
      const newX = edit.x ?? edit.original.x;
      const newBaseline = edit.baseline ?? edit.original.baseline;
      const textChanged = edit.text !== edit.original.text;
      const familyChanged = edit.font !== undefined;

      if (!textChanged && !familyChanged && !edit.runs) {
        // A: mover/escalar — cada op verbatim reubicado EN SU LUGAR (z-order intacto).
        const editSplices: Splice[] = [];
        let degenerate = false;
        for (const o of ops) {
          const block = reemitBlock(o, src, ratio,
            newX + (o.x - edit.original.x) * ratio,
            newBaseline + (o.y - edit.original.baseline) * ratio);
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

      let substituted = 0;
      for (const sr of runsToEmit) {
        if (!sr.text) continue;
        const x = newX + sr.dx * ratio;
        const fontName = familyChanged ? undefined : fontForStyle.get(`${sr.bold}|${sr.italic}`);
        const bytes = fontName ? encoderForFont(doc, page, fontName, encCache)?.encode(sr.text) ?? null : null;
        const inlineBlock = fontName && bytes
          ? newTextBlock(ops.find(o => o.fontName === fontName) ?? firstOp, ratio, x, newBaseline, bytes)
          : null;
        if (inlineBlock) {
          inlineBlocks.push(inlineBlock);
        } else {
          if (!/^\s+$/.test(sr.text)) {
            fallbackDraws.push({
              page: pageNum,
              text: sr.text,
              x,
              y: newBaseline,
              size: edit.fontSize ?? edit.original.fontSize,
              bucket: edit.font ?? edit.original.bucket ?? 'sans',
              bold: sr.bold,
              italic: sr.italic,
            });
          }
          substituted++;
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

    if (splices.length) {
      setPageContents(doc, page, rebuild(src, splices));
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
      try {
        page.drawText(d.text, { x: d.x, y: d.y, size: d.size, font, color: rgb(0, 0, 0) });
      } catch {
        // Caracteres fuera de WinAnsi: filtrarlos e informar (nunca romper el PDF).
        const clean = [...d.text].filter(c => c.charCodeAt(0) <= 0xff).join('');
        try {
          page.drawText(clean, { x: d.x, y: d.y, size: d.size, font, color: rgb(0, 0, 0) });
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
