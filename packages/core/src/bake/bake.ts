/**
 * bake/bake.ts — EL COORDINADOR del bake (audit §3, la pieza central de F3).
 *
 * Aplica las ediciones (AnyEdit) sobre el PDF real: nunca pinta encima, nunca
 * redibuja con una fuente aproximada. Los operadores originales se extirpan
 * IN-PLACE y el contenido se re-emite (reubicado / escalado / reescrito).
 *
 * Estrategia por edit (más fiel primero, jamás adivinar) — ver
 * {@link textEmitStrategies} en `text.ts`:
 *  A) Move/scale → cada show op re-emitido VERBATIM. Pixel-perfect.
 *  B) Texto nuevo, misma fuente → re-encodeado con la fuente ORIGINAL vía el
 *     mapa /ToUnicode inverso. Chars fuera del subset → C, con warning.
 *  C) Cambio de familia/estilo o subset insuficiente → fuente estándar
 *     embebida (sustitución explícita y reportada — la política Acrobat).
 *
 * ORQUESTACIÓN (contrato {@link IEditApplier}, ver appliers/types.ts):
 *  1. FASE 'document' — widgets, highlights, links viven en /Annots y NO tocan
 *     el content stream, por eso corren ANTES del walk por página. Su orden de
 *     bind (widget → highlight → link) se preserva de v1.
 *  2. FASE 'page' — un {@link PageBakeContext} por página (walk con el predicado
 *     `isContentFill: raw => !isWhite(raw)` INYECTADO — sin él el backstop del
 *     papel blanco de JotForm se rompe), appliers en orden (image → shape →
 *     segment), luego rebuild (splices + appendBlocks).
 *  3. FALLBACKS — los draws de fuente sustituta acumulados se dibujan al final.
 *
 * Un edit que ningún applier reclama (kind desconocido) se reporta como
 * warning UnclaimedEdit y no rompe: lo que no se entiende, no se toca.
 */
import { PDFDocument } from 'pdf-lib';
import { isWhite } from '../common/rawFill.js';
import type { AnyEdit, HighlightEdit, ImageEdit, LinkEdit, SegmentEdit, ShapeEdit, WidgetEdit } from '../model/edits.js';
import { walkContent } from '../pdf/contentWalk.js';
import { pageContentBytes, setPageContents } from '../pdf/pageContent.js';
import { rebuild } from '../pdf/splice.js';
import { drawFallbackTexts, type FallbackDraw } from './fonts/fallback.js';
import type { IFallbackFontProvider } from './fonts/fontProviders.js';
import { BakeCodes, BakeReport, type BakeResult } from './report.js';
import { PageBakeContext, type DocBakeContext } from './context.js';
import type { IEditApplier } from './appliers/types.js';
import { WidgetEditApplier } from './appliers/widgetApplier.js';
import { HighlightEditApplier } from './appliers/highlightApplier.js';
import { LinkEditApplier } from './appliers/linkApplier.js';
import { ImageEditApplier } from './appliers/imageApplier.js';
import { ShapeEditApplier } from './appliers/shapeApplier.js';
import { SegmentEditApplier } from './appliers/segmentApplier.js';

export type { BakeResult, BakeEvent, BakeCode } from './report.js';
export { BakeReport, BakeCodes, formatBakeEvent } from './report.js';

/**
 * El set de appliers por defecto, EN ORDEN DE BIND (es contrato, no accidente):
 * fase 'document' primero (widget → highlight → link, no tocan /Contents),
 * luego fase 'page' (image → shape → segment). Idéntico al cableado a mano de
 * v1 bake.ts. Agregar un tipo de edit = una clase + un item acá (o un bind en
 * el container que multi-bindea IEditApplier).
 */
export function defaultEditAppliers(): IEditApplier[] {
  return [
    new WidgetEditApplier(),
    new HighlightEditApplier(),
    new LinkEditApplier(),
    new ImageEditApplier(),
    new ShapeEditApplier(),
    new SegmentEditApplier(),
  ];
}

export interface BakeOptions {
  /** Los appliers a correr. Default: {@link defaultEditAppliers}. El host con
   *  container pasa `container.getAll(IEditApplier)`. */
  appliers?: readonly IEditApplier[];
  /** Cadena de font providers para el fallback. Default: registry global
   *  (compat con la API npm sin container — el boot Node lo puebla). */
  fontProviders?: readonly IFallbackFontProvider[];
}

/** page-phase edits llevan `.page` (segment/image/shape). */
const pageOf = (edit: AnyEdit): number => (edit as { page: number }).page;

/**
 * Bakea `edits` sobre `pdfBytes`. La API pública v2 (el shim
 * {@link bakeSegmentEdits} conserva la firma posicional de v1 para los tests y
 * consumidores viejos).
 */
