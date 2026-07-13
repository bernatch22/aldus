/**
 * listMarkers.test.ts — el motor de marcadores de lista (F4, Lbl/LBody ISO
 * 32000). Portado de v1 styledRuns.test.ts (las describes de list-markers):
 * toggleListMarker, markerAt/markerKindOf, detección, nextListMarker.
 */
import { describe, expect, it } from 'vitest';
import {
  hasListMarker, listMarkerLen, markerAt, markerKindOf, nextListMarker, toggleListMarker,
} from './listMarkers.js';
import type { StyledRun } from '../model/nodes.js';

const R = (text: string, bold = false): StyledRun => ({ text, bold, italic: false, dx: 0 });

describe('toggleListMarker (Lbl/LBody: el marcador es un TRAMO propio)', () => {
  it('sin marcador → agrega el Lbl como TRAMO APARTE (sin underline), el cuerpo intacto', () => {
    const body: StyledRun = { text: 'Hola', bold: true, italic: false, underline: true, dx: 0 };
    const out = toggleListMarker([body, R(' mundo')]);
    expect(out.map(r => [r.text, !!r.underline])).toEqual([['•    ', false], ['Hola', true], [' mundo', false]]);
    expect(hasListMarker(out.map(r => r.text).join(''))).toBe(true);
  });
  it('con viñeta → la quita (marcador + gap completos)', () => {
    const out = toggleListMarker([R('•  Hola')]);
    expect(out.map(r => r.text)).toEqual(['Hola']);
  });
  it('MISMO tipo → off; OTRO tipo → convierte (nunca dos marcadores)', () => {
    expect(toggleListMarker([R('A. ', true), R('GENERACIÓN', true)], 'upper').map(r => r.text).join('')).toBe('GENERACIÓN');
    const conv = toggleListMarker([R('A. ', true), R('GENERACIÓN', true)], 'bullet').map(r => r.text).join('');
    expect(conv.startsWith('•') && !conv.includes('A.')).toBe(true);
    expect(toggleListMarker([R('i) Si no se ha habilitado')], 'roman').map(r => r.text).join('')).toBe('Si no se ha habilitado');
  });
  it('markerAt: número/letra/romano incrementan por posición', () => {
    expect([1, 2, 3].map(n => markerAt('number', n)).join(',')).toBe('1.,2.,3.');
    expect([1, 2, 3].map(n => markerAt('upper', n)).join(',')).toBe('A.,B.,C.');
    expect([1, 2, 3, 4].map(n => markerAt('roman', n)).join(',')).toBe('i),ii),iii),iv)');
    expect(markerKindOf('ii) x')).toBe('roman');
    expect(markerKindOf('A. x')).toBe('upper');
  });
  it('detección: hasListMarker enciende con A./i)/•; listMarkerLen mide el Lbl', () => {
    expect(hasListMarker('A. GENERACIÓN')).toBe(true);
    expect(hasListMarker('i) Si no')).toBe(true);
    expect(hasListMarker('• item')).toBe(true);
    expect(hasListMarker('API1 SUNAT')).toBe(false);
    expect(listMarkerLen('A. GENERACIÓN')).toBe(3);
  });
  it('marcador solo (sin contenido) → no vacía el segmento', () => {
    const runs = [R('•  ')];
    expect(toggleListMarker(runs)).toBe(runs);
  });
  it('detecta romanos/multi-letra ("ii)","iii)","iv)") y no falsos ("API1","2023")', () => {
    for (const t of ['ii) Si', 'iii) foo', 'iv) bar', 'i) uno', 'A. X', 'B) y', '12) z']) expect(hasListMarker(t)).toBe(true);
    for (const t of ['API1 SUNAT', '2023 fue', 'Hola']) expect(hasListMarker(t)).toBe(false);
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
    expect(nextListMarker('2023 fue un año')).toBeNull();
  });
});
