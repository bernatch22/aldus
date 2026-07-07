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
import { isWhiteFill } from './color.js';

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
  /** CLIP rect activo (device space) en el op, si el walk pudo computarlo
   *  (solo clips `re W n` / polígono rect con CTM sin rotación — el caso de
   *  los generadores comunes). Re-emitir IN-PLACE un texto movido FUERA de
   *  este rect lo recorta a nada: el bake debe emitirlo al FINAL del stream. */
  clip: { x: number; y: number; width: number; height: number } | null;
}

/** Un `Do` de XObject (imagen/form) con la CTM vigente y su rango de bytes. */
export interface XObjectOp {
  record: OpRecord;
  /** Nombre del recurso (/Im1). */
  name: string;
  /** CTM al momento del Do. */
  matrix: Matrix;
}

/** Un RECT RELLENO simple (path de un solo `re` + fill, sin rotación) con su
 *  rango de bytes y su geometría absoluta. El bake lo usa para localizar
 *  SUBRAYADOS (rects finos bajo una baseline) y hacer que sigan a su texto al
 *  mover/reescribir/eliminar — sin esto quedaban huérfanos en el lugar viejo. */
export interface FillRectOp {
  /** Rango a extirpar: del `re` al final del operador de pintado. */
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Operador de color de relleno vigente, verbatim ('' = negro). */
  fillColorRaw: string;
}

export interface ContentWalk {
  shows: ShowOp[];
  xobjects: XObjectOp[];
  /** Rects rellenos simples (candidatos a subrayado) — ver {@link FillRectOp}. */
  fillRects: FillRectOp[];
  /** Punto de inserción para "enviar al fondo": justo antes del PRIMER op que
   *  dibuja contenido real (fill no-blanco, Do, BT, sh) — es decir DESPUÉS del
   *  "papel" (los fills blancos full-page con que muchos generadores pintan la
   *  hoja). Insertar en el byte 0 dejaría el bloque bajo ese papel opaco.
   *  `ctm` = CTM vigente ahí (la matriz emitida debe ser relativa: abs×inv). */
  backstop: { offset: number; ctm: Matrix };
}

export function walkTextOps(src: Uint8Array): ShowOp[] {
  return walkContent(src).shows;
}

