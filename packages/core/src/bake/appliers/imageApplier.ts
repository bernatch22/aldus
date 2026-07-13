/**
 * ImageEditApplier — fase 'page'. Trasplante VERBATIM de v1 bake/images.ts:
 *
 * Move/scale REPLACES the `Do` in place with `q cm /Name Do Q` (z-order and
 * paint order intact); remove just deletes it; zOrder re-emits at the edge of
 * the stream. Only Subtype /Image XObjects are ever touched — NEVER a Form
 * XObject (it wraps content; splicing it out would delete everything inside).
 */
import type { AnyEdit, ImageEdit } from '../../model/edits.js';
import { invert, mul, type Matrix } from '../../common/matrix.js';
import { fmt } from '../../common/bytes.js';
import { ImageOpLocator, imageResourceNames, xobjectRect } from '../locate/imageOpLocator.js';
import { BakeCodes } from '../report.js';
import type { PageBakeContext } from '../context.js';
import { byKind, type IEditApplier } from './types.js';

export class ImageEditApplier implements IEditApplier {
  readonly phase = 'page' as const;
  canHandle = byKind('image');
  private readonly locator = new ImageOpLocator();

  apply(edits: AnyEdit[], ctx: PageBakeContext): void {
    if (!edits.length) return;
    const { doc, page, walk, splices, appendBlocks, report } = ctx;
    const { xobjects, backstop } = walk;

    const imgNames = imageResourceNames(doc, page);
    const imageOps = xobjects.filter(o => imgNames.has(o.name));

    for (const anyEdit of edits) {
      const edit = anyEdit as ImageEdit;
      const op = this.locator.locate(edit.original, imageOps);
      if (!op) {
        report.warning(BakeCodes.ImageNotLocated, edit.imageId);
        continue;
      }
      if (edit.remove) {
        splices.push({ start: op.record.start, end: op.record.end, text: '' });
        report.applied(BakeCodes.ImageRemoved, edit.imageId);
        continue;
      }
      const r = xobjectRect(op.matrix);
      if (r.rotated) {
        report.warning(BakeCodes.RotatedImageUnsupported, edit.imageId);
        continue;
      }
      const [a, , , d] = op.matrix;
      const newW = edit.width ?? r.width;
      const newH = edit.height ?? r.height;
      const newX = edit.x ?? r.x;
      const newY = edit.y ?? r.y;
      // Preserve flips: the sign of a/d is kept; the bbox anchor is corrected
      // when the scale is negative.
      const na = a * (newW / r.width);
      const nd = d * (newH / r.height);
      const ne = newX - Math.min(0, na);
      const nf = newY - Math.min(0, nd);
      const abs: Matrix = [na, 0, 0, nd, ne, nf];

      if (edit.zOrder) {
        // Reorder: extirpate the op and re-emit it at the content edge.
        splices.push({ start: op.record.start, end: op.record.end, text: '' });
        if (edit.zOrder === 'back') {
          // The backstop runs under its own CTM → compensate (M_rel = M_abs × inv(ctm)).
          const binv = invert(backstop.ctm);
          const m = binv ? mul(abs, binv) : abs;
          const block = `q ${fmt(m[0])} ${fmt(m[1])} ${fmt(m[2])} ${fmt(m[3])} ${fmt(m[4])} ${fmt(m[5])} cm /${op.name} Do Q`;
          splices.push({ start: backstop.offset, end: backstop.offset, text: block });
        } else {
          // End of the stream: identity CTM → absolute matrix as-is.
          appendBlocks.push(`q ${fmt(abs[0])} ${fmt(abs[1])} ${fmt(abs[2])} ${fmt(abs[3])} ${fmt(abs[4])} ${fmt(abs[5])} cm /${op.name} Do Q`);
        }
        report.applied(BakeCodes.ImageZOrdered, edit.imageId, { zOrder: edit.zOrder });
        continue;
      }

      // MOVE/SCALE IN PLACE: replace the original Do with one carrying the new
      // matrix, at the SAME point of the stream (z-order and paint order
      // intact). Do NOT reorder: pdf.js numbers objIds by paint order, so
      // moving the Do to the front would change its objId → the image identity
      // would jump to another node on re-extraction. The editor keeps a moved
      // image VISIBLE with a clean-pixel sticker ON TOP (overlay), not by
      // touching the stream. The emitted matrix is RELATIVE to the CTM in
      // effect at the Do.
      const inv = invert(op.matrix);
      if (!inv) {
        report.warning(BakeCodes.DegenerateMatrix, edit.imageId);
        continue;
      }
      const rel = mul(abs, inv);
      splices.push({
        start: op.record.start,
        end: op.record.end,
        text: `q ${fmt(rel[0])} ${fmt(rel[1])} ${fmt(rel[2])} ${fmt(rel[3])} ${fmt(rel[4])} ${fmt(rel[5])} cm /${op.name} Do Q`,
      });
      report.applied(BakeCodes.ImageRelocated, edit.imageId);
    }
  }
}
