/**
 * contentWalk — unit básico del walk (nuevo en F2; v1 no lo tenía directo):
 * stack q/Q + cm, posicionamiento Td/Tm, stale en shows encadenados, un
 * fillRect simple, clip `re W n`, y el predicado isContentFill INYECTADO
 * (default: todo es contenido; con el predicado real, el papel blanco no
 * cuenta para el backstop).
 */
import { describe, expect, it } from 'vitest';
import { isWhite } from '../common/rawFill.js';
import { walkContent } from './contentWalk.js';

const bytes = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));

describe('walkContent — máquina de estado ISO 32000 §9.4', () => {
  it('Tm × CTM da la posición absoluta; Q restaura el CTM', () => {
    const src = bytes('q 0.5 0 0 0.5 10 20 cm BT /F1 12 Tf 1 0 0 1 100 700 Tm (a) Tj ET Q BT /F2 9 Tf 1 0 0 1 30 40 Tm (b) Tj ET');
    const { shows } = walkContent(src);
    expect(shows).toHaveLength(2);
    const [a, b] = shows;
    // a: [1 0 0 1 100 700] × [0.5 0 0 0.5 10 20] → x = 60, y = 370
    expect(a!.x).toBeCloseTo(60, 6);
    expect(a!.y).toBeCloseTo(370, 6);
    expect(a!.fontName).toBe('F1');
    expect(a!.fontSize).toBe(12);
    // b: tras Q, CTM = identidad
    expect(b!.x).toBeCloseTo(30, 6);
    expect(b!.y).toBeCloseTo(40, 6);
    expect(b!.fontName).toBe('F2');
  });

  it('Td desplaza desde la line matrix; un show encadenado SIN reposicionar queda stale', () => {
    const src = bytes('BT 1 0 0 1 100 700 Tm (uno) Tj 0 -14.4 Td (dos) Tj (tres) Tj ET');
    const { shows } = walkContent(src);
    expect(shows).toHaveLength(3);
    expect(shows[0]!.stale).toBe(false);
    // Td: nueva línea a y=685.6, x=100 — y stale se limpia.
    expect(shows[1]!.x).toBeCloseTo(100, 6);
    expect(shows[1]!.y).toBeCloseTo(685.6, 6);
    expect(shows[1]!.stale).toBe(false);
    // El tercer show va encadenado (la x real depende del ancho de "dos"): stale.
    expect(shows[2]!.stale).toBe(true);
  });

  it('un `re` + f simple queda registrado como fillRect con su geometría absoluta', () => {
    const src = bytes('0 0 1 rg 50 60 200 5 re f');
    const { fillRects } = walkContent(src);
    expect(fillRects).toHaveLength(1);
    expect(fillRects[0]).toMatchObject({ x: 50, y: 60, width: 200, height: 5, fillColorRaw: '0 0 1 rg' });
  });

  it('un polígono rectangular m+3l (drawRectangle de pdf-lib) también es fillRect', () => {
    const src = bytes('10 10 m 110 10 l 110 30 l 10 30 l h f');
    const { fillRects } = walkContent(src);
    expect(fillRects).toHaveLength(1);
    expect(fillRects[0]).toMatchObject({ x: 10, y: 10, width: 100, height: 20 });
  });

  it('clip `re W n` acota los shows que siguen; Q lo restaura', () => {
    const src = bytes('q 50 60 100 100 re W n BT 1 0 0 1 70 80 Tm (x) Tj ET Q BT 1 0 0 1 70 80 Tm (y) Tj ET');
    const { shows } = walkContent(src);
    expect(shows[0]!.clip).toEqual({ x: 50, y: 60, width: 100, height: 100 });
    expect(shows[1]!.clip).toBeNull();
  });

  it('isContentFill: por default TODO es contenido; inyectado, el papel blanco no mueve el backstop', () => {
    const src = bytes('1 1 1 rg 0 0 612 792 re f 0 0 0 rg BT (x) Tj ET');
    const paperStart = 9; // offset del `0 0 612 792 re` (arranque del path)
    const btStart = src.indexOf(0x42); // 'B' de BT

    // Default (protocolo tonto): el fill blanco YA es contenido.
    expect(walkContent(src).backstop.offset).toBe(paperStart);

    // Con el predicado real del brain: el papel se salta, backstop = BT.
    const walked = walkContent(src, { isContentFill: raw => !isWhite(raw) });
    expect(walked.backstop.offset).toBe(btStart);
  });
});
