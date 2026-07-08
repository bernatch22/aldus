/**
 * session.ts — una sesión de edición sobre un documento. Acumula ediciones (con
 * las MISMAS funciones de merge que el editor UI — una sola fuente de verdad) y
 * las hornea con el bake de @aldus/core al guardar. Las tools son mutaciones; la
 * lectura ya está en el prompt.
 *
 * Dos clases de cambio, igual que el editor:
 *  - EDICIONES sobre nodos EXISTENTES (texto/imagen/campo/highlight/link) →
 *    Maps de *Edit, horneadas por bakeSegmentEdits en un solo tiro.
 *  - CREACIONES de nodos NUEVOS (texto, imagen, highlight, link, watermark,
 *    encabezado/pie, campo) → una cola aplicada DESPUÉS del bake (cada una es
 *    una función de createNodes que toma bytes y devuelve bytes), tal cual el
 *    server (/ops). El highlight/link "sobre un texto" resuelve su rect en el
 *    momento del bake desde la geometría EFECTIVA del segmento (así sigue al
 *    texto aunque el agente lo haya movido antes).
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  mergeSegmentEdit, mergeImageEdit, mergeWidgetEdit, mergeHighlightEdit, mergeLinkEdit,
  applyTextDiff, originalStyledRuns, promoteMovedImages, effectiveGeometry,
  type FontBucket, type SegmentEdit, type ImageEdit, type WidgetEdit, type HighlightEdit, type LinkEdit,
  type SegmentNode, type ImageNode, type WidgetNode, type HighlightNode, type LinkNode, type WidgetKind,
  type StyledRun,
} from '@aldus/core';
import {
  bakeSegmentEdits, addHighlight, addLink, addText, addWatermark, addHeaderFooter, addFormField, insertImage, setFieldValues,
} from '@aldus/core/bake';
import type { DocGraph } from './graph.js';
import { graphFromBytes } from './graph.js';

/** Una CREACIÓN pendiente: se aplica después del bake (bytes→bytes). El
 *  highlight/link "sobre un texto" guarda el segId y resuelve su rect al hornear. */
type CreateOp =
  | { kind: 'highlightSeg'; segId: string; color?: string }
  | { kind: 'linkSeg'; segId: string; url: string }
  | { kind: 'text'; page: number; x: number; y: number; text: string; size?: number; bucket?: FontBucket; bold?: boolean; italic?: boolean; color?: string }
  | { kind: 'image'; page: number; x: number; y: number; path: string; maxWidth?: number }
  | { kind: 'watermark'; text: string; opacity?: number; color?: string }
  | { kind: 'headerFooter'; header?: string; footer?: string; pageNumbers?: boolean }
  | { kind: 'field'; fieldType: WidgetKind; page: number; x: number; y: number; width?: number; height?: number; name?: string };

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/** Ancho ÚTIL objetivo de un campo (pt): el LLM puede pasarlo explícito (`width`);
 *  si no, se estima por el nombre — nombres/direcciones anchos, números medios. */
const WIDE_FIELD = /nombre|apellido|raz[oó]n|social|domicilio|direcci|empresa|calle|ciudad|cargo/i;
const NARROW_FIELD = /ruc|dni|n[uú]m|partida|c[oó]digo|fecha|tel[eé]fono|cuit|nit|zip|cp\b/i;
function targetWidthFor(name: string, width: number | undefined, fontSize: number): number {
  if (typeof width === 'number' && width > 0) return width;
  if (WIDE_FIELD.test(name)) return fontSize * 11;   // ~110pt @10
  if (NARROW_FIELD.test(name)) return fontSize * 5.5; // ~55pt
  return fontSize * 8;                                // ~80pt
}

/* Tipos del reflow de párrafo (compartido por placeholders_to_fields y edit_text). */
interface Paragraph {
  page: DocGraph['pages'][number];
  lines: SegmentNode[];
  leading: number;
  rightEdge: number;
  capacity: number;
  spaceW: number;
  paraBottom: number;
}
interface ReflowHole { li: number; from: number; to: number; name: string; target: number }
interface ReflowTok { kind: 'word' | 'hole'; text?: string; w: number; bold?: boolean; italic?: boolean; hole?: ReflowHole }
interface ReflowResult {
  layout: ReflowTok[][];
  rePage: Awaited<ReturnType<typeof graphFromBytes>>['pages'][number] | undefined;
  scale: number;
  extraLines: number;
}

export class EditSession {
  private edits = new Map<string, SegmentEdit>();
  private imageEdits = new Map<string, ImageEdit>();
  private widgetEdits = new Map<string, WidgetEdit>();
  private highlightEdits = new Map<string, HighlightEdit>();
  private linkEdits = new Map<string, LinkEdit>();
  private creates: CreateOp[] = [];
  /** Valores de formulario a COMPLETAR, por nombre de campo (setFieldValues). */
  private fills = new Map<string, string | boolean | string[]>();

