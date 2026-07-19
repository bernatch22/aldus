/**
 * create/ — creación de nodos NUEVOS, un archivo por capacidad + el registry
 * abierto {@link ICreateOp} (el /ops del server hace getAll + probe por kind).
 * También las ops one-shot deterministas: forms (leer/llenar), flatten, info.
 */
import type { Container } from '../ioc/container.js';
import { ICreateOp } from './registry.js';
import { addFormField, type NewFieldSpec } from './fields.js';
import { addRadioOption, setFieldOptions } from './fieldOptions.js';
import { addText, type NewTextSpec } from './text.js';
import { addWatermark } from './watermark.js';
import { addHeaderFooter } from './headerFooter.js';
import { addHighlight } from './highlight.js';
import { addLink, removeLink } from './link.js';
import { insertImage, type NewImageSpec } from './image.js';

export { ICreateOp, appendAnnot } from './registry.js';
export { addFormField, FIELD_DEFAULT_SIZE, MODERN_WIDGET, type IFieldCreator, type NewFieldSpec } from './fields.js';
export { setFieldOptions, addRadioOption } from './fieldOptions.js';
export { addText, type NewTextSpec } from './text.js';
export { composePageBlocks, type PageBlock, type ComposeResult } from './composePage.js';
export { addWatermark } from './watermark.js';
export { addHeaderFooter } from './headerFooter.js';
export { addHighlight, highlightAppearance } from './highlight.js';
export { addLink, removeLink } from './link.js';
export { insertImage, type NewImageSpec } from './image.js';
export { readFormFields, setFieldValues, type FormField, type FieldRect } from './forms.js';
export { flattenForm, type FlattenResult } from './flatten.js';
export { readPdfInfo, isPdf, type PdfInfo } from './info.js';

/** Las ops de creación como registry (kind → run), en orden estable. */
export const defaultCreateOps = (): ICreateOp[] => [
  { kind: 'addFormField', run: (b, s) => addFormField(b, s as NewFieldSpec) },
  { kind: 'setFieldOptions', run: (b, s) => setFieldOptions(b, s as { fieldName: string; options: string[] }) },
  { kind: 'addRadioOption', run: (b, s) => addRadioOption(b, s as { fieldName: string; page: number; x: number; y: number; value?: string }) },
  { kind: 'addText', run: (b, s) => addText(b, s as NewTextSpec) },
  { kind: 'addWatermark', run: (b, s) => addWatermark(b, s as { text: string; opacity?: number; color?: string }) },
  { kind: 'addHeaderFooter', run: (b, s) => addHeaderFooter(b, s as { header?: string; footer?: string; pageNumbers?: boolean }) },
  { kind: 'addHighlight', run: (b, s) => addHighlight(b, s as { page: number; x: number; y: number; width: number; height: number; color?: string }) },
  { kind: 'addLink', run: (b, s) => addLink(b, s as { page: number; x: number; y: number; width: number; height: number; url: string }) },
  { kind: 'removeLink', run: (b, s) => removeLink(b, s as { page: number; x: number; y: number; width: number; height: number }) },
  { kind: 'insertImage', run: (b, s) => insertImage(b, s as NewImageSpec) },
];

/** Multi-bind de las ops default (orden de bind = orden del registry). */
export function bindCreateOps(container: Container): void {
  for (const op of defaultCreateOps()) container.bind(ICreateOp).toConstantValue(op);
}
