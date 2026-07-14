/**
 * model/nodes.ts — el grafo de contenido de un PDF como modelo tipado
 * (Layer 0.5, protocol layer: SOLO tipos, cero lógica).
 *
 * Convención de coordenadas (ÚNICA en todo Aldus): puntos PDF, origen
 * abajo-izquierda, y crece hacia ARRIBA. La conversión a pantalla vive en
 * common/coords.ts y en ningún otro lado.
 *
 * Jerarquía: TextRunNode (átomo del content stream) → SegmentNode (runs
 * contiguos; LA UNIDAD DE EDICIÓN, anclada a su x como un text box de Acrobat)
 * → LineNode (los segmentos que comparten baseline). Un gap de columna/tab NO
 * se almacena: es la frontera entre dos segmentos, derivable de sus x.
 *
 * Trasplante verbatim en semántica de v1 model.ts. Los tipos *Edit viven en
 * model/edits.ts (vocabulario del ledger, no del grafo).
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
  /** true si el font viene embebido en el PDF (hay FontFace real).
   *  ⚠️ Derivado de `!missingFile` de pdf.js — NUNCA de `font.data` (pdf.js lo
   *  libera tras renderizar salvo `fontExtraProperties`, dando falsos "no
   *  embebido"). */
  embedded: boolean;
}

/** Un run de texto tal cual sale del content stream: el nodo atómico.
 *  ⚠️ `text` viaja INTACTO — un glifo sin entrada /ToUnicode llega como
 *  control char crudo (U+0012, el acento suelto de LibreOffice) y el bake lo
 *  re-encodea identidad. Cualquier normalización/trim acá lo destruye. */
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
  /** El run está SUBRAYADO en el PDF: un rect vectorial fino vive justo bajo
   *  su baseline (detectado en extracción). Alimenta el toggle U del editor. */
  underline?: boolean;
}

/** Runs contiguos de una línea: LA UNIDAD DE EDICIÓN. Su `x` es un ANCLA
 *  (tab stop): editar el segmento de al lado nunca la mueve — el modelo de
 *  text boxes independientes de Acrobat/Foxit. */
export interface SegmentNode {
  id: string;
  kind: 'segment';
  page: number;
  /** Texto reconstruido (espacios de palabra inferidos entre runs; las líneas
   *  de un bloque multilínea se unen con '\n'). */
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
  /** objId del XObject en `page.objs` (solo paintImageXObject/Repeat). El editor
   *  lo usa para sacar los PÍXELES reales de la imagen (con transparencia) y
   *  pintar un ghost limpio al arrastrar — sin el fondo que trae un crop del
   *  snapshot de la página. Ausente en máscaras / inline images. */
  objId?: string;
}

export type WidgetKind = 'text' | 'checkbox' | 'radio' | 'select' | 'list' | 'button' | 'signature';

/** Tamaño default de cada tipo de widget al CREARLO. Es dato de creación/UI
 *  pero vive acá (capa de tipos, pura) porque era export de la RAÍZ de v1
 *  (`@aldus/core`) y el editor lo importa de ahí (usePlacement) — definirlo en
 *  create/ arrastraría pdf-lib al bundle browser. create/fields lo consume y
 *  re-exporta para el subpath ./bake. [C1 del informe de verificación] */
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
  /** Valor ACTUAL del campo (/V): texto (text/select/firma), 'On'/estado
   *  (checkbox/radio) o lista de seleccionados (list múltiple). Ausente = vacío. */
  value?: string | string[];
  /** Rect en puntos PDF, origen abajo-izquierda. */
  x: number;
  y: number;
  width: number;
  height: number;
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

/** Un resaltado (annotation /Highlight). Vive en /Annots — una CAPA aparte, no
 *  en el content stream — así que, como los widgets, se lo puede seleccionar,
 *  mover y borrar incluso después de guardar (editarlo = actualizar /Rect y
 *  /QuadPoints). Rect en puntos PDF, origen abajo-izquierda. */
export interface HighlightNode {
  id: string;
  kind: 'highlight';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Color hex "#rrggbb" (leído de /C). */
  color: string;
}

/** Un rectángulo vectorial relleno del contenido (banner, fondo de título,
 *  caja) — detectado al descomponer los paths de la página en extracción. */
export interface ShapeNode {
  id: string;
  kind: 'shape';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Color de relleno #rrggbb (si se conoce). */
  color?: string;
}

/** Todos los kinds de nodo del grafo.
 *  Nota v2: incluye ShapeNode (v1 lo omitía de la unión por descuido — el
 *  PageGraphService indexa TODOS los kinds por id). */
export type PdfNode =
  | TextRunNode
  | SegmentNode
  | LineNode
  | ImageNode
  | WidgetNode
  | LinkNode
  | HighlightNode
  | ShapeNode;

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
  highlights: HighlightNode[];
  /** Rectángulos VECTORIALES rellenos (fondos, banners, cajas) — sub-paths del
   *  contenido, no XObjects. Informativos/seleccionables; el bake no los toca. */
  shapes: ShapeNode[];
}

/** Un tramo de texto con su estilo, DENTRO de una edición. El estilo vive a
 *  nivel de run — nunca del segmento entero — así "quitar la negrita a una
 *  parte" no pisa el estilo del resto. */
export interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Subrayado (el PDF no lo tiene como atributo: el bake dibuja la línea). */
  underline?: boolean;
  /** Color hex (#rrggbb) del tramo. Ausente = el del segmento/original. */
  color?: string;
  /** Offset horizontal (pt) desde el origen del segmento, medido en el editor. */
  dx: number;
  /** Ancho medido (pt) del tramo — lo setea el editor; el bake lo usa para el
   *  subrayado. Ausente = desconocido. */
  w?: number;
}
