/**
 * Links live in /Annots (Subtype /Link): an edit rewrites /Rect (the URI
 * action is untouched), a remove pulls the annotation — the same layer
 * semantics as highlights and widgets. Creation lives in createNodes.
 */
import type { PDFDocument } from 'pdf-lib';
import type { LinkEdit } from '../model.js';
import { applyAnnotRectEdits } from './annotEdits.js';
import type { BakeReport } from './report.js';

export function applyLinkEdits(doc: PDFDocument, edits: LinkEdit[], report: BakeReport): void {
  applyAnnotRectEdits(
    doc,
    'Link',
    'link',
    edits.map(e => ({ id: e.linkId, page: e.page, x: e.x, y: e.y, width: e.width, height: e.height, remove: e.remove, original: e.original })),
    report,
  );
}
