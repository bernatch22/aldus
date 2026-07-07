/**
 * Byte-level splicing of a PDF content stream.
 *
 * A `Splice` is an in-place replacement `[start, end) → text` (empty text =
 * pure deletion). Replacing IN PLACE — instead of deleting + appending —
 * preserves Z-ORDER: the re-emitted block paints in the same turn as the
 * original did, so a background image that was moved still renders BELOW the
 * text that follows it in the stream.
 */

/** An in-place replacement in the stream: `[start, end)` → `text` ('' = delete). */
export interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Format a number for content-stream output (4 decimals, no negative zero). */
export const fmt = (v: number): string => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Decode a byte range as latin-1 (content streams are byte strings). */
export const latin1 = (bytes: Uint8Array, a: number, b: number): string => {
  let s = '';
  for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]);
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

/**
 * Apply the splices to the source bytes, optionally wrapping the stream with
 * `prepend`/`append` blocks.
 *
 * Ordering invariant: with the SAME start offset, a pure insertion
 * (start === end) sorts BEFORE a replacement/deletion — otherwise the
 * overlapped-splice skip would swallow it (real case: sending an image "to
 * back" when that image is already the first content op of the stream).
 * Overlapping splices are defensive-skipped: the first one wins.
 */
export function rebuild(src: Uint8Array, splices: Splice[], prepend = '', append = ''): Uint8Array {
  const sorted = [...splices].sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  let out = prepend ? `${prepend}\n` : '';
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) continue; // overlap (defensive): first splice wins
    out += latin1(src, pos, s.start);
    if (s.text) out += `\n${s.text}\n`;
    pos = s.end;
  }
  out += latin1(src, pos, src.length);
  if (append) out += `\n${append}\n`;
  return toBytes(out);
}
