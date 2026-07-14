/**
 * boxes/registry.ts — el registry `INodeKind` (audit §3.3): UNA sola fuente de
 * verdad para "¿qué tipo de nodo es este id, y cómo se lo mueve/borra/mide?".
 * Mata las 6 cascadas if-por-tipo de v1 (NodeOverlay ×4: nodeCssRect,
 * moveGroup, marquee test, group delete; useEditorHotkeys; Inspector).
 *
 * El ORDEN del array = el z-order de RENDER en `NodeOverlay`: shapes al fondo,
 * después imágenes, segmentos, links, resaltados huérfanos, y los WIDGETS AL
 * FINAL del DOM = arriba de todo para el mouse (como en el PDF: las
 * anotaciones se dibujan sobre el contenido; una imagen full-page nunca puede
 * taparles los clicks).
 *
 * Agregar un tipo de nodo nuevo (p. ej. anotaciones ink) = un `*Kind.tsx` +
 * UNA línea acá — antes eran ~7 archivos tocados. GroupBox NO es un
 * `INodeKind`: es la selección múltiple sintética del overlay.
 */
import type { PageGraph } from '@aldus/core';
import type { EditLedgerAdapter } from '../../core/index.js';
import { segmentKind } from './segmentKind.js';
import { imageKind } from './imageKind.js';
import { widgetKind } from './widgetKind.js';
import { highlightKind } from './highlightKind.js';
import { linkKind } from './linkKind.js';
import { shapeKind } from './shapeKind.js';
import type { INodeKind, PtRect } from './types.js';

export { segmentKind, SegmentBox } from './segmentKind.js';
export { imageKind, ImageBox } from './imageKind.js';
export { widgetKind, WidgetBox, WIDGET_LABEL } from './widgetKind.js';
export { highlightKind, HighlightBox } from './highlightKind.js';
export { linkKind, LinkBox } from './linkKind.js';
export { shapeKind, ShapeBox } from './shapeKind.js';
export { GroupBox } from './GroupBox.js';
export { HostBoxLayer, type HostBox } from './HostBoxLayer.js';
export { useDragGesture, type DragDelta, type DragGesture, type UseDragGestureOptions } from './useDragGesture.js';
export { useGripResize, type GripResize, type UseGripResizeOptions } from './useGripResize.js';
export * from './types.js';

/** El registry — el orden ES el z-order de render (widgets al final). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const nodeKinds: Array<INodeKind<any>> = [shapeKind, imageKind, segmentKind, linkKind, highlightKind, widgetKind];

/** Encuentra `{kind, node}` de CUALQUIER id — el reemplazo de las cascadas
 *  if-por-tipo. `graph` es el que le pasen (el overlay/los hooks pasan uno con
 *  los segmentos FANTASMA ya mergeados). */
export function findNode(graph: PageGraph, id: string): { kind: INodeKind<{ id: string }>; node: { id: string } } | null {
  for (const kind of nodeKinds) {
    const node = kind.find(graph, id);
    if (node) return { kind, node };
  }
  return null;
}

/** Rect EFECTIVO (pt PDF) de cualquier nodo por id — reemplaza `nodeCssRect`
 *  de v1 (5 ramas); el caller convierte a CSS con `pdfRectToCss`. */
export function effectiveRectOf(graph: PageGraph, ledger: EditLedgerAdapter, id: string): PtRect | null {
  const hit = findNode(graph, id);
  return hit ? hit.kind.effectiveRect(ledger, hit.node) : null;
}

/** Mueve cualquier nodo por id un delta EN PUNTOS PDF (clampeado a página) —
 *  moveGroup (marquee) y el nudge de flechas (hotkeys) pasan por acá. */
export function moveNode(graph: PageGraph, ledger: EditLedgerAdapter, id: string, dxPt: number, dyPt: number): void {
  const hit = findNode(graph, id);
  if (hit) hit.kind.move(ledger, hit.node, dxPt, dyPt, graph.width, graph.height);
}

/** Elimina cualquier nodo por id (edición pendiente; Ctrl+Z restaura) —
 *  el delete de grupo y Delete/Backspace (hotkeys) pasan por acá. */
export function removeNode(graph: PageGraph, ledger: EditLedgerAdapter, id: string): void {
  const hit = findNode(graph, id);
  if (hit) hit.kind.remove(ledger, hit.node);
}
