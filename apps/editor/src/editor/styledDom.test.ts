// @vitest-environment jsdom
/**
 * styledDom.test.ts — el ciclo modelo↔DOM con un DOM real (jsdom):
 * sembrar → serializar (detección de estilos existentes), y
 * applySelectionStyle (estilo SOLO a la selección, con restauración).
 */

import { describe, expect, it } from 'vitest';
import { originalStyledRuns, styledRunsEqual, type FontBucket, type SegmentNode, type TextRunNode } from '@aldus/core';
import { applySelectionStyle, flatOffsets, seedHtml, serializeStyled } from './styledDom';

function mkRun(text: string, x: number, width: number, opts: { bold?: boolean; italic?: boolean } = {}): TextRunNode {
  return {
    id: `r-${x}`, kind: 'text', page: 1, text, x, baseline: 700, width, fontSize: 12, angle: 0,
    font: {
      loadedName: opts.bold ? 'g_f_bold' : 'g_f_reg',
      postScriptName: opts.bold ? 'Arial-BoldMT' : 'ArialMT',
      bold: !!opts.bold, italic: !!opts.italic,
      bucket: 'sans' as FontBucket, ascent: 0.9, descent: -0.2, embedded: true,
    },
  };
}

/** "Total:" en bold + "125.00" regular, mismo segmento (gap de palabra). */
function mkSeg(): SegmentNode {
  const runs = [mkRun('Total:', 72, 34, { bold: true }), mkRun('125.00', 110, 40)];
  return {
    id: 'p1-l0-s0', kind: 'segment', page: 1, text: 'Total: 125.00', runs,
    x: 72, baseline: 700, width: 78, y: 697.6, height: 13.2, fontSize: 12,
  };
}

function mount(seg: SegmentNode): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = seedHtml(seg, null, 1);
  document.body.appendChild(el);
  return el;
}

function select(el: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) throw new Error('sin selection');
  const range = document.createRange();
  let pos = 0;
  let startSet = false;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (!startSet && start <= pos + len) { range.setStart(n, start - pos); startSet = true; }
    if (startSet && end <= pos + len) { range.setEnd(n, end - pos); break; }
    pos += len;
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

describe('seed → serialize', () => {
  it('DETECTA la negrita existente del grafo y el roundtrip es idéntico (sin edits fantasma)', () => {
    const seg = mkSeg();
    const el = mount(seg);
    const runs = serializeStyled(el, seg, 1);
    expect(runs.map(r => ({ text: r.text, bold: r.bold }))).toEqual([
      { text: 'Total: ', bold: true },
      { text: '125.00', bold: false },
    ]);
    expect(styledRunsEqual(runs, originalStyledRuns(seg))).toBe(true);
  });
});

describe('applySelectionStyle (el camino del botón del panel y de Cmd+B)', () => {
  it('pone bold SOLO a la selección "125" y restaura la selección', () => {
    const seg = mkSeg();
    const el = mount(seg);
    // "Total: 125.00" → seleccionar "125" (offsets 7..10)
    select(el, 7, 10);
    applySelectionStyle(el, seg, null, 1, 'bold');
    const runs = serializeStyled(el, seg, 1);
    expect(runs.map(r => ({ text: r.text, bold: r.bold }))).toEqual([
      { text: 'Total: 125', bold: true }, // "Total: " ya era bold; "125" se le suma
      { text: '.00', bold: false },
    ]);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) throw new Error('selección perdida');
    expect(flatOffsets(el, sel.getRangeAt(0))).toEqual({ start: 7, end: 10 });
  });

  it('QUITA el bold solo de la parte seleccionada de un tramo bold', () => {
    const seg = mkSeg();
    const el = mount(seg);
    select(el, 0, 5); // "Total" dentro del tramo bold "Total: "
    applySelectionStyle(el, seg, null, 1, 'bold');
    const runs = serializeStyled(el, seg, 1);
    expect(runs.map(r => ({ text: r.text, bold: r.bold }))).toEqual([
      { text: 'Total', bold: false },
      { text: ': ', bold: true },
      { text: '125.00', bold: false },
    ]);
  });

  it('sin selección (caret): aplica a todo el box', () => {
    const seg = mkSeg();
    const el = mount(seg);
    select(el, 3, 3); // caret colapsado
    applySelectionStyle(el, seg, null, 1, 'bold');
    const runs = serializeStyled(el, seg, 1);
    // mixto → destino bold=true para todo
    expect(runs).toHaveLength(1);
    expect(runs[0].bold).toBe(true);
    expect(runs[0].text).toBe('Total: 125.00');
  });

  it('italic sobre la selección no toca el bold por tramo', () => {
    const seg = mkSeg();
    const el = mount(seg);
    select(el, 0, 13);
    applySelectionStyle(el, seg, null, 1, 'italic');
    const runs = serializeStyled(el, seg, 1);
    expect(runs.map(r => ({ bold: r.bold, italic: r.italic }))).toEqual([
      { bold: true, italic: true },
      { bold: false, italic: true },
    ]);
  });
});
