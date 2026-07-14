/**
 * bake/fonts/fontService.ts — selección de fuentes y re-encodeo para el bake.
 *
 * - {@link stdFontFor} mapea bucket + estilo a la fuente estándar de pdf-lib
 *   usada cuando la original no puede renderizar el texto nuevo (path C —
 *   sustitución explícita y reportada: la política de Acrobat).
 * - {@link baseFontFamilyOf} da la FAMILIA original de un font resource
 *   ("CAAAAA+Cambria-Bold" → "Cambria") para que el fallback busque la fuente
 *   REAL antes de caer a la estándar. null = recurso ilegible (nunca adivinar).
 * - {@link FontService} POSEE el cache de encoders ("services own collections",
 *   art-of-code) — en v1 el Map se pasaba a mano por 3 firmas. Un FontService
 *   por página (mismo scope que el encCache de v1 applySegmentEditsToPage).
 *
 * Semántica de encoderForFont/simpleEncodingEncoder: VERBATIM de v1 fonts.ts.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import type { FontBucket } from '../../model/nodes.js';
import { latin1 } from '../../common/bytes.js';
import { encoderFromSimpleEncoding, parseToUnicode, type ReverseEncoder } from '../../pdf/toUnicode.js';

const STD_FONTS: Record<FontBucket, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

/** Standard font matching a bucket + bold/italic style. */
export function stdFontFor(bucket: FontBucket, bold: boolean, italic: boolean): StandardFonts {
  return STD_FONTS[bucket][(bold ? 1 : 0) + (italic ? 2 : 0)]!;
}

/**
 * FAMILIA original de un font resource de la página: /BaseFont sin el prefijo
 * de subset ni el estilo — "CAAAAA+Cambria-Bold" → "Cambria". Con esto el
 * fallback puede buscar la fuente REAL (sistema / gemela métrica) en vez de
 * caer a ciegas a la estándar. null = recurso ilegible (nunca adivinar).
 */
export function baseFontFamilyOf(page: PDFPage, fontName: string): string | null {
  try {
    const res = page.node.Resources();
    const fonts = res?.lookup(PDFName.of('Font'));
    const fdict = fonts instanceof PDFDict ? fonts.lookup(PDFName.of(fontName)) : null;
    if (!(fdict instanceof PDFDict)) return null;
    const base = fdict.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText();
    if (!base) return null;
    const family = base.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0]!.trim();
    return family || null;
  } catch {
    return null;
  }
}

/** Encoder para fuentes simples (TrueType/Type1) con /MacRomanEncoding o
 *  /WinAnsiEncoding (el nombre directo, o BaseEncoding sin Differences). */
function simpleEncodingEncoder(fdict: PDFDict): ReverseEncoder | null {
  const subtype = fdict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
  if (subtype !== 'TrueType' && subtype !== 'Type1') return null;

  const encRaw = fdict.lookup(PDFName.of('Encoding'));
  let encName: string | undefined;
  if (encRaw instanceof PDFName) encName = encRaw.decodeText();
  else if (encRaw instanceof PDFDict) {
    if (encRaw.has(PDFName.of('Differences'))) return null; // remapeado: no adivinar
    encName = encRaw.lookupMaybe(PDFName.of('BaseEncoding'), PDFName)?.decodeText();
  }
  if (encName !== 'MacRomanEncoding' && encName !== 'WinAnsiEncoding') return null;

  const firstChar = fdict.lookupMaybe(PDFName.of('FirstChar'), PDFNumber)?.asNumber();
  const lastChar = fdict.lookupMaybe(PDFName.of('LastChar'), PDFNumber)?.asNumber();
  if (firstChar === undefined || lastChar === undefined) return null;

  let widths: number[] | null = null;
  const w = fdict.lookupMaybe(PDFName.of('Widths'), PDFArray);
  if (w) widths = w.asArray().map(v => (v instanceof PDFNumber ? v.asNumber() : 0));

  return encoderFromSimpleEncoding(encName, firstChar, lastChar, widths);
}

/** Medidor de ancho para BYTES ya encodeados de un font resource: devuelve el
 *  ancho en unidades /Widths (milésimas de em), o null si algún glifo no tiene
 *  ancho CONFIABLE (jamás adivinar → sin width fitting para ese run). */
type ByteWidthMeasurer = (bytes: Uint8Array) => number | null;

/** Medidor para fuentes SIMPLES (1 byte = 1 glifo): /Widths + /FirstChar.
 *  Un ancho ausente o 0 delata un glifo fuera del subset → null (no confiable). */
