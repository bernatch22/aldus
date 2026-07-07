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
import { PDFDict, PDFDocument, PDFName, PDFPage, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import type { FontBucket } from '../model.js';
import { latin1 } from './splice.js';
import { parseToUnicode, type ReverseEncoder } from './toUnicode.js';

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
    }
  } catch {
    enc = null;
  }
  cache.set(fontName, enc);
  return enc;
}
