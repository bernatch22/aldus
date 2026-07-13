/**
 * model/edits.ts — los 7 tipos de edición pendiente (Layer 0.5, SOLO tipos).
 *
 * Semántica compartida (v1 verbatim): los campos opcionales son OVERRIDES —
 * presentes solo si el usuario los cambió (ausente = se conserva lo original
 * del PDF). `original` es el snapshot que el bake usa para LOCALIZAR el nodo
 * por geometría, nunca por índice.
 *
 * Mejoras v2 sobre v1 model.ts (compatibles estructuralmente — mismos campos):
 *  1. Los 5 edits rect-like derivan del genérico {@link RectEdit} — el par
 *     merge/effective del EditLedger (F4) tipa solo.
 *  2. {@link AnyEdit}: unión discriminada por `kind` explícito — el contrato
 *     IEditApplier del bake (F3) despacha por ese campo.
 */

import type { FontBucket, StyledRun } from './nodes.js';

/**
 * Base genérica de toda edición rect-like: mover/escalar/eliminar un nodo que
 * vive como rectángulo (imagen, forma, widget, resaltado, link). `TOriginal`
 * es el snapshot de localización de cada tipo.
 */
export interface RectEdit<TOriginal> {
  page: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  remove?: boolean;
  /** Snapshot para que el bake localice el nodo sin ambigüedad. */
  original: TOriginal;
}

/** Una edición pendiente sobre una imagen: mover/escalar/eliminar/reordenar. */
export interface ImageEdit extends RectEdit<{ x: number; y: number; width: number; height: number }> {
  imageId: string;
  /** Reordenar en el stream: 'back' = primer op dibujado (fondo),
   *  'front' = último (al frente). */
  zOrder?: 'front' | 'back';
}

/** Edición de una forma vectorial (mover/redimensionar/borrar). El bake localiza
 *  el rect relleno por su geometría ORIGINAL (como imágenes/widgets) y lo re-emite
 *  IN-PLACE (z-order y color intactos) o lo extirpa. */
export interface ShapeEdit extends RectEdit<{ x: number; y: number; width: number; height: number }> {
  shapeId: string;
}

/** Una edición pendiente sobre un widget: mover/escalar/eliminar el campo. */
export interface WidgetEdit extends RectEdit<{ fieldName: string; x: number; y: number; width: number; height: number }> {
  widgetId: string;
}

/** Una edición pendiente sobre un link: mover/escalar/eliminar la anotación. */
export interface LinkEdit extends RectEdit<{ url: string; x: number; y: number; width: number; height: number }> {
  linkId: string;
}

/** Una edición pendiente sobre un resaltado: mover/escalar/recolorear/eliminar. */
export interface HighlightEdit extends RectEdit<{ x: number; y: number; width: number; height: number; color: string }> {
  highlightId: string;
  /** Color hex nuevo "#rrggbb": reescribe /C y regenera el appearance stream. */
  color?: string;
}

/** Una edición pendiente sobre un segmento (lo que el server persiste y, en la
 *  fase de bake, aplica sobre el content stream). El segmento vecino no se toca:
 *  su x de anclaje ES la preservación del gap.
 *
 *  Los campos opcionales son OVERRIDES: presentes solo si el usuario los cambió
 *  (ausente = se conserva lo original del PDF). Mover = x/baseline nuevos.
 *  Estilo (bold/italic) = SIEMPRE por run, en `runs`. */
export interface SegmentEdit {
  segmentId: string;
  page: number;
  /** Texto plano del segmento (derivado de `runs` cuando está presente). */
  text: string;
  /** Contenido estilado por tramos. Presente solo si texto o estilo cambiaron. */
  runs?: StyledRun[];
  /** Tamaño en puntos PDF. */
  fontSize?: number;
  /** Cambiar de familia abandona la fuente embebida → bucket estándar. */
  font?: FontBucket;
  /** Nueva x de anclaje (mover). */
  x?: number;
  /** Nueva baseline (mover). */
  baseline?: number;
  /** ELIMINAR el segmento (los ops se extirpan del stream). */
  remove?: boolean;
  /** Tracking (Tc) en puntos — el "AV" de Acrobat. */
  charSpacing?: number;
  /** Escala horizontal (Tz) en % — el "T↔" de Acrobat. 100 = normal. */
  hScale?: number;
  /** Color de relleno del texto, hex "#rrggbb". */
  color?: string;
  /** Alineación del texto DENTRO del área (no mueve el nodo): el editor la usa
   *  para el text-align y para calcular el dx de cada línea; el bake solo lee
   *  el dx resultante. */
  align?: 'left' | 'center' | 'right';
  /** Snapshot del nodo original para que el bake pueda localizarlo sin
   *  ambigüedad (y, si hay sustitución de fuente, imitar su estilo).
   *  `runs` trae el estilo ORIGINAL por tramo con su x — el bake lo usa para
   *  saber qué recurso de fuente del PDF corresponde a cada estilo. */
  original: {
    text: string;
    x: number;
    baseline: number;
    width: number;
    fontSize: number;
    bucket?: FontBucket;
    bold?: boolean;
    italic?: boolean;
    runs?: Array<{ x: number; bold: boolean; italic: boolean }>;
    /** Bloque MULTILÍNEA: las baselines de TODAS sus líneas (la primera es
     *  `baseline`). El bake matchea/extirpa los ops de todas. */
    baselines?: number[];
  };
}

/**
 * TODA edición posible, discriminada por `kind` explícito. Los tipos base NO
 * llevan `kind` (compat estructural con v1) — la unión lo agrega por
 * intersección. F3 la consume: `bake(bytes, edits: AnyEdit[])` despacha cada
 * edit al IEditApplier cuyo `canHandle(edit)` responde por su `kind`.
 */
export type AnyEdit =
  | ({ kind: 'segment' } & SegmentEdit)
  | ({ kind: 'image' } & ImageEdit)
  | ({ kind: 'widget' } & WidgetEdit)
  | ({ kind: 'highlight' } & HighlightEdit)
  | ({ kind: 'link' } & LinkEdit)
  | ({ kind: 'shape' } & ShapeEdit);

/** El `kind` de {@link AnyEdit}. */
export type EditKind = AnyEdit['kind'];
