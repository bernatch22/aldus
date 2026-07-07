import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import type { ImageEdit, ImageNode, PageGraph, SegmentEdit, SegmentNode } from '@aldus/core';
import type { PendingHighlight } from './usePendingEdits';

/**
 * LIFT (patrón del annotation editor de pdf.js: el canvas NO se toca durante
 * el gesto). Al SELECCIONAR un texto/imagen se hornea en background la página
 * SIN ese nodo; al arrancar el drag, PdfCanvas la blitea (un drawImage,
 * instantáneo) y durante el arrastre no corre ningún pipeline — solo el
 * transform CSS del box.
 *
 * Este es el código más sutil del editor — la máquina de estados completa:
 *  - selección → prepara el lift en el tiempo muerto pre-drag;
 *  - drop COMMITEADO → el lift queda vivo (el canvas muestra sus píxeles)
 *    hasta que el preview re-horneado aterrice (onPreviewLanded);
 *  - drop no-op → se cancela y el canvas se restaura.
 */
export function useLift(opts: {
  selectedId: string | null;
  /** Con editor de texto abierto no hay drags — lift innecesario. */
  editingActive: boolean;
  baseBytes: Uint8Array | null;
  bakePending: (extraRemoval?: SegmentNode, extraImageRemoval?: ImageNode) => Promise<Uint8Array>;
  edits: Map<string, SegmentEdit>;
  imageEdits: Map<string, ImageEdit>;
  pendingHighlights: PendingHighlight[];
  graphRef: MutableRefObject<PageGraph | null>;
  segCache: MutableRefObject<Map<string, SegmentNode>>;
}) {
  const { selectedId, editingActive, baseBytes, bakePending, edits, imageEdits, pendingHighlights, graphRef, segCache } = opts;

  const [lift, setLift] = useState<{ segId: string; doc: PDFDocumentProxy } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Drop consumado: el lift queda vivo (el canvas ya muestra sus píxeles)
  // hasta que el preview re-horneado aterrice — recién ahí se descarta.
  const dropPendingRef = useRef(false);

  // ── PREPARAR EL LIFT al seleccionar un texto (todavía presente en el canvas):
  //    hornear la página sin él AHORA, en el tiempo muerto entre el click y el
  //    posible arrastre. Si el drag arranca, el blit es instantáneo. ──
  useEffect(() => {
    if (editingActive) return;
    const sid = selectedId;
    const seg = sid && !edits.has(sid) ? graphRef.current?.segments.find(s => s.id === sid) : null;
    // El lift también aplica a IMÁGENES: hornear la página sin la imagen
    // seleccionada, para que al arrastrarla se vea lo de atrás (no un velo).
    // CLAVE: solo si la imagen NO tiene ya una edición (igual que el texto usa
    // `!edits.has`). Sin este guard, al soltar (imageEdits cambia) el efecto
    // re-corría y horneaba un lift COMPETIDOR (página sin la imagen) que se
    // blitea ENCIMA del preview ya aterrizado → la imagen se esfumaba.
    const imgNode = sid && !seg && !imageEdits.has(sid) ? graphRef.current?.images.find(im => im.id === sid) : null;
    if ((!seg && !imgNode) || !baseBytes) {
      // Nada que preparar. Ojo: tras un drop consumado el lift NO se descarta
      // acá (el canvas muestra sus píxeles) — lo descarta onPreviewLanded
      // cuando el preview re-horneado aterriza.
      if (!dropPendingRef.current) setLift(prev => { void prev?.doc.destroy(); return null; });
      return;
    }
    const liftId = seg ? seg.id : imgNode!.id;
    let cancelled = false;
    (async () => {
      const bytes = seg ? await bakePending(seg) : await bakePending(undefined, imgNode!);
      if (cancelled) return;
      const doc = await getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
      if (cancelled) { void doc.destroy(); return; }
      setLift(prev => { void prev?.doc.destroy(); return { segId: liftId, doc }; });
    })().catch(() => { /* sin lift: el drag cae al camino lento (blit al aterrizar) */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, baseBytes, bakePending, edits, imageEdits, pendingHighlights, editingActive]);

  // Arranque/fin del ARRASTRE. Al arrancar, PdfCanvas blitea el lift (si está
  // listo). Al soltar: si el drop COMMITEÓ una edición, el lift queda en
  // pantalla hasta que el preview re-horneado (píxeles idénticos) aterrice;
  // si fue un no-op (soltó donde estaba), se cancela y el canvas se restaura.
  const onDragging = useCallback((segId: string, active: boolean, committed = false) => {
    if (active) {
      if (!segCache.current.has(segId)) {
        const s = graphRef.current?.segments.find(x => x.id === segId);
        if (s) segCache.current.set(segId, s);
      }
      setDraggingId(segId);
      return;
    }
    setDraggingId(null);
    if (committed) dropPendingRef.current = true;
    else setLift(prev => (prev?.segId === segId ? (void prev.doc.destroy(), null) : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El grafo nuevo llegó = el preview aterrizó: si había un drop en vuelo,
  // el documento visible ya es el re-horneado — descartar el lift.
  const onPreviewLanded = useCallback(() => {
    if (dropPendingRef.current) {
      dropPendingRef.current = false;
      setLift(prev => { void prev?.doc.destroy(); return null; });
    }
  }, []);

  return { lift, draggingId, onDragging, onPreviewLanded };
}
