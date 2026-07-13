/**
 * WidgetEditApplier — fase 'document'. Trasplante VERBATIM de v1
 * bake/widgets.ts: los widgets AcroForm viven en /Annots, no en el content
 * stream — move/scale reescribe el /Rect del widget (WidgetLocator: nombre +
 * rect, tol 2.5); remove saca el campo del form. Las appearances se refrescan
 * UNA vez al final si algo se tocó (try/catch: los viewers las regeneran
 * igual — la regresión widgetAppearance.test depende del no-touch).
 */
import type { PDFDocument } from 'pdf-lib';
import type { AnyEdit, WidgetEdit } from '../../model/edits.js';
import { WidgetLocator } from '../locate/annotRectLocator.js';
import { BakeCodes } from '../report.js';
import type { DocBakeContext } from '../context.js';
import { byKind, type IEditApplier } from './types.js';

export class WidgetEditApplier implements IEditApplier {
  readonly phase = 'document' as const;
  canHandle = byKind('widget');
  private readonly locator = new WidgetLocator();

  apply(edits: AnyEdit[], ctx: DocBakeContext): void {
    if (!edits.length) return;
    const { doc, report } = ctx;
    let form: ReturnType<PDFDocument['getForm']>;
    try {
      form = doc.getForm();
    } catch {
      report.warning(BakeCodes.NoAcroForm, undefined);
      return;
    }
    let touched = false;
    for (const anyEdit of edits) {
      const edit = anyEdit as WidgetEdit;
      const found = this.locator.locate({ fieldName: edit.original.fieldName, original: edit.original }, form);
      if (!found) {
        report.warning(BakeCodes.WidgetNotLocated, edit.widgetId, { fieldName: edit.original.fieldName });
        continue;
      }
      if (edit.remove) {
        try {
          form.removeField(found.field);
          report.applied(BakeCodes.WidgetRemoved, edit.widgetId, { fieldName: edit.original.fieldName });
          touched = true;
        } catch (err) {
          report.warning(BakeCodes.WidgetRemoveFailed, edit.widgetId, { message: err instanceof Error ? err.message : 'error' });
        }
        continue;
      }
      found.widget.setRectangle({
        x: edit.x ?? edit.original.x,
        y: edit.y ?? edit.original.y,
        width: edit.width ?? edit.original.width,
        height: edit.height ?? edit.original.height,
      });
      report.applied(BakeCodes.WidgetRelocated, edit.widgetId, { fieldName: edit.original.fieldName });
      touched = true;
    }
    if (touched) {
      try {
        form.updateFieldAppearances();
      } catch {
        /* appearances: the viewer regenerates them */
      }
    }
  }
}
