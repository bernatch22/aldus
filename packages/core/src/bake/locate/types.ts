/**
 * bake/locate — localización de los operadores/objetos ORIGINALES de un edit,
 * siempre por GEOMETRÍA contra el snapshot `original`, nunca por índice (los
 * índices se corren; la geometría es lo que el usuario editó de verdad).
 *
 * Contrato {@link ILocator} (audit §3.2.3):
 *  - `null` = NO encontrado (el applier avisa y no toca nada).
 *  - {@link LocateConflict} = encontrado pero AMBIGUO — el conflicto viaja
 *    como DATO (la razón exacta), jamás se adivina.
 *  - Las TOLERANCIAS son constantes NOMBRADAS por tipo, en el archivo de cada
 *    locator. Los VALORES están pagados con PDFs reales: se mueven de archivo,
 *    JAMÁS se "mejoran" (regla dura #2 del plan).
 *
 * Inyección simple: cada applier conoce SU locator (sin multi-bind) — lo que
 * se unifica es el contrato.
 */

/** Resultado ambiguo: la razón exacta, como dato (el applier la reporta). */
export interface LocateConflict {
  conflict: string;
}

export const isLocateConflict = (v: unknown): v is LocateConflict =>
  typeof v === 'object' && v !== null && typeof (v as LocateConflict).conflict === 'string';

/**
 * Localizador por geometría. `TContext` es lo que el locator necesita mirar
 * (shows de la página, xobjects, /Annots del doc…) — lo aporta el applier
 * desde su PageBakeContext/DocBakeContext.
 */
export interface ILocator<TOriginal, TContext, TFound> {
  locate(original: TOriginal, ctx: TContext): TFound | LocateConflict | null;
}