  constructor(private doc: DocGraph) {}

  private seg(id: string): SegmentNode | undefined {
    for (const p of this.doc.pages) { const s = p.segments.find(x => x.id === id); if (s) return s; }
    return undefined;
  }
  private img(id: string): ImageNode | undefined {
    for (const p of this.doc.pages) { const i = p.images.find(x => x.id === id); if (i) return i; }
    return undefined;
  }
  private widget(id: string): WidgetNode | undefined {
    for (const p of this.doc.pages) { const w = p.widgets.find(x => x.id === id); if (w) return w; }
    return undefined;
  }
  private hlNode(id: string): HighlightNode | undefined {
    for (const p of this.doc.pages) { const h = p.highlights.find(x => x.id === id); if (h) return h; }
    return undefined;
  }
  private linkNode(id: string): LinkNode | undefined {
    for (const p of this.doc.pages) { const l = p.links.find(x => x.id === id); if (l) return l; }
    return undefined;
  }

  private putSeg(seg: SegmentNode, patch: Parameters<typeof mergeSegmentEdit>[2]): void {
    const m = mergeSegmentEdit(seg, this.edits.get(seg.id) ?? null, patch);
    if (m) this.edits.set(seg.id, m); else this.edits.delete(seg.id);
  }
  private putImg(img: ImageNode, patch: Parameters<typeof mergeImageEdit>[2]): void {
    const m = mergeImageEdit(img, this.imageEdits.get(img.id) ?? null, patch);
    if (m) this.imageEdits.set(img.id, m); else this.imageEdits.delete(img.id);
  }

  // ── EDICIONES de texto (nodos existentes) ──
  /** Edita el texto de un nodo. Si el texto NUEVO es más ancho de lo que entra
   *  en su renglón, el PÁRRAFO se reconstruye (reflow determinístico): lo que
   *  sobra baja al renglón siguiente en cascada — nunca se superpone ni se sale
   *  del borde. Texto igual o más corto = camino simple (verbatim + diff). */
  async editText(id: string, text: string): Promise<string> {
    const s = this.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    const styled = applyTextDiff(originalStyledRuns(s), text);

    // ¿Entra en el renglón? Estimo con el ancho medio REAL del segmento (incluye
    // el espaciado justificado → sobreestima → seguro). Si no crece, ni mido.
    const para = this.paragraphOf(s);
    const avgCharW = s.width / Math.max(1, s.text.length);
    const fits = text.length <= s.text.length || s.x + text.length * avgCharW <= para.rightEdge + 2;
    if (fits) {
      this.putSeg(s, { runs: styled });
      return `✓ Texto ${id}: ${JSON.stringify(s.text)} → ${JSON.stringify(text)}`;
    }

    // Más largo que el renglón → reflow del párrafo con esta línea reemplazada.
    const toks = this.paragraphToks(para, [], { lineId: s.id, styled, avgCharW });
    const { extraLines, scale } = await this.reflowApply(s, para, toks);
    const grew = extraLines ? ` (+${extraLines} renglón/es, contenido inferior corrido)` : '';
    const note = scale < 1 ? ' ⚠ el párrafo quedó justo: revisá el resultado' : '';
    return `✓ Texto ${id} → ${JSON.stringify(text)} — párrafo reconstruido${grew}${note}`;
  }

  /** Cambia el ESTILO (negrita/itálica) de un nodo de texto entero. El bake
   *  re-encoda con la variante de fuente correspondiente (si el PDF no la trae
   *  embebida, cae a la estándar equivalente y lo reporta). */
  styleText(id: string, opts: { bold?: boolean; italic?: boolean }): string {
    const s = this.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    if (opts.bold === undefined && opts.italic === undefined) return `⚠️ pasá bold y/o italic.`;
    const runs = originalStyledRuns(s).map(r => ({
      ...r,
      bold: opts.bold ?? r.bold,
      italic: opts.italic ?? r.italic,
    }));
    this.putSeg(s, { runs });
    const parts = [opts.bold !== undefined ? `bold=${opts.bold}` : '', opts.italic !== undefined ? `italic=${opts.italic}` : ''].filter(Boolean);
    return `✓ Texto ${id} → ${parts.join(', ')}`;
  }
  moveText(id: string, x?: number, y?: number): string {
    const s = this.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    this.putSeg(s, { x, baseline: y });
    return `✓ Texto ${id} movido a @(${x ?? Math.round(s.x)},${y ?? Math.round(s.baseline)})`;
  }
  colorText(id: string, color: string): string {
    const s = this.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    this.putSeg(s, { color });
    return `✓ Texto ${id} → color ${color}`;
  }
  resizeText(id: string, fontSize: number): string {
    const s = this.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    this.putSeg(s, { fontSize });
    return `✓ Texto ${id} → ${fontSize}pt`;
  }
  deleteText(id: string): string {
    const s = this.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    this.putSeg(s, { remove: true });
    return `✓ Texto ${id} eliminado`;
  }

