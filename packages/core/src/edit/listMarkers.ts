/**
 * edit/listMarkers.ts — el motor de MARCADORES DE LISTA (Lbl/LBody, ISO 32000),
 * dominio autocontenido (Layer 2). Trasplante VERBATIM del bloque de list-markers
 * de v1 edits.ts. El marcador es un TRAMO PROPIO, separado del cuerpo y SIN su
 * formato de carácter (nunca hereda el underline del cuerpo).
 */

import type { StyledRun } from '../model/nodes.js';
import { styledText } from '../graph/segmentContent.js';

// TODOS los tipos de marcador de lista: viñetas (•·▪‣*-), números ("1.", "12)")
// y letras ("a)", "A.", "iv)" cae en letras+): el modelo del PDF etiquetado
// (ISO 32000) es Lbl (marcador) + LBody (contenido) — el marcador es un
// elemento PROPIO, separado del cuerpo y SIN su formato de carácter.
// Marcadores soportados (Lbl): viñeta (•·▪‣*-), número ("1.","12)"), romano
// ("i)","ii)","iv)","IV." — 1-7 chars), o letra suelta ("a)","A."). El romano
// va ANTES que la letra suelta para que "ii)" no falle por multi-letra.
const LIST_MARKER_RE = /^(\s*)(?:[•·▪‣*–—-]|\d{1,3}[.)]|[ivxlcdm]{1,7}[.)]|[IVXLCDM]{1,7}[.)]|[a-zA-Z][.)])(\s+)/;
const BULLET_MARKER_RE = /^(\s*)[•·▪‣](\s+)/;

/** El GAP entre el marcador y el texto (4 espacios — generoso, estilo Acrobat). */
export const LIST_GAP = '    ';

export const hasListMarker = (text: string): boolean => LIST_MARKER_RE.test(text);
export const hasBulletMarker = (text: string): boolean => BULLET_MARKER_RE.test(text);
/** Largo del marcador de lista (Lbl) al frente del texto — 0 si no hay. */
export const listMarkerLen = (text: string): number => LIST_MARKER_RE.exec(text)?.[0].length ?? 0;

/** El dx REAL del CUERPO (LBody) = el indent colgante del marcador (7-8pt), tomado
 *  de la GEOMETRÍA cruda del segmento (seg.runs con su x) — NO de originalStyledRuns,
 *  que fusiona el marcador con el cuerpo cuando comparten estilo y pierde el gap.
 *  0 si el primer run no es un marcador de lista. */
export function markerBodyDx(seg: { x: number; runs: { x: number; text: string }[] }): number {
  const first = seg.runs[0];
  if (!first || seg.runs.length < 2) return 0;
  // ¿el primer run ES un marcador? (le sumo " x" para satisfacer el \s+ del regex).
  if (!hasListMarker(`${first.text.trim()} x`)) return 0;
  return seg.runs[1]!.x - seg.x; // x del primer run del cuerpo, relativo al ancla
}
/** Quita el marcador (cualquier tipo) del frente de UNA línea. */
export const stripListMarker = (line: string): string => line.replace(LIST_MARKER_RE, '');

/** Tipos de marcador de lista que el selector ofrece. */
export type ListKind = 'bullet' | 'number' | 'lower' | 'upper' | 'roman';

const toRoman = (n: number): string => {
  const t: [string, number][] = [['x', 10], ['ix', 9], ['v', 5], ['iv', 4], ['i', 1]];
  let s = ''; for (const [r, v] of t) while (n >= v) { s += r; n -= v; }
  return s || 'i';
};
/** El marcador del tipo `kind` en la posición `n` (1-based): bullet siempre "•",
 *  number "1." "2."…, lower "a)" "b)"…, upper "A." "B."…, roman "i)" "ii)"…. */
export function markerAt(kind: ListKind, n: number): string {
  if (kind === 'bullet') return '•';
  if (kind === 'number') return `${n}.`;
  if (kind === 'lower') return `${String.fromCharCode(97 + (n - 1) % 26)})`;
  if (kind === 'upper') return `${String.fromCharCode(65 + (n - 1) % 26)}.`;
  return `${toRoman(n)})`;
}
/** El primer marcador de cada tipo. */
export const firstMarker = (kind: ListKind): string => markerAt(kind, 1);

