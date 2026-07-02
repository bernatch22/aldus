import { describe, expect, it } from 'vitest';
import { applyTextDiff, hasListMarker, nextListMarker, setStyleRange, toggleListMarker, toggleStyleRange, type StyledRun } from '../src/index.js';

describe('applyTextDiff (textarea plano → estilos re-mapeados)', () => {
  const R = (text: string, bold = false): StyledRun => ({ text, bold, italic: false, dx: 0 });
  it('tipear en el medio hereda el estilo del tramo donde empieza el cambio', () => {
    const out = applyTextDiff([R('Total: ', true), R('125.00')], 'Total: extra 125.00');
    expect(out.map(r => [r.text, r.bold])).toEqual([['Total: ', true], ['extra 125.00', false]]);
  });
  it('borrar el frente conserva los estilos del resto', () => {
    const out = applyTextDiff([R('AB', true), R('CD')], 'BCD');
    expect(out.map(r => [r.text, r.bold])).toEqual([['B', true], ['CD', false]]);
  });
  it('reemplazo total = un solo tramo con el estilo del punto de cambio', () => {
    const out = applyTextDiff([R('Hola', true)], 'Chau');
    expect(out.map(r => [r.text, r.bold])).toEqual([['Chau', true]]);
  });
  it('texto idéntico → misma referencia (noop)', () => {
    const runs = [R('abc')];
    expect(applyTextDiff(runs, 'abc')).toBe(runs);
  });
  it('agregar al final extiende el último tramo', () => {
    const out = applyTextDiff([R('• ', false), R('item', true)], '• items');
    expect(out.map(r => [r.text, r.bold])).toEqual([['• ', false], ['items', true]]);
  });
});

describe('toggleListMarker (lista como formato)', () => {
  const R = (text: string, bold = false): StyledRun => ({ text, bold, italic: false, dx: 0 });
  it('sin marcador → prepende viñeta con gap (2 espacios) al primer tramo', () => {
    const out = toggleListMarker([R('Hola', true), R(' mundo')]);
    expect(out.map(r => [r.text, r.bold])).toEqual([['•  Hola', true], [' mundo', false]]);
    expect(hasListMarker(out.map(r => r.text).join(''))).toBe(true);
  });
  it('con viñeta → la quita (marcador + gap completos)', () => {
    const out = toggleListMarker([R('•  Hola')]);
    expect(out.map(r => r.text)).toEqual(['Hola']);
  });
  it('con marcador numerado → también lo quita, incluso partido en tramos', () => {
    const out = toggleListMarker([R('3. '), R('Item', true)]);
    expect(out.map(r => [r.text, r.bold])).toEqual([['Item', true]]);
  });
  it('marcador solo (sin contenido) → no vacía el segmento', () => {
    const runs = [R('•  ')];
    expect(toggleListMarker(runs)).toBe(runs);
  });
});

describe('setStyleRange (color a la selección)', () => {
  const R = (text: string, bold = false): StyledRun => ({ text, bold, italic: false, dx: 0 });
  it('colorea SOLO la parte seleccionada', () => {
    const out = setStyleRange([R('Hola mundo')], 5, 10, { color: '#ff0000' });
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
    expect(out[0].text).toBe('rojo');
    expect(out[0].color).toBeUndefined();
  });
});

describe('nextListMarker (Enter continúa la lista)', () => {
  it('incrementa números, letras y repite bullets', () => {
    expect(nextListMarker('•  Elemento')).toBe('•  ');
    expect(nextListMarker('- item')).toBe('- ');
    expect(nextListMarker('3. Tercero')).toBe('4. ');
    expect(nextListMarker('1) Primero')).toBe('2) ');
    expect(nextListMarker('b) segundo')).toBe('c) ');
    expect(nextListMarker('B. Segundo')).toBe('C. ');
    expect(nextListMarker('  2)  indentado')).toBe('  3)  ');
  });
  it('texto normal no es lista', () => {
    expect(nextListMarker('Hola mundo')).toBeNull();
    expect(nextListMarker('2023 fue un año')).toBeNull(); // número sin separador de lista
  });
});

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
