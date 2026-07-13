import { describe, expect, it } from 'vitest';
import { once } from './once.js';

describe('once', () => {
  it('runs the thunk a single time and memoizes', () => {
    let calls = 0;
    const fn = once(() => ++calls);
    expect(fn()).toBe(1);
    expect(fn()).toBe(1);
    expect(calls).toBe(1);
  });

  it('a thunk that throws is not memoized and re-runs', () => {
    let calls = 0;
    const fn = once(() => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return calls;
    });
    expect(() => fn()).toThrow('boom');
    expect(fn()).toBe(2);
  });
});
