/**
 * ShapeEditApplier — fase 'page'. Trasplante VERBATIM de v1 bake/shapes.ts:
 * localiza el rect relleno por su GEOMETRÍA original entre los `fillRects`
 * del walk (FillRectLocator: nearest manhattan con tolerancia), y:
 *   - remove: extirpa el rango de bytes del path (`re … f`).
 *   - move/resize: reemplaza IN-PLACE la geometría — el color de relleno
 *     vigente y el z-order quedan intactos (el color se setea con un `rg`
 *     ANTES del path, fuera del rango; no lo tocamos). Coords en el espacio
 *     LOCAL del op (inv CTM).
 * Solo rects axis-aligned (CTM sin rotación) — con rotación se avisa y no se
 * toca. Cada fillRect se consume UNA vez (ctx.usedFillRects).
 */
import type { AnyEdit, ShapeEdit } from '../../model/edits.js';
import { fmt } from '../../common/bytes.js';
import { FillRectLocator } from '../locate/fillRectLocator.js';
import { BakeCodes } from '../report.js';
import type { PageBakeContext } from '../context.js';
import { byKind, type IEditApplier } from './types.js';

export class ShapeEditApplier implements IEditApplier {
  readonly phase = 'page' as const;
  canHandle = byKind('shape');
  private readonly locator = new FillRectLocator();

  apply(edits: AnyEdit[], ctx: PageBakeContext): void {
    if (!edits.length) return;
    const { splices, report, usedFillRects: used } = ctx;
    const fillRects = ctx.walk.fillRects;

    for (const anyEdit of edits) {
      const edit = anyEdit as ShapeEdit;
      const rect = this.locator.locate(edit.original, fillRects.filter(r => !used.has(r)));
      if (!rect) { report.warning(BakeCodes.ShapeNotLocated, edit.shapeId); continue; }
      used.add(rect);

      if (edit.remove) {
        splices.push({ start: rect.start, end: rect.end, text: '' });
        report.applied(BakeCodes.ShapeRemoved, edit.shapeId);
        continue;
      }
      const [a, b, c, d, e, f] = rect.ctm;
      if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3) {
        report.warning(BakeCodes.RotatedShapeUnsupported, edit.shapeId);
        continue;
      }
      const nx = edit.x ?? rect.x, ny = edit.y ?? rect.y;
      const nw = edit.width ?? rect.width, nh = edit.height ?? rect.height;
      // absoluto → local del op (M sin rotación): lx=(X-e)/a, ly=(Y-f)/d, lw=W/a, lh=H/d.
      const lx = (nx - e) / a, ly = (ny - f) / d, lw = nw / a, lh = nh / d;
      splices.push({ start: rect.start, end: rect.end, text: `${fmt(lx)} ${fmt(ly)} ${fmt(lw)} ${fmt(lh)} re f` });
      report.applied(BakeCodes.ShapeMoved, edit.shapeId);
    }
  }
}
