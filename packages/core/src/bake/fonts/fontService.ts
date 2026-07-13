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

/** Dueño del cache de reverse-encoders (null = fuente sin /ToUnicode usable;
 *  también se cachea). Un FontService por página de bake. */
export class FontService {
  private readonly encCache = new Map<string, ReverseEncoder | null>();

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
}
