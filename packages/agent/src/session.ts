/**
 * session.ts — una sesión de edición sobre un documento. Acumula SegmentEdit /
 * ImageEdit (con las MISMAS funciones de merge que el editor UI, una sola fuente
 * de verdad) a medida que el agente llama sus tools, y las hornea con el bake de
 * @aldus/core al guardar. Las tools son mutaciones; la lectura ya está en el
 * prompt.
 */
import { writeFile } from 'node:fs/promises';
import {
  mergeSegmentEdit, mergeImageEdit, applyTextDiff, originalStyledRuns,
  type SegmentEdit, type ImageEdit, type SegmentNode, type ImageNode,
} from '@aldus/core';
import { bakeSegmentEdits } from '@aldus/core/bake';
import type { DocGraph } from './graph.js';

export class EditSession {
  private edits = new Map<string, SegmentEdit>();
  private imageEdits = new Map<string, ImageEdit>();

  constructor(private doc: DocGraph) {}

  private seg(id: string): SegmentNode | undefined {
    for (const p of this.doc.pages) { const s = p.segments.find(x => x.id === id); if (s) return s; }
    return undefined;
  }
  private img(id: string): ImageNode | undefined {
    for (const p of this.doc.pages) { const i = p.images.find(x => x.id === id); if (i) return i; }
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

  // ── mutaciones (devuelven un string de confirmación para el agente) ──
  editText(id: string, text: string): string {
    const s = this.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    // Re-mapea los runs estilados del original al texto nuevo (conserva estilo).
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

  /** Precarga ediciones ya existentes (p. ej. las pendientes del editor UI), para
   *  que el agente CONTINÚE desde el estado actual en vez de empezar de cero. */
  seed(edits: SegmentEdit[] = [], imageEdits: ImageEdit[] = []): void {
    for (const e of edits) this.edits.set(e.segmentId, e);
    for (const e of imageEdits) this.imageEdits.set(e.imageId, e);
  }

  /** Ediciones acumuladas (para devolverlas al editor y que las aplique a su
   *  estado — mismo pipeline preview/guardar que una edición manual). */
  getEdits(): { edits: SegmentEdit[]; imageEdits: ImageEdit[] } {
    return { edits: [...this.edits.values()], imageEdits: [...this.imageEdits.values()] };
  }

  /** Cantidad de ediciones pendientes. */
  get count(): number { return this.edits.size + this.imageEdits.size; }

  /** Resumen legible de las ediciones pendientes. */
  summary(): string {
    const parts: string[] = [];
    for (const e of this.edits.values()) parts.push(e.remove ? `${e.segmentId}: eliminar` : `${e.segmentId}: editar`);
    for (const e of this.imageEdits.values()) parts.push(e.remove ? `${e.imageId}: eliminar` : `${e.imageId}: mover/escalar`);
    return parts.join(' · ') || '(sin ediciones)';
  }

  /** Hornea las ediciones sobre el PDF original y devuelve los BYTES nuevos. */
  async bake(): Promise<{ pdf: Uint8Array; applied: string[]; warnings: string[] }> {
    // AL HORNEAR: las imágenes movidas/escaladas van AL FRENTE (como el editor),
    // si no podrían quedar tapadas por contenido posterior. El bake reubica EN SU
    // LUGAR, así que sin esto "se mueven y desaparecen".
    const imgs = [...this.imageEdits.values()].map(e =>
      !e.remove && !e.zOrder && (e.x != null || e.y != null || e.width != null || e.height != null)
        ? { ...e, zOrder: 'front' as const }
        : e);
    return bakeSegmentEdits(this.doc.bytes.slice(), [...this.edits.values()], imgs, []);
  }

  /** Hornea y escribe el PDF a `outPath`. */
  async save(outPath: string): Promise<{ applied: string[]; warnings: string[] }> {
    const { pdf, applied, warnings } = await this.bake();
    await writeFile(outPath, pdf);
    return { applied, warnings };
  }
}