  // ── EDICIONES de imagen (nodos existentes) ──
  moveImage(id: string, patch: { x?: number; y?: number; width?: number; height?: number }): string {
    const im = this.img(id); if (!im) return `⚠️ No existe la imagen "${id}".`;
    this.putImg(im, patch);
    return `✓ Imagen ${id} → @(${patch.x ?? Math.round(im.x)},${patch.y ?? Math.round(im.y)}) ${patch.width ?? Math.round(im.width)}×${patch.height ?? Math.round(im.height)}`;
  }
  deleteImage(id: string): string {
    const im = this.img(id); if (!im) return `⚠️ No existe la imagen "${id}".`;
    this.putImg(im, { remove: true });
    return `✓ Imagen ${id} eliminada`;
  }

  // ── EDICIONES de campo / highlight / link existentes ──
  moveField(id: string, x?: number, y?: number): string {
    const w = this.widget(id); if (!w) return `⚠️ No existe el campo "${id}".`;
    const m = mergeWidgetEdit(w, this.widgetEdits.get(id) ?? null, { x, y });
    if (m) this.widgetEdits.set(id, m); else this.widgetEdits.delete(id);
    return `✓ Campo ${id} movido a @(${x ?? Math.round(w.x)},${y ?? Math.round(w.y)})`;
  }
  deleteField(id: string): string {
    const w = this.widget(id); if (!w) return `⚠️ No existe el campo "${id}".`;
    const m = mergeWidgetEdit(w, this.widgetEdits.get(id) ?? null, { remove: true });
    if (m) this.widgetEdits.set(id, m);
    return `✓ Campo ${id} eliminado`;
  }
  recolorHighlight(id: string, color: string): string {
    const h = this.hlNode(id); if (!h) return `⚠️ No existe el resaltado "${id}".`;
    const m = mergeHighlightEdit(h, this.highlightEdits.get(id) ?? null, { color });
    if (m) this.highlightEdits.set(id, m); else this.highlightEdits.delete(id);
    return `✓ Resaltado ${id} → color ${color}`;
  }
  deleteHighlight(id: string): string {
    const h = this.hlNode(id); if (!h) return `⚠️ No existe el resaltado "${id}".`;
    const m = mergeHighlightEdit(h, this.highlightEdits.get(id) ?? null, { remove: true });
    if (m) this.highlightEdits.set(id, m);
    return `✓ Resaltado ${id} eliminado`;
  }
  deleteLink(id: string): string {
    const l = this.linkNode(id); if (!l) return `⚠️ No existe el link "${id}".`;
    const m = mergeLinkEdit(l, this.linkEdits.get(id) ?? null, { remove: true });
    if (m) this.linkEdits.set(id, m);
    return `✓ Link ${id} eliminado`;
  }

  // ── CREACIONES (nodos nuevos — cola aplicada post-bake) ──
  highlightText(segId: string, color?: string): string {
    if (!this.seg(segId)) return `⚠️ No existe el nodo de texto "${segId}".`;
    this.creates.push({ kind: 'highlightSeg', segId, color });
    return `✓ Resaltado sobre ${segId}${color ? ` (${color})` : ''}`;
  }
  linkText(segId: string, url: string): string {
    if (!this.seg(segId)) return `⚠️ No existe el nodo de texto "${segId}".`;
    this.creates.push({ kind: 'linkSeg', segId, url });
    return `✓ Link sobre ${segId} → ${url}`;
  }
  /** Agrega texto nuevo. ANTI-COLISIÓN determinística: si el rect estimado pisa
   *  texto existente (u otro texto ya encolado), baja renglón a renglón hasta un
   *  hueco libre — el LLM no tiene que acertar la y exacta. */
  addTextNode(op: Omit<Extract<CreateOp, { kind: 'text' }>, 'kind'>): string {
    const page = this.doc.pages.find(p => p.page === op.page);
    const size = op.size ?? 11;
    let y = op.y; // esquina SUPERIOR-izquierda (baseline ≈ y - size)
    if (page) {
      const estW = Math.min(op.text.length * size * 0.55, page.width - op.x - 20);
      const collides = (yt: number): boolean =>
        page.segments.some(sg =>
          sg.baseline > yt - size * 1.5 && sg.baseline < yt + 2 &&
          sg.x < op.x + estW && sg.x + sg.width > op.x) ||
        this.creates.some(c =>
          c.kind === 'text' && c.page === op.page &&
          Math.abs(c.y - yt) < size * 1.3 && c.x < op.x + estW);
      let guard = 0;
      while (collides(y) && y - size * 1.3 > 40 && guard++ < 60) y -= size * 1.3;
      if (collides(y)) y = op.y; // no hay lugar libre debajo: respetar lo pedido
    }
    const moved = Math.abs(y - op.y) > 1;
    this.creates.push({ kind: 'text', ...op, y });
    return `✓ Texto nuevo en p${op.page} @(${op.x},${Math.round(y)})${moved ? ` — BAJADO desde y=${Math.round(op.y)} (pisaba texto existente)` : ''}: ${JSON.stringify(op.text.slice(0, 40))}`;
  }
  insertImageFile(page: number, x: number, y: number, path: string, maxWidth?: number): string {
    this.creates.push({ kind: 'image', page, x, y, path, maxWidth });
    return `✓ Imagen "${path}" en p${page} @(${x},${y})`;
  }
  watermark(text: string, color?: string, opacity?: number): string {
    this.creates.push({ kind: 'watermark', text, color, opacity });
    return `✓ Marca de agua: ${JSON.stringify(text)}`;
  }
  headerFooter(op: { header?: string; footer?: string; pageNumbers?: boolean }): string {
    this.creates.push({ kind: 'headerFooter', ...op });
    return `✓ Encabezado/pie aplicado`;
  }
  addField(fieldType: WidgetKind, page: number, x: number, y: number, width?: number, height?: number, name?: string): string {
    this.creates.push({ kind: 'field', fieldType, page, x, y, width, height, name });
    return `✓ Campo ${fieldType} en p${page} @(${x},${y})`;
  }

