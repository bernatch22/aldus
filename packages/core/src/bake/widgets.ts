/**
 * Applying WidgetEdits — AcroForm widgets live in /Annots, not in the content
 * stream: move/scale rewrites the widget's /Rect; remove pulls the field out
 * of the form. Appearances are refreshed at the end (viewers regenerate them
 * anyway if that fails).
 */
import type { PDFDocument, PDFField, PDFWidgetAnnotation } from 'pdf-lib';
import type { WidgetEdit } from '../model.js';
import type { BakeReport } from './report.js';

export function applyWidgetEdits(doc: PDFDocument, edits: WidgetEdit[], report: BakeReport): void {
  if (!edits.length) return;
  let form: ReturnType<PDFDocument['getForm']>;
  try {
    form = doc.getForm();
  } catch {
    report.warn('el documento no tiene AcroForm — ediciones de campos saltadas');
    return;
  }
  let touched = false;
  for (const edit of edits) {
    const tol = 2.5;
    let matchedField: PDFField | null = null;
    let matchedWidget: PDFWidgetAnnotation | null = null;
    for (const field of form.getFields()) {
      if (field.getName() !== edit.original.fieldName) continue;
      for (const widget of field.acroField.getWidgets()) {
        const r = widget.getRectangle();
        if (
          Math.abs(r.x - edit.original.x) <= tol && Math.abs(r.y - edit.original.y) <= tol &&
          Math.abs(r.width - edit.original.width) <= tol && Math.abs(r.height - edit.original.height) <= tol
        ) {
          matchedField = field;
          matchedWidget = widget;
          break;
        }
      }
      if (matchedField) break;
    }
    if (!matchedField || !matchedWidget) {
      report.warn(`${edit.widgetId}: campo "${edit.original.fieldName}" no encontrado en su rect — sin cambios`);
      continue;
    }
    if (edit.remove) {
      try {
        form.removeField(matchedField);
        report.apply(`${edit.widgetId}: campo "${edit.original.fieldName}" eliminado`);
        touched = true;
      } catch (err) {
        report.warn(`${edit.widgetId}: no se pudo eliminar (${err instanceof Error ? err.message : 'error'})`);
      }
      continue;
    }
    matchedWidget.setRectangle({
      x: edit.x ?? edit.original.x,
      y: edit.y ?? edit.original.y,
      width: edit.width ?? edit.original.width,
      height: edit.height ?? edit.original.height,
    });
    report.apply(`${edit.widgetId}: campo "${edit.original.fieldName}" reubicado/escalado`);
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
