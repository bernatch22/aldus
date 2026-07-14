/**
 * liftService.test.ts — las transiciones SUTILES de la máquina del lift:
 *  - A1: un bake en vuelo se INVALIDA ante cualquier reconcile posterior
 *    (deseleccionar / abrir el editor de texto) — en v1 lo garantizaba el
 *    cleanup del effect (`cancelled = true`); acá, el bump de `generation`
 *    al ENTRAR a reconcile().
 *  - A2: al arrancar el drag se SIEMBRA el segCache (guard del "ghost vacío",
 *    v1 useLift.ts:79-82).
 */
import { describe, expect, it, vi } from 'vitest';
import type { FontBucket, PageGraph, SegmentNode } from '@aldus/core';
import { EditLedgerAdapter } from '../ledger/editLedgerAdapter.js';
import { LiftService } from './liftService.js';
import type { PreviewService } from './previewService.js';

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

/** PreviewService falso: bytes base presentes + bakePending controlable. */
function mkPreview(bake: () => Promise<Uint8Array>): PreviewService {
  return {
    baseBytesSnapshot: new Uint8Array([1, 2, 3]),
    bakePending: bake,
  } as unknown as PreviewService;
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('LiftService — invalidación por generation (A1)', () => {
  it('DESELECCIONAR mata el bake en vuelo: no instala un lift stale', async () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));

    let resolveBake!: (b: Uint8Array) => void;
    const preview = mkPreview(() => new Promise<Uint8Array>(res => { resolveBake = res; }));
    const lift = new LiftService({ preview, ledger: adapter });

    lift.select('p1-l0-s0', false); // arranca el bake (en vuelo)
    lift.select(null, false);       // deseleccionar ANTES de que termine
    resolveBake(new Uint8Array([9]));
    await flush();

    // Sin el bump al entrar a reconcile(), el bake viejo pasaba el gen-check
    // e instalaba el lift de un nodo DESELECCIONADO.
    expect(lift.current).toBeNull();
    lift.dispose();
    adapter.dispose();
  });

  it('abrir el EDITOR DE TEXTO (editingActive) también mata el bake en vuelo', async () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));

    let resolveBake!: (b: Uint8Array) => void;
    const preview = mkPreview(() => new Promise<Uint8Array>(res => { resolveBake = res; }));
    const lift = new LiftService({ preview, ledger: adapter });

    lift.select('p1-l0-s0', false); // bake en vuelo
    lift.select('p1-l0-s0', true);  // editor abierto → early-return, pero DEBE invalidar
    resolveBake(new Uint8Array([9]));
    await flush();

    expect(lift.current).toBeNull();
    lift.dispose();
    adapter.dispose();
  });

  it('el camino feliz sigue preparando el lift', async () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));

    const preview = mkPreview(() => Promise.resolve(new Uint8Array([9])));
    const lift = new LiftService({ preview, ledger: adapter });

    lift.select('p1-l0-s0', false);
    await flush();

    expect(lift.current?.segId).toBe('p1-l0-s0');
    lift.dispose();
    adapter.dispose();
  });
});

describe('LiftService — seeding del segCache al arrancar el drag (A2)', () => {
  it('onDragging(active) siembra el fantasma: sobrevive al churn del grafo durante el gesto', () => {
    const seg = mkSeg('p1-l0-s0');
    const adapter = new EditLedgerAdapter();
    adapter.setGraph(mkGraph([seg]));

    const preview = mkPreview(() => Promise.resolve(new Uint8Array([9])));
    const lift = new LiftService({ preview, ledger: adapter });

    // El nodo arrastrado NO tiene edición propia → no estaba en segCache.
    lift.onDragging('p1-l0-s0', true);

    // Un preview de OTRA edición aterriza a mitad del drag: el grafo nuevo ya
    // no trae el segmento (extirpado). Sin el seeding, findSeg → null y el
    // overlay dibujaba un ghost VACÍO.
    adapter.setGraph(mkGraph([]));
    expect(adapter.findSeg('p1-l0-s0')).toBe(seg);

    lift.dispose();
    adapter.dispose();
  });
});
