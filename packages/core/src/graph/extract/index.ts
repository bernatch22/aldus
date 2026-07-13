/**
 * graph/extract — el orquestador de la extracción sobre IGraphExtractor.
 *
 * ORDEN DE FUSIÓN (es contrato, no accidente — cada extractor puede leer el
 * draft de los anteriores):
 *   1. TextRunExtractor    → runs (texto intacto, ids posicionales de run)
 *   2. VectorRectExtractor → shapes + marca run.underline (ANTES de agrupar:
 *                            el contenido estilado del segmento lee underline)
 *   3. BlockExtractor      → lines + segments (agrupado + mergeBlockSegments)
 *   4. ImageExtractor      → images (ids por objId)
 *   5. AnnotationExtractor → widgets + links + highlights (/Annots)
 *
 * `getOperatorList()` se ejecuta ANTES de `getTextContent` para que los fonts
 * embebidos estén resueltos en commonObjs (v1 verbatim).
 * ⚠️ El caller debe pasarle a pdf.js `bytes.slice()` (getDocument TRANSFIERE
 * el buffer al worker) — ver JSDoc de {@link IGraphExtractor}.
 */

import type { Container } from '../../ioc/container.js';
import type { FontInfo, PageGraph } from '../../model/nodes.js';
import { AnnotationExtractor } from './annotations.js';
import { BlockExtractor } from './blocks.js';
import { fontInfoFor } from './fonts.js';
import { ImageExtractor } from './images.js';
import { TextRunExtractor } from './textRuns.js';
import { IGraphExtractor, type ExtractContext, type PdfJsPage, type PdfJsTextItem } from './types.js';
import { VectorRectExtractor } from './vectorRects.js';

export * from './types.js';
export { extractLinks, extractHighlights, extractWidgets, AnnotationExtractor } from './annotations.js';
export { groupIntoLines, mergeBlockSegments, BlockExtractor } from './blocks.js';
export { styleFromName } from './fonts.js';
export { extractImages, ImageExtractor } from './images.js';
export { TextRunExtractor } from './textRuns.js';
export { extractVectorRects, applyVectorRects, VectorRectExtractor, type VectorRect } from './vectorRects.js';
export * from './factory.js';

/** Los extractores por default, en el orden de fusión documentado arriba. */
export const defaultGraphExtractors = (): IGraphExtractor[] => [
  new TextRunExtractor(),
  new VectorRectExtractor(),
  new BlockExtractor(),
  new ImageExtractor(),
  new AnnotationExtractor(),
];

/** Multi-bind de los extractores default en un container (el orden de binding
 *  ES el orden de fusión; `getAll(IGraphExtractor)` los devuelve así). */
export function bindGraphExtractors(container: Container): void {
  container.bind(IGraphExtractor).to(TextRunExtractor);
  container.bind(IGraphExtractor).to(VectorRectExtractor);
  container.bind(IGraphExtractor).to(BlockExtractor);
  container.bind(IGraphExtractor).to(ImageExtractor);
  container.bind(IGraphExtractor).to(AnnotationExtractor);
}

export async function extractPageGraph(
  page: PdfJsPage,
  extractors: IGraphExtractor[] = defaultGraphExtractors(),
): Promise<PageGraph> {
  // Resuelve los fonts embebidos en commonObjs (y, en el browser, los registra
  // como FontFace si la página ya se renderizó a canvas) — y da el operator
  // list del que salen imágenes y rects vectoriales.
  const opList = await page.getOperatorList();
  const tc = await page.getTextContent({ disableNormalization: true });
  const annots = await page.getAnnotations().catch(() => [] as unknown[]);
  const [x0, y0, x1, y1] = page.view as [number, number, number, number];
  const fontCache = new Map<string, FontInfo>();
  const draft: Partial<PageGraph> = {};
  const ctx: ExtractContext = {
    page: page.pageNumber,
    x0, y0,
    width: x1 - x0,
    height: y1 - y0,
    opList,
    annots,
    items: tc.items as PdfJsTextItem[],
    fontInfoFor: name => fontInfoFor(page, name, fontCache),
    draft,
  };
  for (const extractor of extractors) {
    Object.assign(draft, await extractor.extract(page, ctx));
  }
  return {
    page: page.pageNumber,
    width: x1 - x0,
    height: y1 - y0,
    runs: draft.runs ?? [],
    lines: draft.lines ?? [],
    segments: draft.segments ?? [],
    images: draft.images ?? [],
    widgets: draft.widgets ?? [],
    links: draft.links ?? [],
    highlights: draft.highlights ?? [],
    shapes: draft.shapes ?? [],
  };
}
