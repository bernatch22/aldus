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

import type { FontBucket, FontInfo, ImageNode, LineNode, LinkNode, PageGraph, SegmentNode, TextRunNode, WidgetKind, WidgetNode } from './model.js';
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
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getAnnotations(): Promise<unknown[]>;
  commonObjs: { get(name: string): unknown };
}

interface RawAnnotation {
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
}

function extractLinks(annots: unknown[], page: number, x0: number, y0: number): LinkNode[] {
  const out: LinkNode[] = [];
  for (const raw of annots as RawAnnotation[]) {
    if (raw?.subtype !== 'Link' || !Array.isArray(raw.rect)) continue;
    const url = raw.url ?? raw.unsafeUrl;
    if (!url) continue;
    const [ax, ay, bx, by] = raw.rect;
    out.push({
      id: `p${page}-link${out.length}`,
      kind: 'link',
      page,
      url,
      x: Math.min(ax, bx) - x0,
      y: Math.min(ay, by) - y0,
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
    });
  }
  return out;
}

function widgetKindOf(a: RawAnnotation): WidgetKind {
  if (a.fieldType === 'Tx') return 'text';
  if (a.fieldType === 'Sig') return 'signature';
  if (a.fieldType === 'Ch') return a.combo ? 'select' : 'list';
  if (a.fieldType === 'Btn') return a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : 'button';
  return 'text';
}

function extractWidgets(annots: unknown[], page: number, x0: number, y0: number): WidgetNode[] {
  const out: WidgetNode[] = [];
  for (const raw of annots as RawAnnotation[]) {
    if (raw?.subtype !== 'Widget' || !Array.isArray(raw.rect) || raw.hidden) continue;
    const [ax, ay, bx, by] = raw.rect;
    const kind = widgetKindOf(raw);
    out.push({
      id: `p${page}-w${out.length}`,
      kind: 'widget',
      page,
      fieldName: raw.fieldName ?? '',
      widgetType: kind,
      readOnly: raw.readOnly === true,
      options: (kind === 'select' || kind === 'list') && Array.isArray(raw.options)
        ? raw.options.map(o => o.displayValue || o.exportValue || '').filter(Boolean)
        : undefined,
      x: Math.min(ax, bx) - x0,
      y: Math.min(ay, by) - y0,
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
    });
  }
  return out;
}

// Valores estables de pdfjs OPS (src/shared/util.js) — el único acople a
// pdf.js que core necesita para leer el operator list sin importarlo.
const OP_SAVE = 10;
const OP_RESTORE = 11;
const OP_TRANSFORM = 12;
const OP_PAINT_IMAGE = 85;
const OP_PAINT_INLINE_IMAGE = 86;
const OP_PAINT_IMAGE_MASK = 83;
const OP_PAINT_IMAGE_REPEAT = 88;
const PAINT_OPS = new Set([OP_PAINT_IMAGE, OP_PAINT_INLINE_IMAGE, OP_PAINT_IMAGE_MASK, OP_PAINT_IMAGE_REPEAT]);

type Mat = [number, number, number, number, number, number];
const mulMat = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/** Imágenes de la página: cada paint de XObject con su CTM → bounding box del
 *  unit square transformado. */
function extractImages(fnArray: number[], argsArray: unknown[][], page: number, x0: number, y0: number): ImageNode[] {
  const images: ImageNode[] = [];
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === OP_SAVE) stack.push(ctm);
    else if (fn === OP_RESTORE) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OP_TRANSFORM) {
      const a = argsArray[i] as number[];
      ctm = mulMat([a[0], a[1], a[2], a[3], a[4], a[5]], ctm);
    } else if (PAINT_OPS.has(fn)) {
      const [a, b, c, d, e, f] = ctm;
      const xs = [e, a + e, c + e, a + c + e];
      const ys = [f, b + f, d + f, b + d + f];
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      images.push({
        id: `p${page}-img${images.length}`,
        kind: 'image',
        page,
        x: minX - x0,
        y: minY - y0,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
        rotated: Math.abs(b) > 0.01 || Math.abs(c) > 0.01,
      });
    }
  }
  return images;
}

interface RawFont {
  name?: string;
  fallbackName?: string;
  ascent?: number;
  descent?: number;
  /** true cuando el font file NO viene en el PDF (pdf.js cae a una del sistema).
   *  OJO: no usar `data` para esto — pdf.js lo libera tras renderizar salvo
   *  `fontExtraProperties`, dando falsos "no embebido". */
  missingFile?: boolean;
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
    embedded: raw != null && raw.missingFile !== true,
  };
  cache.set(loadedName, info);
  return info;
}

export async function extractPageGraph(page: PdfJsPage): Promise<PageGraph> {
  // Resuelve los fonts embebidos en commonObjs (y, en el browser, los registra
  // como FontFace si la página ya se renderizó a canvas) — y da el operator
  // list del que salen las imágenes.
  const opList = await page.getOperatorList();
  const tc = await page.getTextContent({ disableNormalization: true });
  const annots = await page.getAnnotations().catch(() => [] as unknown[]);
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
    images: extractImages(opList.fnArray, opList.argsArray, page.pageNumber, x0, y0),
    widgets: extractWidgets(annots, page.pageNumber, x0, y0),
    links: extractLinks(annots, page.pageNumber, x0, y0),
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
  void index;
  // Id por GEOMETRÍA (no por índice): estable aunque otras líneas desaparezcan
  // (el preview local extirpa los ops de segmentos editados — con ids por
  // índice, todos los ids posteriores se corrían y rompían el mapa de ediciones).
  const lineId = `p${page}-y${Math.round(runs[0].baseline)}`;
  const segments: SegmentNode[] = splitSegments(runs).map(segRuns => ({
    id: `${lineId}-x${Math.round(segRuns[0].x)}`,
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
