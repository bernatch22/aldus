import { describe, expect, it } from 'vitest';
import { normalize } from './text.js';

describe('normalize', () => {
  it('lowercases and strips accents via NFD (ñ pierde la virgulilla también)', () => {
    expect(normalize('PARTE RECEPTORA')).toBe('parte receptora');
    expect(normalize('Áéíóú')).toBe('aeiou');
    expect(normalize('Ñandú')).toBe('nandu');
  });

  it('collapses whitespace and trims', () => {
    expect(normalize('  hola \t\n  mundo  ')).toBe('hola mundo');
  });

  it('precomposed and decomposed forms normalize identically (NFD)', () => {
    expect(normalize('café')).toBe(normalize('café')); // é vs e + ´
    expect(normalize('café')).toBe('cafe');
  });

  it('empty and whitespace-only input → empty string', () => {
    expect(normalize('')).toBe('');
    expect(normalize('  \n ')).toBe('');
  });
});
