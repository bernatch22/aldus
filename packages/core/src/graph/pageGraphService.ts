/**
 * graph/pageGraphService.ts — el SERVICE dueño de las colecciones del grafo
 * (audit-model §3, patrón SourceContainer de js-debug). En v1 cada consumidor
 * hacía su propio `pages.find` / `segments.find` / sort (EditSession ×4,
 * usePendingEdits, locateText…) — acá los índices se construyen UNA vez por
 * `replace()` y se consultan O(1)/O(bucket).
 *
 * `replace()` es el ÚNICO punto de mutación: el grafo de una página se
 * REEMPLAZA entero (re-extract tras preview/bake), nunca se muta in-place —
 * por eso los nodos pueden memoizar (Segment) y los índices ser inmutables
 * entre replaces. `onDidReplace` avisa a los consumidores (editor: mata el
 * patrón refs-espejo/"effect que no debe depender de graph").
 */

import { EventEmitter, type IEvent } from '../common/events.js';
import type { IDisposable } from '../common/disposable.js';
import { MapUsingProjection } from '../common/mapUsingProjection.js';
import { normalize } from '../common/text.js';
import { createToken } from '../ioc/container.js';
import type { PageGraph, PdfNode, SegmentNode } from '../model/nodes.js';
import { SUPERSCRIPT_BREAK_FACTOR } from './segmentContent.js';

/** Tolerancia default de byGeometry, en puntos PDF — la MISMA ~1.8pt con la
 *  que el bake localiza ops por geometría (v1 locate.ts Y_TOL/X_TOL). Valor
 *  sagrado: se nombra, no se cambia. */
export const GEOMETRY_TOL_PT = 1.8;

export interface PdfRect { x: number; y: number; width: number; height: number }

export interface IPageGraphService {
  /** Se dispara tras cada replace() con el grafo nuevo de esa página. */
  readonly onDidReplace: IEvent<PageGraph>;
  /** Todas las páginas cargadas, en orden de número de página. */
  pages(): PageGraph[];
  page(n: number): PageGraph | undefined;
  /** UN map global id→node — TODOS los kinds (runs, segmentos, líneas,
   *  imágenes, widgets, links, highlights, shapes). */
  byId(id: string): PdfNode | undefined;
  /**
   * Los segmentos de la página cuya baseline está a MENOS de
   * 0.55×fontSize de la dada — el MISMO umbral super/subíndice de runLines
   * ({@link SUPERSCRIPT_BREAK_FACTOR}). Implementado con proyección a buckets
   * (MapUsingProjection): la proyección DISCRETIZA un umbral continuo, así que
   * SIEMPRE se chequean bucket±1 (test: casos borde 0.549/0.551×fs).
   */
  segmentsAt(page: number, baseline: number, fontSize: number): SegmentNode[];
  /** Nodos de la página cuyo rect coincide con `rect` dentro de `tolPt`
   *  (default {@link GEOMETRY_TOL_PT}) — el índice que v1 reconstruía ad-hoc
   *  en bake/locate y en el hit-testing del editor. */
  byGeometry(page: number, rect: PdfRect, tolPt?: number): PdfNode[];
  /** Segmentos cuyo texto NORMALIZADO (common/text) contiene el needle
   *  normalizado — locateText consulta acá. */
  byNormalizedText(needle: string): SegmentNode[];
  /** ÚNICO punto de mutación: reemplaza (o agrega) el grafo de una página,
   *  reconstruye los índices y dispara onDidReplace. */
  replace(page: PageGraph): void;
}

export const IPageGraphService = createToken<IPageGraphService>('IPageGraphService');

interface PageIndex {
  graph: PageGraph;
  /** ids de esta página, para purgar el map global en el próximo replace. */
  ids: string[];
  /** [textoNormalizado, segmento] por segmento, en orden del grafo. */
  normText: Array<[string, SegmentNode]>;
  /** Buckets de baseline por quantum (0.55×fs) — lazy por fontSize consultado. */
  buckets: Map<number, MapUsingProjection<number, SegmentNode[]>>;
}

