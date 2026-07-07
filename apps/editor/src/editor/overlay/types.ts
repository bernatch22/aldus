/**
 * Tipos compartidos del overlay: las acciones de edición (edición o revert) y el
 * pedido de un ítem de texto/lista nuevo.
 */
import type { FontBucket, ImageEdit, SegmentEdit, WidgetEdit } from '@aldus/core';

export type EditAction = SegmentEdit | { segmentId: string; revert: true };
export type ImageEditAction = ImageEdit | { imageId: string; revert: true };
export type WidgetEditAction = WidgetEdit | { widgetId: string; revert: true };

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
