/**
 * extractGraph.ts — del PDF renderizado por pdf.js al grafo tipado.
 *
 * Recibe la página de pdf.js por TIPADO ESTRUCTURAL (PdfJsPage): core no importa
 * pdfjs-dist, así que corre igual en browser (pdfjs-dist) y en Node (legacy build)
 * sin acoplarse a los paths de tipos internos de la lib.
 *
 * Precisión, no aproximación:
 *  - baseline = f de la text matrix [a b c d e f] (la y exacta del texto).
 *  - fontSize = |columna y| = hypot(c, d) — sobrevive a texto escalado.
 *  - ascent/descent salen del font embebido (commonObjs), no de un factor mágico.
 *    getOperatorList() se ejecuta antes para que los fonts estén resueltos.
 */

import type { FontBucket, FontInfo, LineNode, PageGraph, SegmentNode, TextRunNode } from './model.js';
import { segmentText, splitSegments } from './tokens.js';

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
  getOperatorList(): Promise<unknown>;
  commonObjs: { get(name: string): unknown };
}

interface RawFont {
  name?: string;
  fallbackName?: string;
  ascent?: number;
  descent?: number;
  data?: unknown;
  bold?: boolean;
  italic?: boolean;
}

function styleFromName(name: string): { bold: boolean; italic: boolean; bucket: FontBucket } {
  const n = name.toLowerCase();
  const bold = /bold|black|heavy|semibold|demibold|extrabold|-bd\b|,bd\b/.test(n);
  const italic = /italic|oblique/.test(n);
  const bucket: FontBucket =
    /(mono|courier|consol|menlo|typewriter|fixed)/.test(n) ? 'mono'
    : /(times|georgia|garamond|serif|roman|minion|antiqua|palatino|cambria|bodoni)/.test(n) ? 'serif'
    : 'sans';
  return { bold, italic, bucket };
}

function fontInfoFor(page: PdfJsPage, loadedName: string, cache: Map<string, FontInfo>): FontInfo {
  const hit = cache.get(loadedName);
  if (hit) return hit;
  let raw: RawFont | null = null;
  try {
    raw = page.commonObjs.get(loadedName) as RawFont;
  } catch {
    raw = null;
  }
  const ps = raw?.name || raw?.fallbackName || loadedName;
  const style = styleFromName(ps);
  const info: FontInfo = {
    loadedName,
    postScriptName: ps,
    bold: raw?.bold ?? style.bold,
    italic: raw?.italic ?? style.italic,
    bucket: style.bucket,
    ascent: typeof raw?.ascent === 'number' && raw.ascent > 0 ? raw.ascent : 0.8,
    descent: typeof raw?.descent === 'number' && raw.descent < 0 ? raw.descent : -0.2,
    embedded: raw?.data != null,
  };
  cache.set(loadedName, info);
  return info;
}

export async function extractPageGraph(page: PdfJsPage): Promise<PageGraph> {
  // Resuelve los fonts embebidos en commonObjs (y, en el browser, los registra
  // como FontFace si la página ya se renderizó a canvas).
  await page.getOperatorList();
  const tc = await page.getTextContent({ disableNormalization: true });
  const [x0, y0, x1, y1] = page.view;
  const fontCache = new Map<string, FontInfo>();
  const runs: TextRunNode[] = [];
  let i = 0;
  for (const item of tc.items as PdfJsTextItem[]) {
    if (typeof item.str !== 'string' || item.str.trim().length === 0) continue;
    const [a, b, c, d, e, f] = item.transform;
    runs.push({
      id: `p${page.pageNumber}-r${i++}`,
      kind: 'text',
      page: page.pageNumber,
      text: item.str,
      x: e - x0,
      baseline: f - y0,
      width: item.width,
      fontSize: Math.hypot(c, d),
      angle: Math.atan2(b, a),
      font: fontInfoFor(page, item.fontName, fontCache),
    });
  }
  const lines = groupIntoLines(runs, page.pageNumber);
  return {
    page: page.pageNumber,
    width: x1 - x0,
    height: y1 - y0,
    runs,
    lines,
    segments: lines.flatMap(l => l.segments),
  };
}

/** Agrupa runs horizontales por baseline (tolerancia relativa al tamaño);
 *  los rotados quedan como líneas de un solo run. */
export function groupIntoLines(runs: TextRunNode[], page: number): LineNode[] {
  const horizontal = runs.filter(r => Math.abs(r.angle) < 0.01);
  const rotated = runs.filter(r => Math.abs(r.angle) >= 0.01);
  const sorted = [...horizontal].sort((p, q) => q.baseline - p.baseline || p.x - q.x);
  const groups: TextRunNode[][] = [];
  for (const r of sorted) {
    const current = groups[groups.length - 1];
    const tol = Math.max(1, r.fontSize * 0.35);
    if (current && Math.abs(current[0].baseline - r.baseline) <= tol) current.push(r);
    else groups.push([r]);
  }
  for (const r of rotated) groups.push([r]);
  return groups.map((g, i) => lineFromRuns(g, page, i));
}

/** Geometría compartida de un grupo de runs (segmento o línea entera). */
function bboxOf(runs: TextRunNode[]) {
  const x = runs[0].x;
  const right = Math.max(...runs.map(r => r.x + r.width));
  const baseline = runs[0].baseline;
  const fontSize = Math.max(...runs.map(r => r.fontSize));
  const ascent = Math.max(...runs.map(r => r.font.ascent * r.fontSize));
  const descent = Math.min(...runs.map(r => r.font.descent * r.fontSize));
  return { x, baseline, width: right - x, y: baseline + descent, height: ascent - descent, fontSize };
}

function lineFromRuns(group: TextRunNode[], page: number, index: number): LineNode {
  const runs = [...group].sort((a, b) => a.x - b.x);
  const lineId = `p${page}-l${index}`;
  const segments: SegmentNode[] = splitSegments(runs).map((segRuns, s) => ({
    id: `${lineId}-s${s}`,
    kind: 'segment',
    page,
    text: segmentText(segRuns),
    runs: segRuns,
    ...bboxOf(segRuns),
  }));
  return {
    id: lineId,
    kind: 'line',
    page,
    text: segments.map(s => s.text).join(' '),
    segments,
    ...bboxOf(runs),
  };
}
