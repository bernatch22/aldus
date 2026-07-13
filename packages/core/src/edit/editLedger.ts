/**
 * edit/editLedger.ts — el LEDGER de ediciones pendientes (Layer 2, service).
 *
 * Mata la duplicación #1 del plan: el patrón "Map<id, XEdit> + merge/revert +
 * snapshot para undo + promote al bake" vivía DOS veces (usePendingEdits del
 * editor + EditSession del agente). Acá es UN service browser-safe, cero React,
 * con `onDidChange` (EventEmitter) + IDisposable.
 *
 * - Los merge* son PRIVADOS del ledger (los usa internamente); siguen exportados
 *   como funciones libres desde `mergeEdits.ts` para la biblia y los tests F1a.
 * - `snapshot()`/`restore()` = Memento (useHistory / el reflow los consumen).
 * - `toBakeInput()` arma el `AnyEdit[]` para `bake()`, aplicando
 *   `promoteMovedImages` ADENTRO (único sitio de esa regla).
 */

import type { IDisposable } from '../common/disposable.js';
import { EventEmitter, type IEvent } from '../common/events.js';
import type {
  AnyEdit,
  HighlightEdit,
  ImageEdit,
  LinkEdit,
  SegmentEdit,
  ShapeEdit,
  WidgetEdit,
} from '../model/edits.js';
import type {
  HighlightNode,
  ImageNode,
  LinkNode,
  PdfNode,
  SegmentNode,
  ShapeNode,
  WidgetNode,
} from '../model/nodes.js';
import {
  effectiveGeometry,
  effectiveRect,
  mergeHighlightEdit,
  mergeImageEdit,
  mergeLinkEdit,
  mergeSegmentEdit,
  mergeShapeEdit,
  mergeWidgetEdit,
  promoteMovedImages,
  type EffectiveGeometry,
  type EffectiveRect,
  type HighlightPatch,
  type ImagePatch,
  type LinkPatch,
  type SegmentPatch,
  type ShapePatch,
  type WidgetPatch,
} from './mergeEdits.js';

/** Nodo rect-like que el ledger sabe editar (todo menos segmento). */
export type RectNode = ImageNode | ShapeNode | WidgetNode | HighlightNode | LinkNode;
/** Parche de un nodo rect-like (unión de los 5 patch; el color es solo de highlight). */
export type RectPatch = ImagePatch & ShapePatch & WidgetPatch & HighlightPatch & LinkPatch;

/** Memento inmutable del estado del ledger (Command history / abort+restore). */
export interface LedgerSnapshot {
  readonly segments: ReadonlyMap<string, SegmentEdit>;
  readonly images: ReadonlyMap<string, ImageEdit>;
  readonly shapes: ReadonlyMap<string, ShapeEdit>;
  readonly widgets: ReadonlyMap<string, WidgetEdit>;
  readonly highlights: ReadonlyMap<string, HighlightEdit>;
  readonly links: ReadonlyMap<string, LinkEdit>;
}

export const IEditLedger = Symbol('IEditLedger');
export interface IEditLedger extends IDisposable {
  readonly onDidChange: IEvent<void>;
  patchSegment(seg: SegmentNode, patch: SegmentPatch): SegmentEdit | null;
  patchRect(node: RectNode, patch: RectPatch): void;
  revert(node: PdfNode): void;
  effective(node: SegmentNode): EffectiveGeometry;
  effective(node: RectNode): EffectiveRect;
  snapshot(): LedgerSnapshot;
  restore(s: LedgerSnapshot): void;
  toBakeInput(): AnyEdit[];
  clear(): void;
}

export class EditLedger implements IEditLedger {
  private segments = new Map<string, SegmentEdit>();
  private images = new Map<string, ImageEdit>();
  private shapes = new Map<string, ShapeEdit>();
  private widgets = new Map<string, WidgetEdit>();
  private highlights = new Map<string, HighlightEdit>();
  private links = new Map<string, LinkEdit>();

  private readonly _onDidChange = new EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  // ── mutación ──
  patchSegment(seg: SegmentNode, patch: SegmentPatch): SegmentEdit | null {
    const m = mergeSegmentEdit(seg, this.segments.get(seg.id) ?? null, patch);
    if (m) this.segments.set(seg.id, m);
    else this.segments.delete(seg.id);
    this._onDidChange.fire();
    return m;
  }

