/**
 * sampleColor.ts — muestrea el COLOR de cada run de texto del canvas ya
 * renderizado. pdf.js no expone el color por run (getTextContent solo da
 * geometría), así que lo leemos de los píxeles: en el bbox del run buscamos el
 * píxel más "tinta" (más lejano del blanco) — el color del texto. Es best-effort
 * y solo para DISPLAY; el bake toma el color exacto del content stream.
 */

import type { PageGraph, TextRunNode } from '@aldus/core';

const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Muta `run.color` de cada run del grafo leyendo el canvas (coords CSS×dpr). */
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

    // Solo los widgets que tocan ESTE bbox obligan al chequeo por píxel.
    const near = widgetRects.filter(wr => wr.l < left + w && wr.r > left && wr.t < top + h && wr.b > top);

    // El píxel con mayor "distancia al blanco" ponderada por opacidad = la tinta.
    let bestScore = -1;
    let br = 0, bg = 0, bb = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 40) continue;
      if (near.length) {
        const p = i / 4;
        const px = left + (p % w);
        const py = top + Math.floor(p / w);
        if (near.some(wr => px >= wr.l && px < wr.r && py >= wr.t && py < wr.b)) continue;
      }
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const inkiness = (255 - r) + (255 - g) + (255 - b); // qué tan oscuro/saturado
      const score = inkiness * (a / 255);
      if (score > bestScore) { bestScore = score; br = r; bg = g; bb = b; }
    }
    // Sin tinta suficiente (run vacío / muy claro) → dejar negro por defecto.
    if (bestScore < 90) continue;
    const hex = `#${toHex(br)}${toHex(bg)}${toHex(bb)}`;
    if (hex !== '#000000') run.color = hex;
  }
}

/** Color dominante (por ancho) de un segmento, o negro. */
export function segColor(runs: TextRunNode[]): string {
  const dom = runs.reduce((a, b) => (b.width > a.width ? b : a));
  return dom.color ?? '#000000';
}