export function walkContent(src: Uint8Array): ContentWalk {
  const ops = tokenizeContentStream(src);
  const shows: ShowOp[] = [];
  const xobjects: XObjectOp[] = [];
  const fillRects: FillRectOp[] = [];
  // Path "simple" candidato a rect: o UN `re`, o UN subpath poligonal
  // rectangular (m + 3×l [+ h] — así dibuja pdf-lib drawRectangle). Cualquier
  // otra construcción (dos subpaths, curvas, >4 puntos) lo invalida.
  interface SimplePath {
    start: number;
    ctm: Matrix;
    fill: string;
    rect?: [number, number, number, number];
    pts: Array<[number, number]>;
    valid: boolean;
  }
  let simple: SimplePath | null = null;
  /** ¿Los 4 puntos forman un rectángulo alineado a los ejes? */
  const isRectPoly = (pts: Array<[number, number]>): boolean => {
    if (pts.length !== 4) return false;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % 4];
      if (Math.abs(y2 - y1) > 0.01 && Math.abs(x2 - x1) > 0.01) return false;
    }
    return true;
  };

  let ctm: Matrix = IDENTITY;
  // CLIP rect activo (device space) — null = sin clip conocido/computable.
  // Se salva/restaura con q/Q junto al CTM. `W`/`W*` marca el path actual
  // como clip pendiente; el paint op que lo consume (`n` normalmente) lo
  // intersecta si es un rect simple con CTM axis-aligned; un clip no-rect
  // deja el estado anterior (v1 honesta: mejor no clip que un clip inventado).
  type ClipRect = { x: number; y: number; width: number; height: number };
  let clip: ClipRect | null = null;
  let clipPending = false;
  const stack: Array<{ ctm: Matrix; clip: ClipRect | null }> = [];
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
  // Backstop: primer op de CONTENIDO (no papel). Un paint op pinta el path
  // construido antes — el punto válido de inserción es el ARRANQUE del path.
  let backstop: ContentWalk['backstop'] | null = null;
  let pathStart: ContentWalk['backstop'] | null = null;
  const markContent = (at: { offset: number; ctm: Matrix }) => {
    if (!backstop) backstop = at;
  };

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
      clip,
    });
    stale = true; // el ancho del texto mostrado desplaza Tm y no lo trackeamos
  };

  /** Rect ABSOLUTO (device) de un path simple, si es un rect axis-aligned. */
  const absRectOf = (p: SimplePath): ClipRect | null => {
    const m = p.ctm;
    const corners: Array<[number, number]> = p.rect
      ? [[p.rect[0], p.rect[1]], [p.rect[0] + p.rect[2], p.rect[1] + p.rect[3]]]
      : isRectPoly(p.pts)
        ? p.pts
        : [];
    if (!corners.length || Math.abs(m[1]) > 0.01 || Math.abs(m[2]) > 0.01) return null;
    const xs = corners.map(([px]) => m[0] * px + m[4]);
    const ys = corners.map(([, py]) => m[3] * py + m[5]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };
  /** El paint op consume un `W` pendiente: intersectar el clip si el path es
   *  un rect computable; si no, conservar el estado anterior (v1). */
  const consumeClip = () => {
    if (!clipPending) return;
    clipPending = false;
    const r = simple?.valid ? absRectOf(simple) : null;
    if (!r) return;
    if (!clip) { clip = r; return; }
    const x = Math.max(clip.x, r.x);
    const y = Math.max(clip.y, r.y);
    clip = {
      x, y,
      width: Math.max(0, Math.min(clip.x + clip.width, r.x + r.width) - x),
      height: Math.max(0, Math.min(clip.y + clip.height, r.y + r.height) - y),
    };
  };

  for (const rec of ops) {
    switch (rec.op) {
      case 'q': stack.push({ ctm, clip }); break;
      case 'Q': { const s = stack.pop(); ctm = s?.ctm ?? IDENTITY; clip = s?.clip ?? null; break; }
      case 'cm': ctm = mul([num(rec, 0), num(rec, 1), num(rec, 2), num(rec, 3), num(rec, 4), num(rec, 5)], ctm); break;
      // ── backstop: construcción y pintado de paths ──
      case 'm':
        if (!pathStart) pathStart = { offset: rec.start, ctm };
        if (simple) simple.valid = false; // segundo subpath = compuesto
        else simple = { start: rec.start, ctm, fill: fillColorRaw, pts: [[num(rec, 0), num(rec, 1)]], valid: true };
        break;
      case 'l':
        if (simple && simple.valid && !simple.rect && simple.pts.length < 5) simple.pts.push([num(rec, 0), num(rec, 1)]);
        else if (simple) simple.valid = false;
        break;
      case 'c': case 'v': case 'y': // curvas: no es un rect
        if (simple) simple.valid = false;
        break;
      case 'h': break; // cerrar el subpath no cambia el bbox
      case 're':
        if (!pathStart) pathStart = { offset: rec.start, ctm };
        if (simple) simple.valid = false; // re + algo más = compuesto
        else simple = { start: rec.start, ctm, fill: fillColorRaw, rect: [num(rec, 0), num(rec, 1), num(rec, 2), num(rec, 3)], pts: [], valid: true };
        break;
      case 'W': case 'W*': clipPending = true; break;
      case 'n': consumeClip(); pathStart = null; simple = null; break; // solo clip — no es contenido
      case 'f': case 'F': case 'f*': case 'b': case 'b*': case 'B': case 'B*': {
        consumeClip();
        if (!isWhiteFill(fillColorRaw)) markContent(pathStart ?? { offset: rec.start, ctm });
        // Rect relleno SIMPLE (re, o polígono rectangular m+3l) con CTM sin
        // rotación: registrarlo con su geometría absoluta — candidato a
        // subrayado para el bake.
        if (simple?.valid) {
          const r = absRectOf(simple);
          if (r) fillRects.push({ start: simple.start, end: rec.end, ...r, fillColorRaw: simple.fill });
        }
        pathStart = null;
        simple = null;
        break;
      }
      case 'S': case 's': // un trazo visible es contenido (conservador)
        consumeClip();
        markContent(pathStart ?? { offset: rec.start, ctm });
        pathStart = null;
        simple = null;
        break;
      case 'sh': markContent({ offset: rec.start, ctm }); break;
      case 'BI': markContent({ offset: rec.start, ctm }); break;
      case 'BT': markContent({ offset: rec.start, ctm }); tm = IDENTITY; tlm = IDENTITY; stale = false; break;
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
        markContent({ offset: rec.start, ctm });
        break;
      }
      default: break;
    }
  }
  return { shows, xobjects, fillRects, backstop: backstop ?? { offset: 0, ctm: IDENTITY } };
}
