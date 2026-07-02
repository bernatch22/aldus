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

// Próximas fases del roadmap — mismos principios, nuevos kinds:
//   ImageNode (XObjects) → FormWidgetNode (AcroForm) → SignatureNode.
export type PdfNode = TextRunNode | SegmentNode | LineNode;

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
}

/** Una edición pendiente sobre un segmento (lo que el server persiste y, en la
 *  fase de bake, aplica sobre el content stream). El segmento vecino no se toca:
 *  su x de anclaje ES la preservación del gap. */
export interface SegmentEdit {
  segmentId: string;
  page: number;
  /** Texto nuevo del segmento. */
  text: string;
  /** Snapshot del nodo original para que el bake pueda localizarlo sin ambigüedad. */
  original: { text: string; x: number; baseline: number; width: number; fontSize: number };
}
