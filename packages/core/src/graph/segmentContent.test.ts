/**
 * segmentContent — runLines y originalStyledRuns (portado de v1
 * test/styledRuns.test.ts describe runLines + test/runLines-edge.test.ts de
 * F1a: los casos BORDE del umbral 0.55×fontSize — la definición ejecutable
 * que la proyección a buckets de PageGraphService debe respetar).
 */
import { describe, expect, it } from 'vitest';
import type { SegmentNode, TextRunNode } from '../model/nodes.js';
import { originalStyledRuns, runLines } from './segmentContent.js';

const TR = (text: string, x: number, baseline: number, fontSize = 9.75, bold = false): TextRunNode =>
  ({ id: `r-${x}`, kind: 'text', page: 1, text, x, baseline, width: text.length * fontSize * 0.5, fontSize, angle: 0, font: { bold, italic: false } as TextRunNode['font'] });
const SEG = (runs: TextRunNode[]): SegmentNode => ({ runs } as unknown as SegmentNode);

describe('runLines — super/subíndice NO abre línea (bug del "1 Una API")', () => {
  it('un superíndice (Δbaseline << fontSize) queda en la MISMA línea', () => {
    // "1" a baseline 94.6, el resto a 97.6 (Δ3pt, fontSize 9.75) — es el caso real.
    const seg = SEG([TR('1', 84.9, 94.6), TR('Una API', 90.9, 97.6), TR('es el resto', 125.4, 97.6)]);
    expect(runLines(seg)).toHaveLength(1);
    expect(originalStyledRuns(seg).map(r => r.text).join('')).not.toContain('\n');
  });
  it('una caída real de línea (Δ ≥ ~fontSize) SÍ abre línea', () => {
    const seg = SEG([TR('linea uno', 84.9, 97.6), TR('linea dos', 84.9, 85.0)]); // Δ12.6 > 0.55×9.75
    expect(runLines(seg)).toHaveLength(2);
    expect(originalStyledRuns(seg).map(r => r.text).join('')).toContain('\n');
  });
});

describe('runLines — el borde exacto del umbral 0.55×fs', () => {
  const fs = 9.75;

  it('caída de 0.549×fs NO abre línea (super/subíndice)', () => {
    const seg = SEG([TR('cuerpo', 10, 100, fs), TR('sub', 50, 100 - 0.549 * fs, fs)]);
    expect(runLines(seg)).toHaveLength(1);
  });

  it('caída de 0.551×fs SÍ abre línea (salto real)', () => {
    const seg = SEG([TR('linea uno', 10, 100, fs), TR('linea dos', 10, 100 - 0.551 * fs, fs)]);
    expect(runLines(seg)).toHaveLength(2);
  });

  it('el umbral usa el fontSize MÁXIMO del segmento (el cuerpo, no el superíndice)', () => {
    // Δ = 5.0: con fs máx 12 el umbral es 6.6 (misma línea); si tomara el fs
    // chico (7 → 3.85) abriría línea.
    const seg = SEG([TR('1', 10, 105, 7), TR('cuerpo grande', 16, 100, 12)]);
    expect(runLines(seg)).toHaveLength(1);
  });

  it('las líneas quedan ordenadas de arriba hacia abajo, y dentro por x', () => {
    const seg = SEG([TR('b', 30, 80, fs), TR('a', 10, 80, fs), TR('arriba', 10, 100, fs)]);
    const lines = runLines(seg);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.map(r => r.text)).toEqual(['arriba']);
    expect(lines[1]!.map(r => r.text)).toEqual(['a', 'b']);
  });
});
