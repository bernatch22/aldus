/**
 * IEditApplier — el contrato ESTRELLA del bake (audit §3.2.1): mata los 7
 * parámetros posicionales de v1 bakeSegmentEdits. Agregar un tipo de edit
 * nuevo = una clase + un bind (antes: tocar la firma pública + bake.ts + un
 * archivo).
 *
 * ORDEN DE BIND (es contrato, no accidente — v1 bake.ts lo hacía a mano):
 *   fase 'document' primero — widgets, highlights, links viven en /Annots y
 *   NO tocan el content stream (por eso corren ANTES del walk por página);
 *   luego fase 'page' — imágenes, formas, segmentos, en ese orden dentro de
 *   cada página. {@link defaultEditAppliers} (bake.ts) fija ese orden.
 *
 * `apply` recibe TODOS los edits que el applier reclamó (doc-phase: los del
 * documento entero; page-phase: los de UNA página). Desvío deliberado del
 * per-edit del audit §3.2: el batch preserva la semántica v1 pagada — un solo
 * getForm() + UN updateFieldAppearances() por bake (widgets), y el set de
 * fillRects consumidos entre ShapeEdits de la misma página.
 */
import { createToken } from '../../ioc/container.js';
import type { AnyEdit, EditKind } from '../../model/edits.js';
import type { DocBakeContext, PageBakeContext } from '../context.js';

export interface IEditApplier {
  /** Self-gate barato por discriminante `kind`. Nunca tira. */
  canHandle(edit: AnyEdit): boolean;
  /** Fase doc (/Annots, sin content stream) o fase página (con PageBakeContext). */
  readonly phase: 'document' | 'page';
  /** Aplica los edits RECLAMADOS (ya filtrados por canHandle; page-phase: los
   *  de la página del contexto). Reporta todo por ctx.report; nunca tira. */
  apply(edits: AnyEdit[], ctx: DocBakeContext | PageBakeContext): void;
}

export const IEditApplier = createToken<IEditApplier>('IEditApplier');

/** Helper de self-gate por kind (todos los appliers gatean igual). */
export const byKind = (kind: EditKind) => (edit: AnyEdit): boolean => edit.kind === kind;
