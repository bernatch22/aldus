/**
 * textWalk.ts — máquina de estado de texto (ISO 32000 §9.4) sobre los ops del
 * content stream: para cada operador de show-text (Tj/TJ/'/") calcula su
 * posición ABSOLUTA (Tm × CTM), fuente, tamaño y estado (Tc/Tw/Tz), con el
 * rango de bytes exacto para extirparlo/re-emitirlo.
 *
 * Limitación honesta v1 (sin tablas de widths): tras un show-text SIN
 * reposicionamiento explícito (Td, TD, Tm, T-star o las comillas) la x del
 * siguiente show es desconocida → se marca `stale` y el bake rehúsa tocar ese
 * segmento en vez de adivinar.
 */

import { tokenizeContentStream, type OpRecord } from './tokenizer.js';

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** Inversa afín (null si degenerada). mul(m, invert(m)) = identidad. */
export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  const ia = m[3] / det;
  const ib = -m[1] / det;
  const ic = -m[2] / det;
  const id = m[0] / det;
  return [ia, ib, ic, id, -(m[4] * ia + m[5] * ic), -(m[4] * ib + m[5] * id)];
}

export interface ShowOp {
  /** El OpRecord original (rango de bytes + operandos crudos). */
  record: OpRecord;
  /** 'Tj' | 'TJ' | "'" | '"' */
  op: string;
  /** Posición absoluta del origen del texto (Tm × CTM). */
  x: number;
  y: number;
  /** Matriz completa Tm × CTM (para re-emitir con la misma orientación/escala). */
  matrix: Matrix;
  /** El CTM solo (sin Tm) vigente en el op — la re-emisión IN-PLACE ejecuta
   *  dentro de este CTM y debe compensarlo (M_rel = M_abs × inv(ctm)). */
  ctm: Matrix;
  /** Nombre del recurso de fuente (/F1) y tamaño de Tf. */
  fontName: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  /** Último operador de color de RELLENO visto, verbatim ("0 0 1 rg"), '' = negro. */
  fillColorRaw: string;
  /** true: x desconocida (show consecutivo sin reposicionar; la y sí se conoce). */
  stale: boolean;
}

/** Un `Do` de XObject (imagen/form) con la CTM vigente y su rango de bytes. */
export interface XObjectOp {
  record: OpRecord;
  /** Nombre del recurso (/Im1). */
  name: string;
  /** CTM al momento del Do. */
  matrix: Matrix;
}

export interface ContentWalk {
  shows: ShowOp[];
  xobjects: XObjectOp[];
}

export function walkTextOps(src: Uint8Array): ShowOp[] {
  return walkContent(src).shows;
}

export function walkContent(src: Uint8Array): ContentWalk {
  const ops = tokenizeContentStream(src);
  const shows: ShowOp[] = [];
  const xobjects: XObjectOp[] = [];

  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let fontName = '';
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let hScale = 100;
  let leading = 0;
  let stale = false;
  let fillColorRaw = '';
  let csRaw = '';

  const raw = (rec: OpRecord): string => {
    let s = '';
    for (let k = rec.start; k < rec.end; k++) s += String.fromCharCode(src[k]);
    return s;
  };

  const num = (rec: OpRecord, idx: number): number => {
    const t = rec.operands[idx];
    return t && t.kind === 'num' ? (t.value as number) : 0;
  };

  const setTd = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    stale = false;
  };

  const record = (rec: OpRecord, op: string) => {
    const m = mul(tm, ctm);
    shows.push({
      record: rec, op,
      x: m[4], y: m[5], matrix: m, ctm,
      fontName, fontSize, charSpacing, wordSpacing, hScale,
      fillColorRaw,
      stale,
    });
    stale = true; // el ancho del texto mostrado desplaza Tm y no lo trackeamos
  };

  for (const rec of ops) {
    switch (rec.op) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() ?? IDENTITY; break;
      case 'cm': ctm = mul([num(rec, 0), num(rec, 1), num(rec, 2), num(rec, 3), num(rec, 4), num(rec, 5)], ctm); break;
      case 'BT': tm = IDENTITY; tlm = IDENTITY; stale = false; break;
      case 'ET': break;
      case 'Tf': {
        const t = rec.operands[0];
        fontName = t && t.kind === 'name' ? (t.value as string) : fontName;
        fontSize = num(rec, 1);
        break;
      }
      case 'Tc': charSpacing = num(rec, 0); break;
      case 'Tw': wordSpacing = num(rec, 0); break;
      case 'Tz': hScale = num(rec, 0); break;
      case 'TL': leading = num(rec, 0); break;
      case 'Td': setTd(num(rec, 0), num(rec, 1)); break;
      case 'TD': leading = -num(rec, 1); setTd(num(rec, 0), num(rec, 1)); break;
      case 'Tm':
        tlm = [num(rec, 0), num(rec, 1), num(rec, 2), num(rec, 3), num(rec, 4), num(rec, 5)];
        tm = tlm;
        stale = false;
        break;
      case 'T*': setTd(0, -leading); break;
      case 'Tj': record(rec, 'Tj'); break;
      case 'TJ': record(rec, 'TJ'); break;
      case "'": setTd(0, -leading); record(rec, "'"); break;
      case '"': wordSpacing = num(rec, 0); charSpacing = num(rec, 1); setTd(0, -leading); record(rec, '"'); break;
      case 'g': case 'rg': case 'k': fillColorRaw = raw(rec); break;
      case 'cs': csRaw = raw(rec); break;
      case 'sc': case 'scn': fillColorRaw = csRaw ? `${csRaw} ${raw(rec)}` : raw(rec); break;
      case 'Do': {
        const t = rec.operands[0];
        if (t && t.kind === 'name') xobjects.push({ record: rec, name: t.value as string, matrix: ctm });
        break;
      }
      default: break;
    }
  }
  return { shows, xobjects };
}
