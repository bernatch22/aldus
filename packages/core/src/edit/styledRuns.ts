/**
 * edit/styledRuns.ts — MUTACIÓN de tramos estilados (Layer 2). Trasplante
 * VERBATIM de la parte de mutación de v1 edits.ts (la de LECTURA —
 * runLines/originalStyledRuns/styledRunsEqual/styledText — ya vive en
 * graph/segmentContent.ts, F2).
 *
 *  - applyTextDiff: re-mapea los tramos a un TEXTO NUEVO por diff de
 *    prefijo/sufijo común + LCS/posicional por CARÁCTER en el medio (el editor
 *    tipea en un textarea PLANO; los estilos viven acá, no en el DOM).
 *  - toggleStyleRange / setStyleRange: aplican estilo a un rango [start,end).
 */

import type { StyledRun } from '../model/nodes.js';
import { styledText } from '../graph/segmentContent.js';

const sameStyle = (a: StyledRun, b: StyledRun): boolean =>
  a.bold === b.bold && a.italic === b.italic && a.color === b.color && !!a.underline === !!b.underline;

/** Re-mapea los tramos estilados a un TEXTO NUEVO por diff de prefijo/sufijo
 *  común (el editor tipea en un textarea PLANO — los estilos viven acá, no en
 *  el DOM): lo insertado hereda el estilo del tramo donde empieza el cambio. */
export function applyTextDiff(runs: StyledRun[], newText: string): StyledRun[] {
  const oldText = styledText(runs);
  if (oldText === newText) return runs;
  if (!runs.length) return newText ? [{ text: newText, bold: false, italic: false, dx: 0 }] : runs;
  let p = 0;
  while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
  let s = 0;
  while (s < oldText.length - p && s < newText.length - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
  const inserted = newText.slice(p, newText.length - s);
  // Estilo del punto de inserción: el tramo que contiene el offset p (o el
  // último si p cae al final).
  let styleSrc = runs[runs.length - 1]!;
  let pos = 0;
  for (const r of runs) {
    if (p < pos + r.text.length || (p === pos + r.text.length && r === runs[runs.length - 1])) { styleSrc = r; break; }
    pos += r.text.length;
  }
  const out: StyledRun[] = [];
  let cursor = 0;
  const pushPiece = (piece: StyledRun) => {
    const last = out[out.length - 1];
    if (last && sameStyle(last, piece)) last.text += piece.text;
    else out.push({ ...piece });
  };
  // prefijo intacto
  for (const r of runs) {
    if (cursor >= p) break;
    const take = Math.min(r.text.length, p - cursor);
    if (take > 0) pushPiece({ ...r, text: r.text.slice(0, take) });
    cursor += r.text.length;
  }
  // El MEDIO cambiado. Un solo prefijo/sufijo se queda corto cuando el cambio
  // toca VARIAS regiones (p. ej. el agente reemplaza tres "XXXX" sueltos): todo
  // el medio contaría como "insertado" y heredaría UN estilo (el del primer
  // tramo — una línea mixta bold/regular quedaba TODA bold y el bake caía a
  // fuente estándar). Acá mapeamos ESTILO POR CARÁCTER: los caracteres que
  // sobreviven conservan el estilo de su tramo original; los nuevos heredan el
  // del último conservado.
  const oldMid = oldText.slice(p, oldText.length - s);
  if (inserted && oldMid && oldMid.length * inserted.length <= 250_000) {
    // Estilo del carácter i del texto viejo (por tramo).
    const styleAt: StyledRun[] = [];
    for (const r of runs) for (let i = 0; i < r.text.length; i++) styleAt.push(r);
    // LCS clásico sobre el medio (posicional cuando coinciden los largos: el
    // reemplazo 1:1 tipo "XXXX"→espacios conserva cada frontera de estilo).
    let match: Array<number | null>; // idx en oldMid (global: +p) por char de inserted, null = nuevo
    if (oldMid.length === inserted.length) {
      match = [...inserted].map((ch, i) => (oldMid[i] === ch ? i : null));
    } else {
      const n = oldMid.length, m2 = inserted.length;
      const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m2 + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m2 - 1; j >= 0; j--) {
          dp[i]![j] = oldMid[i] === inserted[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
        }
      }
      match = new Array(m2).fill(null);
      for (let i = 0, j = 0; i < n && j < m2; ) {
        if (oldMid[i] === inserted[j]) { match[j] = i; i++; j++; }
        else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
        else j++;
      }
    }
    let inherit = styleSrc;
    for (let j = 0; j < inserted.length; j++) {
      const oi = match[j];
      const st = oi != null ? (styleAt[p + oi] ?? inherit) : inherit;
      if (oi != null) inherit = st;
      pushPiece({ ...st, text: inserted[j]! });
    }
  } else if (inserted) {
    pushPiece({ ...styleSrc, text: inserted });
  }
  // sufijo intacto
  const sufStart = oldText.length - s;
  cursor = 0;
  for (const r of runs) {
    const end = cursor + r.text.length;
    if (end > sufStart) {
      const from = Math.max(0, sufStart - cursor);
      pushPiece({ ...r, text: r.text.slice(from) });
    }
    cursor = end;
  }
  // dx recalculado por el caller (serialización) — acá solo texto+estilos.
  return out.filter(r => r.text.length > 0);
}

