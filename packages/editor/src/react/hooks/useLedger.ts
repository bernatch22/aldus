/**
 * useLedger — React SUSCRIBE al adaptador del ledger (useSyncExternalStore).
 * Reemplaza los 7 `useState` + 7 refs espejo de v1 `usePendingEdits`: el
 * servicio es su propia fuente fresca; acá solo se deriva un snapshot
 * inmutable por cambio (audit §3.1).
 */
import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { HighlightEdit, ImageEdit, LedgerSnapshot, LinkEdit, SegmentEdit, ShapeEdit, WidgetEdit } from '@aldus/core';
import type { EditLedgerAdapter, PendingHighlight } from '../../core/index.js';

export interface LedgerView {
  /** Contador de versión (cambia con CADA mutación del adaptador). */
  tick: number;
  edits: ReadonlyMap<string, SegmentEdit>;
  imageEdits: ReadonlyMap<string, ImageEdit>;
  shapeEdits: ReadonlyMap<string, ShapeEdit>;
  widgetEdits: ReadonlyMap<string, WidgetEdit>;
  highlightEdits: ReadonlyMap<string, HighlightEdit>;
  linkEdits: ReadonlyMap<string, LinkEdit>;
  pendingHighlights: readonly PendingHighlight[];
  canUndo: boolean;
  canRedo: boolean;
  totalEdits: number;
}

export function useLedger(adapter: EditLedgerAdapter): LedgerView {
  const version = useRef(0);
  const tick = useSyncExternalStore(
    onStoreChange => {
      const sub = adapter.onDidChange(() => { version.current++; onStoreChange(); });
      return () => sub.dispose();
    },
    () => version.current,
    () => version.current,
  );
  return useMemo(() => {
    const s: LedgerSnapshot = adapter.ledger.snapshot();
    const pendingHighlights = adapter.pendingHighlights;
    return {
      tick,
      edits: s.segments,
      imageEdits: s.images,
      shapeEdits: s.shapes,
      widgetEdits: s.widgets,
      highlightEdits: s.highlights,
      linkEdits: s.links,
      pendingHighlights,
      canUndo: adapter.history.canUndo,
      canRedo: adapter.history.canRedo,
      totalEdits: s.segments.size + s.images.size + s.shapes.size + s.widgets.size
        + s.highlights.size + s.links.size + pendingHighlights.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, tick]);
}
