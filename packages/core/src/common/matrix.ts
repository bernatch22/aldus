/**
 * Matrices afines PDF `[a b c d e f]` (ISO 32000 §8.3.3) — extraído VERBATIM
 * en semántica de v1 bake/textWalk.ts. `mul(m, n)` = m × n en la convención
 * PDF (fila-vector: el punto se transforma p′ = p · m).
 */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** Inversa afín (null si degenerada). mul(m, invert(m)) = identidad. */
export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  const ia = m[3] / det;
  const ib = -m[1] / det;
  const ic = -m[2] / det;
  const id = m[0] / det;
  return [ia, ib, ic, id, -(m[4] * ia + m[5] * ic), -(m[4] * ib + m[5] * id)];
}
