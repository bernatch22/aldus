import { describe, expect, it } from 'vitest';
import { isWhite, parseRawFill, toRgb } from './rawFill.js';

// ---- Copias VERBATIM de los dos parsers de v1 (bake/color.ts) ----
// La equivalencia se prueba CONTRA ellos, no contra valores tipeados a mano.

function rawFillToRgbV1(raw: string | undefined): { r: number; g: number; b: number } | null {
  if (!raw) return null;
  const nums = (raw.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  if (/\brg\b/.test(raw) && nums.length >= 3) return { r: nums[0]!, g: nums[1]!, b: nums[2]! };
  if (/\bg\b/.test(raw) && !/\brg\b/.test(raw) && nums.length >= 1) return { r: nums[0]!, g: nums[0]!, b: nums[0]! };
  if (/\bk\b/.test(raw) && nums.length >= 4) {
    const [c, m, y, kk] = nums as [number, number, number, number];
    return { r: (1 - c) * (1 - kk), g: (1 - m) * (1 - kk), b: (1 - y) * (1 - kk) };
  }
  if (nums.length >= 3) return { r: nums[nums.length - 3]!, g: nums[nums.length - 2]!, b: nums[nums.length - 1]! };
  if (nums.length === 1) return { r: nums[0]!, g: nums[0]!, b: nums[0]! };
  return null;
}

function isWhiteFillV1(rawFill: string): boolean {
  const toks = rawFill.trim().split(/\s+/);
  if (toks.length < 2) return false;
  const nums = toks.filter(t => /^[-+.\d]/.test(t)).map(Number).filter(Number.isFinite);
  const op = toks[toks.length - 1]!;
  if (op === 'g' && nums.length >= 1) return nums[nums.length - 1]! >= 0.99;
  if (op === 'rg' && nums.length >= 3) return nums.slice(-3).every(v => v >= 0.99);
  if (op === 'k' && nums.length >= 4) return nums.slice(-4).every(v => v <= 0.01);
  if ((op === 'sc' || op === 'scn') && nums.length >= 1) {
    const vals = nums.slice(-Math.min(nums.length, 3));
    return vals.every(v => v >= 0.99);
  }
  return false;
}

// Tabla de equivalencia: casos reales de AMBOS parsers viejos.
const TABLE = [
  '0.2 0.4 0.6 rg', // rgb directo
  '1 1 1 rg', //       blanco papel
  '0 0 0 rg', //       negro
  '0.99 1 0.995 rg', // blanco en el umbral
  '0 g', //            gris: negro
  '0.5 g', //          gris medio
  '1 g', //            gris: blanco
  '0 0 0 1 k', //      CMYK negro
  '0 0 0 0 k', //      CMYK blanco (todo ≤0.01)
  '0.2 0.1 0 0.05 k', // CMYK color
  '1 1 1 sc', //       sc blanco
  '0.5 sc', //         sc gris (1 componente)
  '1 scn', //          scn blanco 1 componente
  '0.9 0.99 1 scn', // scn casi-blanco (no llega)
  '0.25 0.5 0.75 scn', // scn rgb
] as const;

describe('rawFill — equivalencia con los DOS parsers de v1', () => {
  for (const raw of TABLE) {
    it(`"${raw}" → mismo rgb y mismo isWhite que v1`, () => {
      expect(toRgb(raw)).toEqual(rawFillToRgbV1(raw));
      expect(isWhite(raw)).toBe(isWhiteFillV1(raw));
    });
  }

  it('entradas vacías/inentendibles: mismo comportamiento que v1', () => {
    expect(toRgb(undefined)).toBeNull();
    expect(toRgb('')).toBeNull();
    expect(isWhite('')).toBe(false);
    expect(isWhite('g')).toBe(false); // sin operandos, como toks.length < 2 en v1
    expect(toRgb('f')).toEqual(rawFillToRgbV1('f')); // fill op sin números → null
  });

  it('parseRawFill expone {op, nums} tokenizados', () => {
    expect(parseRawFill('0.2 0.4 0.6 rg')).toEqual({ op: 'rg', nums: [0.2, 0.4, 0.6] });
    expect(parseRawFill('  1 g ')).toEqual({ op: 'g', nums: [1] });
    expect(parseRawFill(undefined)).toBeNull();
  });

  it('desvío documentado: un pattern name ("/P1 scn") NO alucina números', () => {
    // v1 rawFillToRgb devolvía gris {1,1,1} sacando el 1 del NOMBRE; v1
    // isWhiteFill devolvía false. El parser unificado no inventa componentes.
    expect(parseRawFill('/P1 scn')).toEqual({ op: 'scn', nums: [] });
    expect(toRgb('/P1 scn')).toBeNull();
    expect(isWhite('/P1 scn')).toBe(isWhiteFillV1('/P1 scn')); // false en ambos
  });
});
