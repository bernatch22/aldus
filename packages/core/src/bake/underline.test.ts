/**
 * underline.test.ts — la INVARIANTE de la fuente única (unit, colocado):
 * el rect que emite underlineRectFor es encontrado por underlineRectsFor.
 * Si alguien toca una constante sin la otra, esto explota antes que un PDF.
 */
import { describe, expect, it } from 'vitest';
import type { SegmentEdit } from '../model/edits.js';
import type { FillRectOp } from '../pdf/contentWalk.js';
import { underlineRectFor, underlineRectsFor } from './underline.js';

const IDENTITY: FillRectOp['ctm'] = [1, 0, 0, 1, 0, 0];

const editAt = (x: number, baseline: number, width: number, fontSize: number, baselines?: number[]): SegmentEdit => ({
  segmentId: 's', page: 1, text: 'x',
  original: { text: 'x', x, baseline, width, fontSize, ...(baselines ? { baselines } : {}) },
});

const asFillRect = (r: { x: number; y: number; width: number; height: number }, start = 0): FillRectOp =>
  ({ start, end: start + 10, ...r, fillColorRaw: '0 0 0 rg', ctm: IDENTITY });

describe('underline — emisión ↔ filtro consistentes', () => {
  it('lo que emite underlineRectFor lo encuentra underlineRectsFor (varios tamaños)', () => {
    for (const size of [7, 10, 12, 16, 24, 48]) {
      const edit = editAt(72, 700, 120, size);
      const emitted = underlineRectFor(72, 700, size, 120);
      const found = underlineRectsFor(edit, [asFillRect(emitted)]);
      expect(found, `size ${size}`).toHaveLength(1);
    }
  });

  it('multilínea: el rect de CADA baseline se encuentra', () => {
    const size = 12;
    const baselines = [700, 700 - size * 1.2, 700 - size * 2.4];
    const edit = editAt(72, 700, 200, size, baselines);
    const rects = baselines.map((b, i) => asFillRect(underlineRectFor(72, b, size, 200), i * 100));
    expect(underlineRectsFor(edit, rects)).toHaveLength(3);
  });

  it('un rect GRUESO (no subrayado) no pasa el filtro', () => {
    const edit = editAt(72, 700, 120, 12);
    const thick = asFillRect({ x: 72, y: 700 - 12 * 0.11, width: 120, height: 5 });
    expect(underlineRectsFor(edit, [thick])).toHaveLength(0);
  });

  it('un rect fino LEJOS de la baseline no pasa el filtro', () => {
    const edit = editAt(72, 700, 120, 12);
    const far = asFillRect(underlineRectFor(72, 640, 12, 120));
    expect(underlineRectsFor(edit, [far])).toHaveLength(0);
  });

  it('un rect fino de OTRA columna (fuera en x) no pasa el filtro', () => {
    const edit = editAt(72, 700, 100, 12);
    const other = asFillRect(underlineRectFor(300, 700, 12, 100));
    expect(underlineRectsFor(edit, [other])).toHaveLength(0);
  });
});
