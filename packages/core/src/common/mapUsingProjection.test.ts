import { describe, expect, it } from 'vitest';
import { MapUsingProjection } from './mapUsingProjection.js';

describe('MapUsingProjection', () => {
  it('compares keys through the projection but preserves original keys', () => {
    const map = new MapUsingProjection<string, number>(s => s.toLowerCase());
    map.set('Hello', 1);
    expect(map.get('HELLO')).toBe(1);
    expect(map.has('hello')).toBe(true);
    map.set('HELLO', 2); // same projected key → overwrites
    expect(map.size).toBe(1);
    expect(map.get('hello')).toBe(2);
    expect([...map.entries()]).toEqual([['HELLO', 2]]);
  });

  it('supports delete, clear and iteration', () => {
    const map = new MapUsingProjection<string, string>(s => s.toLowerCase(), [['A', 'a'], ['B', 'b']]);
    expect([...map.values()]).toEqual(['a', 'b']);
    expect([...map]).toEqual([['A', 'a'], ['B', 'b']]);
    expect(map.delete('a')).toBe(true);
    expect(map.size).toBe(1);
    map.clear();
    expect(map.size).toBe(0);
  });
});
