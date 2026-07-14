// @vitest-environment jsdom
/**
 * index.smoke.test.ts — importa TODO el barrel de editor-core: no prueba
 * comportamiento (eso lo hacen los tests dedicados), solo que cada módulo
 * compila/transforma y exporta lo que dice exportar. Sirve de red mínima
 * para los archivos que todavía no tienen test propio (fontRegistry,
 * sampleColor, imagePixels, previewService, liftService, aldusApi).
 */
import { describe, expect, it } from 'vitest';
import * as EditorCore from './index.js';

describe('editor-core barrel', () => {
  it('exporta las clases/servicios del checkpoint 1', () => {
    expect(EditorCore.EditLedgerAdapter).toBeTypeOf('function');
    expect(EditorCore.PreviewService).toBeTypeOf('function');
    expect(EditorCore.LiftService).toBeTypeOf('function');
    expect(EditorCore.TextEditController).toBeTypeOf('function');
    expect(EditorCore.FontRegistryService).toBeTypeOf('function');
    expect(EditorCore.ColorSampler).toBeTypeOf('function');
    expect(EditorCore.ImagePixelCache).toBeTypeOf('function');
    expect(EditorCore.AldusApi).toBeTypeOf('function');
    expect(EditorCore.readNdjson).toBeTypeOf('function');
    expect(EditorCore.seedHtml).toBeTypeOf('function');
    expect(EditorCore.stableFontFamily).toBeTypeOf('function');
    expect(EditorCore.clampX).toBeTypeOf('function');
  });

  it('instancia un TextEditController sin sesión abierta (jsdom)', () => {
    const ctrl = new EditorCore.TextEditController();
    expect(ctrl.isOpen()).toBe(false);
    expect(ctrl.el).toBeInstanceOf(HTMLElement);
    ctrl.dispose();
  });

  it('instancia servicios disposable sin lanzar', () => {
    const fonts = new EditorCore.FontRegistryService();
    fonts.dispose();
    const colors = new EditorCore.ColorSampler();
    colors.dispose();
    const pixels = new EditorCore.ImagePixelCache();
    pixels.dispose();
    const api = new EditorCore.AldusApi({ apiBase: '/api' });
    expect(api.pdfUrl('doc1')).toBe('/api/documents/doc1/pdf');
  });
});