export async function bake(
  pdfBytes: Uint8Array,
  edits: readonly AnyEdit[],
  opts?: BakeOptions,
): Promise<BakeResult> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const report = new BakeReport();
  const appliers = opts?.appliers ?? defaultEditAppliers();
  const fallbackDraws: FallbackDraw[] = [];

  // Edit sin dueño (kind desconocido) → warning, jamás throw (v2 estructural).
  for (const edit of edits) {
    if (!appliers.some(a => a.canHandle(edit))) {
      report.warning(BakeCodes.UnclaimedEdit, nodeIdOf(edit), { kind: edit.kind });
    }
  }

  const docAppliers = appliers.filter(a => a.phase === 'document');
  const pageAppliers = appliers.filter(a => a.phase === 'page');

  // ── FASE 'document' (/Annots — sin content stream) ──
  const docCtx: DocBakeContext = { doc, report };
  for (const applier of docAppliers) {
    const claimed = edits.filter(e => applier.canHandle(e));
    if (claimed.length) applier.apply(claimed, docCtx);
  }

  // ── FASE 'page' (con PageBakeContext por página) ──
  const pageEdits = edits.filter(e => pageAppliers.some(a => a.canHandle(e)));
  const pageNums = [...new Set(pageEdits.map(pageOf))].sort((a, b) => a - b);

  for (const pageNum of pageNums) {
    const page = pages[pageNum - 1];
    if (!page) {
      report.warning(BakeCodes.PageOutOfRange, undefined, { page: pageNum });
      continue;
    }
    let src: Uint8Array;
    try {
      src = pageContentBytes(doc, page);
    } catch (err) {
      report.warning(BakeCodes.UnreadableStream, undefined, {
        page: pageNum,
        message: err instanceof Error ? err.message : 'stream ilegible',
      });
      continue;
    }
    // isContentFill inyectado: el walk (Layer 1) reporta hechos; el brain (acá)
    // le da la heurística de negocio "papel blanco no cuenta como contenido"
    // para computar el backstop del "enviar al fondo" (JotForm).
    const walk = walkContent(src, { isContentFill: raw => !isWhite(raw) });
    const ctx = new PageBakeContext(doc, page, pageNum, walk, src, fallbackDraws, report);

    for (const applier of pageAppliers) {
      const claimed = pageEdits.filter(e => pageOf(e) === pageNum && applier.canHandle(e));
      if (claimed.length) applier.apply(claimed, ctx);
    }

    if (ctx.splices.length || ctx.appendBlocks.length) {
      setPageContents(doc, page, rebuild(src, ctx.splices, '', ctx.appendBlocks.join('\n')));
    }
  }

  await drawFallbackTexts(doc, fallbackDraws, report, opts?.fontProviders);
  return report.finish(await doc.save());
}

/** Id del nodo editado, sea cual sea el kind (para el warning UnclaimedEdit). */
function nodeIdOf(edit: AnyEdit): string | undefined {
  const e = edit as unknown as Record<string, unknown>;
  return (e.segmentId ?? e.imageId ?? e.widgetId ?? e.highlightId ?? e.linkId ?? e.shapeId) as
    | string
    | undefined;
}

/**
 * Shim DEPRECADO — conserva la firma posicional de v1
 * (`bakeSegmentEdits(bytes, edits, imageEdits?, …, shapeEdits?)`). Arma la
 * unión {@link AnyEdit} por kind y delega en {@link bake}. Los tests de v1 y
 * los consumidores viejos (agent/session, server/routes/bake, editor) lo
 * llaman con posicionales — no se rompe hasta que todos migren a `bake`.
 *
 * @deprecated usar `bake(bytes, edits: AnyEdit[])`.
 */
export function bakeSegmentEdits(
  pdfBytes: Uint8Array,
  edits: SegmentEdit[],
  imageEdits: ImageEdit[] = [],
  widgetEdits: WidgetEdit[] = [],
  highlightEdits: HighlightEdit[] = [],
  linkEdits: LinkEdit[] = [],
  shapeEdits: ShapeEdit[] = [],
): Promise<BakeResult> {
  const all: AnyEdit[] = [
    ...edits.map(e => ({ kind: 'segment', ...e }) as AnyEdit),
    ...imageEdits.map(e => ({ kind: 'image', ...e }) as AnyEdit),
    ...widgetEdits.map(e => ({ kind: 'widget', ...e }) as AnyEdit),
    ...highlightEdits.map(e => ({ kind: 'highlight', ...e }) as AnyEdit),
    ...linkEdits.map(e => ({ kind: 'link', ...e }) as AnyEdit),
    ...shapeEdits.map(e => ({ kind: 'shape', ...e }) as AnyEdit),
  ];
  return bake(pdfBytes, all);
}
