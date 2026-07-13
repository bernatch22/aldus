/**
 * toUnicode — regresión de la CAJITA CON X (glifos sin entrada ToUnicode).
 *
 * Un código sin entrada en el CMap llega del grafo como control char crudo
 * (U+0012 = el acento suelto de LibreOffice). El encoder inverso lo re-encodea
 * IDENTIDAD (mismo byte → mismo glifo, misma fuente) en fuentes de 1 byte;
 * en fuentes CID (códigos de 2 bytes) sigue rechazando (null → sustituta).
 * (Portado de v1 test/toUnicode.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { parseToUnicode } from './toUnicode.js';

const CMAP_1BYTE = `
begincmap
beginbfchar
<11> <00FA>
<13> <0072>
endbfchar
endcmap`;

const CMAP_2BYTE = `
begincmap
beginbfchar
<0011> <00FA>
endbfchar
endcmap`;

describe('parseToUnicode — fallback identidad para códigos sin mapear', () => {
  it('control char (artefacto de extracción) → byte identidad en fuente de 1 byte', () => {
    const enc = parseToUnicode(CMAP_1BYTE);
    // "ú" + U+0012 (código crudo sin entrada) + "r"
    const bytes = enc.encode('úr');
    expect(bytes).not.toBeNull();
    expect([...bytes!]).toEqual([0x11, 0x12, 0x13]);
  });

  it('un char normal fuera del subset sigue rechazando (null → sustituta)', () => {
    const enc = parseToUnicode(CMAP_1BYTE);
    expect(enc.encode('x')).toBeNull();
  });

  it('\\n, \\t, \\r nunca van por identidad', () => {
    const enc = parseToUnicode(CMAP_1BYTE);
    expect(enc.encode('ú\n')).toBeNull();
  });

  it('fuente CID (códigos de 2 bytes): sin identidad — null', () => {
    const enc = parseToUnicode(CMAP_2BYTE);
    expect(enc.encode('')).toBeNull();
  });
});
