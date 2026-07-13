/**
 * Parser UNIFICADO de operadores de fill crudos del content stream
 * ("0.2 0.4 0.6 rg", "0 g", "C M Y K k", sc/scn) — reemplaza a los DOS
 * parsers de v1 (`rawFillToRgb` en bake/color.ts y `isWhiteFill` ídem), que
 * extraían los números con estrategias distintas.
 *
 * Extracción de números: por TOKEN numérico (la estrategia de isWhiteFill).
 * ⚠️ Desvío deliberado respecto de rawFillToRgb: aquel sacaba números por
 * regex sobre el string entero, así que un pattern fill "/P1 scn" alucinaba
 * el `1` del nombre como componente de color. El parser unificado NO — un
 * name token nunca aporta números. Para todo fill numérico real ambos viejos
 * y este coinciden (el test lo prueba contra copias verbatim de ambos).
 */

export interface ParsedFill {
  /** El operador (último token): 'rg' | 'g' | 'k' | 'sc' | 'scn' | otro. */
  op: string;
  /** Los operandos numéricos, en orden (tokens que parsean como número finito). */
  nums: number[];
}

/** Tokeniza un raw fill. Devuelve null para undefined/vacío. */
export function parseRawFill(raw: string | undefined): ParsedFill | null {
  if (!raw) return null;
  const toks = raw.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return null;
  const op = toks[toks.length - 1]!;
  const nums = toks
    .slice(0, -1)
    .filter(t => /^[-+.\d]/.test(t))
    .map(Number)
    .filter(Number.isFinite);
  return { op, nums };
}

/**
 * Raw fill → rgb 0..1, o null si no se entiende. Misma tabla de verdad que
 * v1 `rawFillToRgb`: rg directo, g gris, k CMYK naïve, y sc/scn sin
 * color-space conocido: 3 números = rgb (los últimos 3), 1 = gris.
 */
export function toRgb(raw: string | undefined): { r: number; g: number; b: number } | null {
  const p = parseRawFill(raw);
  if (!p) return null;
  const { op, nums } = p;
  if (op === 'rg' && nums.length >= 3) return { r: nums[0]!, g: nums[1]!, b: nums[2]! };
  if (op === 'g' && nums.length >= 1) return { r: nums[0]!, g: nums[0]!, b: nums[0]! };
  if (op === 'k' && nums.length >= 4) {
    const [c, m, y, kk] = nums as [number, number, number, number];
    return { r: (1 - c) * (1 - kk), g: (1 - m) * (1 - kk), b: (1 - y) * (1 - kk) };
  }
  // sc/scn (u operador desconocido) con números sueltos: 3 = rgb, 1 = gris.
  if (nums.length >= 3) return { r: nums[nums.length - 3]!, g: nums[nums.length - 2]!, b: nums[nums.length - 1]! };
  if (nums.length === 1) return { r: nums[0]!, g: nums[0]!, b: nums[0]! };
  return null;
}

/**
 * ¿Este fill pinta blanco ("papel")? '' = negro por defecto → false.
 * Misma tabla de verdad que v1 `isWhiteFill` (el walk la usa para saltar el
 * rect blanco de página completa que muchos generadores pintan de fondo).
 */
export function isWhite(raw: string): boolean {
  const p = parseRawFill(raw);
  if (!p || p.nums.length === 0) return false;
  const { op, nums } = p;
  if (op === 'g' && nums.length >= 1) return nums[nums.length - 1]! >= 0.99;
  if (op === 'rg' && nums.length >= 3) return nums.slice(-3).every(v => v >= 0.99);
  if (op === 'k' && nums.length >= 4) return nums.slice(-4).every(v => v <= 0.01);
  if ((op === 'sc' || op === 'scn') && nums.length >= 1) {
    const vals = nums.slice(-Math.min(nums.length, 3));
    return vals.every(v => v >= 0.99);
  }
  return false;
}
