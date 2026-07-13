/**
 * graph/locateText.ts — localizador por TEXTO CITADO sobre el grafo: "la firma
 * va debajo de PARTE RECEPTORA, página 5". Devuelve el segmento que contiene
 * el needle con su rect real (y el sub-rect aproximado del span matcheado),
 * para colocar nodos nuevos ANCLADOS a texto en vez de a coordenadas a ciegas.
 *
 * Matching normalizado (case/acentos/espacios, common/text.normalize) — el
 * usuario cita de memoria, el PDF tiene su propia ortografía. Empates:
 * `prefer` ('shortest' = el segmento más corto que lo contiene, el ancla más
 * apretada; 'first' = orden de lectura). Sin match → null, nunca una
 * adivinanza.
 *
 * v2: consulta el índice `byNormalizedText` del PageGraphService (v1 escaneaba
 * `g.segments.filter(...)` lineal por página). Semántica idéntica.
 */
import { normalize } from '../common/text.js';
import type { SegmentNode } from '../model/nodes.js';
import type { IPageGraphService } from './pageGraphService.js';

export interface TextAnchor {
  page: number;
  segmentId: string;
  /** Texto REAL del segmento ancla (sin normalizar). */
  text: string;
  /** Rect del segmento entero (puntos PDF, origen abajo-izquierda). */
  rect: { x: number; y: number; width: number; height: number };
  /** Sub-rect aproximado del span matcheado (interpolación por caracteres). */
  matchRect: { x: number; y: number; width: number; height: number };
}

export function locateText(
  graphs: IPageGraphService,
  needle: string,
  opts?: { pageHint?: number; prefer?: 'shortest' | 'first' },
): TextAnchor | null {
  const n = normalize(needle);
  if (!n) return null;
  const prefer = opts?.prefer ?? 'shortest';

  const anchorFrom = (seg: SegmentNode): TextAnchor => {
    // Sub-rect por interpolación de caracteres sobre el texto NORMALIZADO
    // (aprox honesta: sirve para above/below/right-of, no para recortes finos).
    const segNorm = normalize(seg.text);
    const start = segNorm.indexOf(n);
    const frac = (i: number) => (segNorm.length ? i / segNorm.length : 0);
    const mx = seg.x + seg.width * frac(Math.max(0, start));
    const mw = seg.width * (n.length / Math.max(1, segNorm.length));
    return {
      page: seg.page,
      segmentId: seg.id,
      text: seg.text,
      rect: { x: seg.x, y: seg.y, width: seg.width, height: seg.height },
      matchRect: { x: mx, y: seg.y, width: Math.min(mw, seg.width), height: seg.height },
    };
  };

  // El índice ya viene en orden de página; agrupamos y respetamos el pageHint
  // (v1: la página del hint primero, después el resto en orden).
  const hits = graphs.byNormalizedText(needle);
  if (!hits.length) return null;
  const pageNums = [...new Set(hits.map(s => s.page))];
  const ordered = opts?.pageHint
    ? [...pageNums.filter(p => p === opts.pageHint), ...pageNums.filter(p => p !== opts.pageHint)]
    : pageNums;

  for (const pageNum of ordered) {
    const pageHits = hits.filter(s => s.page === pageNum);
    if (!pageHits.length) continue;
    if (prefer === 'first') {
      // Orden de lectura: de arriba hacia abajo, izquierda a derecha.
      const first = [...pageHits].sort((a, b) => b.baseline - a.baseline || a.x - b.x)[0]!;
      return anchorFrom(first);
    }
    const tightest = [...pageHits].sort((a, b) => a.text.length - b.text.length)[0]!;
    return anchorFrom(tightest);
  }
  return null;
}
