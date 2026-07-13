import { describe, expect, it } from 'vitest';
import { fmt, hexString, latin1, toBytes } from './bytes.js';

describe('bytes', () => {
  it('fmt rounds to 4 decimals and never emits -0', () => {
    expect(fmt(1.234567)).toBe('1.2346');
    expect(fmt(-0.00004)).toBe('0'); // rounds to -0 → '0'
    expect(fmt(-0)).toBe('0');
    expect(fmt(0)).toBe('0');
    expect(fmt(-1.5)).toBe('-1.5');
    expect(fmt(72)).toBe('72');
  });

  it('latin1 decodes a byte range (control bytes intact); toBytes is its inverse', () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xe9, 0x00, 0x12]);
    const s = latin1(bytes, 0, bytes.length);
    expect(s).toBe('Helloé\u0000\u0012'); // U+0012 viaja intacto (gotcha LibreOffice)
    expect(toBytes(s)).toEqual(bytes);
    // sub-rango [1, 3)
    expect(latin1(bytes, 1, 3)).toBe('el');
  });

  it('toBytes truncates codepoints above 0xff (byte strings, not UTF-8)', () => {
    expect([...toBytes('Ł')]).toEqual([0x41]); // U+0141 & 0xff
  });

  it('hexString emits a PDF hex-string literal, zero-padded', () => {
    expect(hexString(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]))).toBe('<48656c6c6f>');
    expect(hexString(new Uint8Array([0x00, 0x0f]))).toBe('<000f>');
    expect(hexString(new Uint8Array([]))).toBe('<>');
  });
});
