/**
 * Emitting text blocks back into the content stream. Trasplante VERBATIM de
 * v1 bake/textEmit.ts (matrix desde common/matrix, bytes desde common/bytes).
 *
 * Every emitted text matrix is RELATIVE to the CTM at the insertion point
 * (`M_rel = M_abs × inv(ctm)`): re-emission is in-place, inside the original
 * q/cm nesting, so the surrounding transform must be compensated.
 */
import { invert, mul, type Matrix } from '../common/matrix.js';
import { fmt, hexString, latin1 } from '../common/bytes.js';
import type { ShowOp } from '../pdf/contentWalk.js';

/** Segment-level style overrides applicable at the operator level. */
export interface TextStyleOverrides {
  /** Tc in points (Acrobat's "AV"). */
  charSpacing?: number;
  /** Tz in % (Acrobat's "T↔"). */
  hScale?: number;
  /** Fill color operator ("r g b rg"). */
  colorRaw?: string;
}

/** Text matrix RELATIVE to the op's CTM for the given scale + position.
 *  Devuelve null también si algún componente NO es finito (NaN/Infinity):
 *  `fmt(NaN)` escribiría literalmente "NaN" en el stream → PDF corrupto e
 *  ilegible ("Unknown command NaN"). El emit JAMÁS puede corromper. */
export function relTm(o: ShowOp, ratio: number, x: number, y: number): Matrix | null {
  const m = o.matrix;
  const abs: Matrix = [m[0] * ratio, m[1] * ratio, m[2] * ratio, m[3] * ratio, x, y];
  const inv = invert(o.ctm);
  const t = inv ? mul(abs, inv) : null;
  return t && t.every(Number.isFinite) ? t : null;
}

/**
 * Block re-emitting ONE show op VERBATIM (same bytes, same font, TJ kerning
 * intact), relocated/scaled/re-styled. Path A: pixel-perfect. Returns null on
 * a degenerate matrix.
 */
export function reemitBlock(o: ShowOp, src: Uint8Array, ratio: number, x: number, y: number, ov: TextStyleOverrides = {}): string | null {
  const show =
    o.op === 'Tj' || o.op === 'TJ'
      ? latin1(src, o.record.start, o.record.end)
      : o.op === "'"
        ? `${o.record.operands[0]?.raw ?? '()'} Tj`
        : `${o.record.operands[2]?.raw ?? '()'} Tj`;
  const t = relTm(o, ratio, x, y);
  if (!t) return null;
  const colorRaw = ov.colorRaw ?? o.fillColorRaw;
  const color = colorRaw ? `${colorRaw} ` : '';
  const tc = ov.charSpacing ?? o.charSpacing * ratio;
  const tz = ov.hScale ?? o.hScale;
  return (
    `q BT ${color}/${o.fontName} ${fmt(o.fontSize)} Tf ` +
    `${fmt(tc)} Tc ${fmt(o.wordSpacing * ratio)} Tw ${fmt(tz)} Tz ` +
    `${fmt(t[0])} ${fmt(t[1])} ${fmt(t[2])} ${fmt(t[3])} ${fmt(t[4])} ${fmt(t[5])} Tm ` +
    `${show} ET Q`
  );
}

/**
 * Block showing NEW text re-encoded with the original font (path B). `bytes`
 * must already be encoded through the font's reverse /ToUnicode map.
 */
export function newTextBlock(o: ShowOp, ratio: number, x: number, y: number, bytes: Uint8Array, ov: TextStyleOverrides = {}): string | null {
  const t = relTm(o, ratio, x, y);
  if (!t) return null;
  const colorRaw = ov.colorRaw ?? o.fillColorRaw;
  const color = colorRaw ? `${colorRaw} ` : '';
  const tc = ov.charSpacing ?? 0;
  const tz = ov.hScale ?? o.hScale;
  return (
    `q BT ${color}/${o.fontName} ${fmt(o.fontSize)} Tf ${fmt(tc)} Tc 0 Tw ${fmt(tz)} Tz ` +
    `${fmt(t[0])} ${fmt(t[1])} ${fmt(t[2])} ${fmt(t[3])} ${fmt(t[4])} ${fmt(t[5])} Tm ` +
    `${hexString(bytes)} Tj ET Q`
  );
}