/** Corta los runs en los límites [start, end) del texto plano. */
function splitAt(runs: StyledRun[], start: number, end: number): Array<{ run: StyledRun; from: number }> {
  const pieces: Array<{ run: StyledRun; from: number }> = [];
  let pos = 0;
  for (const r of runs) {
    const bounds = new Set([0, r.text.length]);
    for (const cut of [start - pos, end - pos]) {
      if (cut > 0 && cut < r.text.length) bounds.add(cut);
    }
    const sorted = [...bounds].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      pieces.push({ run: { ...r, text: r.text.slice(sorted[i], sorted[i + 1]) }, from: pos + sorted[i]! });
    }
    pos += r.text.length;
  }
  return pieces;
}

function mergeAdjacent(pieces: StyledRun[], firstDx: number): StyledRun[] {
  const out: StyledRun[] = [];
  for (const r of pieces) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) last.text += r.text;
    else out.push({ ...r, dx: 0 });
  }
  if (out.length) out[0]!.dx = firstDx;
  return out;
}

/** Aplica un toggle de estilo SOLO al rango [start, end) del texto plano de los
 *  runs (offsets en caracteres): corta los tramos en los límites, decide el
 *  destino (si TODO el rango ya tiene el estilo → quitarlo; si no → ponerlo),
 *  lo aplica solo adentro y fusiona adyacentes. Operación pura — el editor la
 *  usa para Cmd+B/Cmd+I sobre la selección, sin execCommand del browser. */
export function toggleStyleRange(
  runs: StyledRun[],
  start: number,
  end: number,
  key: 'bold' | 'italic' | 'underline',
): StyledRun[] {
  if (end <= start) return runs;
  const pieces = splitAt(runs, start, end);
  const inRange = (p: { from: number; run: StyledRun }) => p.from >= start && p.from < end;
  const selected = pieces.filter(inRange);
  if (!selected.length) return runs;
  const target = !selected.every(p => p.run[key]);
  return mergeAdjacent(pieces.map(p => (inRange(p) ? { ...p.run, [key]: target } : p.run)), runs[0]?.dx ?? 0);
}

/** Aplica un estilo ARBITRARIO (color/bold/italic) al rango [start, end). */
export function setStyleRange(
  runs: StyledRun[],
  start: number,
  end: number,
  style: { bold?: boolean; italic?: boolean; color?: string | null },
): StyledRun[] {
  if (end <= start) return runs;
  const pieces = splitAt(runs, start, end);
  const inRange = (p: { from: number; run: StyledRun }) => p.from >= start && p.from < end;
  if (!pieces.some(inRange)) return runs;
  const apply = (r: StyledRun): StyledRun => {
    const next = { ...r };
    if (style.bold !== undefined) next.bold = style.bold;
    if (style.italic !== undefined) next.italic = style.italic;
    if (style.color !== undefined) {
      if (style.color === null) delete next.color;
      else next.color = style.color;
    }
    return next;
  };
  return mergeAdjacent(pieces.map(p => (inRange(p) ? apply(p.run) : p.run)), runs[0]?.dx ?? 0);
}
