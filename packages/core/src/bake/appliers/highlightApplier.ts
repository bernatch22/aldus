/**
 * HighlightEditApplier — fase 'document'. Trasplante VERBATIM de v1
 * bake/highlights.ts (la parte de edición): los highlights viven en /Annots
 * (Subtype /Highlight) — un edit reescribe /Rect + /QuadPoints (el appearance
 * es un Form XObject que el viewer escala al /Rect, así que MOVE/RESIZE no
 * regenera AP), un RECOLOR reescribe /C Y regenera el AP (el color va quemado
 * en su content), un remove saca la anotación. Creación: create/highlight.ts.
 * `hideHighlightAnnotations` (concern de PREVIEW) vive aparte en display.ts.
 */
import { PDFName } from 'pdf-lib';
import type { AnyEdit, HighlightEdit } from '../../model/edits.js';
import { applyAnnotRectEdits } from '../annotEdits.js';
import { highlightAppearance } from '../../create/highlight.js';
import type { DocBakeContext } from '../context.js';
import { byKind, type IEditApplier } from './types.js';

export class HighlightEditApplier implements IEditApplier {
  readonly phase = 'document' as const;
  canHandle = byKind('highlight');

  apply(edits: AnyEdit[], ctx: DocBakeContext): void {
    const { doc, report } = ctx;
    applyAnnotRectEdits(
      doc,
      'Highlight',
      'resaltado',
      (edits as HighlightEdit[]).map(e => ({ id: e.highlightId, page: e.page, x: e.x, y: e.y, width: e.width, height: e.height, color: e.color, remove: e.remove, original: e.original })),
      report,
      (dict, nx, ny, nw, nh, edit) => {
        // QuadPoints ISO 32000: UL UR LL LR (y crece hacia arriba).
        dict.set(PDFName.of('QuadPoints'), doc.context.obj([nx, ny + nh, nx + nw, ny + nh, nx, ny, nx + nw, ny]));
        // RECOLOR: /C + regenerar el AP (el color va quemado en su content). El
        // AP vive en espacio local [0,0,w,h] → BBox = tamaño del rect actual.
        if (edit.color) {
          const { apRef, color } = highlightAppearance(doc.context, edit.color, nw, nh);
          dict.set(PDFName.of('C'), doc.context.obj(color));
          dict.set(PDFName.of('AP'), doc.context.obj({ N: apRef }));
        }
      },
    );
  }
}
