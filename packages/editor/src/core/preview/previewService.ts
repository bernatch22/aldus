/**
 * preview/previewService.ts — el preview WYSIWYG horneado EN EL BROWSER (v1:
 * `apps/editor/src/pages/editor/useLocalPreview.ts`).
 *
 * Las ediciones pendientes se aplican EN EL BROWSER (el mismo bake de core,
 * import dinámico) sobre una copia de los bytes base, y se renderiza ESO. El
 * server no se toca hasta Aplicar.
 *
 * El invariante de v1 ("el effect del preview NO puede depender de `graph`ni
 * de funciones que lo capturen — si no, loop de re-render") DESAPARECE
 * ESTRUCTURALMENTE (audit §3.4/§3.5): acá no hay array de deps que envenenar
 * — el servicio se suscribe UNA sola vez, en el constructor, a
 * `ledger.onDidChange`. Un `generation` counter reemplaza el `cancelled` de
 * cada efecto (una carga/rebake en vuelo que ya no es la última se descarta).
 */
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import {
  EventEmitter,
  mergeImageEdit,
  segmentOriginal,
  type AnyEdit,
  type IDisposable,
  type IEvent,
  type ImageEdit,
  type ImageNode,
  type LedgerSnapshot,
  type SegmentEdit,
  type SegmentNode,
  type ShapeEdit,
  type WidgetEdit,
} from '@aldus/core';
import type { AldusApi } from '../api/aldusApi.js';
import type { EditLedgerAdapter, PendingHighlight } from '../ledger/editLedgerAdapter.js';

export interface PreviewServiceOptions {
  id: string;
  api: AldusApi;
  ledger: EditLedgerAdapter;
  onError(message: string): void;
}

export class PreviewService implements IDisposable {
  private baseBytes: Uint8Array | null = null;
  private pdf: PDFDocumentProxy | null = null;
  private docVersion = 0;
  private generation = 0;

  private readonly _onPreviewReady = new EventEmitter<PDFDocumentProxy>();
  /** Fired cada vez que un documento nuevo (bytes re-horneados) terminó de
   *  parsear. `LiftService.onPreviewLanded` se cuelga de este evento. */
  readonly onPreviewReady: IEvent<PDFDocumentProxy> = this._onPreviewReady.event;

  private readonly ledgerSub: IDisposable;

  constructor(private readonly opts: PreviewServiceOptions) {
    // Precalentar el chunk del bake (pdf-lib es pesado): sin esto, la PRIMERA
    // edición paga el import dinámico y el preview extirpador tarda ~1s en
    // llegar — se veía el texto "duplicado" hasta entonces.
    void import('@aldus/core/bake');
    this.consumeRelevantChange(); // sembrar la línea base ANTES de suscribirse
    // FILTRO por kind (v1): el effect de useLocalPreview NO dependía de
    // highlightEdits/linkEdits — mover un highlight/link GUARDADO va por
    // /Annots (lo dibuja el overlay; el preview los oculta siempre igual) y
    // NO amerita re-hornear el content stream. Sin el filtro, cada
    // syncHighlightEdits durante un drag de texto disparaba un bake completo
    // in-browser extra.
    this.ledgerSub = opts.ledger.onDidChange(() => { if (this.consumeRelevantChange()) void this.rebake(); });
    void this.loadBase();
  }

  /** ¿Cambió el subset que el preview HORNEA (texto/imagen/campo/forma +
   *  pendingHighlights)? Compara por identidad de los objetos edit (cada merge
   *  produce un objeto nuevo — mismo criterio que las deps del effect v1) y
   *  actualiza la línea base. */
  private lastRelevant: { snap: LedgerSnapshot; highlights: readonly PendingHighlight[] } | null = null;
  private consumeRelevantChange(): boolean {
    const snap = this.opts.ledger.ledger.snapshot();
    const highlights = this.opts.ledger.pendingHighlights;
    const prev = this.lastRelevant;
    this.lastRelevant = { snap, highlights };
    if (!prev) return true;
    return highlights !== prev.highlights
      || !mapEquals(snap.segments, prev.snap.segments)
      || !mapEquals(snap.images, prev.snap.images)
      || !mapEquals(snap.widgets, prev.snap.widgets)
      || !mapEquals(snap.shapes, prev.snap.shapes);
  }

  get currentPdf(): PDFDocumentProxy | null {
    return this.pdf;
  }

  get baseBytesSnapshot(): Uint8Array | null {
    return this.baseBytes;
  }

  /** Nueva revisión persistida en el server (tras Aplicar, o un revert): re-
   *  descargar los bytes base y re-hornear. */
  async reload(docVersion: number): Promise<void> {
    this.docVersion = docVersion;
    await this.loadBase();
  }

  private async loadBase(): Promise<void> {
    const gen = ++this.generation;
    try {
      const res = await fetch(`${this.opts.api.pdfUrl(this.opts.id)}?v=${this.docVersion}`);
      if (!res.ok) throw new Error(String(res.status));
      const buf = await res.arrayBuffer();
      if (gen !== this.generation) return;
      this.baseBytes = new Uint8Array(buf);
      await this.rebake();
    } catch (e) {
      if (gen === this.generation) this.opts.onError(e instanceof Error ? e.message : 'No se pudo abrir el PDF');
    }
  }

