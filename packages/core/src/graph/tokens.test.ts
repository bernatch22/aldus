/**
 * tokens — los umbrales sagrados de classifyGap, testeados AL LADO de su
 * fuente (movido de v1 test/styledRuns.test.ts, describe classifyGap).
 */
import { describe, expect, it } from 'vitest';
import type { TextRunNode } from '../model/nodes.js';
import { classifyGap } from './tokens.js';

const TR = (text: string, x: number, baseline: number, fontSize = 9.75): TextRunNode =>
  ({ id: `r-${x}`, kind: 'text', page: 1, text, x, baseline, width: text.length * fontSize * 0.5, fontSize, angle: 0, font: { bold: false, italic: false } as TextRunNode['font'] });

describe('classifyGap — un marcador de lista corto NO parte en columna (bug del "i)")', () => {
  // "i)" (w=6.4, 2 chars, fs 11.3) seguido de un párrafo. gap 7.9pt: con el
  // promedio daba "columna" (umbral 7.7) → el marcador quedaba de nodo suelto.
  // Valores REALES del doc capturado (page 4, baseline 736).
  const marker: TextRunNode = TR('i)', 84.9, 736, 11.3); marker.width = 6.4;
  const para: TextRunNode = TR('Si no se ha habilitado anteriorme', 99.1, 736, 11.3); para.width = 174.9;
  it('un gap normal tras un marcador corto es espacio, no columna', () => {
    const gap = para.x - (marker.x + marker.width); // 7.9pt
    expect(classifyGap(gap, marker, para)).toBe('space');
  });
  it('un gap grande de verdad SIGUE siendo columna', () => {
    const colGap = 40;
    expect(classifyGap(colGap, para, para)).toBe('column');
  });
  it('espacio COMPRIMIDO por justificado (gap ~2pt @11.3pt) es espacio, no ruido', () => {
    // "Siel número deRUC": el justificado aprieta el espacio bajo 0.5×charW.
    const a = TR('Si', 99.1, 492, 11.3); a.width = 8;
    const b = TR('el número de', 109.1, 492, 11.3); b.width = 60;
    expect(classifyGap(2.0, a, b)).toBe('space');
    expect(classifyGap(0.6, a, b)).toBe('none'); // kerning real sigue siendo nada
  });
});
