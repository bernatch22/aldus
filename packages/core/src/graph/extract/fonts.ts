/**
 * graph/extract/fonts.ts — FontInfo desde los commonObjs de pdf.js
 * (trasplante verbatim de v1 extractGraph.ts: styleFromName + fontInfoFor).
 */

import type { FontBucket, FontInfo } from '../../model/nodes.js';
import type { PdfJsPage } from './types.js';

interface RawFont {
  name?: string;
  fallbackName?: string;
  ascent?: number;
  descent?: number;
  /** true cuando el font file NO viene en el PDF (pdf.js cae a una del sistema).
   *  OJO: no usar `data` para esto — pdf.js lo libera tras renderizar salvo
   *  `fontExtraProperties`, dando falsos "no embebido". */
  missingFile?: boolean;
  bold?: boolean;
  italic?: boolean;
}

export function styleFromName(name: string): { bold: boolean; italic: boolean; bucket: FontBucket } {
  const n = name.toLowerCase();
  const bold = /bold|black|heavy|semibold|demibold|extrabold|-bd\b|,bd\b/.test(n);
  const italic = /italic|oblique/.test(n);
  const bucket: FontBucket =
    /(mono|courier|consol|menlo|typewriter|fixed)/.test(n) ? 'mono'
    : /(times|georgia|garamond|serif|roman|minion|antiqua|palatino|cambria|bodoni)/.test(n) ? 'serif'
    : 'sans';
  return { bold, italic, bucket };
}

export function fontInfoFor(page: PdfJsPage, loadedName: string, cache: Map<string, FontInfo>): FontInfo {
  const hit = cache.get(loadedName);
  if (hit) return hit;
  let raw: RawFont | null = null;
  try {
    raw = page.commonObjs.get(loadedName) as RawFont;
  } catch {
    raw = null;
  }
  const ps = raw?.name || raw?.fallbackName || loadedName;
  const style = styleFromName(ps);
  const info: FontInfo = {
    loadedName,
    postScriptName: ps,
    bold: raw?.bold ?? style.bold,
    italic: raw?.italic ?? style.italic,
    bucket: style.bucket,
    ascent: typeof raw?.ascent === 'number' && raw.ascent > 0 ? raw.ascent : 0.8,
    descent: typeof raw?.descent === 'number' && raw.descent < 0 ? raw.descent : -0.2,
    embedded: raw != null && raw.missingFile !== true,
  };
  cache.set(loadedName, info);
  return info;
}