  /* ── REFLOW DE PÁRRAFO (compartido por placeholders_to_fields y edit_text) ──
   * El LLM nunca calcula geometría: estos helpers tokenizan el párrafo con
   * anchos MEDIDOS, lo re-envuelven, re-emiten cada renglón con runs anclados a
   * posiciones calculadas, y hornean+miden EN LOOP hasta que ningún renglón se
   * pasa del borde ni dos tramos chocan. */

  /** x por CARÁCTER de un segmento, desde sus runs reales. */
  private charXOf(seg: SegmentNode): number[] {
    const cx = new Array<number>(seg.text.length + 1).fill(seg.x);
    let cur = 0, lastEnd = seg.x;
    for (const r of seg.runs) {
      const at = seg.text.indexOf(r.text, cur);
      if (at < 0) continue;
      for (let k = cur; k <= at; k++) cx[k] = lastEnd + ((r.x - lastEnd) * (k - cur)) / Math.max(1, at - cur);
      const w = r.width / Math.max(1, r.text.length);
      for (let k = 0; k <= r.text.length; k++) cx[at + k] = r.x + w * k;
      cur = at + r.text.length; lastEnd = r.x + r.width;
    }
    for (let k = cur; k <= seg.text.length; k++) cx[k] = lastEnd;
    return cx;
  }

  /** El párrafo de un segmento: líneas consecutivas con el mismo x de anclaje
   *  y paso de interlineado regular. */
  private paragraphOf(s: SegmentNode): Paragraph {
    const page = this.doc.pages.find(p => p.page === s.page)!;
    const sameCol = page.segments
      .filter(x => Math.abs(x.x - s.x) < 4 && Math.abs(x.fontSize - s.fontSize) < 2)
      .sort((a, b) => b.baseline - a.baseline);
    const idx = sameCol.findIndex(x => x.id === s.id);
    const maxLead = s.fontSize * 1.7;
    let lo = idx, hi = idx;
    while (lo > 0 && sameCol[lo - 1].baseline - sameCol[lo].baseline < maxLead) lo--;
    while (hi + 1 < sameCol.length && sameCol[hi].baseline - sameCol[hi + 1].baseline < maxLead) hi++;
    const lines = sameCol.slice(lo, hi + 1); // arriba → abajo
    const leading = lines.length > 1
      ? (lines[0].baseline - lines[lines.length - 1].baseline) / (lines.length - 1)
      : s.fontSize * 1.15;
    const rightEdge = Math.max(...lines.map(l => l.x + l.width));
    return {
      page, lines, leading, rightEdge,
      capacity: rightEdge - s.x,
      spaceW: s.fontSize * 0.28,
      paraBottom: lines[lines.length - 1].baseline,
    };
  }

