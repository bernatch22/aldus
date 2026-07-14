/**
 * NodeIndex — resuelve `id → nodo` en O(1). Mata los CINCO scans lineales de v1
 * (session.seg/img/widget/hlNode/linkNode re-escaneaban TODAS las páginas en
 * cada tool call — un doc de 9 páginas con cientos de segmentos re-recorría todo
 * por cada edit_text). El mapa se construye UNA vez del DocGraph (mandamiento 5:
 * "services own collections — un map por query shape").
 */
import type {
  ImageNode, HighlightNode, LinkNode, PageGraph, PdfNode, SegmentNode, WidgetNode,
} from '@aldus/core';
import type { DocGraph } from '../graph.js';

export class NodeIndex {
  private readonly byId = new Map<string, PdfNode>();
  /** id de nodo → su página (para el motor de layout, que necesita la PageGraph). */
  private readonly pageById = new Map<string, PageGraph>();

  constructor(doc: DocGraph) {
    for (const p of doc.pages) {
      const all: PdfNode[] = [
        ...p.segments, ...p.images, ...p.widgets, ...p.highlights, ...p.links, ...(p.shapes ?? []),
      ];
      for (const n of all) {
        this.byId.set(n.id, n);
        this.pageById.set(n.id, p);
      }
    }
  }

  /** El nodo con ese id, del kind pedido (o undefined si no existe / no coincide). */
  private of<T extends PdfNode>(id: string, kind: PdfNode['kind']): T | undefined {
    const n = this.byId.get(id);
    return n && n.kind === kind ? (n as T) : undefined;
  }

  node(id: string): PdfNode | undefined { return this.byId.get(id); }
  seg(id: string): SegmentNode | undefined { return this.of<SegmentNode>(id, 'segment'); }
  img(id: string): ImageNode | undefined { return this.of<ImageNode>(id, 'image'); }
  widget(id: string): WidgetNode | undefined { return this.of<WidgetNode>(id, 'widget'); }
  highlight(id: string): HighlightNode | undefined { return this.of<HighlightNode>(id, 'highlight'); }
  link(id: string): LinkNode | undefined { return this.of<LinkNode>(id, 'link'); }

  /** La PageGraph de un nodo por su id. */
  pageOf(id: string): PageGraph | undefined { return this.pageById.get(id); }
}
