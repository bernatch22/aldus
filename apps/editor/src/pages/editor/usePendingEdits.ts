import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import type { ImageEdit, PageGraph, SegmentEdit, SegmentNode, WidgetEdit } from '@aldus/core';
import { useHistory, type History } from './useHistory';

export interface PendingHighlight {
  page: number;
  segmentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

/** Snapshot de las cuatro colecciones (el memento del historial). */
interface Snap {
  e: Map<string, SegmentEdit>;
  i: Map<string, ImageEdit>;
  w: Map<string, WidgetEdit>;
  h: PendingHighlight[];
}

/**
 * Las 4 colecciones PENDIENTES del editor (texto / imagen / campo / highlight)
 * + el historial unificado + el cache de nodos originales para fantasmas.
 *
 * - Las ediciones son overrides acumulados vía merge (patrón COMMAND: cada
 *   parche se funde sobre el anterior; null = revert). NADA se guarda solo —
 *   el botón Aplicar manda todo a POST /bake.
 * - Ctrl+Z/Ctrl+Shift+Z restauran snapshots de los cuatro maps (MEMENTO,
 *   ver useHistory).
 * - `segCache` guarda el NODO original de cada segmento editado: el preview
 *   extirpa sus ops (desaparece del grafo extraído), así que el overlay lo
 *   dibuja como "fantasma" desde acá.
 */
export function usePendingEdits(
  graphRef: MutableRefObject<PageGraph | null>,
  onAfterRestore?: () => void,
) {
  const [edits, setEdits] = useState<Map<string, SegmentEdit>>(new Map());
  const [imageEdits, setImageEdits] = useState<Map<string, ImageEdit>>(new Map());
  const [widgetEdits, setWidgetEdits] = useState<Map<string, WidgetEdit>>(new Map());
  const [pendingHighlights, setPendingHighlights] = useState<PendingHighlight[]>([]);

  const editsRef = useRef(edits);
  const imageEditsRef = useRef(imageEdits);
  const widgetEditsRef = useRef(widgetEdits);
  const highlightsRef = useRef(pendingHighlights);
  editsRef.current = edits;
  imageEditsRef.current = imageEdits;
  widgetEditsRef.current = widgetEdits;
  highlightsRef.current = pendingHighlights;

  const afterRestoreRef = useRef(onAfterRestore);
  afterRestoreRef.current = onAfterRestore;

  const segCache = useRef(new Map<string, SegmentNode>());

  const snapNow = useCallback((): Snap => ({
    e: editsRef.current,
    i: imageEditsRef.current,
    w: widgetEditsRef.current,
    h: highlightsRef.current,
  }), []);
  const restoreSnap = useCallback((s: Snap) => {
    setEdits(s.e);
    setImageEdits(s.i);
    setWidgetEdits(s.w);
    setPendingHighlights(s.h);
    afterRestoreRef.current?.();
  }, []);
  const history: History = useHistory(snapNow, restoreSnap);
  const { pushHistory, clear: clearHistory } = history;

  const cacheSegment = useCallback((segmentId: string) => {
    if (!segCache.current.has(segmentId)) {
      const s = graphRef.current?.segments.find(x => x.id === segmentId);
      if (s) segCache.current.set(segmentId, s);
    }
  }, [graphRef]);

  const onEdit = useCallback((edit: SegmentEdit | { segmentId: string; revert: true }) => {
    pushHistory();
    if (!('revert' in edit)) cacheSegment(edit.segmentId);
    setEdits(prev => {
      const next = new Map(prev);
      if ('revert' in edit) next.delete(edit.segmentId); else next.set(edit.segmentId, edit);
      return next;
    });
  }, [pushHistory, cacheSegment]);

  // Las ediciones de IMAGEN y CAMPO también ACUMULAN (nada se guarda solo):
  // el documento se escribe únicamente con el botón Aplicar. El preview en el
  // lienzo usa píxeles reales del snapshot, así que se ven movidas de verdad.
  const onImageEdit = useCallback((edit: ImageEdit | { imageId: string; revert: true }) => {
    pushHistory();
    setImageEdits(prev => {
      const next = new Map(prev);
      if ('revert' in edit) next.delete(edit.imageId); else next.set(edit.imageId, edit);
      return next;
    });
  }, [pushHistory]);

  const onWidgetEdit = useCallback((edit: WidgetEdit | { widgetId: string; revert: true }) => {
    pushHistory();
    setWidgetEdits(prev => {
      const next = new Map(prev);
      if ('revert' in edit) next.delete(edit.widgetId); else next.set(edit.widgetId, edit);
      return next;
    });
  }, [pushHistory]);

  // El AGENTE devuelve el SET COMPLETO de ediciones (texto + imagen):
  // reemplazan el estado (una sola vez, deshacible con Ctrl+Z). Cacheamos el
  // nodo original de cada segmento editado para el fantasma, igual que una
  // edición manual.
  const applyAgentEdits = useCallback((segEdits: SegmentEdit[], imgEdits: ImageEdit[]) => {
    pushHistory();
    for (const e of segEdits) cacheSegment(e.segmentId);
    setEdits(new Map(segEdits.map(e => [e.segmentId, e])));
    setImageEdits(new Map(imgEdits.map(e => [e.imageId, e])));
  }, [pushHistory, cacheSegment]);

  /** HIGHLIGHT acumula (preview local; se escribe con Aplicar). Varios de una
   *  (grupo) = UN solo snapshot de historial → un Ctrl+Z los deshace juntos. */
  const addHighlights = useCallback((hs: PendingHighlight[]) => {
    if (!hs.length) return;
    pushHistory();
    setPendingHighlights(prev => [...prev, ...hs]);
  }, [pushHistory]);

  // Buscar un segmento por id: primero el grafo del preview; si fue editado
  // (extirpado del preview), el cache de fantasmas.
  const findSeg = useCallback(
    (sid: string): SegmentNode | null =>
      graphRef.current?.segments.find(s => s.id === sid) ?? segCache.current.get(sid) ?? null,
    [graphRef],
  );

  /** Tras un Aplicar exitoso: todo lo pendiente quedó horneado en el server. */
  const clearAll = useCallback(() => {
    setEdits(new Map());
    setImageEdits(new Map());
    setWidgetEdits(new Map());
    setPendingHighlights([]);
    segCache.current.clear();
    clearHistory();
  }, [clearHistory]);

  return {
    edits, imageEdits, widgetEdits, pendingHighlights,
    editsRef, imageEditsRef, widgetEditsRef, highlightsRef,
    segCache,
    onEdit, onImageEdit, onWidgetEdit, applyAgentEdits, addHighlights,
    findSeg, clearAll, history,
  };
}
