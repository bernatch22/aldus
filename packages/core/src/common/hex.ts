/**
 * common/hex.ts — conversiones hex CSS ↔ rgb 0..1 ↔ operador de fill del
 * content stream. Trasplante VERBATIM de v1 bake/color.ts (la parte hex);
 * mata la duplicación #3 del audit (createNodes.hexToRgb era una copia local).
 * Los parsers de raw fill viven en common/rawFill.ts (parseRawFill/toRgb/isWhite).
 */
import { fmt } from './bytes.js';

/** `#rrggbb` → an `R G B rg` fill operator, or undefined if not parseable. */
export function hexToRg(hex: string): string | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const v = parseInt(m[1]!, 16);
  const c = (n: number) => fmt(n / 255);
  return `${c((v >> 16) & 0xff)} ${c((v >> 8) & 0xff)} ${c(v & 0xff)} rg`;
}

/** `#rrggbb` → rgb 0..1 (black when not parseable). */
export const hexToRgbObj = (hex: string): { r: number; g: number; b: number } => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1]!, 16) : 0;
  return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255 };
};

/** rgb 0..1 → `#rrggbb` (clamped). */
export const rgbToHex = (c: { r: number; g: number; b: number }): string => {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
};