  /** Tokens (palabras con ancho medido + estilo, y huecos) de las líneas del
   *  párrafo. `replace` sustituye el contenido de UNA línea por runs nuevos
   *  (edit_text): sus palabras se estiman con el ancho medio del segmento. */
  private paragraphToks(para: Paragraph, holes: ReflowHole[], replace?: { lineId: string; styled: StyledRun[]; avgCharW: number }): ReflowTok[] {
    const toks: ReflowTok[] = [];
    for (let k = 0; k < para.lines.length; k++) {
      const line = para.lines[k];
      if (replace && line.id === replace.lineId) {
        for (const run of replace.styled) {
          for (const m of run.text.matchAll(/\S+/g)) {
            toks.push({ kind: 'word', text: m[0], w: m[0].length * replace.avgCharW, bold: run.bold, italic: run.italic });
          }
        }
        continue;
      }
      const text = line.text;
      const cx = this.charXOf(line);
      // estilo por carácter (del run que lo contiene) — para conservar negritas.
      const styleAt: Array<{ bold: boolean; italic: boolean }> = new Array(text.length).fill({ bold: false, italic: false });
      let sc = 0;
      for (const r of line.runs) {
        const at = text.indexOf(r.text, sc);
        if (at < 0) continue;
        for (let c = at; c < at + r.text.length; c++) styleAt[c] = { bold: r.font.bold, italic: r.font.italic };
        sc = at + r.text.length;
      }
      const lineHoles = holes.filter(h => h.li === k).sort((a, b) => a.from - b.from);
      let pos = 0;
      const pushWords = (from: number, to: number) => {
        for (const m of text.slice(from, to).matchAll(/\S+/g)) {
          const a = from + m.index!, b = a + m[0].length;
          toks.push({ kind: 'word', text: m[0], w: cx[b] - cx[a], bold: styleAt[a]?.bold ?? false, italic: styleAt[a]?.italic ?? false });
        }
      };
      for (const h of lineHoles) { pushWords(pos, h.from); toks.push({ kind: 'hole', w: 0, hole: h }); pos = h.to; }
      pushWords(pos, text.length);
    }
    return toks;
  }

  /** Re-envuelve, aplica y MIDE EN LOOP: re-emite cada renglón con runs propios
   *  (dx calculado, nunca heredado), hornea un preview, y corrige — overflow del
   *  borde achica los targets de los huecos; tramos que chocan se re-anclan con
   *  el corrimiento EXACTO medido. Si el párrafo crece, corre lo de abajo. */
  private async reflowApply(s: SegmentNode, para: Paragraph, toks: ReflowTok[]): Promise<ReflowResult> {
    const { page, lines, leading, rightEdge, capacity, spaceW, paraBottom } = para;
    const slackBelow = Math.max(0, paraBottom - 60);
    const maxExtraLines = Math.min(3, Math.floor(slackBelow / leading));

    const holeW = (t: ReflowTok, scale: number) => Math.max(25, t.hole!.target * scale);
    const wrap = (scale: number): ReflowTok[][] => {
      const rows: ReflowTok[][] = [[]];
      let curW = 0;
      for (const t of toks) {
        const w = t.kind === 'hole' ? holeW(t, scale) : t.w;
        const sep = rows[rows.length - 1].length ? spaceW : 0;
        if (curW + sep + w > capacity && rows[rows.length - 1].length) { rows.push([]); curW = 0; }
        rows[rows.length - 1].push(t);
        curW += (rows[rows.length - 1].length > 1 ? spaceW : 0) + w;
      }
      return rows;
    };

    const BOUNDARY_PAD = 2; // aire al cambiar de estilo (deriva de estimación)
    const dxFix = new Map<string, number>(); // "fila:texto" → corrimiento medido
    const rowRuns = (row: ReflowTok[], scale: number, rowIdx: number): StyledRun[] => {
      const runs: StyledRun[] = [];
      let cursor = 0;
      for (const t of row) {
        const isFirst = runs.length === 0;
        const sep = isFirst ? 0 : spaceW;
        const text = t.kind === 'word' ? t.text! : ' '.repeat(Math.max(3, Math.round(holeW(t, scale) / spaceW)));
        const w = t.kind === 'word' ? t.w : holeW(t, scale);
        const bold = t.kind === 'word' ? !!t.bold : false;
        const italic = t.kind === 'word' ? !!t.italic : false;
        const last = runs[runs.length - 1];
        if (last && (t.kind === 'hole' || (last.bold === bold && last.italic === italic))) {
          last.text += (isFirst ? '' : ' ') + text; // mismo estilo (o hueco): fluye en el run
        } else {
          runs.push({ text, bold, italic, dx: cursor + sep + (isFirst ? 0 : BOUNDARY_PAD) });
        }
        cursor += sep + w;
      }
      for (const r of runs) {
        const fix = dxFix.get(`${rowIdx}:${r.text.trim().slice(0, 30)}`);
        if (fix) r.dx += fix;
      }
      return runs;
    };

    const createStart = this.creates.length;
    let scale = 1;
    let layout: ReflowTok[][] = [];
    let extraLines = 0;
    let rePage: ReflowResult['rePage'];

    for (let iter = 0; iter < 8; iter++) {
      layout = wrap(scale);
      while (layout.length > lines.length + maxExtraLines && scale > 0.3) { scale *= 0.9; layout = wrap(scale); }
      extraLines = Math.max(0, layout.length - lines.length);

      // (re)aplicar desde cero: ediciones frescas + creates truncados
      this.creates.length = createStart;
      for (const l of lines) this.edits.delete(l.id);
      for (let k = 0; k < lines.length; k++) {
        const runs = k < layout.length ? rowRuns(layout[k], scale, k) : [];
        if (runs.length) this.putSeg(lines[k], { runs });
        else this.putSeg(lines[k], { remove: true });
      }
      for (let e = 0; e < extraLines; e++) {
        const bl = paraBottom - leading * (e + 1);
        const text = layout[lines.length + e].map(t => (t.kind === 'word' ? t.text! : ' '.repeat(Math.max(3, Math.round(holeW(t, scale) / spaceW))))).join(' ');
        this.creates.push({ kind: 'text', page: s.page, x: s.x, y: bl + s.fontSize, text, size: s.fontSize });
      }
      if (extraLines > 0) {
        const dy = extraLines * leading;
        for (const other of page.segments) {
          if (other.baseline < paraBottom - 1 && !lines.some(l => l.id === other.id)) {
            this.putSeg(other, { baseline: other.baseline - dy });
          }
        }
        for (let ci = 0; ci < createStart; ci++) {
          const c = this.creates[ci];
          if (c.kind === 'field' && c.page === s.page && c.y < paraBottom - 1) c.y -= dy;
        }
      }

      // MEDIR: (a) ningún renglón puede pasarse del borde de texto original (los
      // generadores tipo Word CLIPPEAN ahí), (b) gap mínimo entre tramos — si
      // chocan o quedan pegados, corrijo el ancla con el corrimiento medido.
      const { pdf } = await this.bake();
      const re = await graphFromBytes(pdf.slice());
      rePage = re.pages.find(p => p.page === s.page);
      let overflow = false;
      let collided = false;
      const MIN_GAP = spaceW * 0.7;
      for (let k = 0; k < layout.length; k++) {
        const bl = k < lines.length ? lines[k].baseline : paraBottom - leading * (k - lines.length + 1);
        const rowSegs = (rePage?.segments ?? [])
          .filter(x => Math.abs(x.baseline - bl) < 6 && x.x >= s.x - 3)
          .sort((a, b) => a.x - b.x);
        const flat = rowSegs.flatMap(seg => seg.runs).sort((a, b) => a.x - b.x);
        for (let i = 0; i < flat.length; i++) {
          if (flat[i].x + flat[i].width > rightEdge + 3) overflow = true;
          if (i > 0) {
            const gap = flat[i].x - (flat[i - 1].x + flat[i - 1].width);
            if (gap < MIN_GAP) {
              collided = true;
              const key = `${k}:${flat[i].text.trim().slice(0, 30)}`;
              dxFix.set(key, (dxFix.get(key) ?? 0) + (MIN_GAP - gap));
            }
          }
        }
      }
      if (!overflow && !collided) break;
      if (overflow) scale *= 0.92; // el overflow achica huecos; el choque se re-ancla
    }
    return { layout, rePage, scale, extraLines };
  }

