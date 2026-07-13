/**
 * TextOpLocator — los show ops de un snapshot de segmento (bloques multilínea
 * matchean TODAS sus baselines). Trasplante VERBATIM de v1 locate.matchOps:
 * mismas tolerancias, mismo rechazo de stale, mismo leftSlack de ½em.
 *
 * `null` = ningún op arranca dentro del segmento; conflict = shows encadenados
 * sin reposicionar (x desconocida sin widths) — nunca adivinar.
 */
import type { SegmentEdit } from '../../model/edits.js';
import type { ShowOp } from '../../pdf/contentWalk.js';
import type { ILocator, LocateConflict } from './types.js';

/** Geometry tolerance (pt) when matching text ops to a segment snapshot. */
export const Y_TOL = 1.8;
export const X_TOL = 1.8;

/** Razón (dato) cuando ningún op arranca dentro del segmento — el applier la
 *  renderiza en el warning byte-idéntico de v1. */
export const TEXT_NOT_LOCATED_REASON =
  'ningún operador de texto arranca dentro del segmento (¿un TJ de otra columna lo contiene?)';

export const STALE_CHAINED_SHOWS_REASON =
  'la línea tiene shows encadenados sin reposicionar (x desconocida sin widths)';

export class TextOpLocator implements ILocator<SegmentEdit['original'], ShowOp[], ShowOp[]> {
  locate(orig: SegmentEdit['original'], shows: ShowOp[]): ShowOp[] | LocateConflict | null {
    const lines = orig.baselines?.length ? orig.baselines : [orig.baseline];
    const inLine = shows.filter(s => lines.some(b => Math.abs(s.y - b) <= Y_TOL));
    if (inLine.some(s => s.stale)) {
      return { conflict: STALE_CHAINED_SHOWS_REASON };
    }
    // Margen IZQUIERDO extra de medio em: un op que arranca con un glifo de
    // ESPACIO origina 2-4pt a la izquierda del primer glifo visible (que es la x
    // extraída del segmento). Un op de la columna vecina arranca en SU x (mucho
    // más lejos: el gap de columna es > 2×charW) y un show encadenado ya fue
    // rechazado como stale — no hay ambigüedad dentro de medio em.
    const leftSlack = Math.max(X_TOL, orig.fontSize * 0.5);
    const inside = inLine.filter(s => s.x >= orig.x - leftSlack && s.x <= orig.x + orig.width + X_TOL);
    if (!inside.length) return null;
    return inside;
  }
}
