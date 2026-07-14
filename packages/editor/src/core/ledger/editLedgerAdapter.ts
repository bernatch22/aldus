/**
 * ledger/editLedgerAdapter.ts — adaptador fino sobre el `EditLedger` de core
 * (v1: `apps/editor/src/pages/editor/usePendingEdits.ts`, 233 LOC de
 * andamiaje React sobre 7 `useState` + 7 refs espejo).
 *
 * El ESTADO (7 colecciones de edits + Memento) YA vive en `@aldus/core`
 * (`EditLedger`/`LedgerSnapshot` — F4). Este adaptador NO reimplementa el
 * merge, el snapshot ni el restore — solo agrega lo que el ledger de core no modela
 * porque es concepto de EDITOR, no de dominio del bake:
 *
 *  - `pendingHighlights`: resaltados NUEVOS (aún no son un HighlightNode del
 *    grafo — no hay nodo que "revertir", así que no encajan en
 *    `IEditLedger.patchRect`). Viven acá como su propio array.
 *  - `findSeg`: grafo actual → `segCache` (el fantasma de un segmento cuya
 *    edición lo extirpó del preview).
 *  - `syncHighlightEdits`: el GLUE geométrico (un highlight guardado sigue al
 *    texto que resalta) — documentado como API que NO empuja historial (un
 *    solo Ctrl+Z revierte texto + highlight juntos, ver JSDoc abajo).
 *  - `applyAgentEdits`: el agente reemplaza el set COMPLETO de edits de texto
 *    e imagen en una sola entrada de historial.
 *  - El **Memento**: v1 juntaba 7 refs a mano en un `Snap`; acá el snapshot
 *    del ledger de core YA es un puntero al estado inmutable (`O(1)`, sin la
 *    clase de bug "me olvidé de sumar la colección nueva" — audit §3.2). Este
 *    adaptador solo le agrega `pendingHighlights` al snapshot compuesto.
 *  - El **historial** (undo/redo + comandos de servidor) es la MISMA máquina
 *    de `useHistory` (v1), portada a clase pura sin React (`EditHistory`).
 *
 * Sin React: `onDidChange` es un EventEmitter propio de core; la capa React
 * (checkpoint 2) se suscribe con `useSyncExternalStore`.
 */
import {
  EventEmitter,
  EditLedger,
  type EffectiveGeometry,
  type EffectiveRect,
  type IDisposable,
  type IEditLedger,
  type IEvent,
  type ImageEdit,
  type LedgerSnapshot,
  type PageGraph,
  type RectNode,
  type RectPatch,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
} from '@aldus/core';

/** Un resaltado PENDIENTE (aún no aplicado al PDF) — capa overlay anclada a un
 *  segmento hasta que el server lo hornea como anotación real al Aplicar. */
export interface PendingHighlight {
  page: number;
  segmentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

/** Parche de un highlight GUARDADO (o su revert), keyed por id — el
 *  vocabulario de {@link EditLedgerAdapter.syncHighlightEdits}. */
export type HighlightSyncAction =
  | ({ highlightId: string } & RectPatch)
  | { highlightId: string; revert: true };

export interface HistoryCommand {
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
}

/** Snapshot COMPUESTO (Memento): el del ledger de core + `pendingHighlights`
 *  (lo único que este adaptador agrega al estado). */
interface AdapterSnapshot {
  ledger: LedgerSnapshot;
  pendingHighlights: readonly PendingHighlight[];
}

type Entry =
  | { kind: 'snap'; snap: AdapterSnapshot }
  | ({ kind: 'command' } & HistoryCommand);

/**
 * Historial unificado — MEMENTO + COMMAND, portado 1:1 de `useHistory` (v1)
 * sin el `useState`/`setTick` de React (el `onDidChange` del adaptador ya
 * notifica cualquier cambio; los botones undo/redo se suscriben a eso).
 */
class EditHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];

  constructor(
    private readonly snapNow: () => AdapterSnapshot,
    private readonly restore: (s: AdapterSnapshot) => void,
    private readonly onChange: () => void,
    private readonly limit = 100,
  ) {}

  private push(entry: Entry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.onChange();
  }

  pushHistory(): void {
    this.push({ kind: 'snap', snap: this.snapNow() });
  }

  pushCommand(command: HistoryCommand): void {
    this.push({ kind: 'command', ...command });
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    if (entry.kind === 'snap') {
      this.redoStack.push({ kind: 'snap', snap: this.snapNow() });
      this.restore(entry.snap);
    } else {
      this.redoStack.push(entry);
      void entry.undo();
    }
    this.onChange();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    if (entry.kind === 'snap') {
      this.undoStack.push({ kind: 'snap', snap: this.snapNow() });
      this.restore(entry.snap);
    } else {
      this.undoStack.push(entry);
      void entry.redo();
    }
    this.onChange();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}

