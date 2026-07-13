/**
 * Normalización de texto para MATCHING (no para el grafo): el usuario cita de
 * memoria, el PDF tiene su propia ortografía. Case-insensitive, sin acentos
 * (NFD + strip de combining marks U+0300..U+036F), espacios colapsados.
 * Extraída VERBATIM de v1 locateText.ts.
 *
 * ⚠️ Regla dura del plan: esta es la ÚNICA normalización de texto permitida y
 * se usa SOLO al comparar (locateText, hosts e-sign, agente). El texto del
 * grafo viaja intacto — U+0012 y compañía incluidos — o los acentos
 * LibreOffice mueren en el bake.
 */
export const normalize = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
