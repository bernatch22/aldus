/**
 * graph/extract/types.ts — el contrato de la extracción.
 *
 * La página de pdf.js llega por TIPADO ESTRUCTURAL (PdfJsPage): core no importa
 * pdfjs-dist, así que corre igual en browser (pdfjs-dist) y en Node (legacy
 * build) sin acoplarse a los paths de tipos internos de la lib.
 */

import { createToken } from '../../ioc/container.js';
import type { PageGraph, FontInfo } from '../../model/nodes.js';

export interface PdfJsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL?: boolean;
}

export interface PdfJsPage {
  pageNumber: number;
  /** [x0, y0, x1, y1] en puntos PDF. */
  view: number[];
  getTextContent(opts?: { disableNormalization?: boolean }): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getAnnotations(): Promise<unknown[]>;
  commonObjs: { get(name: string): unknown };
}

/** Forma cruda de una anotación de pdf.js (subset que la extracción lee). */
export interface RawAnnotation {
  subtype?: string;
  fieldName?: string;
  fieldType?: string;
  rect?: number[];
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  combo?: boolean;
  readOnly?: boolean;
  hidden?: boolean;
  url?: string;
  unsafeUrl?: string;
  options?: Array<{ exportValue?: string; displayValue?: string }>;
  /** Valor actual del campo (/V) — pdf.js lo entrega como string o string[]. */
  fieldValue?: string | string[];
  /** /C de la anotación (0..1 en pdf.js) — color del resaltado. */
  color?: Uint8ClampedArray | number[];
}

/**
 * Contexto COMPARTIDO de una extracción: el orquestador resuelve las promesas
 * de pdf.js UNA vez (getOperatorList primero — resuelve los fonts embebidos en
 * commonObjs) y cada extractor lee de acá.
 */
export interface ExtractContext {
  /** Número de página 1-based. */
  page: number;
  /** Origen de la vista ([x0, y0] de page.view) — TODA coordenada se traslada. */
  x0: number;
  y0: number;
  /** Tamaño de página en puntos PDF. */
  width: number;
  height: number;
  opList: { fnArray: number[]; argsArray: unknown[][] };
  annots: unknown[];
  items: PdfJsTextItem[];
  /** FontInfo memoizado por loadedName (cache por extracción). */
  fontInfoFor(loadedName: string): FontInfo;
  /**
   * El grafo PARCIAL acumulado hasta este extractor — el orden de binding ES
   * el orden de fusión (documentado en extractPageGraph): un extractor puede
   * leer lo que produjeron los anteriores (VectorRectExtractor marca
   * `underline` sobre los runs de TextRunExtractor; BlockExtractor agrupa esos
   * runs en líneas/segmentos).
   */
  draft: Partial<PageGraph>;
}

/**
 * Un extractor del grafo: produce una PARTE de PageGraph. Multi-bound en el
 * container (`container.bind(IGraphExtractor).to(...)` × N; el orquestador
 * hace `getAll`) — agregar "extraer tablas" = una clase + un bind (OCP).
 *
 * Sutilezas del dominio (viven ACÁ porque todo implementador las hereda):
 *  - ⚠️ pdf.js TRANSFIERE el buffer al worker en `getDocument`: el caller debe
 *    pasar `bytes.slice()` — un buffer detached crashea la extracción Y el
 *    bake posterior sobre los mismos bytes.
 *  - ⚠️ "fuente embebida" = `!missingFile` de pdf.js, NUNCA `font.data`
 *    (pdf.js libera `data` tras renderizar salvo `fontExtraProperties` →
 *    falsos "no embebido" → fallback erróneo).
 *  - ⚠️ El texto extraído viaja INTACTO (disableNormalization: true y cero
 *    trims): un glifo sin /ToUnicode es un control char legítimo del grafo.
 */
export interface IGraphExtractor {
  extract(page: PdfJsPage, ctx: ExtractContext): Promise<Partial<PageGraph>> | Partial<PageGraph>;
}

export const IGraphExtractor = createToken<IGraphExtractor>('IGraphExtractor');
