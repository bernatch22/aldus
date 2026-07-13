/**
 * fontProviders — la cadena de fuentes sustitutas del fallback (path C).
 * Unit: orden de probing, errores tragados, registro idempotente.
 * (El camino feliz con TTF real — Caladea por Cambria — necesita red/disco:
 * se verifica con el PDF real fuera de CI; bytes ilegibles caen a estándar
 * por el try/catch de drawFallbackTexts.)
 */
import { describe, expect, it } from 'vitest';
import { registerFallbackFontProvider, resolveFallbackFont, type FallbackFontRequest, type IFallbackFontProvider } from '../src/bake/fonts/fontProviders.js';

const REQ: FallbackFontRequest = { family: 'Cambria', bold: false, italic: false, bucket: 'serif' };
const font = (name: string) => ({ bytes: new Uint8Array([1]), name });

describe('resolveFallbackFont', () => {
  it('sin providers → null (el fallback cae a la estándar de siempre)', async () => {
    expect(await resolveFallbackFont(REQ)).toBeNull();
  });

  it('probing en orden: el primero que resuelve gana; null y errores siguen la cadena; registro idempotente', async () => {
    const broken: IFallbackFontProvider = { resolve: async () => { throw new Error('roto'); } };
    const misses: IFallbackFontProvider = { resolve: async () => null };
    const hits: IFallbackFontProvider = { resolve: async () => font('Primera') };
    const shadowed: IFallbackFontProvider = { resolve: async () => font('Segunda') };
    registerFallbackFontProvider(broken);
    registerFallbackFontProvider(misses);
    registerFallbackFontProvider(hits);
    registerFallbackFontProvider(hits); // idempotente: no duplica
    registerFallbackFontProvider(shadowed);
    const r = await resolveFallbackFont(REQ);
    expect(r?.name).toBe('Primera');
  });
});
