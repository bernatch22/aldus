/**
 * bake/context.ts — los unit-of-work del bake (audit §3.2.2: el "target
 * container" de js-debug). En v1 esta bolsa se re-declaraba a mano en cada
 * apply*ToPage con 8-11 campos posicionales.
 *
 *  - {@link DocBakeContext}: fase 'document' (widgets y /Annots — no tocan el
 *    content stream).
 *  - {@link PageBakeContext}: fase 'page' — posee el walk de la página, los
 *    sinks (splices/appendBlocks/fallbackDraws), el FontService (dueño del
 *    encCache, scope página como en v1) y el set de fillRects ya consumidos
 *    (dos ShapeEdits no pueden colapsar al mismo op).
 */
import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { ContentWalk } from '../pdf/contentWalk.js';
import type { FillRectOp } from '../pdf/contentWalk.js';
import type { Splice } from '../pdf/splice.js';
import type { BakeReport } from './report.js';
import type { FallbackDraw } from './fonts/fallback.js';
import { FontService } from './fonts/fontService.js';

export interface DocBakeContext {
  doc: PDFDocument;
  report: BakeReport;
}

export class PageBakeContext implements DocBakeContext {
  /** Sink: in-place stream replacements. */
  readonly splices: Splice[] = [];
  /** Sink: blocks appended at the end of the stream (identity CTM, sin clip).
   *  "To front" va acá; "to back" va al backstop del walk (ver bake.ts). */
  readonly appendBlocks: string[] = [];
  /** FontService por página: dueño del cache de reverse-encoders. */
  readonly fonts = new FontService();
  /** fillRects ya matcheados por un ShapeEdit (cada rect se usa UNA vez). */
  readonly usedFillRects = new Set<FillRectOp>();

  constructor(
    public readonly doc: PDFDocument,
    public readonly page: PDFPage,
    /** 1-based. */
    public readonly pageNum: number,
    /** El walk COMPLETO de la página (shows/xobjects/fillRects/backstop). */
    public readonly walk: ContentWalk,
    /** Bytes decodificados del content stream (para re-emitir verbatim). */
    public readonly src: Uint8Array,
    /** Sink global del bake: draws con fuente sustituta (se dibujan al final). */
    public readonly fallbackDraws: FallbackDraw[],
    public readonly report: BakeReport,
  ) {}
}
