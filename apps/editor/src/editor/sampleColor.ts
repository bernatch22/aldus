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

    // El píxel con mayor "distancia al blanco" ponderada por opacidad = la tinta.
    let bestScore = -1;
    let br = 0, bg = 0, bb = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 40) continue;
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
