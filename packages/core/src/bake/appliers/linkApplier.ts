/**
 * LinkEditApplier — fase 'document'. Trasplante VERBATIM de v1 bake/links.ts
 * (19 líneas de delegación pura — el patrón objetivo ya logrado): los links
 * viven en /Annots (Subtype /Link) — un edit reescribe /Rect (la acción URI
 * no se toca), un remove saca la anotación. Creación: create/link.ts.
 */
import type { AnyEdit, LinkEdit } from '../../model/edits.js';
import { applyAnnotRectEdits } from '../annotEdits.js';
import type { DocBakeContext } from '../context.js';
import { byKind, type IEditApplier } from './types.js';

export class LinkEditApplier implements IEditApplier {
  readonly phase = 'document' as const;
  canHandle = byKind('link');

  apply(edits: AnyEdit[], ctx: DocBakeContext): void {
    applyAnnotRectEdits(
      ctx.doc,
      'Link',
      'link',
      (edits as LinkEdit[]).map(e => ({ id: e.linkId, page: e.page, x: e.x, y: e.y, width: e.width, height: e.height, remove: e.remove, original: e.original })),
      ctx.report,
    );
  }
}
