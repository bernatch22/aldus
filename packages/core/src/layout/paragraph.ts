/**
 * layout/paragraph.ts — detección y tokenización de PÁRRAFOS (Layer 2,
 * geometría determinística). Trasplante VERBATIM de v1 session:
 * paraLinesOf / paragraphOf / paragraphToks. Razona SIEMPRE en líneas VISUALES
 * (runLines — un super/subíndice o marcador "a)" NO abre línea), jamás en
 * segmentos: un bloque multilínea (párrafo Word fusionado en un segmento) aporta
 * varias líneas del mismo seg.
 *
 * El `LayoutEnv` inyecta la geometría EFECTIVA de la sesión (corrimientos de
 * reflows anteriores + nodos removidos) — así las llamadas sucesivas componen.
 * F5 (EditSession) lo implementa sobre el EditLedger.
 */

import type { PageGraph, SegmentNode } from '../model/nodes.js';
import { runLines } from '../graph/segmentContent.js';
import { segmentText } from '../graph/tokens.js';
import { charXOf } from './charX.js';

/** El estado EFECTIVO de la sesión que el layout necesita (sin acoplar a core
 *  con el ledger ni el grafo). F5 lo implementa sobre el EditLedger. */
export interface LayoutEnv {
  /** baseline EFECTIVA de un segmento (corrimientos de reflows anteriores). */
  effBaseline(seg: SegmentNode): number;
  /** ¿El segmento está marcado como removido en la sesión? */
  isRemoved(id: string): boolean;
}

/** Una LÍNEA VISUAL del párrafo. Un segmento puede ser un BLOQUE multilínea
 *  (la extracción fusiona párrafos Word en un solo segmento) — runLines lo
 *  parte; en PDFs "un segmento por renglón" es 1:1. */
export interface ParaLine {
  seg: SegmentNode;
  /** baseline EFECTIVA (corrimientos de la sesión aplicados). */
  baseline: number;
  runs: SegmentNode['runs'];
  text: string;
  x: number;
  width: number;
}

export interface Paragraph {
  page: PageGraph;
  lines: ParaLine[];
  leading: number;
  rightEdge: number;
  capacity: number;
  spaceW: number;
  paraBottom: number;
}

/** `drop`: el rango se elimina del texto SIN emitir hueco (la parte del
 *  placeholder que no es el campo — p. ej. el label "[company legal name]"). */
export interface ReflowHole { li: number; from: number; to: number; name: string; target: number; drop?: boolean }
export interface ReflowTok { kind: 'word' | 'hole'; text?: string; w: number; bold?: boolean; italic?: boolean; hole?: ReflowHole; line?: number }

/** Las líneas VISUALES de un segmento (runLines — la misma fuente de verdad del
 *  editor), con la baseline efectiva de la sesión. */
export function paraLinesOf(seg: SegmentNode, env: LayoutEnv): ParaLine[] {
  const shift = env.effBaseline(seg) - seg.baseline;
  return runLines(seg).map(rs => {
    const sorted = [...rs].sort((a, b) => a.x - b.x);
    const x = sorted[0]!.x;
    const width = Math.max(...sorted.map(r => r.x + r.width)) - x;
    // baseline de la LÍNEA = la del run dominante (el más ancho — un
    // superíndice no manda).
    const dom = sorted.reduce((a, b) => (b.width > a.width ? b : a), sorted[0]!);
    return { seg, baseline: dom.baseline + shift, runs: sorted, text: segmentText(sorted), x, width };
  });
}

/** El párrafo de un segmento: líneas consecutivas con el mismo x de anclaje y
 *  paso de interlineado regular. */
