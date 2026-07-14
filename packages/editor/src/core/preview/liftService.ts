/**
 * preview/liftService.ts — LIFT (v1: `apps/editor/src/pages/editor/useLift.ts`
 * + la mitad de `PdfCanvas.tsx`, el double-buffer/lift-blit). Patrón del
 * annotation editor de pdf.js: el canvas NO se toca durante el gesto.
 *
 * Al SELECCIONAR un texto/imagen se hornea en background la página SIN ese
 * nodo; al arrancar el drag, el presenter del canvas la blitea (un
 * drawImage, instantáneo) y durante el arrastre no corre ningún pipeline —
 * solo el transform CSS del box.
 *
 * "El código más sutil del editor" (dixit v1) — el ALGORITMO viaja VERBATIM
 * (audit §4 riesgo 2): cada guard parcha una regresión real (ghost vacío,
 * imagen esfumada, lift competidor tras drop, duplicado sobre imágenes). Lo
 * que cambia es el TRANSPORTE: una máquina de estados EXPLÍCITA
 * (`idle → prepared → dragging → dropPending`, vuelta a `idle` en el drop) en
 * vez de `dropPendingRef`/`liftHoldRef`/`liftShownRef` + deps de effect.
 */
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import { EventEmitter, type IDisposable, type IEvent } from '@aldus/core';
import type { EditLedgerAdapter } from '../ledger/editLedgerAdapter.js';
import type { PreviewService } from './previewService.js';

export type LiftPhase = 'idle' | 'prepared' | 'dragging' | 'dropPending';

export interface LiftEntry {
  segId: string;
  doc: PDFDocumentProxy;
}

export interface LiftServiceOptions {
  preview: PreviewService;
  ledger: EditLedgerAdapter;
}

export class LiftService implements IDisposable {
  private phase: LiftPhase = 'idle';
  private lift: LiftEntry | null = null;
  private selectedId: string | null = null;
  private editingActive = false;
  private draggingId: string | null = null;
  private generation = 0;

  private readonly _onLiftChanged = new EventEmitter<LiftEntry | null>();
  /** Fired con el lift vigente (o null) cada vez que cambia — el presenter
   *  del canvas lo blitea cuando hay uno listo. */
  readonly onLiftChanged: IEvent<LiftEntry | null> = this._onLiftChanged.event;

  private readonly ledgerSub: IDisposable;

  constructor(private readonly opts: LiftServiceOptions) {
    // Ecos del cambio de edits/imageEdits/pendingHighlights: re-evaluar si el
    // nodo seleccionado sigue mereciendo un lift (los mismos guards de v1,
    // acá reactivos a UN evento en vez de a un array de deps).
    this.ledgerSub = opts.ledger.onDidChange(() => { void this.reconcile(); });
    // OJO timing (v1): el lift NO se descarta cuando el PDF re-horneado
    // PARSEA (onPreviewReady) sino cuando su GRAFO aterriza — el canvas ya
    // blitteó el render nuevo para entonces. Descartarlo antes restauraba el
    // back-buffer VIEJO un frame (los glifos originales "flasheaban"). El
    // composition root llama `previewLanded()` al recibir el grafo.
  }

  get current(): LiftEntry | null {
    return this.lift;
  }

  get isDragging(): boolean {
    return this.draggingId !== null;
  }

  get draggingSegId(): string | null {
    return this.draggingId;
  }

  /**
   * PREPARAR EL LIFT al seleccionar un texto/imagen (todavía presente en el
   * canvas): hornear la página sin él AHORA, en el tiempo muerto entre el
   * click y el posible arrastre. Con editor de texto abierto no hay drags —
   * lift innecesario (`editingActive`).
   */
  select(segId: string | null, editingActive: boolean): void {
    this.selectedId = segId;
    this.editingActive = editingActive;
    void this.reconcile();
  }

  private async reconcile(): Promise<void> {
    if (this.editingActive) return;
    const graph = this.opts.ledger.currentGraph;
    const sid = this.selectedId;
    const baseBytes = this.opts.preview.baseBytesSnapshot;
    const all = this.opts.ledger.toBakeInput();
    const hasSegEdit = (id: string) => all.some(e => e.kind === 'segment' && e.segmentId === id);
    const hasImgEdit = (id: string) => all.some(e => e.kind === 'image' && e.imageId === id);

    const seg = sid && !hasSegEdit(sid) ? graph?.segments.find(s => s.id === sid) : null;
    // El lift también aplica a IMÁGENES: hornear la página sin la imagen
    // seleccionada, para que al arrastrarla se vea lo de atrás (no un velo).
    // CLAVE: solo si la imagen NO tiene ya una edición. Sin este guard, al
    // soltar (imageEdits cambia) reconcile() re-corría y horneaba un lift
    // COMPETIDOR (página sin la imagen) que se blitea ENCIMA del preview ya
    // aterrizado → la imagen se esfumaba.
    const imgNode = sid && !seg && !hasImgEdit(sid) ? graph?.images.find(im => im.id === sid) : null;

    if ((!seg && !imgNode) || !baseBytes) {
      // Nada que preparar. Ojo: tras un drop consumado el lift NO se
      // descarta acá (el canvas muestra sus píxeles) — lo descarta
      // `onPreviewLanded` cuando el preview re-horneado aterriza.
      if (this.phase !== 'dropPending') this.setLift(null, 'idle');
      return;
    }

    const gen = ++this.generation;
    try {
      const bytes = seg ? await this.opts.preview.bakePending(seg) : await this.opts.preview.bakePending(undefined, imgNode!);
      if (gen !== this.generation) return;
      const doc = await getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
      if (gen !== this.generation) { void doc.destroy(); return; }
      this.setLift({ segId: seg ? seg.id : imgNode!.id, doc }, 'prepared');
    } catch {
      // Sin lift: el drag cae al camino lento (blit al aterrizar).
    }
  }

  /**
   * Arranque/fin del ARRASTRE. Al arrancar, el presenter blitea el lift (si
   * está listo). Al soltar: si el drop COMMITEÓ una edición, el lift queda en
   * pantalla (fase `dropPending`) hasta que el preview re-horneado (píxeles
   * idénticos) aterrice; si fue un no-op (soltó donde estaba), se cancela y
   * el canvas se restaura.
   */
  onDragging(segId: string, active: boolean, committed = false): void {
    if (active) {
      this.draggingId = segId;
      this.phase = 'dragging';
      return;
    }
    this.draggingId = null;
    if (committed) {
      this.phase = 'dropPending';
    } else if (this.lift?.segId === segId) {
      this.setLift(null, 'idle');
    }
  }

  /** El grafo nuevo llegó = el preview aterrizó: si había un drop en vuelo,
   *  el documento visible ya es el re-horneado — descartar el lift. */
  previewLanded(): void {
    if (this.phase === 'dropPending') this.setLift(null, 'idle');
  }

  private setLift(entry: LiftEntry | null, phase: LiftPhase): void {
    const prev = this.lift;
    this.lift = entry;
    this.phase = phase;
    if (prev && prev !== entry) void prev.doc.destroy();
    this._onLiftChanged.fire(entry);
  }

  dispose(): void {
    this.ledgerSub.dispose();
    this._onLiftChanged.dispose();
    void this.lift?.doc.destroy();
    this.lift = null;
  }
}
