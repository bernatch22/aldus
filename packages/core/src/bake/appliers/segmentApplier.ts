/**
 * SegmentEditApplier — fase 'page': envuelve el pipeline de texto
 * (locate → color → remove → probe de textEmitStrategies) de bake/text.ts.
 */
import type { AnyEdit, SegmentEdit } from '../../model/edits.js';
import type { PageBakeContext } from '../context.js';
import { applySegmentEdit } from '../text.js';
import { byKind, type IEditApplier } from './types.js';

export class SegmentEditApplier implements IEditApplier {
  readonly phase = 'page' as const;
  canHandle = byKind('segment');

  apply(edits: AnyEdit[], ctx: PageBakeContext): void {
    for (const edit of edits) applySegmentEdit(edit as SegmentEdit, ctx);
  }
}
