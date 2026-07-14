/**
 * previewService.test.ts — el FILTRO por kind del rebake (D1): mover un
 * highlight/link GUARDADO va por /Annots (lo dibuja el overlay) y NO debe
 * re-hornear el content stream — v1 useLocalPreview no tenía highlightEdits/
 * linkEdits en las deps del effect. Texto/imagen/campo/forma + pendingHighlights
 * SÍ re-hornean.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FontBucket, HighlightNode, LinkNode, PageGraph, SegmentNode, WidgetNode } from '@aldus/core';
import { EditLedgerAdapter } from '../ledger/editLedgerAdapter.js';
import { PreviewService } from './previewService.js';
import type { AldusApi } from '../api/aldusApi.js';

vi.mock('pdfjs-dist', () => ({
  getDocument: () => ({ promise: Promise.resolve({ destroy: vi.fn() }) }),
}));

function mkSeg(id: string, text = 'Acme Corp'): SegmentNode {
  const font = {
    loadedName: 'g_f_reg', postScriptName: 'ArialMT', bold: false, italic: false,
    bucket: 'sans' as FontBucket, ascent: 0.9, descent: -0.2, embedded: true,
  };
  return {
    id, kind: 'segment', page: 1, text,
    runs: [{ id: `${id}-r0`, kind: 'text', page: 1, text, x: 72, baseline: 700, width: 60, fontSize: 12, angle: 0, font }],
    x: 72, baseline: 700, width: 60, y: 697.6, height: 13.2, fontSize: 12,
  };
}

function mkGraph(segs: SegmentNode[]): PageGraph {
  return { page: 1, width: 612, height: 792, runs: [], lines: [], segments: segs, images: [], widgets: [], links: [], highlights: [], shapes: [] };
}

function mkService(adapter: EditLedgerAdapter) {
  // El fetch de loadBase falla a propósito: acá solo se testea el DISPARO del
  // rebake (la suscripción al ledger), no el pipeline de bytes.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  const api = { pdfUrl: () => 'http://localhost/none.pdf' } as unknown as AldusApi;
  const svc = new PreviewService({ id: 'doc-x', api, ledger: adapter, onError: () => {} });
  const rebake = vi.spyOn(svc as unknown as { rebake(): Promise<void> }, 'rebake').mockResolvedValue(undefined);
  return { svc, rebake };
}

describe('PreviewService — filtro por kind del rebake (D1)', () => {
  it('un highlightEdit/linkEdit puro NO re-hornea; texto/campo SÍ', () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));
    const { svc, rebake } = mkService(adapter);

    const hl: HighlightNode = { id: 'h1', kind: 'highlight', page: 1, x: 70, y: 695, width: 60, height: 14, color: '#ffd400' };
    const link: LinkNode = { id: 'l1', kind: 'link', page: 1, url: 'https://example.com', x: 70, y: 650, width: 80, height: 12 };

    adapter.patchRect(hl, { x: 90 });   // mover un resaltado GUARDADO
    adapter.patchRect(link, { x: 90 }); // mover un link GUARDADO
    expect(rebake).not.toHaveBeenCalled();

    adapter.patchSegment(seg, { text: 'Beta Corp' }); // edición de TEXTO
    expect(rebake).toHaveBeenCalledTimes(1);

    const widget: WidgetNode = {
      id: 'w1', kind: 'widget', page: 1, fieldName: 'firma', widgetType: 'text' as WidgetNode['widgetType'],
      readOnly: false, x: 100, y: 200, width: 120, height: 20,
    };
    adapter.patchRect(widget, { x: 140 }); // edición de CAMPO
    expect(rebake).toHaveBeenCalledTimes(2);

    svc.dispose();
    adapter.dispose();
    vi.unstubAllGlobals();
  });

  it('pendingHighlights nuevos SÍ disparan (estaban en las deps de v1)', () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));
    const { svc, rebake } = mkService(adapter);

    adapter.addHighlights([{ page: 1, segmentId: 'p1-l0-s0', x: 72, y: 690, width: 60, height: 14 }]);
    expect(rebake).toHaveBeenCalledTimes(1);

    svc.dispose();
    adapter.dispose();
    vi.unstubAllGlobals();
  });
});
