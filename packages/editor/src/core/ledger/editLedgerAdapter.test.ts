/**
 * editLedgerAdapter.test.ts — el adaptador SIN React: apply → snapshot →
 * undo/redo, `findSeg` cayendo al cache de fantasmas, y `applyAgentEdits`
 * reemplazando el estado en una sola entrada de historial.
 */
import { describe, expect, it } from 'vitest';
import type { FontBucket, PageGraph, SegmentNode } from '@aldus/core';
import { EditLedgerAdapter } from './editLedgerAdapter.js';

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

describe('EditLedgerAdapter — apply → snapshot → undo/redo', () => {
  it('patchSegment acumula, fire onDidChange, y undo restaura el estado previo', () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));

    let fires = 0;
    adapter.onDidChange(() => { fires++; });

    adapter.patchSegment(seg, { text: 'Beta Corp' });
    expect(adapter.ledger.toBakeInput()).toHaveLength(1);
    expect(fires).toBeGreaterThan(0);
    expect(adapter.history.canUndo).toBe(true);

    adapter.history.undo();
    expect(adapter.ledger.toBakeInput()).toHaveLength(0);
    expect(adapter.history.canRedo).toBe(true);

    adapter.history.redo();
    expect(adapter.ledger.toBakeInput()).toHaveLength(1);
  });

  it('revertir a texto idéntico al original hace merge → null (sin zombie)', () => {
    const seg = mkSeg('p1-l0-s0', 'Acme Corp');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));

    adapter.patchSegment(seg, { text: 'Beta Corp' });
    expect(adapter.ledger.toBakeInput()).toHaveLength(1);

    adapter.patchSegment(seg, { text: 'Acme Corp' }); // vuelve al original → noop
    expect(adapter.ledger.toBakeInput()).toHaveLength(0);
  });

  it('findSeg cae al segCache cuando el segmento fue extirpado del preview', () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));
    adapter.patchSegment(seg, { text: 'Beta Corp' });

    // El preview re-extrae SIN el segmento editado (extirpado del grafo).
    adapter.setGraph(mkGraph([]));
    expect(adapter.findSeg('p1-l0-s0')).toBe(seg);
  });

  it('applyAgentEdits reemplaza el set completo en UNA entrada de historial', () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));

    adapter.patchSegment(seg, { text: 'manual edit' });
    const historyDepthBefore = adapter.history.canUndo;
    expect(historyDepthBefore).toBe(true);

    adapter.applyAgentEdits(
      [{ segmentId: 'p1-l0-s0', page: 1, text: 'agent edit', original: { text: 'Acme Corp', x: 72, baseline: 700, width: 60, fontSize: 12 } }],
      [],
    );
    expect(adapter.ledger.toBakeInput()).toHaveLength(1);
    expect((adapter.ledger.toBakeInput()[0] as { text: string }).text).toBe('agent edit');

    // Un solo undo vuelve al estado ANTERIOR al agente (la edición manual).
    adapter.history.undo();
    expect((adapter.ledger.toBakeInput()[0] as { text: string }).text).toBe('manual edit');
  });

  it('pendingHighlights: addHighlights/removePendingHighlightsFor con historial; clearAll limpia todo', () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));

    adapter.addHighlights([{ page: 1, segmentId: 'p1-l0-s0', x: 72, y: 690, width: 60, height: 14 }]);
    expect(adapter.pendingHighlights).toHaveLength(1);

    adapter.removePendingHighlightsFor('p1-l0-s0');
    expect(adapter.pendingHighlights).toHaveLength(0);

    adapter.history.undo(); // deshace el remove
    expect(adapter.pendingHighlights).toHaveLength(1);

    adapter.clearAll();
    expect(adapter.pendingHighlights).toHaveLength(0);
    expect(adapter.history.canUndo).toBe(false);
  });
});
