/**
 * styledRuns.test.ts — la MUTACIÓN de tramos estilados (F4): applyTextDiff (LCS
 * por carácter), setStyleRange, toggleStyleRange. Portado de v1
 * styledRuns.test.ts (las describes de mutación; classifyGap/runLines viven en
 * F2 graph/). Operaciones puras — el editor las usa para tipear/Cmd+B/color.
 */
import { describe, expect, it } from 'vitest';
import { applyTextDiff, setStyleRange, toggleStyleRange } from './styledRuns.js';
import type { StyledRun } from '../model/nodes.js';

const R = (text: string, bold = false, italic = false, dx = 0): StyledRun => ({ text, bold, italic, dx });

describe('applyTextDiff (textarea plano → estilos re-mapeados)', () => {
  const B = (text: string, bold = false): StyledRun => ({ text, bold, italic: false, dx: 0 });
  it('tipear en el medio hereda el estilo del tramo donde empieza el cambio', () => {
    const out = applyTextDiff([B('Total: ', true), B('125.00')], 'Total: extra 125.00');
    expect(out.map(r => [r.text, r.bold])).toEqual([['Total: ', true], ['extra 125.00', false]]);
  });
  it('borrar el frente conserva los estilos del resto', () => {
    const out = applyTextDiff([B('AB', true), B('CD')], 'BCD');
    expect(out.map(r => [r.text, r.bold])).toEqual([['B', true], ['CD', false]]);
  });
  it('reemplazo total = un solo tramo con el estilo del punto de cambio', () => {
    const out = applyTextDiff([B('Hola', true)], 'Chau');
    expect(out.map(r => [r.text, r.bold])).toEqual([['Chau', true]]);
  });
  it('texto idéntico → misma referencia (noop)', () => {
    const runs = [B('abc')];
    expect(applyTextDiff(runs, 'abc')).toBe(runs);
  });
  it('agregar al final extiende el último tramo', () => {
    const out = applyTextDiff([B('• ', false), B('item', true)], '• items');
    expect(out.map(r => [r.text, r.bold])).toEqual([['• ', false], ['items', true]]);
  });
});

describe('setStyleRange (color a la selección)', () => {
  const B = (text: string): StyledRun => ({ text, bold: false, italic: false, dx: 0 });
  it('colorea SOLO la parte seleccionada', () => {
    const out = setStyleRange([B('Hola mundo')], 5, 10, { color: '#ff0000' });
    expect(out.map(r => [r.text, r.color])).toEqual([
      ['Hola ', undefined],
      ['mundo', '#ff0000'],
    ]);
  });
  it('no rompe los estilos existentes ni fusiona colores distintos', () => {
    const runs: StyledRun[] = [{ text: 'AB', bold: true, italic: false, dx: 0 }, { text: 'CD', bold: false, italic: false, dx: 0 }];
    const out = setStyleRange(runs, 1, 3, { color: '#00ff00' });
    expect(out.map(r => [r.text, r.bold, r.color])).toEqual([
      ['A', true, undefined],
      ['B', true, '#00ff00'],
      ['C', false, '#00ff00'],
      ['D', false, undefined],
    ]);
  });
  it('color null limpia el override del rango', () => {
    const runs: StyledRun[] = [{ text: 'rojo', bold: false, italic: false, color: '#ff0000', dx: 0 }];
    const out = setStyleRange(runs, 0, 4, { color: null });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('rojo');
    expect(out[0]!.color).toBeUndefined();
  });
});

describe('toggleStyleRange', () => {
  it('pone negrita SOLO a la parte seleccionada', () => {
    const out = toggleStyleRange([R('Hello world')], 6, 11, 'bold');
    expect(out).toMatchObject([
      { text: 'Hello ', bold: false },
      { text: 'world', bold: true },
    ]);
  });
  it('quita la negrita SOLO de la parte seleccionada dentro de un tramo bold', () => {
    const out = toggleStyleRange([R('Total: ', true), R('125', false)], 0, 5, 'bold');
    expect(out).toMatchObject([
      { text: 'Total', bold: false },
      { text: ': ', bold: true },
      { text: '125', bold: false },
    ]);
  });
  it('selección mixta → todo el rango al estilo destino', () => {
    const out = toggleStyleRange([R('ab'), R('cd', true)], 1, 3, 'bold');
    expect(out).toMatchObject([
      { text: 'a', bold: false },
      { text: 'bcd', bold: true },
    ]);
  });
  it('italic no toca el bold existente', () => {
    const out = toggleStyleRange([R('abc', true)], 0, 3, 'italic');
    expect(out).toMatchObject([{ text: 'abc', bold: true, italic: true }]);
  });
  it('rango vacío o fuera → sin cambios', () => {
    const runs = [R('abc')];
    expect(toggleStyleRange(runs, 2, 2, 'bold')).toBe(runs);
  });
});
