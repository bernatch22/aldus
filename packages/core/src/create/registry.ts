/**
 * create/registry.ts — la familia de operaciones de CREACIÓN como registry
 * abierto (audit §3.2.4): `ICreateOp {kind, run}` multi-bound. El /ops del
 * server (F7) hace getAll(ICreateOp) + probe por kind en vez del switch a
 * mano. Agregar una capacidad = una clase/objeto + un bind.
 *
 * También vive acá {@link appendAnnot}: el patrón `lookupMaybe(/Annots) ??
 * obj([])` + push + set que v1 repetía 3× (firma, highlight, link) —
 * duplicación #5 del audit.
 */
import { PDFArray, PDFName, PDFRef, type PDFContext, type PDFPage } from 'pdf-lib';
import { createToken } from '../ioc/container.js';

/** Una operación de creación one-shot: bytes → bytes (+ extras por kind). */
export interface ICreateOp {
  readonly kind: string;
  /** Corre la creación. `spec` es el spec propio del kind (tipado en cada
   *  módulo); el resultado siempre lleva `pdf` y puede llevar extras
   *  (name/rect/value…). Tira Error con mensaje de usuario si el spec es
   *  inválido (página fuera de rango, campo inexistente…). */
  run(pdfBytes: Uint8Array, spec: unknown): Promise<{ pdf: Uint8Array } & Record<string, unknown>>;
}

export const ICreateOp = createToken<ICreateOp>('ICreateOp');

/**
 * Alta de una anotación en /Annots de la página.
 * lookupMaybe: la variante tipada LANZA si /Annots falta — el `?? obj([])`
 * (crear el array en una página sin anotaciones) nunca llegaría a correr.
 */
export function appendAnnot(ctx: PDFContext, page: PDFPage, ref: PDFRef): void {
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray) ?? ctx.obj([]);
  annots.push(ref);
  page.node.set(PDFName.of('Annots'), annots);
}
