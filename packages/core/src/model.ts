/**
 * model.ts — el grafo de contenido de un PDF como modelo tipado.
 *
 * Convención de coordenadas (ÚNICA en todo Aldus): puntos PDF, origen
 * abajo-izquierda, y crece hacia ARRIBA. La conversión a pantalla vive en
 * coords.ts y en ningún otro lado.
 *
 * Jerarquía: TextRunNode (átomo del content stream) → SegmentNode (runs
 * contiguos; LA UNIDAD DE EDICIÓN, anclada a su x como un text box de Acrobat)
 * → LineNode (los segmentos que comparten baseline). Un gap de columna/tab NO
 * se almacena: es la frontera entre dos segmentos, derivable de sus x.
 */

export type FontBucket = 'sans' | 'serif' | 'mono';

export interface FontInfo {
  /** Nombre interno de pdf.js (p. ej. "g_d0_f1"). Tras renderizar la página a
   *  canvas, pdf.js registra la fuente EMBEBIDA bajo este nombre en
   *  `document.fonts` — usarlo como font-family en un overlay hace que el
   *  browser dibuje con los MISMOS glifos que el PDF. */
  loadedName: string;
  /** Nombre PostScript real (p. ej. "Arial-BoldMT"). */
  postScriptName: string;
  bold: boolean;
  italic: boolean;
  bucket: FontBucket;
  /** Métricas verticales en unidades em, leídas del font embebido. */
  ascent: number;
  /** Negativo (por debajo de la baseline). */
  descent: number;
  /** true si el font viene embebido en el PDF (hay FontFace real). */
  embedded: boolean;
}

/** Un run de texto tal cual sale del content stream: el nodo atómico. */
export interface TextRunNode {
  id: string;
  kind: 'text';
  /** 1-based. */
  page: number;
  text: string;
  /** Izquierda del run (origen del texto). */
  x: number;
  /** y de la BASELINE — exacta, tomada de la text matrix. */
  baseline: number;
  width: number;
  /** Tamaño efectivo: |columna y| de la text matrix (soporta escalado). */
  fontSize: number;
  /** Rotación en radianes; 0 = horizontal. */
  angle: number;
  font: FontInfo;
  /** Color del texto en hex (#rrggbb). Muestreado del canvas renderizado
   *  (browser); ausente = negro. Solo para DISPLAY — el bake toma el color
   *  exacto del content stream. */
  color?: string;
}

/** Runs contiguos de una línea: LA UNIDAD DE EDICIÓN. Su `x` es un ANCLA
 *  (tab stop): editar el segmento de al lado nunca la mueve — el modelo de
 *  text boxes independientes de Acrobat/Foxit. */
export interface SegmentNode {
  id: string;
  kind: 'segment';
  page: number;
  /** Texto reconstruido (espacios de palabra inferidos entre runs). */
  text: string;
  runs: TextRunNode[];
  /** x de anclaje del segmento. */
  x: number;
  baseline: number;
  width: number;
  /** Bounding box derivado de las métricas reales: y = baseline + descent·size. */
  y: number;
  height: number;
  /** Tamaño dominante (el mayor de sus runs). */
  fontSize: number;
}

/** Una línea visual: los segmentos que comparten baseline. */
export interface LineNode {
  id: string;
  kind: 'line';
  page: number;
  text: string;
  segments: SegmentNode[];
  x: number;
  baseline: number;
  width: number;
  y: number;
  height: number;
  fontSize: number;
}

/** Una imagen de la página (XObject dibujado por un `Do`): su rect es el
 *  bounding box de la matriz con la que se pintó (unit square × CTM). */
export interface ImageNode {
  id: string;
  kind: 'image';
  page: number;
  /** Rect en puntos PDF, origen abajo-izquierda. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** La matriz tiene rotación/skew — el bake v1 la deja intacta (warning). */
  rotated: boolean;
}

/** Una edición pendiente sobre una imagen: mover/escalar/eliminar/reordenar. */
export interface ImageEdit {
  imageId: string;
  page: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  remove?: boolean;
  /** Reordenar en el stream: 'back' = primer op dibujado (fondo),
   *  'front' = último (al frente). */
  zOrder?: 'front' | 'back';
  /** Snapshot para que el bake localice el Do sin ambigüedad. */
  original: { x: number; y: number; width: number; height: number };
}

export type WidgetKind = 'text' | 'checkbox' | 'radio' | 'select' | 'list' | 'button' | 'signature';

export const FIELD_DEFAULT_SIZE: Record<WidgetKind, { width: number; height: number }> = {
  text: { width: 160, height: 20 },
  checkbox: { width: 14, height: 14 },
  radio: { width: 14, height: 14 },
  select: { width: 140, height: 20 },
  list: { width: 140, height: 60 },
  button: { width: 90, height: 24 },
  signature: { width: 200, height: 50 },
};

/** Un campo de formulario (widget annotation de AcroForm). Vive en la capa
 *  /Annots — no en el content stream — así que editarlo es actualizar /Rect. */
export interface WidgetNode {
  id: string;
  kind: 'widget';
  page: number;
  fieldName: string;
  widgetType: WidgetKind;
  readOnly: boolean;
  /** Opciones actuales (solo select/lista). */
  options?: string[];
  /** Rect en puntos PDF, origen abajo-izquierda. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Una edición pendiente sobre un widget: mover/escalar/eliminar el campo. */
export interface WidgetEdit {
  widgetId: string;
  page: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  remove?: boolean;
  original: { fieldName: string; x: number; y: number; width: number; height: number };
}

/** Un link (annotation /Link con acción URI). */
export interface LinkNode {
  id: string;
  kind: 'link';
  page: number;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PdfNode = TextRunNode | SegmentNode | LineNode | ImageNode | WidgetNode | LinkNode;

/** El grafo completo de una página. */
export interface PageGraph {
  page: number;
  /** Tamaño de página en puntos PDF. */
  width: number;
  height: number;
  runs: TextRunNode[];
  lines: LineNode[];
  /** Todos los segmentos de la página (las unidades de edición), aplanados. */
  segments: SegmentNode[];
  images: ImageNode[];
  widgets: WidgetNode[];
  links: LinkNode[];
}

/** Un tramo de texto con su estilo, DENTRO de una edición. El estilo vive a
 *  nivel de run — nunca del segmento entero — así "quitar la negrita a una
 *  parte" no pisa el estilo del resto. */
export interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Offset horizontal (pt) desde el origen del segmento, medido en el editor. */
  dx: number;
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
  };
}
