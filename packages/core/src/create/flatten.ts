/**
 * flatten.ts — aplana el AcroForm: cada widget se convierte en contenido
 * ESTÁTICO de la página (su appearance se dibuja en el content stream y el
 * campo desaparece). Es EL paso de tamper-evidence al finalizar una firma:
 * después de aplanar, los valores ya no son editables por ningún viewer.
 *
 * Honesto como todo el bake: si pdf-lib no puede aplanar (campo exótico sin
 * appearance), se reporta y se devuelven los bytes SIN tocar — nunca un PDF
 * a medio aplanar.
 */
import { PDFDocument } from 'pdf-lib';

export interface FlattenResult {
  pdf: Uint8Array;
  /** Nombres de los campos aplanados (vacío si no había AcroForm). */
  flattened: string[];
  warnings: string[];
}

export async function flattenForm(pdfBytes: Uint8Array): Promise<FlattenResult> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  let names: string[] = [];
  try {
    const form = doc.getForm();
    const fields = form.getFields();
    if (!fields.length) return { pdf: pdfBytes, flattened: [], warnings: [] };
    names = fields.map(f => f.getName());
    // Appearances al día ANTES de aplanar: lo que se hornea es lo que se ve.
    try { form.updateFieldAppearances(); } catch { /* el flatten regenera lo que pueda */ }
    form.flatten();
  } catch (err) {
    return {
      pdf: pdfBytes,
      flattened: [],
      warnings: [`no se pudo aplanar: ${err instanceof Error ? err.message : 'AcroForm ilegible'} — PDF sin cambios`],
    };
  }
  return { pdf: await doc.save(), flattened: names, warnings: [] };
}