  /**
   * DETERMINÍSTICO — el LLM DETECTA (pasa los substrings de placeholder + nombre
   * y opcionalmente el ancho útil) y el CÓDIGO hace TODO el layout: campos con
   * ancho ÚTIL (nombre ~110pt, número ~55pt), párrafo reconstruido si hace falta
   * (renglón extra + contenido inferior corrido), loop de medición hasta que
   * todo queda dentro, y cada campo sobre el HUECO REAL medido del preview.
   * `id` puede ser cualquier línea del párrafo; `fields` en orden de lectura.
   */
  async placeholdersToFields(id: string, fields: Array<{ placeholder: string; name: string; width?: number }>): Promise<string> {
    const s = this.seg(id);
    if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    if (!fields.length) return `⚠️ placeholders_to_fields necesita al menos un {placeholder,name}.`;
    const para = this.paragraphOf(s);
    const { lines, leading, rightEdge, paraBottom } = para;

    // Localizar cada placeholder (literal, en orden de lectura, cruzando líneas).
    const holes: ReflowHole[] = [];
    let li = 0, off = 0;
    for (const f of fields) {
      if (!f.placeholder) return `⚠️ un field vino sin placeholder.`;
      let at = -1;
      while (li < lines.length) {
        at = lines[li].text.indexOf(f.placeholder, off);
        if (at >= 0) break;
        li++; off = 0;
      }
      if (at < 0) return `⚠️ no encontré ${JSON.stringify(f.placeholder)} en el párrafo de ${id} (usá el texto EXACTO, en orden de lectura).`;
      holes.push({ li, from: at, to: at + f.placeholder.length, name: (f.name || '').trim() || `campo_${holes.length + 1}`, target: targetWidthFor(f.name ?? '', f.width, s.fontSize) });
      off = at + f.placeholder.length;
    }

    const toks = this.paragraphToks(para, holes);
    const { layout, rePage, scale, extraLines } = await this.reflowApply(s, para, toks);

    // Con el layout final medido, crear cada campo sobre el GAP real de su
    // renglón — imposible pisar texto (no hay glifos ahí).
    const made: string[] = [];
    let holeCursor = 0;
    for (let k = 0; k < layout.length && holeCursor < holes.length; k++) {
      const rowHoles = layout[k].filter(t => t.kind === 'hole').map(t => t.hole!);
      if (!rowHoles.length) continue;
      const bl = k < lines.length ? lines[k].baseline : paraBottom - leading * (k - lines.length + 1);
      const rowSegs = (rePage?.segments ?? [])
        .filter(x => Math.abs(x.baseline - bl) < 6 && x.x >= s.x - 3 && x.x <= rightEdge + 8)
        .sort((a, b) => a.x - b.x);
      const gaps: Array<{ from: number; to: number }> = [];
      const GAP_MIN = 10;
      if (rowSegs.length && rowSegs[0].x - s.x > GAP_MIN) gaps.push({ from: s.x, to: rowSegs[0].x });
      for (let i = 0; i < rowSegs.length; i++) {
        const from = rowSegs[i].x + rowSegs[i].width;
        const to = i + 1 < rowSegs.length ? rowSegs[i + 1].x : rightEdge;
        if (to - from > GAP_MIN) gaps.push({ from, to });
      }
      const size = rowSegs[0]?.fontSize ?? s.fontSize;
      const rbl = rowSegs[0]?.baseline ?? bl;
      for (let i = 0; i < rowHoles.length && holeCursor < holes.length; i++, holeCursor++) {
        const g = gaps[i];
        if (!g) { made.push(`(⚠ sin hueco medible para ${rowHoles[i].name})`); continue; }
        this.creates.push({
          kind: 'field', fieldType: 'text', page: s.page,
          x: Math.round((g.from + 1) * 100) / 100, y: Math.round((rbl - 2) * 100) / 100,
          width: Math.round(Math.max(20, g.to - g.from - 2) * 100) / 100, height: Math.round((size + 2) * 100) / 100,
          name: rowHoles[i].name,
        });
        made.push(`${rowHoles[i].name} @(${Math.round(g.from + 1)},${Math.round(rbl - 2)}) ${Math.round(g.to - g.from - 2)}pt`);
      }
    }
    const grew = extraLines ? ` · párrafo reconstruido (+${extraLines} renglón/es, contenido inferior corrido)` : '';
    const shrunk = scale < 1 ? ` · targets al ${Math.round(scale * 100)}% para entrar en página` : '';
    return `✓ ${made.length} campo(s) con ancho útil sobre huecos REALES (medidos tras hornear)${grew}${shrunk}: ${made.join(' · ')}`;
  }

