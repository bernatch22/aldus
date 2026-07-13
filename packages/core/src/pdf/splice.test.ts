/**
 * splice.test.ts — unit de `rebuild` (pdf/splice.ts). Portado de F1a
 * (v1 test/splice.test.ts).
 *
 * El invariante crítico (documentado en el propio archivo): con el MISMO
 * start, una INSERCIÓN pura (start === end) ordena ANTES que un
 * reemplazo/borrado — si no, el skip defensivo de solapes se la tragaría
 * (caso real: mandar una imagen "al fondo" cuando ya es el primer op).
 */
import { describe, expect, it } from 'vitest';
import { rebuild, type Splice } from './splice.js';

const str = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};
const src = (s: string): Uint8Array => Uint8Array.from([...s].map(c => c.charCodeAt(0)));

describe('rebuild — splicing byte a byte', () => {
  it('reemplaza in-place un rango (con \\n alrededor del texto nuevo)', () => {
    const out = rebuild(src('AAABBBCCC'), [{ start: 3, end: 6, text: 'XX' }]);
    expect(str(out)).toBe('AAA\nXX\nCCC');
  });

  it('borra puro (text vacío = sin \\n insertado)', () => {
    const out = rebuild(src('AAABBBCCC'), [{ start: 3, end: 6, text: '' }]);
    expect(str(out)).toBe('AAACCC');
  });

  it('prepend y append envuelven el stream', () => {
    const out = rebuild(src('CONTENIDO'), [], 'PRE', 'POST');
    expect(str(out)).toBe('PRE\nCONTENIDO\nPOST\n');
  });

  it('varios splices se aplican en orden de offset, no de llegada', () => {
    const out = rebuild(src('AAABBBCCC'), [
      { start: 6, end: 9, text: 'Z' },
      { start: 0, end: 3, text: 'X' },
    ]);
    expect(str(out)).toBe('\nX\nBBB\nZ\n');
  });

  it('INVARIANTE: con el mismo start, la inserción va ANTES que el reemplazo (no se la traga el skip)', () => {
    const splices: Splice[] = [
      { start: 0, end: 3, text: 'NEW' },  // reemplazo del primer op
      { start: 0, end: 0, text: 'BACK' }, // inserción "al fondo" en el mismo offset
    ];
    const out = str(rebuild(src('IMG resto'), splices));
    // Ambos presentes (la inserción NO fue tragada) y en el orden correcto.
    expect(out).toContain('BACK');
    expect(out).toContain('NEW');
    expect(out.indexOf('BACK')).toBeLessThan(out.indexOf('NEW'));
    expect(out).not.toContain('IMG');
    // Independiente del orden de llegada (el sort manda, no el input).
    expect(str(rebuild(src('IMG resto'), [...splices].reverse()))).toBe(out);
  });

  it('splices solapados: el primero gana, el segundo se salta (defensivo)', () => {
    const out = rebuild(src('0123456789'), [
      { start: 0, end: 5, text: 'A' },
      { start: 2, end: 7, text: 'B' }, // solapa con el anterior → skip
    ]);
    expect(str(out)).toBe('\nA\n56789');
  });

  it('inserción pura en el medio no consume bytes', () => {
    const out = rebuild(src('ABCD'), [{ start: 2, end: 2, text: 'X' }]);
    expect(str(out)).toBe('AB\nX\nCD');
  });
});
