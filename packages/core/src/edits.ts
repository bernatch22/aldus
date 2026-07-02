/**
 * edits.ts — la semántica de editar un segmento, en UN lugar.
 *
 * Un SegmentEdit se construye SIEMPRE por acumulación de parches sobre el nodo
 * original (mergeSegmentEdit). Si el resultado queda idéntico al original
 * (mismo texto, mismo estilo por run, cero overrides) devuelve null: la
 * edición se revierte sola — el caller borra la entrada en vez de guardar un
 * no-op.
 *
 * El estilo (bold/italic) vive a nivel de RUN (`edit.runs`), nunca del
 * segmento: quitar la negrita a una parte no toca el resto.
 */

import type { FontBucket, ImageEdit, ImageNode, SegmentEdit, SegmentNode, StyledRun, WidgetEdit, WidgetNode } from './model.js';
import { classifyGap } from './tokens.js';

/** Un parche parcial: `undefined` = no tocar; `null` = LIMPIAR el override
 *  (volver al valor original del PDF). */
export interface SegmentPatch {
  text?: string;
  runs?: StyledRun[] | null;
  fontSize?: number | null;
  font?: FontBucket | null;
  x?: number | null;
  baseline?: number | null;
  remove?: boolean | null;
  charSpacing?: number | null;
  hScale?: number | null;
  color?: string | null;
}

const OVERRIDE_KEYS = ['fontSize', 'font', 'x', 'baseline', 'remove', 'charSpacing', 'hScale', 'color'] as const;

/** El contenido del segmento SIN editar, como runs estilados (tramos por
 *  estilo, con los espacios de palabra inferidos y su dx real). */
export function originalStyledRuns(seg: SegmentNode): StyledRun[] {
  const runs = [...seg.runs].sort((a, b) => a.x - b.x);
  const out: StyledRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    let space = '';
    if (i > 0) {
      const prev = runs[i - 1];
      const gap = r.x - (prev.x + prev.width);
      if (classifyGap(gap, prev, r) === 'space' && !out[out.length - 1]?.text.endsWith(' ') && !r.text.startsWith(' ')) {
        space = ' ';
      }
    }
    const last = out[out.length - 1];
    if (last && last.bold === r.font.bold && last.italic === r.font.italic) {
      last.text += space + r.text;
    } else {
      if (last && space) last.text += space;
      out.push({ text: r.text, bold: r.font.bold, italic: r.font.italic, dx: r.x - seg.x });
    }
  }
  return out;
}

export function styledRunsEqual(a: StyledRun[], b: StyledRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || a[i].bold !== b[i].bold || a[i].italic !== b[i].italic) return false;
  }
  return true;
}

export const styledText = (runs: StyledRun[]): string => runs.map(r => r.text).join('');

/** Si el texto arranca con un marcador de LISTA, devuelve el marcador del
 *  SIGUIENTE ítem (comportamiento Word/Acrobat: Enter continúa la lista):
 *  "• " → "• " · "3. " → "4. " · "b) " → "c) " · "B) " → "C) ". null = no es lista. */
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

/** Aplica un toggle de estilo SOLO al rango [start, end) del texto plano de los
 *  runs (offsets en caracteres): corta los tramos en los límites, decide el
 *  destino (si TODO el rango ya tiene el estilo → quitarlo; si no → ponerlo),
 *  lo aplica solo adentro y fusiona adyacentes. Operación pura — el editor la
 *  usa para Cmd+B/Cmd+I sobre la selección, sin execCommand del browser. */
export function toggleStyleRange(
  runs: StyledRun[],
  start: number,
  end: number,
  key: 'bold' | 'italic',
): StyledRun[] {
  if (end <= start) return runs;
  const pieces: Array<{ run: StyledRun; from: number }> = [];
  let pos = 0;
  for (const r of runs) {
    const bounds = new Set([0, r.text.length]);
    for (const cut of [start - pos, end - pos]) {
      if (cut > 0 && cut < r.text.length) bounds.add(cut);
    }
    const sorted = [...bounds].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      pieces.push({ run: { ...r, text: r.text.slice(sorted[i], sorted[i + 1]) }, from: pos + sorted[i] });
    }
    pos += r.text.length;
  }
  const inRange = (p: { from: number; run: StyledRun }) => p.from >= start && p.from < end;
  const selected = pieces.filter(inRange);
  if (!selected.length) return runs;
  const target = !selected.every(p => p.run[key]);
  const out: StyledRun[] = [];
  for (const p of pieces) {
    const r = inRange(p) ? { ...p.run, [key]: target } : p.run;
    const last = out[out.length - 1];
    if (last && last.bold === r.bold && last.italic === r.italic) last.text += r.text;
    else out.push({ ...r, dx: 0 });
  }
  if (out.length) out[0].dx = runs[0]?.dx ?? 0;
  return out;
}

