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
} from '@aldus/core';
import {
  bakeSegmentEdits, addHighlight, addLink, addText, addWatermark, addHeaderFooter, addFormField, insertImage, setFieldValues,
} from '@aldus/core/bake';
import type { DocGraph } from './graph.js';

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

  /** COMPLETA un campo de formulario por su NOMBRE (no id). Valor: texto para
   *  text/select/radio, true/false para checkbox. Determinístico (setFieldValues). */
  fillField(fieldName: string, value: string | boolean | string[]): string {
    const exists = this.doc.pages.some(p => p.widgets.some(w => w.fieldName === fieldName));
    if (!exists) return `⚠️ No existe un campo llamado "${fieldName}".`;
    this.fills.set(fieldName, value);
    return `✓ Campo "${fieldName}" ← ${JSON.stringify(value)}`;
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
