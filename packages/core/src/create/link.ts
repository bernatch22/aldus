/**
 * create/link.ts — links NUEVOS + removeLink.
 *
 * addLink: VERBATIM v1 (annotación /Link con acción URI, vía appendAnnot).
 * removeLink: en v1 DUPLICABA el loop de annotEdits casi línea a línea
 * (duplicación #4 del audit) — acá usa el AnnotRectLocator unificado con la
 * MISMA tolerancia (2pt) y la misma semántica de retorno: {pdf original,
 * removed:false} si no hay /Annots o no matchea; save solo si removió.
 */
import { PDFDocument, PDFString } from 'pdf-lib';
import { AnnotRectLocator } from '../bake/locate/annotRectLocator.js';
import { appendAnnot } from './registry.js';

export async function addLink(
  pdfBytes: Uint8Array,
  spec: { page: number; x: number; y: number; width: number; height: number; url: string },
): Promise<{ pdf: Uint8Array }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);
  const ctx = doc.context;
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [spec.x, spec.y, spec.x + spec.width, spec.y + spec.height],
    Border: [0, 0, 0],
    A: ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(spec.url) }),
  });
  appendAnnot(ctx, page, ctx.register(dict));
  return { pdf: await doc.save() };
}

const locator = new AnnotRectLocator();

export async function removeLink(
  pdfBytes: Uint8Array,
  spec: { page: number; x: number; y: number; width: number; height: number },
): Promise<{ pdf: Uint8Array; removed: boolean }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) throw new Error(`página ${spec.page} fuera de rango`);
  const found = locator.locate(
    { subtype: 'Link', original: { x: spec.x, y: spec.y, width: spec.width, height: spec.height } },
    { doc, page },
  );
  if (!found) return { pdf: pdfBytes, removed: false };
  found.annots.remove(found.index);
  return { pdf: await doc.save(), removed: true };
}