  /** Un highlight atado a un segmento SIGUE al texto: su rect se resuelve
   *  contra la geometría efectiva (con la edición pendiente aplicada, vía
   *  `ledger.effective` — el MISMO cálculo que el bake usaría). Un segmento
   *  con edición pendiente está EXTIRPADO del grafo del preview — `findSeg`
   *  cae al segCache de fantasmas (mismo fallback en todo el editor). */
  resolveHighlights(): PendingHighlight[] {
    return this.opts.ledger.pendingHighlights.map(h => {
      if (!h.segmentId) return h;
      const seg = this.opts.ledger.findSeg(h.segmentId);
      if (!seg) return h;
      const eff = this.opts.ledger.effective(seg);
      return { ...h, x: eff.x, y: eff.y, width: eff.width, height: eff.height };
    });
  }

  /** Hornea los BYTES del preview: base + ediciones pendientes (texto editado
   *  EXTIRPADO — el overlay lo dibuja como fantasma) + imágenes + campos +
   *  formas. `extraRemoval`/`extraImageRemoval` extirpan además un nodo SIN
   *  edición propia (el lift del que está por arrastrarse). */
  async bakePending(extraRemoval?: SegmentNode, extraImageRemoval?: ImageNode): Promise<Uint8Array> {
    if (!this.baseBytes) throw new Error('documento no cargado');
    const { bakeSegmentEdits, hideHighlightAnnotations } = await import('@aldus/core/bake');
    const all = this.opts.ledger.toBakeInput();

    const segEdits = all.filter((e): e is Extract<AnyEdit, { kind: 'segment' }> => e.kind === 'segment');
    const segIds = new Set(segEdits.map(e => e.segmentId));
    // El PREVIEW no escribe el texto NUEVO al content stream (lo dibuja el
    // overlay/fantasma) — solo EXTIRPA el original, para cada edit pendiente.
    const textRemovals: SegmentEdit[] = segEdits.map(e => ({
      segmentId: e.segmentId, page: e.page, text: e.original.text, remove: true, original: e.original,
    }));
    if (extraRemoval && !segIds.has(extraRemoval.id)) {
      textRemovals.push({ segmentId: extraRemoval.id, page: extraRemoval.page, text: extraRemoval.text, remove: true, original: segmentOriginal(extraRemoval) });
    }

    let imgEditList: ImageEdit[] = all.filter((e): e is Extract<AnyEdit, { kind: 'image' }> => e.kind === 'image')
      .map(({ kind: _kind, ...rest }) => rest);
    // LIFT de imagen: hornear la página SIN esa imagen (removida), para que al
    // arrastrarla el canvas muestre lo que hay detrás (no un velo blanco).
    if (extraImageRemoval) {
      const rm = mergeImageEdit(extraImageRemoval, null, { remove: true });
      if (rm) imgEditList = [...imgEditList.filter(e => e.imageId !== extraImageRemoval.id), rm];
    }

    const widgetEditList: WidgetEdit[] = all.filter((e): e is Extract<AnyEdit, { kind: 'widget' }> => e.kind === 'widget')
      .map(({ kind: _kind, ...rest }) => rest);
    const shapeEditList: ShapeEdit[] = all.filter((e): e is Extract<AnyEdit, { kind: 'shape' }> => e.kind === 'shape')
      .map(({ kind: _kind, ...rest }) => rest);

    const r = await bakeSegmentEdits(this.baseBytes.slice(), textRemovals, imgEditList, widgetEditList, [], [], shapeEditList);
    // Color EXACTO del content stream → sobreescribe el muestreado en el cache
    // de fantasmas (el fantasma se ve idéntico al original, sin aproximación).
    this.opts.ledger.applyGhostColors(r.colors);
    // Los HIGHLIGHTS pendientes NO se hornean en el preview: capa overlay
    // anclada al segmento. Los GUARDADOS (/Highlight en /Annots) se OCULTAN
    // del canvas (flag Hidden, solo en la copia de display) — si pdf.js
    // también los pintara, se duplicarían con el HighlightBox del overlay.
    return hideHighlightAnnotations(r.pdf);
  }

  private async rebake(): Promise<void> {
    if (!this.baseBytes) return;
    const gen = ++this.generation;
    try {
      const bytes = this.opts.ledger.isEmpty
        ? await (await import('@aldus/core/bake')).hideHighlightAnnotations(this.baseBytes)
        : await this.bakePending();
      if (gen !== this.generation) return;
      // pdf.js TRANSFIERE el buffer al worker → siempre una copia.
      // fontExtraProperties: FontRegistryService necesita font.data para
      // re-registrar las embebidas bajo nombres estables.
      const doc = await getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
      if (gen !== this.generation) { void doc.destroy(); return; }
      const prev = this.pdf;
      this.pdf = doc;
      void prev?.destroy();
      this._onPreviewReady.fire(doc);
    } catch (e) {
      if (gen === this.generation) this.opts.onError(e instanceof Error ? e.message : 'No se pudo generar el preview');
    }
  }

  dispose(): void {
    this.ledgerSub.dispose();
    this._onPreviewReady.dispose();
    void this.pdf?.destroy();
    this.pdf = null;
  }
}

function mapEquals<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