export class EditLedgerAdapter implements IDisposable {
  readonly ledger: IEditLedger = new EditLedger();

  private pendingHighlightsList: PendingHighlight[] = [];
  private readonly segCache = new Map<string, SegmentNode>();
  private graph: PageGraph | null = null;

  private readonly _onDidChange = new EventEmitter<void>();
  readonly onDidChange: IEvent<void> = this._onDidChange.event;

  readonly history = new EditHistory(
    () => this.snapshot(),
    s => this.restoreSnapshot(s),
    () => this._onDidChange.fire(),
  );

  private readonly ledgerSub = this.ledger.onDidChange(() => this._onDidChange.fire());

  /** El grafo VIGENTE de la página (para `findSeg`/glue). Lo llama el
   *  composition root cada vez que el preview re-extrae. */
  setGraph(graph: PageGraph | null): void {
    this.graph = graph;
  }

  /** El grafo vigente (LiftService lo lee para saber si el nodo seleccionado
   *  sigue "vivo" en el canvas o ya está extirpado por una edición). */
  get currentGraph(): PageGraph | null {
    return this.graph;
  }

  get pendingHighlights(): readonly PendingHighlight[] {
    return this.pendingHighlightsList;
  }

  /** Pass-through de lectura del ledger de core — evita el "ledger.ledger"
   *  desde afuera (PreviewService, boxes) para lo que se consulta seguido. */
  toBakeInput() {
    return this.ledger.toBakeInput();
  }

  effective(node: SegmentNode): EffectiveGeometry;
  effective(node: RectNode): EffectiveRect;
  effective(node: SegmentNode | RectNode): EffectiveGeometry | EffectiveRect {
    return node.kind === 'segment' ? this.ledger.effective(node) : this.ledger.effective(node);
  }

  /** ¿Hay algo pendiente (ledger de core + resaltados nuevos)? */
  get isEmpty(): boolean {
    return this.toBakeInput().length === 0 && this.pendingHighlightsList.length === 0;
  }

  /**
   * Pisa el color de los runs de un segmento FANTASMA (segCache) con el color
   * EXACTO que el bake leyó del content stream — SOLO sobre la copia dueña
   * del adaptador, nunca sobre el grafo vivo que entrega pdf.js. Desviación
   * documentada (audit §4 riesgo 4, "parcial"): `sampleColor` (muestreo por
   * píxeles, best-effort) es puro y no muta nada; ESTA mutación es la única
   * que sobrevive del patrón v1, acotada al cache de fantasmas que el propio
   * adaptador posee (nadie más escribe ahí) — así el fantasma se ve IDÉNTICO
   * al original en vez de con el color aproximado del muestreo.
   */
  applyGhostColors(colors: Record<string, string>): void {
    for (const [segId, hex] of Object.entries(colors)) {
      const seg = this.segCache.get(segId);
      if (seg) seg.runs.forEach(run => { run.color = hex; });
    }
  }

  // ── mutación con historial (equivalente a onEdit/onImageEdit/... de v1) ──

  patchSegment(seg: SegmentNode, patch: SegmentPatch): SegmentEdit | null {
    this.history.pushHistory();
    this.cacheSegment(seg.id);
    return this.ledger.patchSegment(seg, patch);
  }

  revertSegment(segmentId: string): void {
    this.history.pushHistory();
    const seg = this.findSeg(segmentId);
    if (seg) this.ledger.revert(seg);
  }

  patchRect(node: RectNode, patch: RectPatch): void {
    this.history.pushHistory();
    this.ledger.patchRect(node, patch);
  }

  revertRect(node: RectNode): void {
    this.history.pushHistory();
    this.ledger.revert(node);
  }

  /**
   * GLUE: un resaltado guardado sigue al texto que resalta. Cuando un
   * segmento se mueve, su highlight se corre por el mismo delta — SIN
   * `pushHistory`: el snapshot del propio movimiento del segmento ya
   * capturó los highlightEdits previos, así un solo Ctrl+Z revierte texto +
   * resaltado juntos. Documentado explícitamente como el ÚNICO método del
   * adaptador que muta sin historial propio (audit §3.4 — "pasa de
   * convención entre 3 archivos a método con JSDoc en el contrato").
   */
  syncHighlightEdits(actions: HighlightSyncAction[], nodes: ReadonlyMap<string, RectNode>): void {
    if (!actions.length) return;
    for (const a of actions) {
      const node = nodes.get(a.highlightId);
      if (!node) continue;
      if ('revert' in a) this.ledger.revert(node);
      else {
        const { highlightId: _highlightId, ...patch } = a;
        this.ledger.patchRect(node, patch);
      }
    }
  }