  /** COMPLETA un campo de formulario por su NOMBRE o por su id de widget
   *  ([[p1-w3]] de la vista de Lectura — se resuelve al fieldName). Valor:
   *  texto para text/select/radio, true/false para checkbox. Determinístico. */
  fillField(nameOrId: string, value: string | boolean | string[]): string {
    let fieldName = nameOrId;
    if (!this.doc.pages.some(p => p.widgets.some(w => w.fieldName === fieldName))) {
      const byId = this.widget(nameOrId.replace(/^\[\[|\]\]$/g, ''));
      if (!byId) return `⚠️ No existe un campo llamado "${nameOrId}" (ni como fieldName ni como id).`;
      fieldName = byId.fieldName;
    }
    this.fills.set(fieldName, value);
    return `✓ Campo "${fieldName}" ← ${JSON.stringify(value)}`;
  }

  /** COMPLETA VARIOS campos de una (por fieldName o id de widget) — UNA sola tool
   *  call en vez de N idas y vueltas con el modelo (clave para forms grandes). */
  fillFields(entries: Array<{ name: string; value: string | boolean | string[] }>): string {
    const lines = entries.map(e => this.fillField(e.name, e.value));
    return lines.join('\n');
  }

  /** Precarga ediciones ya existentes (p. ej. las pendientes del editor UI). */
  seed(edits: SegmentEdit[] = [], imageEdits: ImageEdit[] = []): void {
    for (const e of edits) this.edits.set(e.segmentId, e);
    for (const e of imageEdits) this.imageEdits.set(e.imageId, e);
  }

  /** Ediciones de texto/imagen acumuladas (lo que el editor sabe aplicar a su
   *  estado local; las creaciones/annotations se hornean en el server/CLI). */
  getEdits(): { edits: SegmentEdit[]; imageEdits: ImageEdit[] } {
    return { edits: [...this.edits.values()], imageEdits: [...this.imageEdits.values()] };
  }

