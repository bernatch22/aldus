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
import type { DocGraph } from './graph.js';

const r = (n: number): number => Math.round(n);

export function serializeDoc(doc: DocGraph): string {
  const out: string[] = [];
  for (const p of doc.pages) {
    out.push(`## Página ${p.page} — ${r(p.width)}×${r(p.height)} pt`);

    if (p.segments.length) {
      out.push('### Texto  (id @(x,y) tamaño: "contenido")');
      // Orden de lectura: de arriba hacia abajo, izquierda a derecha.
      const segs = [...p.segments].sort((a, b) => b.baseline - a.baseline || a.x - b.x);
      for (const s of segs) {
        const t = s.text.replace(/\n/g, '\\n');
        out.push(`- ${s.id} @(${r(s.x)},${r(s.baseline)}) ${r(s.fontSize)}pt: ${JSON.stringify(t)}`);
      }
    }

    if (p.images.length) {
      out.push('### Imágenes  (id @(x,y) ancho×alto)');
      for (const im of p.images) {
        out.push(`- ${im.id} @(${r(im.x)},${r(im.y)}) ${r(im.width)}×${r(im.height)}`);
      }
    }

    if (p.widgets.length) {
      out.push('### Campos de formulario  (id "nombre" tipo @(x,y) ancho×alto)');
      for (const w of p.widgets) {
        out.push(`- ${w.id} ${JSON.stringify(w.fieldName)} ${w.widgetType} @(${r(w.x)},${r(w.y)}) ${r(w.width)}×${r(w.height)}`);
      }
    }

    if (p.links.length) {
      out.push('### Links');
      for (const l of p.links) out.push(`- ${l.id} → ${JSON.stringify(l.url)} @(${r(l.x)},${r(l.y)})`);
    }

    out.push('');
  }
  return out.join('\n').trimEnd();
}
