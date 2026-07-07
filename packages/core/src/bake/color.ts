/**
 * Color conversions between hex CSS colors, rgb 0..1 triples, and the raw
 * fill-color operators found in (and emitted to) the content stream.
 */
import { fmt } from './splice.js';

/** `#rrggbb` → an `R G B rg` fill operator, or undefined if not parseable. */
export function hexToRg(hex: string): string | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const v = parseInt(m[1], 16);
  const c = (n: number) => fmt(n / 255);
  return `${c((v >> 16) & 0xff)} ${c((v >> 8) & 0xff)} ${c(v & 0xff)} rg`;
}

/**
 * Parse an original raw fill operator ("R G B rg", "G g", "C M Y K k", or
 * sc/scn with 1/3 numbers) into rgb 0..1. Returns null when not understood.
 */
export function rawFillToRgb(raw: string | undefined): { r: number; g: number; b: number } | null {
  if (!raw) return null;
  const nums = (raw.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  if (/\brg\b/.test(raw) && nums.length >= 3) return { r: nums[0], g: nums[1], b: nums[2] };
  if (/\bg\b/.test(raw) && !/\brg\b/.test(raw) && nums.length >= 1) return { r: nums[0], g: nums[0], b: nums[0] };
  if (/\bk\b/.test(raw) && nums.length >= 4) {
    const [c, m, y, kk] = nums;
    return { r: (1 - c) * (1 - kk), g: (1 - m) * (1 - kk), b: (1 - y) * (1 - kk) };
  }
  // sc/scn without a recognized color-space operator: 3 numbers = rgb, 1 = gray.
  if (nums.length >= 3) return { r: nums[nums.length - 3], g: nums[nums.length - 2], b: nums[nums.length - 1] };
  if (nums.length === 1) return { r: nums[0], g: nums[0], b: nums[0] };
  return null;
}

/** `#rrggbb` → rgb 0..1 (black when not parseable). */
export const hexToRgbObj = (hex: string): { r: number; g: number; b: number } => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0;
  return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255 };
};

/** rgb 0..1 → `#rrggbb` (clamped). */
export const rgbToHex = (c: { r: number; g: number; b: number }): string => {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
};

/**
 * Does this raw fill operator paint white ("paper")? '' = default black.
 * Used by the content walk to find the first REAL content op — many
 * generators paint a full-page white rect as the sheet, and inserting behind
 * that opaque paper would hide the block entirely.
 */
export function isWhiteFill(rawFill: string): boolean {
  const toks = rawFill.trim().split(/\s+/);
  if (toks.length < 2) return false;
  const nums = toks.filter(t => /^[-+.\d]/.test(t)).map(Number).filter(Number.isFinite);
  const op = toks[toks.length - 1];
  if (op === 'g' && nums.length >= 1) return nums[nums.length - 1] >= 0.99;
  if (op === 'rg' && nums.length >= 3) return nums.slice(-3).every(v => v >= 0.99);
  if (op === 'k' && nums.length >= 4) return nums.slice(-4).every(v => v <= 0.01);
  if ((op === 'sc' || op === 'scn') && nums.length >= 1) {
    const vals = nums.slice(-Math.min(nums.length, 3));
    return vals.every(v => v >= 0.99);
  }
  return false;
}