  /** Cantidad total de cambios pendientes. */
  get count(): number {
    return this.edits.size + this.imageEdits.size + this.widgetEdits.size + this.highlightEdits.size + this.linkEdits.size + this.creates.length + this.fills.size;
  }

  /** ¿Hay cambios que el editor NO puede reflejar con getEdits() (creaciones,
   *  ediciones de annotations, o llenado de formularios)? El server los hornea +
   *  persiste en vez de devolverlos como seg/img edits. */
  get hasBakedOps(): boolean {
    return this.creates.length + this.widgetEdits.size + this.highlightEdits.size + this.linkEdits.size + this.fills.size > 0;
  }

  summary(): string {
    const parts: string[] = [];
    for (const e of this.edits.values()) parts.push(e.remove ? `${e.segmentId}: eliminar` : `${e.segmentId}: editar`);
    for (const e of this.imageEdits.values()) parts.push(e.remove ? `${e.imageId}: eliminar` : `${e.imageId}: mover/escalar`);
    for (const e of this.widgetEdits.values()) parts.push(`${e.widgetId}: campo`);
    for (const e of this.highlightEdits.values()) parts.push(`${e.highlightId}: resaltado`);
    for (const e of this.linkEdits.values()) parts.push(`${e.linkId}: link`);
    for (const c of this.creates) parts.push(`+${c.kind}`);
    for (const [name] of this.fills) parts.push(`${name}: completar`);
    return parts.join(' · ') || '(sin cambios)';
  }

  /** Aplica una CREACIÓN sobre los bytes ya horneados (bytes→bytes). */
  private async applyCreate(pdf: Uint8Array, op: CreateOp): Promise<Uint8Array> {
    switch (op.kind) {
      case 'highlightSeg': {
        const s = this.seg(op.segId)!;
        const g = effectiveGeometry(s, this.edits.get(op.segId) ?? null);
        return (await addHighlight(pdf, { page: s.page, x: g.x, y: g.y, width: g.width, height: g.height, color: op.color })).pdf;
      }
      case 'linkSeg': {
        const s = this.seg(op.segId)!;
        const g = effectiveGeometry(s, this.edits.get(op.segId) ?? null);
        return (await addLink(pdf, { page: s.page, x: g.x, y: g.y, width: g.width, height: g.height, url: op.url })).pdf;
      }
      case 'text':
        return (await addText(pdf, op)).pdf;
      case 'image': {
        const bytes = new Uint8Array(await readFile(op.path));
        const ext = op.path.split('.').pop()?.toLowerCase() ?? '';
        const mime = MIME[ext];
        if (!mime) throw new Error(`imagen no soportada (${op.path}): solo PNG/JPEG`);
        return (await insertImage(pdf, { page: op.page, x: op.x, y: op.y, bytes, mime, maxWidth: op.maxWidth })).pdf;
      }
      case 'watermark':
        return (await addWatermark(pdf, { text: op.text, opacity: op.opacity, color: op.color })).pdf;
      case 'headerFooter':
        return (await addHeaderFooter(pdf, { header: op.header, footer: op.footer, pageNumbers: op.pageNumbers })).pdf;
      case 'field':
        return (await addFormField(pdf, { type: op.fieldType, page: op.page, x: op.x, y: op.y, width: op.width, height: op.height, name: op.name })).pdf;
    }
  }

  /** Hornea TODO (ediciones + annotations + creaciones) y devuelve los bytes. */
  async bake(): Promise<{ pdf: Uint8Array; applied: string[]; warnings: string[] }> {
    const imgs = promoteMovedImages([...this.imageEdits.values()]);
    const r = await bakeSegmentEdits(
      this.doc.bytes.slice(), [...this.edits.values()], imgs, [...this.widgetEdits.values()],
      [...this.highlightEdits.values()], [...this.linkEdits.values()],
    );
    let pdf = r.pdf;
    for (const op of this.creates) { pdf = await this.applyCreate(pdf, op); r.applied.push(`+${op.kind}`); }
    // Completar formularios AL FINAL (sobre el PDF ya con los campos creados, por
    // si el agente creó un campo y lo completó en el mismo turno).
    if (this.fills.size) {
      const res = await setFieldValues(pdf, Object.fromEntries(this.fills));
      pdf = res.pdf;
      r.applied.push(...res.applied.map(a => `campo ${a}`));
      r.warnings.push(...res.warnings);
    }
    return { pdf, applied: r.applied, warnings: r.warnings };
  }

  /** Hornea y escribe el PDF a `outPath`. */
  async save(outPath: string): Promise<{ applied: string[]; warnings: string[] }> {
    const { pdf, applied, warnings } = await this.bake();
    await writeFile(outPath, pdf);
    return { applied, warnings };
  }
}
