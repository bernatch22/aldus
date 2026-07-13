/**
 * Fallback text drawing (path C): when the original font can't render the new
 * text (insufficient subset, or a family/style change), the text is drawn with
 * the BEST available substitute — the provider chain first (the ORIGINAL font
 * from the system, or its downloaded metric twin: see fontProviders / ./node),
 * the STANDARD font as last resort. An explicit, reported substitution that
 * preserves the original color. Never guessed, never silent.
 *
 * Trasplante VERBATIM de v1 bake/fallback.ts con dos ajustes del plan:
 *  - la cadena de providers llega por DI (default: registry global — compat);
 *  - la geometría del subrayado viene de bake/underline.ts (fuente única).
 */
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';
import type { FontBucket } from '../../model/nodes.js';
import { BakeCodes, type BakeReport } from '../report.js';
import { underlineRectFor } from '../underline.js';
import { stdFontFor } from './fontService.js';
import { resolveFallbackFont, type IFallbackFontProvider } from './fontProviders.js';

/** One queued substitute-font draw (accumulated across pages, drawn at the end). */
export interface FallbackDraw {
  page: number;
  text: string;
  x: number;
  y: number;
  size: number;
  bucket: FontBucket;
  bold: boolean;
  italic: boolean;
  /** FAMILIA original ("Cambria") — la cadena de providers intenta resolverla
   *  a la fuente real / gemela métrica. Ausente (cambio explícito de familia)
   *  → directo a la estándar del bucket. */
  family?: string;
  /** Text color (0..1). Absent = black. */
  color?: { r: number; g: number; b: number };
  /** Underline: drawn as a thin rect under the text. */
  underline?: boolean;
}

/** Draw every queued fallback, embedding each substitute font at most once. */
export async function drawFallbackTexts(
  doc: PDFDocument,
  draws: FallbackDraw[],
  report: BakeReport,
  providerChain?: readonly IFallbackFontProvider[],
): Promise<void> {
  if (!draws.length) return;
  const pages = doc.getPages();
  const fontCache = new Map<string, PDFFont>();
  const reported = new Set<string>();
  for (const d of draws) {
    const key = `${d.family ?? ''}|${d.bucket}|${d.bold}|${d.italic}`;
    let font = fontCache.get(key);
    if (!font) {
      // 1) La cadena de providers (fuente original del sistema / gemela
      //    métrica descargada). fontkit solo se carga si un provider resuelve
      //    — el bundle del browser no lo paga nunca (allí no hay providers).
      if (d.family) {
        const req = { family: d.family, bold: d.bold, italic: d.italic, bucket: d.bucket };
        const resolved = providerChain
          ? await resolveFallbackFont(req, providerChain)
          : await resolveFallbackFont(req);
        if (resolved) {
          try {
            const fontkit = (await import('@pdf-lib/fontkit')).default;
            doc.registerFontkit(fontkit);
            font = await doc.embedFont(resolved.bytes, { subset: true });
            if (!reported.has(key)) {
              reported.add(key);
              report.applied(BakeCodes.SubstituteFontUsed, undefined, {
                name: resolved.name, bold: d.bold ? 1 : 0, italic: d.italic ? 1 : 0,
              });
            }
          } catch {
            font = undefined; // bytes ilegibles → estándar (nunca romper)
          }
        }
      }
      // 2) Último recurso: la estándar del bucket (comportamiento histórico).
      if (!font) font = await doc.embedFont(stdFontFor(d.bucket, d.bold, d.italic));
      fontCache.set(key, font);
    }
    const page = pages[d.page - 1]!;
    const color = d.color ? rgb(d.color.r, d.color.g, d.color.b) : rgb(0, 0, 0);
    // CONTROL CHARS (< 0x20) = artefactos de extracción (códigos sin ToUnicode
    // en el doc original) — jamás texto legítimo. La fuente estándar TIRA con
    // ellos, pero una custom (fontkit) los dibuja como .notdef → CAJITA con X.
    // Se filtran SIEMPRE antes de dibujar, con reporte.
    const text = [...d.text].filter(c => c.codePointAt(0)! >= 0x20).join('');
    if (text !== d.text) report.warning(BakeCodes.GlyphArtifactDropped, undefined, { page: d.page, text: d.text.slice(0, 24) });
    if (!text) continue;
    const drawUnderline = () => {
      if (!d.underline || !font) return;
      const w = font.widthOfTextAtSize(text, d.size);
      const r = underlineRectFor(d.x, d.y, d.size, w);
      page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color });
    };
    try {
      page.drawText(text, { x: d.x, y: d.y, size: d.size, font, color });
      drawUnderline();
    } catch {
      // Characters outside the font: filter them out and report (never break the PDF).
      const clean = [...text].filter(c => c.charCodeAt(0) <= 0xff).join('');
      try {
        page.drawText(clean, { x: d.x, y: d.y, size: d.size, font, color });
        report.warning(BakeCodes.UnrepresentableDropped, undefined, { page: d.page, text: text.slice(0, 24) });
      } catch {
        report.warning(BakeCodes.FallbackDrawFailed, undefined, { page: d.page, text: text.slice(0, 24) });
      }
    }
  }
}