  /** El AGENTE devuelve el SET COMPLETO de ediciones (texto + imagen):
   *  reemplazan el estado (una sola vez, deshacible con Ctrl+Z). Cachea el
   *  nodo original de cada segmento editado para el fantasma, igual que una
   *  edición manual. */
  applyAgentEdits(segEdits: SegmentEdit[], imgEdits: ImageEdit[]): void {
    this.history.pushHistory();
    for (const e of segEdits) this.cacheSegment(e.segmentId);
    this.ledger.clear();
    for (const e of segEdits) this.ledger.patchSegment(this.requireSeg(e.segmentId), toSegmentPatch(e));
    for (const e of imgEdits) {
      const img = this.graph?.images.find(im => im.id === e.imageId);
      if (img) this.ledger.patchRect(img, toRectPatch(e));
    }
  }

  /** HIGHLIGHT pendiente (preview local; se escribe con Aplicar). Varios de
   *  una (grupo) = UN solo snapshot de historial → un Ctrl+Z los deshace
   *  juntos. */
  addHighlights(hs: PendingHighlight[]): void {
    if (!hs.length) return;
    this.history.pushHistory();
    this.pendingHighlightsList = [...this.pendingHighlightsList, ...hs];
    this._onDidChange.fire();
  }

  /** Quita los resaltados PENDIENTES anclados a un segmento (toggle "quitar"
   *  antes de Aplicar → no apila). No-op si no hay ninguno. */
  removePendingHighlightsFor(segmentId: string): void {
    if (!this.pendingHighlightsList.some(h => h.segmentId === segmentId)) return;
    this.history.pushHistory();
    this.pendingHighlightsList = this.pendingHighlightsList.filter(h => h.segmentId !== segmentId);
    this._onDidChange.fire();
  }

  /** Buscar un segmento por id: primero el grafo vigente; si fue editado
   *  (extirpado del preview), el cache de fantasmas. */
  findSeg(segmentId: string): SegmentNode | null {
    return this.graph?.segments.find(s => s.id === segmentId) ?? this.segCache.get(segmentId) ?? null;
  }

  private requireSeg(segmentId: string): SegmentNode {
    const seg = this.findSeg(segmentId);
    if (!seg) throw new Error(`applyAgentEdits: segmento ${segmentId} no está en el grafo ni en el cache`);
    return seg;
  }

  private cacheSegment(segmentId: string): void {
    if (this.segCache.has(segmentId)) return;
    const seg = this.graph?.segments.find(s => s.id === segmentId);
    if (seg) this.segCache.set(segmentId, seg);
  }

  /** Tras un Aplicar exitoso: todo lo pendiente quedó horneado en el server. */
  clearAll(): void {
    this.ledger.clear();
    this.pendingHighlightsList = [];
    this.segCache.clear();
    this.history.clear();
  }

  private snapshot(): AdapterSnapshot {
    return { ledger: this.ledger.snapshot(), pendingHighlights: this.pendingHighlightsList };
  }

  private restoreSnapshot(s: AdapterSnapshot): void {
    this.ledger.restore(s.ledger);
    this.pendingHighlightsList = [...s.pendingHighlights];
  }

  dispose(): void {
    this.ledgerSub.dispose();
    this._onDidChange.dispose();
    this.ledger.dispose();
  }
}

/** SegmentEdit completo (como los que trae el agente) → el patch equivalente
 *  para `ledger.patchSegment` (todos los campos son overrides explícitos). */
function toSegmentPatch(e: SegmentEdit): SegmentPatch {
  return {
    text: e.text,
    runs: e.runs ?? null,
    fontSize: e.fontSize ?? null,
    font: e.font ?? null,
    x: e.x ?? null,
    baseline: e.baseline ?? null,
    remove: e.remove ?? null,
    charSpacing: e.charSpacing ?? null,
    hScale: e.hScale ?? null,
    color: e.color ?? null,
    align: e.align ?? null,
  };
}

function toRectPatch(e: ImageEdit): RectPatch {
  return {
    x: e.x ?? null,
    y: e.y ?? null,
    width: e.width ?? null,
    height: e.height ?? null,
    remove: e.remove ?? null,
    zOrder: e.zOrder ?? null,
  } as RectPatch;
}