export function paragraphOf(page: PageGraph, s: SegmentNode, env: LayoutEnv): Paragraph {
  // LÍNEAS VISUALES de toda la columna, en geometría EFECTIVA (corrimientos de
  // la sesión aplicados, nodos removidos afuera) — así las llamadas sucesivas
  // componen y los bloques multilínea cuentan renglón por renglón.
  const all = page.segments
    .filter(x => !env.isRemoved(x.id) && Math.abs(x.x - s.x) < 4 && Math.abs(x.fontSize - s.fontSize) < 2)
    .flatMap(x => paraLinesOf(x, env))
    .sort((a, b) => b.baseline - a.baseline);
  const idx = all.findIndex(l => l.seg.id === s.id);
  const maxLead = s.fontSize * 1.7;
  let lo = idx, hi = idx;
  while (lo > 0 && all[lo - 1]!.baseline - all[lo]!.baseline < maxLead) lo--;
  while (hi + 1 < all.length && all[hi]!.baseline - all[hi + 1]!.baseline < maxLead) hi++;
  const lines = all.slice(lo, hi + 1); // arriba → abajo
  const leading = lines.length > 1
    ? (lines[0]!.baseline - lines[lines.length - 1]!.baseline) / (lines.length - 1)
    : s.fontSize * 1.15;
  const rightEdge = Math.max(...lines.map(l => l.x + l.width));
  return {
    page, lines, leading, rightEdge,
    capacity: rightEdge - Math.min(...lines.map(l => l.x)),
    spaceW: s.fontSize * 0.28,
    paraBottom: lines[lines.length - 1]!.baseline,
  };
}

/** Tokens (palabras con ancho medido + estilo, y huecos) de las líneas del
 *  párrafo. `replace` sustituye el contenido de UNA línea por runs nuevos
 *  (edit_text): sus palabras se estiman con el ancho medio del segmento. */
export function paragraphToks(
  para: Paragraph,
  holes: ReflowHole[],
  replace?: { lineId: string; styled: { text: string; bold: boolean; italic: boolean }[]; avgCharW: number },
): ReflowTok[] {
  const toks: ReflowTok[] = [];
  let replaced = false;
  for (let k = 0; k < para.lines.length; k++) {
    const line = para.lines[k]!;
    if (replace && line.seg.id === replace.lineId) {
      // El reemplazo cubre el SEGMENTO entero (un bloque multilínea aporta
      // varias ParaLines del mismo seg): se emite UNA vez, las demás se saltan.
      if (!replaced) {
        replaced = true;
        for (const run of replace.styled) {
          for (const m of run.text.matchAll(/\S+/g)) {
            toks.push({ kind: 'word', text: m[0], w: m[0].length * replace.avgCharW, bold: run.bold, italic: run.italic });
          }
        }
      }
      continue;
    }
    const text = line.text;
    const cx = charXOf(line);
    // estilo por carácter (del run que lo contiene) — para conservar negritas.
    const styleAt: Array<{ bold: boolean; italic: boolean }> = new Array(text.length).fill({ bold: false, italic: false });
    let sc = 0;
    for (const r of line.runs) {
      const at = text.indexOf(r.text, sc);
      if (at < 0) continue;
      for (let c = at; c < at + r.text.length; c++) styleAt[c] = { bold: r.font.bold, italic: r.font.italic };
      sc = at + r.text.length;
    }
    const lineHoles = holes.filter(h => h.li === k).sort((a, b) => a.from - b.from);
    let pos = 0;
    const pushWords = (from: number, to: number) => {
      for (const m of text.slice(from, to).matchAll(/\S+/g)) {
        const a = from + m.index!, b = a + m[0].length;
        toks.push({ kind: 'word', text: m[0], w: cx[b]! - cx[a]!, bold: styleAt[a]?.bold ?? false, italic: styleAt[a]?.italic ?? false, line: k });
      }
    };
    for (const h of lineHoles) { pushWords(pos, h.from); if (!h.drop) toks.push({ kind: 'hole', w: 0, hole: h, line: k }); pos = h.to; }
    pushWords(pos, text.length);
  }
  // DES-HIFENAR cortes de línea de Word: "…[ad-" al final de un renglón +
  // "dress,…" al inicio del siguiente son UNA palabra partida por el
  // compositor original — al re-envolver hay que rejuntarla ("address"),
  // nunca unir con espacio ("ad- dress"). Solo cruce de renglón consecutivo
  // con letra minúscula a ambos lados del guion (un "his/her" o "e-mail"
  // dentro del mismo renglón no se toca).
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i]!, b = toks[i + 1]!;
    if (a.kind === 'word' && b.kind === 'word' && b.line === (a.line ?? -2) + 1 &&
        /\p{Ll}-$/u.test(a.text!) && /^\p{Ll}/u.test(b.text!)) {
      a.text = a.text!.slice(0, -1) + b.text!;
      a.w += b.w;
      toks.splice(i + 1, 1);
    }
  }
  return toks;
}
