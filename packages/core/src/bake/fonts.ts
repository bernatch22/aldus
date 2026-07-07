/**
 * Font selection and re-encoding support for the bake.
 *
 * - `stdFontFor` maps a font bucket + style to the pdf-lib standard font used
 *   when the original font can't render the new text (path C — explicit,
 *   reported substitution: the Acrobat policy).
 * - `encoderForFont` builds (and caches) the reverse /ToUnicode encoder of an
 *   embedded font, so NEW text can be re-encoded with the ORIGINAL font
 *   (path B) as long as every character exists in its subset.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import type { FontBucket } from '../model.js';
import { latin1 } from './splice.js';
import { encoderFromSimpleEncoding, parseToUnicode, type ReverseEncoder } from './toUnicode.js';

const STD_FONTS: Record<FontBucket, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

/** Standard font matching a bucket + bold/italic style. */
export function stdFontFor(bucket: FontBucket, bold: boolean, italic: boolean): StandardFonts {
  return STD_FONTS[bucket][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

/**
 * Reverse /ToUnicode encoder for a page font resource, memoized in `cache`
 * (null = the font has no usable /ToUnicode; also cached).
 */
export function encoderForFont(
  doc: PDFDocument,
  page: PDFPage,
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
    } else if (fdict instanceof PDFDict) {
      // Sin /ToUnicode (típico Word/Quartz): una fuente SIMPLE con encoding
      // estándar define el mapa unicode→byte por sí misma. Antes esto caía a
      // fuente estándar aunque la original renderizara el texto perfecto.
      enc = simpleEncodingEncoder(fdict);
    }
  } catch {
    enc = null;
  }
  cache.set(fontName, enc);
  return enc;
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
