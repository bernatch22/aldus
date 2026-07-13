/**
 * pdf/splice.ts — byte-level splicing of a PDF content stream (Layer 1).
 *
 * A `Splice` is an in-place replacement `[start, end) → text` (empty text =
 * pure deletion). Replacing IN PLACE — instead of deleting + appending —
 * preserves Z-ORDER: the re-emitted block paints in the same turn as the
 * original did, so a background image that was moved still renders BELOW the
 * text that follows it in the stream.
 *
 * Trasplante de v1 bake/splice.ts: `rebuild` verbatim; los helpers
 * fmt/latin1/toBytes/hexString viven en common/bytes.ts (Layer 0).
 */

import { latin1, toBytes } from '../common/bytes.js';

/** An in-place replacement in the stream: `[start, end)` → `text` ('' = delete). */
export interface Splice {
  start: number;
  end: number;
  text: string;
}

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
