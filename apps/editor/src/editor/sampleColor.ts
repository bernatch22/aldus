/**
 * sampleColor.ts — muestrea el COLOR de cada run de texto del canvas ya
 * renderizado. pdf.js no expone el color por run (getTextContent solo da
 * geometría), así que lo leemos de los píxeles: en el bbox del run buscamos el
 * píxel más "tinta" (más lejano del blanco) — el color del texto. Es best-effort
 * y solo para DISPLAY; el bake toma el color exacto del content stream.
 */

import type { PageGraph, TextRunNode } from '@aldus/core';

const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

// CACHE de colores por run (clave = página + posición + texto, estable para un
// run que no se movió): muestrear con getImageData en CADA re-bake era caro Y,
// peor, si se saltea, los runs pierden el color. Con cache, el estado base
// muestrea todo y los re-bakes reaplican por clave sin leer píxeles. '' = run
// sin color (negro) ya muestreado — no se re-muestrea.
const colorCache = new Map<string, string>();
export function clearColorCache(): void { colorCache.clear(); }
const runKey = (page: number, r: TextRunNode): string =>
  `${page}|${Math.round(r.baseline * 2)}|${Math.round(r.x * 2)}|${r.text}`;

/** Muta `run.color` de cada run del grafo: cache primero, muestreo solo lo que
 *  falta (coords CSS×dpr). */
export function sampleRunColors(graph: PageGraph, canvas: HTMLCanvasElement, scale: number): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const dpr = canvas.width / (graph.width * scale); // px de canvas por punto PDF

  // Los WIDGETS pintan su apariencia (bordes/fondo) en el canvas: un run que
  // se solapa con un campo muestreaba la tinta del CAMPO, no la del texto —
  // el texto quedaba cacheado "de otro color". Sus rects se excluyen.
  const k = scale * dpr;
  const widgetRects = graph.widgets.map(w => ({
    l: Math.floor(w.x * k) - 1, t: Math.floor((graph.height - w.y - w.height) * k) - 1,
    r: Math.ceil((w.x + w.width) * k) + 1, b: Math.ceil((graph.height - w.y) * k) + 1,
  }));

  for (const run of graph.runs) {
    if (run.angle && Math.abs(run.angle) > 0.01) continue;
    // Cache: hit → reaplicar sin leer píxeles ('' = negro, sin color).
    const key = runKey(graph.page, run);
    const cached = colorCache.get(key);
    if (cached !== undefined) { if (cached) run.color = cached; continue; }
    // bbox del run en píxeles del canvas (origen arriba-izquierda).
    const left = Math.floor(run.x * scale * dpr);
    const top = Math.floor((graph.height - run.baseline - run.fontSize * 0.25) * scale * dpr);
    const w = Math.max(1, Math.ceil(run.width * scale * dpr));
    const h = Math.max(1, Math.ceil(run.fontSize * 1.1 * scale * dpr));
    if (left < 0 || top < 0 || left + w > canvas.width || top + h > canvas.height || w * h > 200000) continue;

    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(left, top, w, h).data;
    } catch {
      return; // canvas tainted → abortar (todos quedan sin color = negro)
    }

    // Un run que TOCA un campo no se muestrea: los widgets pintan bordes/fondos
    // (y su antialiasing se derrama fuera del rect) que siempre le ganan al
    // trazo del texto — el texto "bajo los inputs" salía #dcdcdc. Negro default.
    if (widgetRects.some(wr => wr.l < left + w && wr.r > left && wr.t < top + h && wr.b > top)) { colorCache.set(key, ''); continue; }

    // Primero: la inkiness MÁXIMA (el pixel más "tinta" = núcleo del glifo).
    let maxInk = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 40) continue;
      const ink = (255 - data[i]) + (255 - data[i + 1]) + (255 - data[i + 2]);
      if (ink > maxInk) maxInk = ink;
    }
    if (maxInk < 90) { colorCache.set(key, ''); continue; }
    // Luego: PROMEDIAR los pixels del núcleo (inkiness ≥ 80% del máximo) — un
    // solo pixel "más oscuro" puede ser un outlier de antialiasing y daba un
    // color distinto al real del canvas. El promedio del núcleo = color real.
    const thresh = maxInk * 0.8;
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 40) continue;
      const ink = (255 - data[i]) + (255 - data[i + 1]) + (255 - data[i + 2]);
      if (ink < thresh) continue;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
    }
    if (!n) { colorCache.set(key, ''); continue; }
    const br = sr / n, bg = sg / n, bb = sb / n;
    // Grises = antialiasing (trazos finos / chrome), no color: sin croma → negro.
    const chroma = Math.max(br, bg, bb) - Math.min(br, bg, bb);
    if (chroma < 24) { colorCache.set(key, ''); continue; }
    const hex = `#${toHex(br)}${toHex(bg)}${toHex(bb)}`;
    if (hex !== '#000000') { run.color = hex; colorCache.set(key, hex); }
    else colorCache.set(key, '');
  }
}

/** Color dominante (por ancho) de un segmento, o negro. */
export function segColor(runs: TextRunNode[]): string {
  const dom = runs.reduce((a, b) => (b.width > a.width ? b : a));
  return dom.color ?? '#000000';
}
