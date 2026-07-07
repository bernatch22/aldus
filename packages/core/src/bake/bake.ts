/**
 * bake.ts — the ORCHESTRATOR: applies SegmentEdits / ImageEdits / WidgetEdits
 * to the PDF's real content stream. No paint-over, ever: the original
 * operators are spliced out in place and the content is re-emitted
 * (relocated / scaled / rewritten).
 *
 * Per-edit strategy (most faithful first, never guessing) — see
 * {@link textEmitStrategies} in `text.ts`:
 *  A) Move/scale only → every show op re-emitted VERBATIM. Pixel-perfect.
 *  B) New text, same font → re-encoded with the ORIGINAL font via the
 *     reverse /ToUnicode map. Characters missing from the subset → C, warned.
 *  C) Family/style change or insufficient subset → embedded standard font
 *     (explicit, reported substitution — the Acrobat policy).
 *
 * A segment that can't be located unambiguously (chained shows without
 * widths, or no op inside its bbox) is skipped with a warning: what isn't
 * understood is never touched.
 */
import { PDFDocument } from 'pdf-lib';
import type { HighlightEdit, ImageEdit, LinkEdit, SegmentEdit, WidgetEdit } from '../model.js';
import { walkContent } from './textWalk.js';
import { pageContentBytes, setPageContents } from './pageContent.js';
import { rebuild, type Splice } from './splice.js';
import { applyImageEditsToPage } from './images.js';
import { applySegmentEditsToPage } from './text.js';
import { applyWidgetEdits } from './widgets.js';
import { applyHighlightEdits } from './highlights.js';
import { applyLinkEdits } from './links.js';
import { drawFallbackTexts, type FallbackDraw } from './fallback.js';
import { BakeReport, type BakeResult } from './report.js';

export type { BakeResult } from './report.js';
export { stdFontFor } from './fonts.js';
export { hexToRg } from './color.js';

const groupByPage = <T extends { page: number }>(items: T[]): Map<number, T[]> => {
  const out = new Map<number, T[]>();
  for (const item of items) out.set(item.page, [...(out.get(item.page) ?? []), item]);
  return out;
};

export async function bakeSegmentEdits(
  pdfBytes: Uint8Array,
  edits: SegmentEdit[],
  imageEdits: ImageEdit[] = [],
  widgetEdits: WidgetEdit[] = [],
  highlightEdits: HighlightEdit[] = [],
  linkEdits: LinkEdit[] = [],
): Promise<BakeResult> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const report = new BakeReport();
  const fallbackDraws: FallbackDraw[] = [];

  applyWidgetEdits(doc, widgetEdits, report);
  // Capa /Annots (resaltados y links): mover/borrar los existentes. Los NUEVOS
  // se crean con addHighlight/addLink (rutas aparte, en el server).
  applyHighlightEdits(doc, highlightEdits, report);
  applyLinkEdits(doc, linkEdits, report);

  const byPage = groupByPage(edits);
  const imgByPage = groupByPage(imageEdits);
  const allPages = new Set([...byPage.keys(), ...imgByPage.keys()]);

  for (const pageNum of allPages) {
    const pageEdits = byPage.get(pageNum) ?? [];
    const pageImgEdits = imgByPage.get(pageNum) ?? [];
    const page = pages[pageNum - 1];
    if (!page) {
      report.warn(`página ${pageNum} fuera de rango — ediciones saltadas`);
      continue;
    }
    let src: Uint8Array;
    try {
      src = pageContentBytes(doc, page);
    } catch (err) {
      report.warn(`página ${pageNum}: ${err instanceof Error ? err.message : 'stream ilegible'}`);
      continue;
    }
    const { shows, xobjects, fillRects, backstop } = walkContent(src);
    const splices: Splice[] = [];
    // "To front" = block at the END of the stream (identity CTM there →
    // absolute matrix). "To back" does NOT go to byte 0: that would land
    // BEFORE the full-page white fill many PDFs (JotForm) paint as the paper
    // — and that opaque white would cover the image ("everything white"). It
    // goes to the `backstop`: right before the first real content op, with a
    // matrix RELATIVE to its CTM.
    const appendBlocks: string[] = [];

    applyImageEditsToPage({ doc, page, pageImgEdits, xobjects, backstop, splices, appendBlocks, report });
    applySegmentEditsToPage({ doc, page, pageNum, pageEdits, shows, fillRects, src, splices, appendBlocks, fallbackDraws, report });

    if (splices.length || appendBlocks.length) {
      setPageContents(doc, page, rebuild(src, splices, '', appendBlocks.join('\n')));
    }
  }

  await drawFallbackTexts(doc, fallbackDraws, report);
  return report.finish(await doc.save());
}
