/**
 * graph/extract/annotations.ts — nodos desde /Annots (links, resaltados,
 * widgets). v1 repetía el MISMO loop rect→node tres veces (extractLinks /
 * extractHighlights / extractWidgets, audit-model §3): acá se unifica en
 * {@link eachAnnot} (filtro por subtype + rect normalizado + índice) y cada
 * tipo aporta solo su builder. Semántica de cada builder: verbatim v1.
 */

import type { HighlightNode, LinkNode, PageGraph, WidgetKind, WidgetNode } from '../../model/nodes.js';
import { annotIdOf } from './factory.js';
import type { ExtractContext, IGraphExtractor, PdfJsPage, RawAnnotation } from './types.js';

interface AnnotRect { x: number; y: number; width: number; height: number }

/**
 * EL loop unificado: recorre las anotaciones del subtype pedido, normaliza el
 * /Rect a puntos PDF origen abajo-izquierda (trasladado por x0/y0, min/abs
 * para rects "al revés") y llama al builder con un índice DENTRO de la
 * colección resultante (ids `p{n}-{prefix}{i}` — v1 verbatim: el índice
 * cuenta solo los aceptados). El builder devuelve null para saltar.
 */
function eachAnnot<T>(
  annots: unknown[],
  subtype: string,
  x0: number,
  y0: number,
  build: (raw: RawAnnotation, rect: AnnotRect, index: number) => T | null,
): T[] {
  const out: T[] = [];
  for (const raw of annots as RawAnnotation[]) {
    if (raw?.subtype !== subtype || !Array.isArray(raw.rect)) continue;
    const [ax, ay, bx, by] = raw.rect as [number, number, number, number];
    const rect: AnnotRect = {
      x: Math.min(ax, bx) - x0,
      y: Math.min(ay, by) - y0,
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
    };
    const node = build(raw, rect, out.length);
    if (node !== null) out.push(node);
  }
  return out;
}

export function extractLinks(annots: unknown[], page: number, x0: number, y0: number): LinkNode[] {
  return eachAnnot(annots, 'Link', x0, y0, (raw, rect, i) => {
    const url = raw.url ?? raw.unsafeUrl;
    if (!url) return null;
    return { id: annotIdOf(page, 'link', i), kind: 'link' as const, page, url, ...rect };
  });
}

/** Resaltados: anotaciones /Highlight de /Annots (capa aparte del contenido).
 *  pdf.js entrega el color en `color` como bytes 0..255 (o 0..1 en versiones
 *  viejas) — normalizamos a hex. */
export function extractHighlights(annots: unknown[], page: number, x0: number, y0: number): HighlightNode[] {
  const hx = (v: number) => Math.max(0, Math.min(255, Math.round(v <= 1 ? v * 255 : v))).toString(16).padStart(2, '0');
  return eachAnnot(annots, 'Highlight', x0, y0, (raw, rect, i) => {
    const c = raw.color && (raw.color as ArrayLike<number>).length >= 3 ? raw.color as ArrayLike<number> : null;
    return {
      id: annotIdOf(page, 'hl', i),
      kind: 'highlight' as const,
      page,
      ...rect,
      color: c ? `#${hx(c[0]!)}${hx(c[1]!)}${hx(c[2]!)}` : '#ffd400',
    };
  });
}

function widgetKindOf(a: RawAnnotation): WidgetKind {
  if (a.fieldType === 'Tx') return 'text';
  if (a.fieldType === 'Sig') return 'signature';
  if (a.fieldType === 'Ch') return a.combo ? 'select' : 'list';
  if (a.fieldType === 'Btn') return a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : 'button';
  return 'text';
}

export function extractWidgets(annots: unknown[], page: number, x0: number, y0: number): WidgetNode[] {
  return eachAnnot(annots, 'Widget', x0, y0, (raw, rect, i) => {
    if (raw.hidden) return null;
    const kind = widgetKindOf(raw);
    return {
      id: annotIdOf(page, 'w', i),
      kind: 'widget' as const,
      page,
      fieldName: raw.fieldName ?? '',
      widgetType: kind,
      readOnly: raw.readOnly === true,
      options: (kind === 'select' || kind === 'list') && Array.isArray(raw.options)
        ? raw.options.map(o => o.displayValue || o.exportValue || '').filter(Boolean)
        : undefined,
      // Valor actual (/V). pdf.js entrega '' para vacío y 'Off' para un
      // checkbox/radio sin marcar → los normalizamos a "ausente".
      value: (() => {
        const v = raw.fieldValue;
        if (Array.isArray(v)) return v.length ? v : undefined;
        if (typeof v === 'string' && v && v !== 'Off') return v;
        return undefined;
      })(),
      ...rect,
    };
  });
}

export class AnnotationExtractor implements IGraphExtractor {
  extract(_page: PdfJsPage, ctx: ExtractContext): Partial<PageGraph> {
    return {
      widgets: extractWidgets(ctx.annots, ctx.page, ctx.x0, ctx.y0),
      links: extractLinks(ctx.annots, ctx.page, ctx.x0, ctx.y0),
      highlights: extractHighlights(ctx.annots, ctx.page, ctx.x0, ctx.y0),
    };
  }
}
