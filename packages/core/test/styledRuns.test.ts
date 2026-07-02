import { describe, expect, it } from 'vitest';
import { toggleStyleRange, type StyledRun } from '../src/index.js';

const R = (text: string, bold = false, italic = false, dx = 0): StyledRun => ({ text, bold, italic, dx });

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
