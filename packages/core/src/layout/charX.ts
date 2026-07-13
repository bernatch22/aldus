/**
 * layout/charX.ts — x por CARÁCTER de una línea, desde sus runs reales
 * (Layer 2, geometría determinística). FUENTE ÚNICA de charX en v2 (audit-agent
 * §1, duplicación #3): mata el `charXMap` naïve de verify (F5 consume ESTE).
 *
 * Trasplante VERBATIM de v1 session.charXOf — incluye el fix de la ELIPSIS
 * U+2026 del commit 35c9222 (pesa como glifo ANCHO ~1.4, dibuja 3 puntos).
 */

import type { TextRunNode } from '../model/nodes.js';

/** Línea mínima que charXOf necesita: texto, runs y x de anclaje. */
export interface CharXLine {
  text: string;
  runs: Pick<TextRunNode, 'text' | 'x' | 'width'>[];
  x: number;
}

/** x por CARÁCTER de una línea, desde sus runs reales. Devuelve
 *  `text.length + 1` posiciones (la última = borde derecho). */
export function charXOf(line: CharXLine): number[] {
  // Peso RELATIVO de cada glifo: un run que mezcla palabras y leaders
  // ("office is at ............") repartido UNIFORME corría el inicio de los
  // puntos ~50pt a la izquierda (un '.' mide ~la mitad que una letra) — y el
  // campo terminaba PISANDO el texto previo. Pesos aproximados por clase de
  // glifo bastan para clavar los bordes de un placeholder.
  const uw = (ch: string): number =>
    ch === ' ' ? 0.7 // los espacios de un renglón justificado vienen ESTIRADOS
    : ch === '…' ? 1.4 // la ELIPSIS es UN char pero dibuja 3 puntos (~1em+)
    : /[.,:;'!|íìil[\]()]/.test(ch) ? 0.45
    : /[mwMW@]/.test(ch) ? 1.5
    : /[A-Z_]/.test(ch) ? 1.15
    : 1;
  const cx = new Array<number>(line.text.length + 1).fill(line.x);
  let cur = 0, lastEnd = line.x;
  for (const r of line.runs) {
    const at = line.text.indexOf(r.text, cur);
    if (at < 0) continue;
    for (let k = cur; k <= at; k++) cx[k] = lastEnd + ((r.x - lastEnd) * (k - cur)) / Math.max(1, at - cur);
    const ws = [...r.text].map(uw);
    const tot = ws.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    cx[at] = r.x;
    for (let k = 0; k < r.text.length; k++) { acc += ws[k]!; cx[at + k + 1] = r.x + (r.width * acc) / tot; }
    cur = at + r.text.length; lastEnd = r.x + r.width;
  }
  for (let k = cur; k <= line.text.length; k++) cx[k] = lastEnd;
  return cx;
}