  patchRect(node: RectNode, patch: RectPatch): void {
    switch (node.kind) {
      case 'image': this.set(this.images, node.id, mergeImageEdit(node, this.images.get(node.id) ?? null, patch)); break;
      case 'shape': this.set(this.shapes, node.id, mergeShapeEdit(node, this.shapes.get(node.id) ?? null, patch)); break;
      case 'widget': this.set(this.widgets, node.id, mergeWidgetEdit(node, this.widgets.get(node.id) ?? null, patch)); break;
      case 'highlight': this.set(this.highlights, node.id, mergeHighlightEdit(node, this.highlights.get(node.id) ?? null, patch)); break;
      case 'link': this.set(this.links, node.id, mergeLinkEdit(node, this.links.get(node.id) ?? null, patch)); break;
    }
    this._onDidChange.fire();
  }

  private set<E>(map: Map<string, E>, id: string, edit: E | null): void {
    if (edit) map.set(id, edit);
    else map.delete(id);
  }

  revert(node: PdfNode): void {
    const map = this.mapFor(node.kind);
    if (map?.delete(node.id)) this._onDidChange.fire();
  }

  private mapFor(kind: PdfNode['kind']): Map<string, unknown> | undefined {
    switch (kind) {
      case 'segment': return this.segments as Map<string, unknown>;
      case 'image': return this.images as Map<string, unknown>;
      case 'shape': return this.shapes as Map<string, unknown>;
      case 'widget': return this.widgets as Map<string, unknown>;
      case 'highlight': return this.highlights as Map<string, unknown>;
      case 'link': return this.links as Map<string, unknown>;
      default: return undefined;
    }
  }

  // ── lectura ──
  effective(node: SegmentNode): EffectiveGeometry;
  effective(node: RectNode): EffectiveRect;
  effective(node: SegmentNode | RectNode): EffectiveGeometry | EffectiveRect {
    if (node.kind === 'segment') return effectiveGeometry(node, this.segments.get(node.id) ?? null);
    const map = this.mapFor(node.kind) as Map<string, HighlightEdit> | undefined;
    return effectiveRect(node, map?.get(node.id) ?? null);
  }

  /** La edición pendiente de un segmento (para el motor de layout: effBaseline,
   *  isRestyled). `undefined` = sin edición. */
  segmentEdit(id: string): SegmentEdit | undefined {
    return this.segments.get(id);
  }

  // ── Memento ──
  snapshot(): LedgerSnapshot {
    return {
      segments: new Map(this.segments),
      images: new Map(this.images),
      shapes: new Map(this.shapes),
      widgets: new Map(this.widgets),
      highlights: new Map(this.highlights),
      links: new Map(this.links),
    };
  }

  restore(s: LedgerSnapshot): void {
    this.segments = new Map(s.segments);
    this.images = new Map(s.images);
    this.shapes = new Map(s.shapes);
    this.widgets = new Map(s.widgets);
    this.highlights = new Map(s.highlights);
    this.links = new Map(s.links);
    this._onDidChange.fire();
  }

  /** El `AnyEdit[]` para `bake()`. `promoteMovedImages` se aplica ACÁ (único
   *  sitio de la regla "imagen movida sin zOrder → front"). El orden de bind del
   *  bake (widget → highlight → link → image → shape → segment) lo decide el
   *  coordinador; acá solo agrupamos por kind. */
  toBakeInput(): AnyEdit[] {
    const images = promoteMovedImages([...this.images.values()]);
    return [
      ...[...this.segments.values()].map(e => ({ kind: 'segment', ...e }) as AnyEdit),
      ...images.map(e => ({ kind: 'image', ...e }) as AnyEdit),
      ...[...this.widgets.values()].map(e => ({ kind: 'widget', ...e }) as AnyEdit),
      ...[...this.highlights.values()].map(e => ({ kind: 'highlight', ...e }) as AnyEdit),
      ...[...this.links.values()].map(e => ({ kind: 'link', ...e }) as AnyEdit),
      ...[...this.shapes.values()].map(e => ({ kind: 'shape', ...e }) as AnyEdit),
    ];
  }

  /** ¿Hay alguna edición pendiente? */
  get isEmpty(): boolean {
    return this.segments.size === 0 && this.images.size === 0 && this.shapes.size === 0
      && this.widgets.size === 0 && this.highlights.size === 0 && this.links.size === 0;
  }

  /** Cantidad total de ediciones pendientes. */
  get size(): number {
    return this.segments.size + this.images.size + this.shapes.size
      + this.widgets.size + this.highlights.size + this.links.size;
  }

  clear(): void {
    this.segments.clear();
    this.images.clear();
    this.shapes.clear();
    this.widgets.clear();
    this.highlights.clear();
    this.links.clear();
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
