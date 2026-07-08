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
  editText(id: string, text: string): string {
    const s = this.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    this.putSeg(s, { runs: applyTextDiff(originalStyledRuns(s), text) });
    return `✓ Texto ${id}: ${JSON.stringify(s.text)} → ${JSON.stringify(text)}`;
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
  addTextNode(op: Omit<Extract<CreateOp, { kind: 'text' }>, 'kind'>): string {
    this.creates.push({ kind: 'text', ...op });
    return `✓ Texto nuevo en p${op.page} @(${op.x},${op.y}): ${JSON.stringify(op.text.slice(0, 40))}`;
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

  /**
   * DETERMINÍSTICO — el LLM DETECTA (pasa los substrings de placeholder + nombre
   * y opcionalmente el ancho útil) y el CÓDIGO hace TODO el layout: los campos
   * reciben ancho ÚTIL (nombre ~110pt, número ~55pt) y el PÁRRAFO SE RECONSTRUYE
   * — las palabras que ya no entran en un renglón bajan al siguiente en cascada;
   * si el párrafo necesita un renglón más, se crea y TODO lo de abajo se corre.
   * Un loop determinístico achica los targets hasta que cada grafo quede dentro
   * de la página. Al final se hornea un preview, se re-extrae y cada campo se
   * ubica sobre el HUECO REAL medido — sin pisar texto, por construcción.
   * `id` puede ser cualquier línea del párrafo; `fields` en orden de lectura.
   */
  async placeholdersToFields(id: string, fields: Array<{ placeholder: string; name: string; width?: number }>): Promise<string> {
    const s = this.seg(id);
    if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    if (!fields.length) return `⚠️ placeholders_to_fields necesita al menos un {placeholder,name}.`;
    const page = this.doc.pages.find(p => p.page === s.page);
    if (!page) return `⚠️ página ${s.page} no encontrada.`;

    // x por CARÁCTER de un segmento, desde sus runs reales.
    const charXOf = (seg: SegmentNode): number[] => {
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
    };

    // ── 1. EL PÁRRAFO: líneas consecutivas con el mismo x de anclaje y paso de
    // interlineado regular, conteniendo a `id`.
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
    const lineMaps = lines.map(charXOf);
    const rightEdge = Math.max(...lines.map(l => l.x + l.width));
    const capacity = rightEdge - s.x;
    const spaceW = s.fontSize * 0.28;

    // ── 2. LOCALIZAR cada placeholder (literal, en orden de lectura, cruzando líneas).
    interface Hole { li: number; from: number; to: number; name: string; target: number }
    const holes: Hole[] = [];
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

    // ── 3. TOKENS del párrafo (palabras con su ancho REAL medido + estilo + huecos).
    interface Tok { kind: 'word' | 'hole'; text?: string; w: number; bold?: boolean; italic?: boolean; hole?: Hole }
    const toks: Tok[] = [];
    for (let k = 0; k < lines.length; k++) {
      const text = lines[k].text;
      const cx = lineMaps[k];
      // estilo por carácter (del run que lo contiene) — para conservar negritas.
      const styleAt: Array<{ bold: boolean; italic: boolean }> = new Array(text.length).fill({ bold: false, italic: false });
      let sc = 0;
      for (const r of lines[k].runs) {
        const at = text.indexOf(r.text, sc);
        if (at < 0) continue;
        for (let c = at; c < at + r.text.length; c++) styleAt[c] = { bold: r.font.bold, italic: r.font.italic };
        sc = at + r.text.length;
      }
      const lineHoles = holes.filter(h => h.li === k).sort((a, b) => a.from - b.from);
      let pos = 0;
      const pushWords = (from: number, to: number) => {
        const re = /\S+/g;
        re.lastIndex = 0;
        const slice = text.slice(from, to);
        let m: RegExpExecArray | null;
        while ((m = re.exec(slice))) {
          const a = from + m.index, b = a + m[0].length;
          toks.push({ kind: 'word', text: m[0], w: cx[b] - cx[a], bold: styleAt[a]?.bold ?? false, italic: styleAt[a]?.italic ?? false });
        }
      };
      for (const h of lineHoles) { pushWords(pos, h.from); toks.push({ kind: 'hole', w: 0, hole: h }); pos = h.to; }
      pushWords(pos, text.length);
    }

    // ── 4. REFLOW en LOOP: targets al 100%; si el párrafo no entra (renglones
    // disponibles + los extra que quepan en la página), achicar 10% y reintentar.
    const bottomMost = Math.min(...page.segments.map(x => x.baseline));
    const paraBottom = lines[lines.length - 1].baseline;
    const isLastBlock = Math.abs(bottomMost - paraBottom) < 1;
    const slackBelow = isLastBlock ? Math.max(0, paraBottom - 60) : Math.max(0, paraBottom - 60); // hasta 60pt del borde
    const maxExtraLines = Math.min(3, Math.floor(slackBelow / leading));

    const wrap = (scale: number): Tok[][] => {
      const rows: Tok[][] = [[]];
      let curW = 0;
      for (const t of toks) {
        const w = t.kind === 'hole' ? Math.max(25, t.hole!.target * scale) : t.w;
        const sep = rows[rows.length - 1].length ? spaceW : 0;
        if (curW + sep + w > capacity && rows[rows.length - 1].length) { rows.push([]); curW = 0; }
        rows[rows.length - 1].push(t);
        curW += (rows[rows.length - 1].length > 1 ? spaceW : 0) + w;
      }
      return rows;
    };

    // ── 5. APLICAR + MEDIR EN LOOP (grafo por grafo): cada renglón se
    // reconstruye con RUNS PROPIOS anclados (dx) a posiciones calculadas — nunca
    // heredamos el dx viejo (una palabra bold movida quedaría anclada a su
    // posición anterior y se superpondría). Después se HORNEA y se MIDE: si un
    // renglón real se pasa del borde o dos tramos chocan, se achican los targets
    // y se re-aplica, hasta que TODO quede dentro. Determinístico, sin LLM.
    const BOUNDARY_PAD = 2; // aire extra al cambiar de estilo (deriva de estimación)
    // Correcciones de ancla MEDIDAS: clave "fila:texto_del_run" → pt a correr el
    // dx (se llenan cuando el preview muestra dos runs chocando; la próxima
    // pasada emite el ancla en la posición real).
    const dxFix = new Map<string, number>();
    const rowRuns = (row: Tok[], scale: number, rowIdx: number): StyledRun[] => {
      const runs: StyledRun[] = [];
      let cursor = 0;
      for (const t of row) {
        const isFirst = runs.length === 0;
        const sep = isFirst ? 0 : spaceW;
        const text = t.kind === 'word' ? t.text! : ' '.repeat(Math.max(3, Math.round(Math.max(25, t.hole!.target * scale) / spaceW)));
        const w = t.kind === 'word' ? t.w : Math.max(25, t.hole!.target * scale);
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
    let layout: Tok[][] = [];
    let extraLines = 0;
    let pdf: Uint8Array | null = null;
    let rePage: Awaited<ReturnType<typeof graphFromBytes>>['pages'][number] | undefined;

    for (let iter = 0; iter < 8; iter++) {
      // wrap con el scale actual (respetando el tope de renglones extra)
      layout = wrap(scale);
      while (layout.length > lines.length + maxExtraLines && scale > 0.3) { scale *= 0.9; layout = wrap(scale); }
      extraLines = Math.max(0, layout.length - lines.length);

      // (re)aplicar desde cero: ediciones frescas de las líneas + creates truncados
      this.creates.length = createStart;
      for (const l of lines) this.edits.delete(l.id);
      for (let k = 0; k < lines.length; k++) {
        const runs = k < layout.length ? rowRuns(layout[k], scale, k) : [];
        if (runs.length) this.putSeg(lines[k], { runs });
        else this.putSeg(lines[k], { remove: true });
      }
      for (let e = 0; e < extraLines; e++) {
        const bl = paraBottom - leading * (e + 1);
        const text = layout[lines.length + e].map(t => (t.kind === 'word' ? t.text! : ' '.repeat(Math.max(3, Math.round(Math.max(25, t.hole!.target * scale) / spaceW))))).join(' ');
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

      // MEDIR el resultado real: (a) ningún renglón puede pasarse del borde de
      // texto original (los generadores tipo Word CLIPPEAN ahí — el excedente
      // desaparece visualmente), (b) ningún par de runs puede solaparse — si
      // chocan, registro el corrimiento EXACTO medido y re-aplico.
      ({ pdf } = await this.bake());
      const re = await graphFromBytes(pdf.slice());
      rePage = re.pages.find(p => p.page === s.page);
      let overflow = false;
      let collided = false;
      for (let k = 0; k < layout.length; k++) {
        const bl = k < lines.length ? lines[k].baseline : paraBottom - leading * (k - lines.length + 1);
        const rowSegs = (rePage?.segments ?? [])
          .filter(x => Math.abs(x.baseline - bl) < 6 && x.x >= s.x - 3)
          .sort((a, b) => a.x - b.x);
        // runs reales de la fila, en orden x (los segmentos pueden fusionar tramos)
        const flat = rowSegs.flatMap(seg => seg.runs).sort((a, b) => a.x - b.x);
        const MIN_GAP = spaceW * 0.7; // ~2pt: un espacio de palabra decente entre tramos de distinto estilo
        for (let i = 0; i < flat.length; i++) {
          if (flat[i].x + flat[i].width > rightEdge + 3) overflow = true;
          if (i > 0) {
            const gap = flat[i].x - (flat[i - 1].x + flat[i - 1].width);
            if (gap < MIN_GAP) {
              collided = true; // incluye solapamiento (gap<0) Y espacio demasiado angosto
              const key = `${k}:${flat[i].text.trim().slice(0, 30)}`;
              dxFix.set(key, (dxFix.get(key) ?? 0) + (MIN_GAP - gap));
            }
          }
        }
      }
      if (!overflow && !collided) break;
      if (overflow) scale *= 0.92; // solo el overflow achica los campos; el choque se corrige por ancla
    }

    // ── 6. Con el layout final medido, crear cada campo sobre el GAP real de su
    // renglón — imposible pisar texto (no hay glifos ahí).
    const made: string[] = [];
    let holeCursor = 0;
    const holesPerRow = layout.map(row => row.filter(t => t.kind === 'hole').length);
    for (let k = 0; k < layout.length && holeCursor < holes.length; k++) {
      if (!holesPerRow[k]) continue;
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
      const rowHoles = layout[k].filter(t => t.kind === 'hole').map(t => t.hole!);
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
