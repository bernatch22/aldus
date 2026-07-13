import { describe, expect, it } from 'vitest';
import { IDENTITY, invert, mul, type Matrix } from './matrix.js';

const expectClose = (actual: Matrix, expected: Matrix) =>
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 10));

describe('matrix', () => {
  it('mul with identity is a no-op on both sides', () => {
    const m: Matrix = [2, 0.5, -1, 3, 10, -20];
    expectClose(mul(m, IDENTITY), m);
    expectClose(mul(IDENTITY, m), m);
  });

  it('mul composes translations additively', () => {
    const t1: Matrix = [1, 0, 0, 1, 5, 7];
    const t2: Matrix = [1, 0, 0, 1, -2, 3];
    expectClose(mul(t1, t2), [1, 0, 0, 1, 3, 10]);
  });

  it('round-trip: mul(m, invert(m)) = identity (rotación+escala+traslación)', () => {
    const cos = Math.cos(0.7);
    const sin = Math.sin(0.7);
    const m: Matrix = [2 * cos, 2 * sin, -2 * sin, 2 * cos, 42, -13.5];
    const inv = invert(m);
    expect(inv).not.toBeNull();
    expectClose(mul(m, inv!), IDENTITY);
    expectClose(mul(inv!, m), IDENTITY);
  });

  it('invert of a degenerate matrix is null', () => {
    expect(invert([0, 0, 0, 0, 3, 4])).toBeNull();
    expect(invert([1, 2, 2, 4, 0, 0])).toBeNull(); // det = 0
  });
});
