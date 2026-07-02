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
  PDFFont,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from 'pdf-lib';
import type { FontBucket, ImageEdit, SegmentEdit, StyledRun } from '../model.js';
import { walkContent, type ShowOp, type XObjectOp } from './textWalk.js';
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

/** Bloque que re-emite UN show-op verbatim, reubicado/escalado. */
function reemitBlock(o: ShowOp, src: Uint8Array, ratio: number, x: number, y: number): string {
  const show =
    o.op === 'Tj' || o.op === 'TJ'
      ? latin1(src, o.record.start, o.record.end)
      : o.op === "'"
        ? `${o.record.operands[0]?.raw ?? '()'} Tj`
        : `${o.record.operands[2]?.raw ?? '()'} Tj`;
  const m = o.matrix;
  const color = o.fillColorRaw ? `${o.fillColorRaw} ` : '';
  return (
    `q BT ${color}/${o.fontName} ${fmt(o.fontSize)} Tf ` +
    `${fmt(o.charSpacing * ratio)} Tc ${fmt(o.wordSpacing * ratio)} Tw ${fmt(o.hScale)} Tz ` +
    `${fmt(m[0] * ratio)} ${fmt(m[1] * ratio)} ${fmt(m[2] * ratio)} ${fmt(m[3] * ratio)} ${fmt(x)} ${fmt(y)} Tm ` +
    `${show} ET Q`
  );
}

/** Bloque de texto NUEVO re-codificado con la fuente original. */
function newTextBlock(o: ShowOp, ratio: number, x: number, y: number, bytes: Uint8Array): string {
  const m = o.matrix;
  const color = o.fillColorRaw ? `${o.fillColorRaw} ` : '';
  return (
    `q BT ${color}/${o.fontName} ${fmt(o.fontSize)} Tf 0 Tc 0 Tw ${fmt(o.hScale)} Tz ` +
    `${fmt(m[0] * ratio)} ${fmt(m[1] * ratio)} ${fmt(m[2] * ratio)} ${fmt(m[3] * ratio)} ${fmt(x)} ${fmt(y)} Tm ` +
    `${hexString(bytes)} Tj ET Q`
  );
}

function rebuild(src: Uint8Array, removals: Array<[number, number]>, appendix: string): Uint8Array {
  const sorted = [...removals].sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of sorted) {
    if (a > pos) out += latin1(src, pos, a);
    pos = Math.max(pos, b);
  }
  out += latin1(src, pos, src.length);
  out += `\n${appendix}\n`;
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

export async function bakeSegmentEdits(
  pdfBytes: Uint8Array,
  edits: SegmentEdit[],
  imageEdits: ImageEdit[] = [],
): Promise<BakeResult> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const applied: string[] = [];
  const warnings: string[] = [];
  const fallbackDraws: FallbackDraw[] = [];

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
    const removals: Array<[number, number]> = [];
    const blocks: string[] = [];

    // ── imágenes: mover/escalar re-emite `q cm /Nombre Do Q`; eliminar solo
    //    extirpa el Do (los cm huérfanos no dibujan nada) ──
    for (const edit of pageImgEdits) {
      const op = matchImage(xobjects, edit.original);
      if (!op) {
        warnings.push(`${edit.imageId}: no se encontró el XObject en la posición original — sin cambios`);
        continue;
      }
      removals.push([op.record.start, op.record.end]);
      if (edit.remove) {
        applied.push(`${edit.imageId}: eliminada`);
        continue;
      }
      const r = xobjectRect(op.matrix);
      if (r.rotated) {
        warnings.push(`${edit.imageId}: la imagen tiene rotación — mover/escalar no soportado aún, queda intacta`);
        removals.pop();
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
      blocks.push(`q ${fmt(na)} 0 0 ${fmt(nd)} ${fmt(ne)} ${fmt(nf)} cm /${op.name} Do Q`);
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

      for (const o of ops) removals.push([o.record.start, o.record.end]);

      if (!textChanged && !familyChanged && !edit.runs) {
        // A: mover/escalar — verbatim reubicado.
        for (const o of ops) {
          blocks.push(reemitBlock(o, src, ratio,
            newX + (o.x - edit.original.x) * ratio,
            newBaseline + (o.y - edit.original.baseline) * ratio));
        }
        applied.push(`${edit.segmentId}: reubicado/escalado (${ops.length} op${ops.length > 1 ? 's' : ''})`);
        continue;
      }

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
        if (fontName && bytes) {
          const op = ops.find(o => o.fontName === fontName) ?? ops[0];
          blocks.push(newTextBlock(op, ratio, x, newBaseline, bytes));
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
      if (substituted && !familyChanged) {
        warnings.push(`${edit.segmentId}: ${substituted} tramo${substituted > 1 ? 's' : ''} sin fuente original disponible (estilo nuevo o subset insuficiente) — sustituido por estándar`);
      }
      applied.push(familyChanged
        ? `${edit.segmentId}: redibujado con fuente estándar (cambio de familia)`
        : `${edit.segmentId}: reescrito por tramos (${runsToEmit.length})`);
    }

    if (removals.length || blocks.length) {
      setPageContents(doc, page, rebuild(src, removals, blocks.join('\n')));
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