export class PageGraphService implements IPageGraphService, IDisposable {
  private readonly emitter = new EventEmitter<PageGraph>();
  public readonly onDidReplace: IEvent<PageGraph> = this.emitter.event;

  private readonly byPage = new Map<number, PageIndex>();
  private readonly ids = new Map<string, PdfNode>();

  public pages(): PageGraph[] {
    return [...this.byPage.values()].map(p => p.graph).sort((a, b) => a.page - b.page);
  }

  public page(n: number): PageGraph | undefined {
    return this.byPage.get(n)?.graph;
  }

  public byId(id: string): PdfNode | undefined {
    return this.ids.get(id);
  }

  public segmentsAt(page: number, baseline: number, fontSize: number): SegmentNode[] {
    const idx = this.byPage.get(page);
    if (!idx) return [];
    const quantum = SUPERSCRIPT_BREAK_FACTOR * fontSize;
    if (!(quantum > 0)) return [];
    // Cache de buckets por quantum (redondeado a centésima de punto para que
    // fontSize con ruido float comparta índice).
    const qKey = Math.round(quantum * 100);
    let buckets = idx.buckets.get(qKey);
    if (!buckets) {
      buckets = new MapUsingProjection<number, SegmentNode[]>(b => Math.round(b / quantum));
      for (const seg of idx.graph.segments) {
        const list = buckets.get(seg.baseline);
        if (list) list.push(seg);
        else buckets.set(seg.baseline, [seg]);
      }
      idx.buckets.set(qKey, buckets);
    }
    // bucket±1 SIEMPRE: la proyección discretiza el umbral continuo — un
    // segmento a 0.549×fs puede caer en el bucket vecino.
    const b0 = Math.round(baseline / quantum);
    const out: SegmentNode[] = [];
    for (const db of [-1, 0, 1]) {
      for (const seg of buckets.get((b0 + db) * quantum) ?? []) {
        if (Math.abs(seg.baseline - baseline) < quantum) out.push(seg);
      }
    }
    return out;
  }

  public byGeometry(page: number, rect: PdfRect, tolPt = GEOMETRY_TOL_PT): PdfNode[] {
    const idx = this.byPage.get(page);
    if (!idx) return [];
    const g = idx.graph;
    const near = (node: { x: number; y: number; width: number; height: number }) =>
      Math.abs(node.x - rect.x) <= tolPt &&
      Math.abs(node.y - rect.y) <= tolPt &&
      Math.abs(node.width - rect.width) <= tolPt &&
      Math.abs(node.height - rect.height) <= tolPt;
    const out: PdfNode[] = [];
    for (const list of [g.segments, g.images, g.widgets, g.links, g.highlights, g.shapes] as PdfNode[][]) {
      for (const node of list) if (near(node as PdfNode & PdfRect)) out.push(node);
    }
    return out;
  }

  public byNormalizedText(needle: string): SegmentNode[] {
    const n = normalize(needle);
    if (!n) return [];
    const out: SegmentNode[] = [];
    for (const pageNum of [...this.byPage.keys()].sort((a, b) => a - b)) {
      for (const [norm, seg] of this.byPage.get(pageNum)!.normText) {
        if (norm.includes(n)) out.push(seg);
      }
    }
    return out;
  }

  public replace(page: PageGraph): void {
    const prev = this.byPage.get(page.page);
    if (prev) for (const id of prev.ids) this.ids.delete(id);

    const ids: string[] = [];
    const add = (node: PdfNode) => {
      this.ids.set(node.id, node);
      ids.push(node.id);
    };
    for (const list of [page.runs, page.lines, page.segments, page.images, page.widgets, page.links, page.highlights, page.shapes] as PdfNode[][]) {
      for (const node of list) add(node);
    }
    this.byPage.set(page.page, {
      graph: page,
      ids,
      // ⚠️ normalize SOLO en el ÍNDICE de matching — el texto del grafo queda intacto.
      normText: page.segments.map(s => [normalize(s.text), s]),
      buckets: new Map(),
    });
    this.emitter.fire(page);
  }

  public dispose(): void {
    this.emitter.dispose();
    this.byPage.clear();
    this.ids.clear();
  }
}
