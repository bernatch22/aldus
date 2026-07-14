/**
 * styledGeometry — preservar la GEOMETRÍA del PDF al re-estilar sin cambiar
 * texto (v2 del fix; la v1, `restyleKeepingGeometry(seed, styled)`, mezclaba
 * dx del seed con runs SIN dx multi-línea y el emit del bake escribía NaN en
 * el content stream → PDF corrupto; hoy el bake tiene escudo InvalidGeometry,
 * pero acá directamente no se produce esa forma).
 *
 * El caso: el usuario aplica bold/italic/color a una palabra SIN tocar el
 * texto. El camino normal del commit (applyTextDiff + applyAlign) recalcula
 * los `dx` midiendo con la fuente del BROWSER — que difiere de la métrica
 * real del PDF (itálicas, bold sintético, glifos sin /ToUnicode tipo
 * U+0011/U+0012): "denominación" en bold midió 83.2pt en browser pero el bake
 * la dibuja en 71.2pt. El bake re-emitía con esos dx corridos → agujeros que
 * el re-extract clasifica COLUMNA (nodo PARTIDO) o texto pisado.
 *
 * {@link restyleFromGraph} construye los runs de salida desde la GEOMETRÍA
 * DEL GRAFO (seg.runs vía runLines: cada run trae x/width REALES del PDF):
 *  - recorre las líneas y los graph-runs EXACTAMENTE como `originalStyledRuns`
 *    arma el texto (espacios inferidos con classifyGap, '\n' entre líneas) —
 *    los offsets calzan 1:1 con `styled`;
 *  - corta en: inicios de línea ∪ fronteras de estilo ∪ fronteras de graph-run
 *    (estas últimas regalan los dx exactos). Ningún run de salida cruza '\n'
 *    (va pegado al final del último run de su línea, como originalStyledRuns);
 *  - dx = posición PDF real − seg.x: frontera en el inicio de un graph-run →
 *    su x exacta; adentro de un graph-run → interpolación por clase de glifo
 *    con `charXOf` (la misma de placeholderMatch);
 *  - estilos del run de `styled` que cubre el tramo; underline lleva el `w`
 *    GEOMÉTRICO del tramo (cx[to]−cx[from]: exacto cuando coincide con un run
 *    subrayado del grafo).
 *
 * Nota de fidelidad: el ancla de cada graph-run queda EXACTA (eso mata el
 * split); y como cada run lleva su dx real, el bake conoce el SLOT geométrico
 * de cada tramo (ancla siguiente − propia) y ENCAJA el ancho dibujado con Tz
 * (core bake/widthFit.ts — path B y fallback), así la cara re-emitida/sustituta
 * no invade la ancla siguiente ni deja agujero (clamp 65–135%: fuera de rango
 * se dibuja al ancho natural).
 *
 * DEFENSIVO: si el texto de `styled` no calza con el ensamblado del grafo
 * (edición previa, trailing space, cualquier duda) devuelve null y el caller
 * cae al camino applyAlign — nunca adivina.
 */
import {
  charXOf,
  classifyGap,
  runLines,
  styledText,
  type SegmentNode,
  type StyledRun,
  type TextRunNode,
} from '@aldus/core';
import { round1 } from './styledDom.js';

/** El run de `styled` que cubre el offset `o` (por construcción los cortes
 *  incluyen las fronteras de estilo: un tramo nunca cruza dos estilos). */
function styleAt(styled: StyledRun[], o: number): StyledRun {
  let p = 0;
  for (const r of styled) {
    if (o < p + r.text.length) return r;
    p += r.text.length;
  }
  return styled[styled.length - 1]!;
}

export function restyleFromGraph(seg: SegmentNode, styled: StyledRun[]): StyledRun[] | null {
  if (!seg.runs.length || !styled.length) return null;
  const lines = runLines(seg);

  // ── 1. Ensamblar el texto COMO originalStyledRuns (misma regla de espacios
  // y de '\n') registrando, por línea, el offset de inicio de cada graph-run.
  interface LineInfo {
    start: number; // offset de la línea en el texto ensamblado
    text: string; // texto de la línea (sin '\n')
    runs: TextRunNode[];
    /** offset GLOBAL de inicio de cada graph-run de la línea. */
    runStart: Map<number, TextRunNode>;
  }
  const infos: LineInfo[] = [];
  let text = '';
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) text += '\n';
    const start = text.length;
    const runs = lines[li]!;
    const runStart = new Map<number, TextRunNode>();
    let lineText = '';
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!;
      if (i > 0) {
        const prev = runs[i - 1]!;
        const gap = r.x - (prev.x + prev.width);
        if (classifyGap(gap, prev, r) === 'space' && !lineText.endsWith(' ') && !r.text.startsWith(' ')) {
          lineText += ' ';
        }
      }
      runStart.set(start + lineText.length, r);
      lineText += r.text;
    }
    text += lineText;
    infos.push({ start, text: lineText, runs, runStart });
  }

  // ── 2. Pre-condición sagrada: los offsets deben calzar 1:1 con `styled`.
  if (text !== styledText(styled)) return null;

  // Fronteras de estilo (inicios de run de `styled`), offsets globales.
  const styleStarts: number[] = [];
  let off = 0;
  for (const r of styled) {
    styleStarts.push(off);
    off += r.text.length;
  }

  // ── 3. Cortar por línea y asignar dx desde la geometría real.
  const out: StyledRun[] = [];
  for (let li = 0; li < infos.length; li++) {
    const info = infos[li]!;
    const lineEnd = info.start + info.text.length;
    const cuts = [...new Set([
      info.start,
      ...info.runStart.keys(),
      ...styleStarts.filter(o => o > info.start && o < lineEnd),
    ])].filter(o => o < lineEnd).sort((a, b) => a - b);
    // x por carácter de la línea, desde sus runs reales (pesos por clase de
    // glifo — la interpolación para fronteras a mitad de un graph-run).
    const cx = charXOf({ text: info.text, runs: info.runs, x: info.runs[0]!.x });
    const lineFirst = out.length;
    for (let c = 0; c < cuts.length; c++) {
      const from = cuts[c]!;
      const to = c + 1 < cuts.length ? cuts[c + 1]! : lineEnd;
      const slice = text.slice(from, to);
      if (!slice) continue;
      const st = styleAt(styled, from);
      const atRun = info.runStart.get(from);
      const x = atRun ? atRun.x : cx[from - info.start]!;
      if (!Number.isFinite(x)) return null; // jamás alimentar NaN al bake
      const run: StyledRun = { text: slice, bold: st.bold, italic: st.italic, dx: round1(x - seg.x) };
      if (st.color !== undefined) run.color = st.color;
      if (st.underline) {
        run.underline = true;
        // Ancho GEOMÉTRICO del tramo (cx es exacto en los bordes de graph-run:
        // un tramo que coincide con un run subrayado hereda su width real).
        const xEnd = to === lineEnd ? cx[info.text.length]! : (info.runStart.get(to)?.x ?? cx[to - info.start]!);
        run.w = Number.isFinite(xEnd) ? round1(Math.max(0, xEnd - x)) : st.w ?? 0;
      }
      out.push(run);
    }
    if (out.length === lineFirst) return null; // línea vacía: no debería pasar
    if (li < infos.length - 1) out[out.length - 1]!.text += '\n';
  }
  return out;
}
