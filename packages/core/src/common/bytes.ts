/**
 * Helpers byte↔string para content streams (extraído VERBATIM de v1
 * bake/splice.ts). Los content streams son BYTE strings: latin-1 es la
 * biyección byte↔char, nunca UTF-8.
 */

/** Format a number for content-stream output (4 decimals, no negative zero). */
export const fmt = (v: number): string => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Decode a byte range as latin-1 (content streams are byte strings). */
export const latin1 = (bytes: Uint8Array, a: number, b: number): string => {
  let s = '';
  for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]!);
  return s;
};

/** Encode a latin-1 string back to bytes (inverse of {@link latin1}). */
export const toBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** PDF hex-string literal (`<48656c6c6f>`) for arbitrary bytes. */
export const hexString = (bytes: Uint8Array): string =>
  `<${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}>`;
