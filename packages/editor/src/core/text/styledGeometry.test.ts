import { describe, expect, it } from 'vitest';
import type { StyledRun } from '@aldus/core';
import { restyleKeepingGeometry } from './styledGeometry.js';

/** El caso REAL de los logs del usuario (contrato de distribución, glifos
 *  U+0011): el seed viene fragmentado por el acento con dx geométricos; el
 *  commit fusionaba y PERDÍA los dx → el bake re-emitía corrido → espacio
 *  fantasma "nombre ]" / nodo partido. */
describe('restyleKeepingGeometry', () => {
  const seed: StyledRun[] = [
    { text: 'programa inform', bold: false, italic: false },
    { text: 'a', bold: false, italic: false, dx: 82.3 },
    { text: 'tico como ', bold: false, italic: false, dx: 88.1 },
    { text: 'insertar nombre', bold: false, italic: true, dx: 140.5 },
    { text: '].', bold: false, italic: false, dx: 210.9 },
  ];
  const text = seed.map(r => r.text).join('');

  it('texto idéntico + estilos nuevos → dx del seed byte-idénticos en sus fronteras', () => {
    // El editor fusionó tramos y aplicó bold a "nombre" (frontera nueva adentro
    // del run itálico del seed).
    const styled: StyledRun[] = [
      { text: 'programa informatico como ', bold: false, italic: false },
      { text: 'insertar ', bold: false, italic: true },
      { text: 'nombre', bold: true, italic: true },
      { text: '].', bold: false, italic: false },
    ];
    const out = restyleKeepingGeometry(seed, styled);
    expect(out.map(r => r.text).join('')).toBe(text);
    // Cada frontera del SEED reaparece con su dx EXACTO:
    const dxOf = (t: string) => out.find(r => r.text.startsWith(t))?.dx;
    expect(dxOf('a')).toBe(82.3);
    expect(dxOf('tico')).toBe(88.1);
    expect(dxOf('insertar')).toBe(140.5);
    expect(dxOf('].')).toBe(210.9);
    // El estilo nuevo manda: "nombre" quedó bold+italic, sin dx inventado
    // (arranca DENTRO de un run del seed — fluye desde "insertar ").
    const nombre = out.find(r => r.text === 'nombre')!;
    expect(nombre.bold).toBe(true);
    expect(nombre.italic).toBe(true);
    expect(nombre.dx).toBeUndefined();
  });

  it('estilos idénticos (toggle y des-toggle) → runs equivalentes al seed', () => {
    const styled: StyledRun[] = [
      { text: 'programa informatico como ', bold: false, italic: false },
      { text: 'insertar nombre', bold: false, italic: true },
      { text: '].', bold: false, italic: false },
    ];
    const out = restyleKeepingGeometry(seed, styled);
    // Mismo texto, mismos dx, mismos estilos que el seed (módulo fronteras
    // sin dx, que el bake emite pegadas — geometría idéntica).
    expect(out.map(r => r.text).join('')).toBe(text);
    for (const s of seed) {
      if (s.dx === undefined) continue;
      const m = out.find(r => r.dx === s.dx)!;
      expect(m).toBeDefined();
      expect(m.text).toBe(s.text.length <= m.text.length ? m.text : s.text);
      expect(m.bold).toBe(s.bold);
      expect(m.italic).toBe(s.italic);
    }
  });

  it('underline conserva el ancho geométrico del seed', () => {
    const seedU: StyledRun[] = [
      { text: 'hola ', bold: false, italic: false },
      { text: 'mundo', bold: false, italic: false, underline: true, w: 31.4, dx: 25 },
    ];
    const styled: StyledRun[] = [
      { text: 'hola ', bold: false, italic: false },
      { text: 'mundo', bold: true, italic: false, underline: true, w: 33.9 }, // w del browser: difiere
    ];
    const out = restyleKeepingGeometry(seedU, styled);
    const mundo = out.find(r => r.text === 'mundo')!;
    expect(mundo.underline).toBe(true);
    expect(mundo.w).toBe(31.4); // gana la geometría del PDF
    expect(mundo.bold).toBe(true); // gana el estilo nuevo
    expect(mundo.dx).toBe(25);
  });
});
