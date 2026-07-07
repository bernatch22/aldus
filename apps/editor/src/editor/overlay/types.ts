/**
 * Tipos compartidos del overlay: las acciones de edición (edición o revert) y el
 * pedido de un ítem de texto/lista nuevo.
 */
import type { FontBucket, HighlightEdit, ImageEdit, LinkEdit, SegmentEdit, WidgetEdit } from '@aldus/core';

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
