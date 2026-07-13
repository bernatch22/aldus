/**
 * tokenizer — regresión del CUELGUE con PDFs taggeados (LibreOffice).
 *
 * `/Span<</ActualText<FEFF00FA>>>BDC`: el hex string dentro del dict hacía
 * que el `>` de cierre del hex se apareara con un `>` del dict → el dict
 * "cerraba" un byte antes → quedaba un `>` huérfano a nivel top → y
 * parseKeyword no avanzaba sobre un delimitador → loop infinito → OOM
 * (mataba el tab del browser al hornear el lift). Dos defensas: el dict
 * entiende hex strings, y parseKeyword garantiza progreso.
 * (Portado de v1 test/tokenizer.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { tokenizeContentStream } from './tokenizer.js';

const bytes = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));

describe('tokenizeContentStream', () => {
  it('dict con hex string adentro (ActualText de PDF taggeado) no cuelga ni desbalancea', () => {
    const src = bytes('/Span<</ActualText<FEFF00FA>>>\nBDC\n1 0 0 1 175.096 581.783 Tm\n(hola)Tj\nEMC\n');
    const ops = tokenizeContentStream(src);
    const names = ops.map(o => o.op);
    expect(names).toEqual(['BDC', 'Tm', 'Tj', 'EMC']);
    // El dict entero (con el hex) es UN operando del BDC.
    const bdc = ops[0]!;
    expect(bdc.operands.map(t => t.kind)).toEqual(['name', 'dict']);
    expect(bdc.operands[1]!.raw).toBe('<</ActualText<FEFF00FA>>>');
  });

  it('dict anidado + hex string siguen balanceando', () => {
    const src = bytes('/OC<</Inner<</K<AB>>>/V(x)>>BDC\nQ\n');
    const ops = tokenizeContentStream(src);
    expect(ops.map(o => o.op)).toEqual(['BDC', 'Q']);
    expect(ops[0]!.operands[1]!.raw).toBe('<</Inner<</K<AB>>>/V(x)>>');
  });

  it('delimitador huérfano a nivel top AVANZA (nunca loop infinito)', () => {
    const src = bytes(') ] } >\nBT\n(ok)Tj\nET\n');
    const ops = tokenizeContentStream(src);
    // Los huérfanos salen como keywords basura de un byte; el resto se parsea.
    const names = ops.map(o => o.op);
    expect(names).toContain('BT');
    expect(names).toContain('Tj');
    expect(names).toContain('ET');
  });
});