export function mergeSegmentEdit(
  seg: SegmentNode,
  prev: SegmentEdit | null,
  patch: SegmentPatch,
): SegmentEdit | null {
  const dom = seg.runs.reduce((a, b) => (b.width > a.width ? b : a));
  const next: SegmentEdit = prev
    ? { ...prev }
    : {
        segmentId: seg.id,
        page: seg.page,
        text: seg.text,
        original: {
          text: seg.text, x: seg.x, baseline: seg.baseline, width: seg.width, fontSize: seg.fontSize,
          bucket: dom.font.bucket, bold: dom.font.bold, italic: dom.font.italic,
          runs: [...seg.runs].sort((a, b) => a.x - b.x).map(r => ({ x: r.x, bold: r.font.bold, italic: r.font.italic })),
        },
      };

  if (patch.runs !== undefined) {
    if (patch.runs === null) delete next.runs;
    else next.runs = patch.runs;
  }
  if (patch.text !== undefined) next.text = patch.text;
  // runs manda: el texto plano siempre es su aplanado.
  if (next.runs) {
    if (styledRunsEqual(next.runs, originalStyledRuns(seg))) delete next.runs;
    else next.text = styledText(next.runs);
  }
  for (const key of OVERRIDE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }

  const noop =
    next.text === seg.text &&
    next.runs === undefined &&
    OVERRIDE_KEYS.every(k => next[k] === undefined);
  return noop ? null : next;
}

/** Parche parcial de una imagen: `undefined` = no tocar; `null` = limpiar. */
export interface ImagePatch {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  remove?: boolean | null;
  zOrder?: 'front' | 'back' | null;
}

const IMAGE_KEYS = ['x', 'y', 'width', 'height', 'remove', 'zOrder'] as const;

export function mergeImageEdit(img: ImageNode, prev: ImageEdit | null, patch: ImagePatch): ImageEdit | null {
  const next: ImageEdit = prev
    ? { ...prev }
    : {
        imageId: img.id,
        page: img.page,
        original: { x: img.x, y: img.y, width: img.width, height: img.height },
      };
  for (const key of IMAGE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return IMAGE_KEYS.every(k => next[k] === undefined) ? null : next;
}

/** Rect EFECTIVO de una imagen con su edición aplicada. */
export function effectiveImageRect(img: ImageNode, edit: ImageEdit | null) {
  return {
    x: edit?.x ?? img.x,
    y: edit?.y ?? img.y,
    width: edit?.width ?? img.width,
    height: edit?.height ?? img.height,
    removed: edit?.remove === true,
    moved: edit?.x !== undefined || edit?.y !== undefined || edit?.width !== undefined || edit?.height !== undefined,
  };
}

/** Parche parcial de un widget: `undefined` = no tocar; `null` = limpiar. */
export interface WidgetPatch {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  remove?: boolean | null;
}

const WIDGET_KEYS = ['x', 'y', 'width', 'height', 'remove'] as const;

export function mergeWidgetEdit(w: WidgetNode, prev: WidgetEdit | null, patch: WidgetPatch): WidgetEdit | null {
  const next: WidgetEdit = prev
    ? { ...prev }
    : {
        widgetId: w.id,
        page: w.page,
        original: { fieldName: w.fieldName, x: w.x, y: w.y, width: w.width, height: w.height },
      };
  for (const key of WIDGET_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return WIDGET_KEYS.every(k => next[k] === undefined) ? null : next;
}

/** Rect EFECTIVO de un widget con su edición aplicada. */
export function effectiveWidgetRect(w: WidgetNode, edit: WidgetEdit | null) {
  return {
    x: edit?.x ?? w.x,
    y: edit?.y ?? w.y,
    width: edit?.width ?? w.width,
    height: edit?.height ?? w.height,
    removed: edit?.remove === true,
  };
}

/** Geometría/tamaño EFECTIVOS de un segmento con su edición aplicada.
 *  Cambiar el tamaño escala el alto del box alrededor de la baseline. */
export function effectiveGeometry(seg: SegmentNode, edit: SegmentEdit | null) {
  const fontSize = edit?.fontSize ?? seg.fontSize;
  const ratio = fontSize / seg.fontSize;
  const x = edit?.x ?? seg.x;
  const baseline = edit?.baseline ?? seg.baseline;
  return {
    x,
    baseline,
    fontSize,
    y: baseline + (seg.y - seg.baseline) * ratio,
    height: seg.height * ratio,
    width: seg.width,
    moved: edit?.x !== undefined || edit?.baseline !== undefined,
  };
}
