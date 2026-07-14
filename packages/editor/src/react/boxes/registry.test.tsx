// @vitest-environment jsdom
/**
 * registry.test — el contrato INodeKind: (1) `findNode` resuelve CUALQUIER id
 * a su kind (la función que mata las cascadas if-por-tipo de v1), (2)
 * move/remove mutan el ledger vía el kind, (3) un Box del registry MONTA en
 * jsdom (smoke: el adaptador ctx→props del box verbatim compila y renderiza).
 */
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { HighlightNode, ImageNode, LinkNode, PageGraph, SegmentNode, ShapeNode, WidgetNode } from '@aldus/core';
import { EditLedgerAdapter, TextEditController } from '../../core/index.js';
import { effectiveRectOf, findNode, moveNode, nodeKinds, removeNode } from './registry.js';
import { highlightKind } from './highlightKind.js';
import type { OverlayCtx } from './types.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const image: ImageNode = { kind: 'image', id: 'img1', page: 1, x: 10, y: 20, width: 100, height: 50, rotated: false } as ImageNode;
const widget: WidgetNode = { kind: 'widget', id: 'w1', page: 1, x: 30, y: 40, width: 80, height: 20, fieldName: 'f', widgetType: 'text' } as WidgetNode;
const link: LinkNode = { kind: 'link', id: 'lk1', page: 1, x: 5, y: 5, width: 40, height: 10, url: 'https://x.dev' } as LinkNode;
const highlight: HighlightNode = { kind: 'highlight', id: 'hl1', page: 1, x: 50, y: 60, width: 70, height: 12, color: '#ffd400' } as HighlightNode;
const shape: ShapeNode = { kind: 'shape', id: 'sh1', page: 1, x: 0, y: 0, width: 200, height: 30 } as ShapeNode;
const segment = { kind: 'segment', id: 'seg1', page: 1, x: 12, baseline: 700, y: 697, width: 90, height: 12, fontSize: 11, text: 'hola', runs: [] } as unknown as SegmentNode;

const graph: PageGraph = {
  page: 1, width: 612, height: 792,
  runs: [], lines: [],
  segments: [segment], images: [image], widgets: [widget],
  links: [link], highlights: [highlight], shapes: [shape],
} as unknown as PageGraph;

describe('nodeKinds registry', () => {
  it('resuelve CUALQUIER id a su kind (una función, no 5 cascadas)', () => {
    expect(findNode(graph, 'seg1')?.kind.kind).toBe('segment');
    expect(findNode(graph, 'img1')?.kind.kind).toBe('image');
    expect(findNode(graph, 'w1')?.kind.kind).toBe('widget');
    expect(findNode(graph, 'lk1')?.kind.kind).toBe('link');
    expect(findNode(graph, 'hl1')?.kind.kind).toBe('highlight');
    expect(findNode(graph, 'sh1')?.kind.kind).toBe('shape');
    expect(findNode(graph, 'nope')).toBeNull();
  });

  it('el orden del array ES el z-order de render (widgets al final)', () => {
    expect(nodeKinds[0]!.kind).toBe('shape');
    expect(nodeKinds[nodeKinds.length - 1]!.kind).toBe('widget');
  });

  it('effectiveRectOf refleja la edición pendiente del ledger', () => {
    const ledger = new EditLedgerAdapter();
    expect(effectiveRectOf(graph, ledger, 'img1')).toMatchObject({ x: 10, y: 20 });
    moveNode(graph, ledger, 'img1', 5, -5);
    expect(effectiveRectOf(graph, ledger, 'img1')).toMatchObject({ x: 15, y: 15 });
    // moveNode empujó historial: un undo revierte.
    ledger.history.undo();
    expect(effectiveRectOf(graph, ledger, 'img1')).toMatchObject({ x: 10, y: 20 });
    ledger.dispose();
  });

  it('removeNode marca el nodo como eliminado (pendiente, deshacible)', () => {
    const ledger = new EditLedgerAdapter();
    removeNode(graph, ledger, 'hl1');
    const snap = ledger.ledger.snapshot();
    expect(snap.highlights.get('hl1')?.remove).toBe(true);
    ledger.history.undo();
    expect(ledger.ledger.snapshot().highlights.size).toBe(0);
    ledger.dispose();
  });
});

describe('Box (jsdom smoke)', () => {
  it('el Box de highlight monta con un ctx mínimo', () => {
    const ledger = new EditLedgerAdapter();
    const controller = new TextEditController();
    const noop = () => undefined;
    const snap = ledger.ledger.snapshot();
    const ctx: OverlayCtx = {
      graph, allSegments: graph.segments, inGraph: new Set(['seg1']), scale: 1,
      ledger, controller,
      edits: snap.segments, imageEdits: snap.images, shapeEdits: snap.shapes,
      widgetEdits: snap.widgets, highlightEdits: snap.highlights, linkEdits: snap.links,
      selectedId: null, multiSel: new Set(), locked: new Set(), editingId: null,
      snapshot: null, imagePixels: new Map(),
      highlightColor: '#ffd400', onHighlightColor: noop,
      hlBySeg: new Map(), savedHlBySeg: new Map(),
      areaWidths: new Map(), onAreaWidth: noop,
      selectNode: noop, onStartEdit: noop, onDragging: noop,
      onDocOp: noop, onRequestLink: noop, onAddText: noop,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<highlightKind.Box ctx={ctx} node={highlight} />);
    });
    const box = host.querySelector('.hl-box') as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.style.background).toBeTruthy();
    act(() => root.unmount());
    controller.dispose();
    ledger.dispose();
    host.remove();
  });
});