/** ¿El texto es SOLO un marcador de lista (ítem recién creado, sin contenido)?
 *  El PDF no persiste espacios finales sin contenido — el gap lo siembra el
 *  editor al abrirlo en edición. */
export const isBareListMarker = (text: string): boolean =>
  /^\s*(?:[•·▪‣*-]|\d{1,3}[.)]|[a-zA-Z][.)])\s*$/.test(text);

const KIND_RE: Record<ListKind, RegExp> = {
  bullet: /^[•·▪‣*–—-]$/,
  number: /^\d{1,3}[.)]$/,
  roman: /^[ivxlcdm]+[.)]$/i,
  lower: /^[a-z][.)]$/,
  upper: /^[A-Z][.)]$/,
};
/** ¿El marcador al frente PERTENECE a la familia `kind`? (un "i)" suelto sirve
 *  como romano O como letra — ambos togglean off). */
export function markerIsKind(text: string, kind: ListKind): boolean {
  const m = LIST_MARKER_RE.exec(text);
  return !!m && KIND_RE[kind].test(m[0].trim());
}

/** Tipo del marcador al frente del texto (null = no hay marcador). */
export function markerKindOf(text: string): ListKind | null {
  const m = LIST_MARKER_RE.exec(text);
  if (!m) return null;
  const c = m[0].trim();
  if (/^[•·▪‣*–—-]$/.test(c)) return 'bullet';
  if (/^\d/.test(c)) return 'number';
  if (/^[ivxlcdm]{2,}[.)]$/.test(c) || /^[IVXLCDM]{2,}[.)]$/.test(c)) return 'roman';
  if (/^[a-z][.)]$/.test(c)) return 'lower';
  if (/^[A-Z][.)]$/.test(c)) return 'upper';
  return 'roman'; // "i)"/"I)" sueltos → romano por default
}

/** Toggle/convertir el marcador de lista (Lbl/LBody, ISO 32000). El marcador es
 *  un TRAMO PROPIO, separado del contenido y SIN su formato (nunca hereda el
 *  underline del cuerpo). Según `kind` (default viñeta):
 *   · sin marcador           → antepone el marcador de ese tipo.
 *   · marcador del MISMO tipo → lo quita (toggle off).
 *   · marcador de OTRO tipo   → lo CONVIERTE al tipo pedido (Acrobat). */
export function toggleListMarker(runs: StyledRun[], kind: ListKind = 'bullet'): StyledRun[] {
  if (!runs.length) return runs;
  const text = styledText(runs);
  const want = firstMarker(kind);
  const marker = LIST_MARKER_RE.exec(text);
  const first = runs[0]!;
  const lbl = (t: string): StyledRun => ({ text: `${t}${LIST_GAP}`, bold: first.bold, italic: first.italic, color: first.color, dx: first.dx ?? 0 });
  if (!marker) return [lbl(want), ...runs];
  // Cortar el marcador actual de los tramos.
  let toCut = marker[0].length;
  const out: StyledRun[] = [];
  for (const r of runs) {
    if (toCut >= r.text.length) { toCut -= r.text.length; continue; }
    out.push(toCut > 0 ? { ...r, text: r.text.slice(toCut) } : r);
    toCut = 0;
  }
  if (!out.length) return runs; // marcador solo (sin contenido): no vaciar
  return markerIsKind(text, kind) ? out : [lbl(want), ...out]; // misma familia = off; otra = convertir
}

export function nextListMarker(text: string): string | null {
  const m = /^(\s*)(?:([•·▪‣*-])|(\d{1,3})([.)])|([a-z])([.)])|([A-Z])([.)]))(\s+)/.exec(text);
  if (!m) return null;
  const [, indent, bullet, num, numSep, low, lowSep, up, upSep, gap] = m;
  if (bullet) return `${indent}${bullet}${gap}`;
  if (num) return `${indent}${Number(num) + 1}${numSep}${gap}`;
  if (low) return `${indent}${low === 'z' ? 'a' : String.fromCharCode(low.charCodeAt(0) + 1)}${lowSep}${gap}`;
  if (up) return `${indent}${up === 'Z' ? 'A' : String.fromCharCode(up.charCodeAt(0) + 1)}${upSep}${gap}`;
  return null;
}
