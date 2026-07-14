/**
 * bake/widthFit.ts — WIDTH FITTING: encajar un run re-emitido en su SLOT
 * geométrico. Fuente ÚNICA del cálculo y del clamp (la comparten el path B de
 * text.ts y el fallback de fonts/fallback.ts — jamás duplicar la regla).
 *
 * El caso: un run re-estilado viene ANCLADO a su x real del PDF y el run
 * siguiente también (restyleFromGraph) — el SLOT entre anclas es conocido.
 * Pero la cara nueva (el bold del fallback, o el re-encode sin el kerning TJ
 * original) tiene otro ancho natural: si es más ANCHA, el último glifo invade
 * la ancla siguiente ("a]" pegado); más angosta, deja un agujero que el
 * re-extract clasifica como espacio/columna. El fix: Tz (horizontal scaling,
 * ISO 32000 §9.3.4) = (slot/natural)×100 — el texto dibujado termina EXACTO
 * en la ancla siguiente.
 *
 * CLAMP DE CORDURA (sagrado): fuera de 65%–135% NO se ajusta — texto deforme
 * es PEOR que un solape leve o un hueco. Y con |natural−slot| ≤ 0.2pt tampoco
 * (ruido de medición: no ensuciar el stream con Tz ≈ 100.0).
 */

/** Tz mínimo/máximo (%) que se acepta emitir. Fuera de rango: sin ajuste. */
export const FIT_MIN_HSCALE = 65;
export const FIT_MAX_HSCALE = 135;
/** Diferencia (pt) por debajo de la cual no vale la pena ajustar. */
export const FIT_TOLERANCE_PT = 0.2;

/**
 * Tz (%) que encaja un texto de ancho `natural` (pt, a Tz=100) en un `slot`
 * (pt). `undefined` = no ajustar (sin slot útil, diferencia despreciable, o
 * fuera del clamp de cordura).
 */
export function fitHScale(natural: number, slot: number): number | undefined {
  if (!Number.isFinite(natural) || !Number.isFinite(slot)) return undefined;
  if (natural <= 0 || slot <= 0) return undefined;
  if (Math.abs(natural - slot) <= FIT_TOLERANCE_PT) return undefined;
  const tz = (slot / natural) * 100;
  if (tz < FIT_MIN_HSCALE || tz > FIT_MAX_HSCALE) return undefined;
  return tz;
}