function simpleWidthMeasurer(fdict: PDFDict): ByteWidthMeasurer | null {
  const subtype = fdict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
  if (subtype !== 'TrueType' && subtype !== 'Type1') return null;
  const firstChar = fdict.lookupMaybe(PDFName.of('FirstChar'), PDFNumber)?.asNumber();
  const w = fdict.lookupMaybe(PDFName.of('Widths'), PDFArray);
  if (firstChar === undefined || !w) return null;
  const widths = w.asArray().map(v => (v instanceof PDFNumber ? v.asNumber() : 0));
  return bytes => {
    let sum = 0;
    for (const b of bytes) {
      const gw = widths[b - firstChar];
      if (!(typeof gw === 'number' && gw > 0)) return null;
      sum += gw;
    }
    return sum;
  };
}

/** Medidor para Type0 con /Encoding Identity-H (CID = código de 2 bytes):
 *  /W del descendant font, /DW como default (1000 por spec, ISO 32000 §9.7.4.3).
 *  Otros encodings CMap: null — el mapeo código→CID no es trivial, no adivinar. */
function cidWidthMeasurer(fdict: PDFDict): ByteWidthMeasurer | null {
  const subtype = fdict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
  if (subtype !== 'Type0') return null;
  const enc = fdict.lookup(PDFName.of('Encoding'));
  if (!(enc instanceof PDFName) || enc.decodeText() !== 'Identity-H') return null;
  const desc = fdict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookup(0);
  if (!(desc instanceof PDFDict)) return null;
  const dw = desc.lookupMaybe(PDFName.of('DW'), PDFNumber)?.asNumber() ?? 1000;
  // /W: [ cFirst [w w ...] | cFirst cLast w ]* → mapa CID → ancho.
  const cidW = new Map<number, number>();
  const w = desc.lookupMaybe(PDFName.of('W'), PDFArray);
  if (w) {
    const items = [...Array(w.size()).keys()].map(i => w.lookup(i));
    for (let i = 0; i < items.length; ) {
      const c0 = items[i];
      if (!(c0 instanceof PDFNumber)) return null; // /W malformado: no adivinar
      const next = items[i + 1];
      if (next instanceof PDFArray) {
        const list = next.asArray();
        for (let k = 0; k < list.length; k++) {
          const gw = list[k];
          if (gw instanceof PDFNumber) cidW.set(c0.asNumber() + k, gw.asNumber());
        }
        i += 2;
      } else if (next instanceof PDFNumber && items[i + 2] instanceof PDFNumber) {
        const cLast = next.asNumber();
        const gw = (items[i + 2] as PDFNumber).asNumber();
        for (let c = c0.asNumber(); c <= cLast && c - c0.asNumber() < 0x10000; c++) cidW.set(c, gw);
        i += 3;
      } else {
        return null; // forma inesperada: no adivinar
      }
    }
  }
  return bytes => {
    if (bytes.length % 2 !== 0) return null;
    let sum = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      sum += cidW.get((bytes[i]! << 8) | bytes[i + 1]!) ?? dw;
    }
    return sum;
  };
}

/** Dueño del cache de reverse-encoders (null = fuente sin /ToUnicode usable;
 *  también se cachea). Un FontService por página de bake. */
export class FontService {
  private readonly encCache = new Map<string, ReverseEncoder | null>();
  private readonly widthCache = new Map<string, ByteWidthMeasurer | null>();

  /** Reverse /ToUnicode encoder for a page font resource, memoized. */
  encoderForFont(doc: PDFDocument, page: PDFPage, fontName: string): ReverseEncoder | null {
    const hit = this.encCache.get(fontName);
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
      } else if (fdict instanceof PDFDict) {
        // Sin /ToUnicode (típico Word/Quartz): una fuente SIMPLE con encoding
        // estándar define el mapa unicode→byte por sí misma. Antes esto caía a
        // fuente estándar aunque la original renderizara el texto perfecto.
        enc = simpleEncodingEncoder(fdict);
      }
    } catch {
      enc = null;
    }
    this.encCache.set(fontName, enc);
    return enc;
  }

  /**
   * Ancho (unidades /Widths, milésimas de em) de los BYTES ya encodeados para
   * un font resource de la página — para el WIDTH FITTING del path B (Tz sobre
   * el slot geométrico, ver bake/widthFit.ts). null = la fuente no expone
   * anchos confiables (sin /Widths, /W ilegible, glifo fuera del subset,
   * encoding CMap no-Identity): NO se ajusta, comportamiento intacto.
   */
  widthOfBytes(doc: PDFDocument, page: PDFPage, fontName: string, bytes: Uint8Array): number | null {
    let measurer = this.widthCache.get(fontName);
    if (measurer === undefined) {
      measurer = null;
      try {
        const res = page.node.Resources();
        const fonts = res?.lookup(PDFName.of('Font'));
        const fdict = fonts instanceof PDFDict ? fonts.lookup(PDFName.of(fontName)) : null;
        if (fdict instanceof PDFDict) measurer = simpleWidthMeasurer(fdict) ?? cidWidthMeasurer(fdict);
      } catch {
        measurer = null;
      }
      this.widthCache.set(fontName, measurer);
    }
    return measurer ? measurer(bytes) : null;
  }
}
