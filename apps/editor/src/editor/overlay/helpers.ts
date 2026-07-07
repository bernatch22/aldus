/**
 * Helpers compartidos por los boxes del overlay: el logger gateado, el volcado
 * de debug de estilos, el estilo del contenedor editable y el clamp de arrastre.
 */
import type { CSSProperties } from 'react';
import {
  createLogger,
  type SegmentEdit,
  type SegmentNode,
} from '@aldus/core';
import { bucketFallback, dominantRun, family } from '../styledDom';
import { stableFontFamily } from '../fontRegistry';

/** Logger gateado del overlay (ALDUS_DEBUG / localStorage.aldusDebug). */
export const log = createLogger('aldus:overlay');

// ── DEBUG temporal (pedido explícito): estado COMPLETO de estilos de un
//    segmento al agarrarlo, soltarlo y re-renderizarse editado. ──
export function dbgStyles(tag: string, seg: SegmentNode, edit: SegmentEdit | null, extra?: Record<string, unknown>): void {
  try {
    // TODO PLANO (una línea por run): el console colapsa objetos anidados.
    const lines = seg.runs.map(r => {
      const vivo = document.fonts.check(`12px '${r.font.loadedName}'`);
      const stable = r.font.postScriptName ? document.fonts.check(`12px '${stableFontFamily(r.font.postScriptName)}'`) : null;
      return `  run "${r.text.slice(0, 12)}" font=${r.font.loadedName}(${r.font.postScriptName ?? '?'}) emb=${r.font.embedded} ` +
        `b=${r.font.bold} i=${r.font.italic} size=${r.fontSize.toFixed(1)} color=${r.color ?? '-'} ` +
        `VIVO=${vivo} STABLE=${stable}`;
    });
    const e = edit
      ? `edit{x:${edit.x ?? '-'} y:${edit.baseline ?? '-'} size:${edit.fontSize ?? '-'} font:${edit.font ?? '-'} color:${edit.color ?? '-'} runs:${edit.runs ? edit.runs.map(r => `${r.text.slice(0, 8)}|b${+r.bold}i${+r.italic}c${r.color ?? '-'}`).join(',') : '-'}}`
      : 'edit:null';
    log(`[aldus:${tag}] ${seg.id} "${(edit?.text ?? seg.text).slice(0, 40)}" ${e} ${extra ? JSON.stringify(extra) : ''}\n${lines.join('\n')}`);
  } catch { /* solo debug */ }
}

/** Tipografía del CONTENEDOR editable: la dominante del segmento (con tamaño/
 *  familia de la edición). Todo texto que el browser inserte fuera de los spans
 *  hereda esto — nunca el system font del UI. */
export function containerStyle(seg: SegmentNode, edit: SegmentEdit | null, scale: number): CSSProperties {
  const dom = dominantRun(seg);
  const ratio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
  return {
    fontFamily: edit?.font ? bucketFallback(edit.font) : family(dom),
    fontSize: `${(dom.fontSize * ratio * scale).toFixed(2)}px`,
    fontWeight: !dom.font.embedded && dom.font.bold ? 700 : 400,
    fontStyle: !dom.font.embedded && dom.font.italic ? 'italic' : 'normal',
    color: edit?.color ?? dom.color ?? '#000',
  };
}

// Ningún drag puede dejar un nodo perdido fuera de la página: al soltar,
// siempre quedan al menos 24pt visibles.
export const MIN_VISIBLE = 24;
export const clampX = (x: number, w: number, pageW: number) => Math.min(Math.max(x, MIN_VISIBLE - w), pageW - MIN_VISIBLE);
export const clampY = (y: number, h: number, pageH: number) => Math.min(Math.max(y, MIN_VISIBLE - h), pageH - MIN_VISIBLE);
