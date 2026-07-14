/**
 * boxes/types.ts — tipos compartidos del overlay (v1:
 * `apps/editor/src/editor/overlay/types.ts`, COPY) + el contrato `INodeKind`
 * (audit-editor.md §3.3): el registry que mata las 6 cascadas
 * if-por-tipo-de-nodo de v1 (NodeOverlay ×4, useEditorHotkeys, Inspector).
 * Un tipo de nodo nuevo = un archivo `*Kind.tsx` + UNA línea en `nodeKinds`
 * (`registry.tsx`) — nunca tocar 7 switches (OCP).
 */
import type { ComponentType, ReactNode } from 'react';
import type { FontBucket, HighlightEdit, ImageEdit, LinkEdit, PageGraph, SegmentEdit, ShapeEdit, WidgetEdit } from '@aldus/core';
import type { EditLedgerAdapter, TextEditController } from '../../core/index.js';

/** Un resaltado GUARDADO (HighlightNode) PEGADO a un segmento, ya resuelto para
 *  el overlay: geometría ORIGINAL (el box la posiciona por offset y lo sigue al
 *  mover) + color EFECTIVO (con su highlightEdit de recolor aplicado). */
export interface SavedHighlight {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Color efectivo (edit?.color ?? node.color). */
  color: string;
}

export type EditAction = SegmentEdit | { segmentId: string; revert: true };
export type ImageEditAction = ImageEdit | { imageId: string; revert: true };
export type WidgetEditAction = WidgetEdit | { widgetId: string; revert: true };
export type HighlightEditAction = HighlightEdit | { highlightId: string; revert: true };
export type LinkEditAction = LinkEdit | { linkId: string; revert: true };

/**
 * Un resaltado PENDIENTE (aún no aplicado al PDF). Se dibuja como CAPA OVERLAY
 * — no se hornea en el preview — para que, anclado a su segmento, acompañe al
 * texto durante el arrastre (hereda el mismo transform del box). Al Aplicar,
 * el server lo hornea como rect multiply real en el content stream.
 */
export interface OverlayHighlight {
  page: number;
  segmentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

/** Pedido de un ítem de LISTA nuevo (Enter al final de un ítem existente). */
export interface AddTextRequest {
  page: number;
  x: number;
  /** Baseline del ítem nuevo (una línea debajo del actual). */
  baseline: number;
  text: string;
  size: number;
  bucket: FontBucket;
}

/** Rect en PUNTOS PDF (origen abajo-izquierda). */
export interface PtRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * El CONTEXTO que el NodeOverlay le pasa al `Box` de cada kind: todo lo que los
 * boxes de v1 recibían por prop-drilling desde EditorPage, ahora una sola vez.
 * Los boxes internos (SegmentBox, ImageBox, …) quedan VERBATIM; el `Box` del
 * kind es un adaptador fino ctx→props.
 */
export interface OverlayCtx {
  graph: PageGraph;
  /** Segmentos del grafo + FANTASMAS editados (dedupe por id) — la lista que
   *  el overlay realmente dibuja. */
  allSegments: import('@aldus/core').SegmentNode[];
  /** Ids presentes en el grafo del preview (los fantasmas NO están acá). */
  inGraph: Set<string>;
  scale: number;
  ledger: EditLedgerAdapter;
  controller: TextEditController;
  /** Snapshot VIGENTE de las ediciones pendientes (del ledger de core). */
  edits: ReadonlyMap<string, SegmentEdit>;
  imageEdits: ReadonlyMap<string, ImageEdit>;
  shapeEdits: ReadonlyMap<string, ShapeEdit>;
  widgetEdits: ReadonlyMap<string, WidgetEdit>;
  highlightEdits: ReadonlyMap<string, HighlightEdit>;
  linkEdits: ReadonlyMap<string, LinkEdit>;
  selectedId: string | null;
  multiSel: Set<string>;
  locked: Set<string>;
  editingId: string | null;
  snapshot: { url: string; width: number; height: number } | null;
  imagePixels: Map<string, string>;
  highlightColor: string;
  onHighlightColor: (c: string) => void;
  /** Resaltados PENDIENTES por segmento (capa hija del SegmentBox). */
  hlBySeg: Map<string, OverlayHighlight[]>;
  /** Resaltados GUARDADOS pegados por segmento (glue geométrico). */
  savedHlBySeg: Map<string, import('@aldus/core').HighlightNode[]>;
  areaWidths: Map<string, { w?: number; h?: number }>;
  onAreaWidth: (segId: string, area: { w?: number; h?: number } | null) => void;
  selectNode: (id: string | null) => void;
  onStartEdit: (seg: import('@aldus/core').SegmentNode) => void;
  onDragging: (segId: string, active: boolean, committed?: boolean) => void;
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  onAddText: (req: AddTextRequest) => void;
}

/**
 * El contrato del registry (audit §3.3). `N` = el tipo de nodo del grafo.
 * Self-gating: `find` devuelve null (nunca throw) si el id no es de este tipo.
 * El ORDEN del array `nodeKinds` = el z-order de RENDER del overlay.
 */
export interface INodeKind<N extends { id: string } = { id: string }> {
  readonly kind: string;
  /** Busca el nodo por id EN EL GRAFO que recibe (el overlay le pasa uno con
   *  los segmentos fantasma ya mergeados). */
  find(graph: PageGraph, id: string): N | null;
  /** Rect EFECTIVO (pt PDF) con la edición pendiente del ledger aplicada. */
  effectiveRect(ledger: EditLedgerAdapter, node: N): PtRect;
  /** Mueve el nodo un delta EN PUNTOS PDF (x: derecha+, y: arriba+), clampeado
   *  a la página (bbox ENTERO adentro — lo de afuera se pierde al re-extraer).
   *  Usado por moveGroup (marquee) y el nudge de flechas (hotkeys). */
  move(ledger: EditLedgerAdapter, node: N, dxPt: number, dyPt: number, pageW: number, pageH: number): void;
  /** Marca el nodo como eliminado (edición pendiente, Ctrl+Z lo restaura). */
  remove(ledger: EditLedgerAdapter, node: N): void;
  /** El componente React del tipo: adaptador ctx→props del box VERBATIM. */
  Box: ComponentType<{ ctx: OverlayCtx; node: N }>;
  /** Panel de propiedades del Inspector (opcional). */
  inspector?: (ctx: { node: N; ledger: EditLedgerAdapter; onDocOp: (a: string, p: Record<string, unknown>) => void }) => ReactNode;
}
