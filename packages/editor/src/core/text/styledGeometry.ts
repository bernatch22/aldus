/**
 * styledGeometry — preservar la GEOMETRÍA del PDF al re-estilar sin cambiar texto.
 *
 * El caso: el usuario aplica bold/italic/color a una palabra SIN tocar el texto.
 * El camino normal del commit (applyTextDiff + applyAlign) recalcula los `dx`
 * midiendo con la fuente del BROWSER — que difiere de la métrica real del PDF
 * (itálicas, glifos sin /ToUnicode tipo U+0011/U+0012). El bake re-emite con
 * esos dx corridos → huecos → el re-extract los lee como espacios de palabra
 * ("nombre ]") o directamente parte el nodo (gap de columna).
 *
 * Con texto idéntico, la geometría correcta YA LA TENEMOS: son los dx del seed
 * (los del PDF si es la primera edición; los del edit previo si no). Esta
 * función re-corta el texto en la UNIÓN de fronteras (seed ∪ estilados), toma
 * el ESTILO del run estilado que cubre cada tramo, y el `dx` del seed cuando el
 * tramo arranca exactamente donde arrancaba un run del seed. Resultado: mismos
 * bytes de posición que el original, estilos nuevos.
 */
import type { StyledRun } from '@aldus/core';

/** Pre-condición: `seed` y `styled` concatenan EXACTAMENTE el mismo texto. */
export function restyleKeepingGeometry(seed: StyledRun[], styled: StyledRun[]): StyledRun[] {
  const text = seed.map(r => r.text).join('');
  const total = text.length;

  // Fronteras: la unión de los inicios de run de ambos lados.
  const starts = new Set<number>([0]);
  let off = 0;
  for (const r of seed) { starts.add(off); off += r.text.length; }
  off = 0;
  for (const r of styled) { starts.add(off); off += r.text.length; }
  const cuts = [...starts].filter(c => c < total).sort((a, b) => a - b);

  // dx del seed, indexado por el offset de inicio de su run.
  const seedDxAt = new Map<number, number>();
  off = 0;
  for (const r of seed) { if (r.dx !== undefined) seedDxAt.set(off, r.dx); off += r.text.length; }

  const runAt = (runs: StyledRun[], o: number): StyledRun => {
    let p = 0;
    for (const r of runs) { if (o < p + r.text.length) return r; p += r.text.length; }
    return runs[runs.length - 1]!;
  };

  const out: StyledRun[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i]!;
    const to = i + 1 < cuts.length ? cuts[i + 1]! : total;
    const st = runAt(styled, from);   // el ESTILO manda el lado editado
    const ge = runAt(seed, from);     // la GEOMETRÍA manda el seed
    const run: StyledRun = { text: text.slice(from, to), bold: st.bold, italic: st.italic };
    if (st.color !== undefined) run.color = st.color;
    if (st.underline) {
      run.underline = true;
      const w = ge.underline ? ge.w : st.w;
      if (w !== undefined) run.w = w;
    }
    const dx = seedDxAt.get(from);
    if (dx !== undefined) run.dx = dx;
    out.push(run);
  }
  return out;
}
