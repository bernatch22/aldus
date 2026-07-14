/**
 * canvas/sampleColor.ts — muestrea el COLOR de cada run de texto del canvas ya
 * renderizado (v1: `apps/editor/src/editor/sampleColor.ts`). pdf.js no expone
 * el color por run (getTextContent solo da geometría), así que lo leemos de
 * los píxeles: en el bbox del run buscamos el píxel más "tinta" (más lejano
 * del blanco) — el color del texto. Es best-effort y solo para DISPLAY; el
 * bake toma el color exacto del content stream.
 *
 * AJUSTE v2 (audit §2 / riesgo §4.4): v1 MUTABA `run.color` directo sobre el
 * grafo extraído (dos escritores silenciosos: este muestreo Y el bake exacto
 * de useLocalPreview escribían encima del mismo campo). Acá `sample()` es
 * PURO: no toca `graph` — devuelve un `Map<runKey, hex>` y el caller decide
 * cuándo/cómo aplicarlo (p. ej. PreviewService pisa esta capa con el color
 * EXACTO del bake). El cache de sesión (muestrear con getImageData en cada
 * re-bake es caro) vive en la instancia — `dispose()` lo limpia, en vez del
 * `clearColorCache()` global manual de v1.
 */

import type { IDisposable, PageGraph, TextRunNode } from '@aldus/core';

const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Clave estable de un run (página + posición + texto) — sobrevive a que el
 *  run se re-extraiga con un `id` distinto; NO sobrevive a que se mueva. */
export const runKey = (page: number, r: TextRunNode): string =>
  `${page}|${Math.round(r.baseline * 2)}|${Math.round(r.x * 2)}|${r.text}`;

/** Color dominante (por ancho) de un segmento, o negro. Toma el color de
 *  `colors` (el Map de sample/bake) si está, si no cae a `run.color`. */
export function segColor(runs: TextRunNode[], colors?: ReadonlyMap<string, string>, page?: number): string {
  const dom = runs.reduce((a, b) => (b.width > a.width ? b : a));
  const sampled = colors && page !== undefined ? colors.get(runKey(page, dom)) : undefined;
  return sampled ?? dom.color ?? '#000000';
}

export class ColorSampler implements IDisposable {
  /** '' = ya muestreado, sin color detectado (negro) — no se re-muestrea. */
  private readonly cache = new Map<string, string>();

  /** Muestrea los runs sin edición pendiente del grafo (cache primero) y
   *  devuelve `Map<runKey, hex>` — NO muta `graph`. */
  sample(graph: PageGraph, canvas: HTMLCanvasElement, scale: number): Map<string, string> {
    const out = new Map<string, string>();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return out;
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
      const key = runKey(graph.page, run);
      const cached = this.cache.get(key);
      if (cached !== undefined) { if (cached) out.set(key, cached); continue; }
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
        return out; // canvas tainted → abortar (el resto queda sin color = negro)
      }

      // Un run que TOCA un campo no se muestrea: los widgets pintan bordes/fondos
      // (y su antialiasing se derrama fuera del rect) que siempre le ganan al
      // trazo del texto — el texto "bajo los inputs" salía #dcdcdc. Negro default.
      if (widgetRects.some(wr => wr.l < left + w && wr.r > left && wr.t < top + h && wr.b > top)) { this.cache.set(key, ''); continue; }

      // Primero: la inkiness MÁXIMA (el pixel más "tinta" = núcleo del glifo).
      let maxInk = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! < 40) continue;
        const ink = (255 - data[i]!) + (255 - data[i + 1]!) + (255 - data[i + 2]!);
        if (ink > maxInk) maxInk = ink;
      }
      if (maxInk < 90) { this.cache.set(key, ''); continue; }
      // Luego: PROMEDIAR los pixels del núcleo (inkiness ≥ 80% del máximo) — un
      // solo pixel "más oscuro" puede ser un outlier de antialiasing y daba un
      // color distinto al real del canvas. El promedio del núcleo = color real.
      const thresh = maxInk * 0.8;
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! < 40) continue;
        const ink = (255 - data[i]!) + (255 - data[i + 1]!) + (255 - data[i + 2]!);
        if (ink < thresh) continue;
        sr += data[i]!; sg += data[i + 1]!; sb += data[i + 2]!; n++;
      }
      if (!n) { this.cache.set(key, ''); continue; }
      const br = sr / n, bg = sg / n, bb = sb / n;
      // Grises = antialiasing (trazos finos / chrome), no color: sin croma → negro.
      const chroma = Math.max(br, bg, bb) - Math.min(br, bg, bb);
      if (chroma < 24) { this.cache.set(key, ''); continue; }
      const hex = `#${toHex(br)}${toHex(bg)}${toHex(bb)}`;
      if (hex !== '#000000') { out.set(key, hex); this.cache.set(key, hex); }
      else this.cache.set(key, '');
    }
    return out;
  }

  dispose(): void {
    this.cache.clear();
  }
}
