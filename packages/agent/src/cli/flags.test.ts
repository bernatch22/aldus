/**
 * flags.test.ts — el parser de flags del CLI.
 *
 * Existe porque el parser es la superficie donde un typo del usuario se
 * convierte en un mensaje útil o en una confusión. El caso testigo: antes, una
 * flag desconocida caía como argumento POSICIONAL, así que `aldus doc.pdf
 * --chat` no decía "no conozco --chat" sino "aldus <pdf> no lleva prompt".
 */
import { describe, expect, it } from 'vitest';
import { CliError, parseFillJson, parseFlags } from './flags.js';

describe('parseFlags', () => {
  it('separa posicionales de flags y parsea --pages ordenando y deduplicando', () => {
    const f = parseFlags(['doc.pdf', 'poné el título', '--pages', '3,1,3', '-o', 'out.pdf']);
    expect(f.positional).toEqual(['doc.pdf', 'poné el título']);
    expect(f.pages).toEqual([1, 3]);   // ordenado y sin repetidos
    expect(f.out).toBe('out.pdf');
    expect(f.auto).toBe(false);
  });

  it('los booleanos entran en cualquier orden', () => {
    const f = parseFlags(['doc.pdf', '--chat', '--fields', '--auto', '--flatten']);
    expect([f.chat, f.fields, f.auto, f.flatten]).toEqual([true, true, true, true]);
  });

  it('una flag DESCONOCIDA falla — no se cuela como posicional', () => {
    expect(() => parseFlags(['doc.pdf', '--chta'])).toThrow(CliError);
    expect(() => parseFlags(['doc.pdf', '--chta'])).toThrow(/flag desconocida: --chta/);
  });

  it('una flag que espera valor y no lo tiene falla en vez de comerse la siguiente', () => {
    expect(() => parseFlags(['doc.pdf', '--pages'])).toThrow(/--pages: falta el valor/);
    expect(() => parseFlags(['doc.pdf', '--pages', '--auto'])).toThrow(/--pages: falta el valor/);
  });

  it('--pages rechaza basura, cero y negativos (editar "la página NaN" no existe)', () => {
    for (const bad of ['abc', '0', '-1', '1,x', '']) {
      expect(() => parseFlags(['doc.pdf', '--pages', bad]), bad).toThrow(CliError);
    }
  });
});

describe('parseFillJson', () => {
  it('acepta texto, booleano y lista', () => {
    expect(parseFillJson('{"nombre":"Ana","acepta":true,"tags":["a","b"]}')).toEqual({
      nombre: 'Ana', acepta: true, tags: ['a', 'b'],
    });
  });

  it('un número se pasa a string — nadie escribe {"edad":"30"} a mano', () => {
    expect(parseFillJson('{"edad":30}')).toEqual({ edad: '30' });
  });

  it('JSON roto falla con el motivo y un ejemplo, no con un stack de JSON.parse', () => {
    expect(() => parseFillJson('{nombre:Ana}')).toThrow(CliError);
    expect(() => parseFillJson('{nombre:Ana}')).toThrow(/--fill: JSON inválido/);
    expect(() => parseFillJson('{nombre:Ana}')).toThrow(/--fill '\{"nombre":"Ana"/);
  });

  it('rechaza lo que no es un objeto de campos', () => {
    expect(() => parseFillJson('[1,2]')).toThrow(/esperaba un OBJETO/);
    expect(() => parseFillJson('"hola"')).toThrow(/esperaba un OBJETO/);
    expect(() => parseFillJson('null')).toThrow(/esperaba un OBJETO/);
  });

  it('rechaza un valor anidado nombrando el campo culpable', () => {
    expect(() => parseFillJson('{"a":{"b":1}}')).toThrow(/el campo "a"/);
    expect(() => parseFillJson('{"a":null}')).toThrow(/el campo "a"/);
  });

  it('llega entero desde parseFlags', () => {
    expect(parseFlags(['f.pdf', '--fill', '{"n":"Ana"}']).fill).toEqual({ n: 'Ana' });
  });
});
