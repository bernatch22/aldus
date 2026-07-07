/**
 * serialize.ts — el grafo del documento como texto compacto para EMBEBER en el
 * system prompt del agente. La idea del diseño: el agente NO tiene una tool de
 * lectura; ve TODO el contenido acá y responde/edita directo, referenciando los
 * ids exactos. Formato pensado para pocos tokens y para que el modelo ancle sus
 * ediciones a ids reales.
 *
 * Coordenadas: puntos PDF, origen abajo-izquierda, x→derecha, y→arriba. Para el
 * texto la `y` es la BASELINE (lo que consumen las tools move_text).
 */
import type { SegmentNode } from '@aldus/core';
import type { DocGraph } from './graph.js';

const r = (n: number): number => Math.round(n);

/** Estilo del segmento (del run DOMINANTE — el de mayor tamaño): negrita,
 *  itálica, fuente PostScript y color si se conoce. Compacto para el prompt. */
function styleOf(s: SegmentNode): string {
  const run = s.runs.reduce((a, b) => (b.fontSize > a.fontSize ? b : a), s.runs[0]);
  if (!run) return '';
  const bits: string[] = [];
  if (run.font.bold) bits.push('bold');
  if (run.font.italic) bits.push('italic');
  bits.push(run.font.postScriptName || run.font.bucket);
  if (run.color) bits.push(run.color); // muestreado (browser); ausente en headless
  return bits.join(' ');
}

/** El texto más cercano a un campo (su "label"): preferimos el que está a la
 *  IZQUIERDA en la misma línea, si no el de ARRIBA, si no el más próximo. Le da
 *  al agente el ancla semántica que los nombres opacos (id-1234) no tienen. */
function nearestLabel(
  w: { x: number; y: number; width: number; height: number },
  segs: SegmentNode[],
): string | undefined {
  const cy = w.y + w.height / 2;
  let best: { s: SegmentNode; score: number } | null = null;
  for (const s of segs) {
    const sy = s.baseline;
    const dyLine = Math.abs(sy - cy);
    const leftGap = w.x - (s.x + s.width); // >0 = el texto termina a la izquierda del campo
    const aboveGap = sy - (w.y + w.height); // >0 = el texto está por encima
    let score: number;
    const belowGap = w.y - sy; // >0 = el texto está por debajo (label bajo la caja)
    const hOverlap = s.x < w.x + w.width && s.x + s.width > w.x - 40;
    if (dyLine <= w.height + 6 && leftGap >= -2 && leftGap < 220) score = leftGap; // misma línea, a la izquierda
    else if (aboveGap >= -2 && aboveGap < 26 && hOverlap) score = 300 + aboveGap; // justo arriba
    else if (belowGap >= -2 && belowGap < 20 && hOverlap) score = 600 + belowGap; // justo abajo (label bajo la caja)
    else continue;
    if (!best || score < best.score) best = { s, score };
  }
  if (!best) return undefined;
  const t = best.s.text.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

export function serializeDoc(doc: DocGraph): string {
  const out: string[] = [];
  for (const p of doc.pages) {
    out.push(`## Página ${p.page} — ${r(p.width)}×${r(p.height)} pt`);

    if (p.segments.length) {
      out.push('### Texto  (id @(x,baseline) ancho×alto tamaño estilo: "contenido")');
      // Orden de lectura: de arriba hacia abajo, izquierda a derecha.
      const segs = [...p.segments].sort((a, b) => b.baseline - a.baseline || a.x - b.x);
      for (const s of segs) {
        const t = s.text.replace(/\n/g, '\\n');
        out.push(`- ${s.id} @(${r(s.x)},${r(s.baseline)}) ${r(s.width)}×${r(s.height)} ${r(s.fontSize)}pt ${styleOf(s)}: ${JSON.stringify(t)}`);
      }
    }

    if (p.images.length) {
      out.push('### Imágenes  (id @(x,y) ancho×alto)');
      for (const im of p.images) {
        out.push(`- ${im.id} @(${r(im.x)},${r(im.y)}) ${r(im.width)}×${r(im.height)}`);
      }
    }

    if (p.widgets.length) {
      out.push('### Campos de formulario  (nombre tipo [valor] near "label" @(x,y) ancho×alto)');
      out.push('  (los nombres suelen ser opacos → usá "near" (el texto pegado al campo) para saber QUÉ va en cada uno)');
      for (const w of p.widgets) {
        const val = w.value != null ? ` = ${JSON.stringify(Array.isArray(w.value) ? w.value.join(', ') : w.value)}` : ' (vacío)';
        const opts = w.options?.length ? ` opciones:[${w.options.join(', ')}]` : '';
        const label = nearestLabel(w, p.segments);
        const near = label ? ` near ${JSON.stringify(label)}` : '';
        out.push(`- ${w.id} ${JSON.stringify(w.fieldName)} ${w.widgetType}${val}${opts}${near} @(${r(w.x)},${r(w.y)}) ${r(w.width)}×${r(w.height)}${w.readOnly ? ' read-only' : ''}`);
      }
    }

    if (p.highlights.length) {
      out.push('### Resaltados  (id color @(x,y) ancho×alto)');
      for (const h of p.highlights) out.push(`- ${h.id} ${h.color} @(${r(h.x)},${r(h.y)}) ${r(h.width)}×${r(h.height)}`);
    }

    if (p.links.length) {
      out.push('### Links  (id → url @(x,y) ancho×alto)');
      for (const l of p.links) out.push(`- ${l.id} → ${JSON.stringify(l.url)} @(${r(l.x)},${r(l.y)}) ${r(l.width)}×${r(l.height)}`);
    }

    out.push('');
  }
  return out.join('\n').trimEnd();
}
