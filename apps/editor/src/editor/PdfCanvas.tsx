/**
 * PdfCanvas — renderiza UNA página a canvas (nítido en HiDPI) y extrae su grafo.
 *
 * Orden importante: primero el render a canvas (pdf.js registra ahí las fuentes
 * embebidas como FontFace bajo su loadedName), después extractPageGraph — así el
 * overlay ya puede usar esas familias y dibujar con los glifos REALES del PDF.
 */

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { extractPageGraph, type ImageEdit, type PageGraph, type PdfJsPage, type SegmentEdit, type SegmentNode, type WidgetEdit } from '@aldus/core';
import { NodeOverlay, type AddTextRequest, type EditAction, type ImageEditAction, type WidgetEditAction } from './NodeOverlay';
import { sampleRunColors } from './sampleColor';

interface Props {
  pdf: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  graph: PageGraph | null;
  onGraph: (g: PageGraph) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  edits: Map<string, SegmentEdit>;
  onEdit: (action: EditAction) => void;
  imageEdits: Map<string, ImageEdit>;
  onImageEdit: (action: ImageEditAction) => void;
  widgetEdits: Map<string, WidgetEdit>;
  onWidgetEdit: (action: WidgetEditAction) => void;
  locked: Set<string>;
  placing: boolean;
  onPlace: (x: number, y: number) => void;
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  onAddText: (req: AddTextRequest) => void;
  highlightColor: string;
  onHighlightColor: (c: string) => void;
  phantomSegments: SegmentNode[];
  onDragging: (segId: string, active: boolean, committed?: boolean) => void;
  /** Página pre-horneada SIN el segmento seleccionado (lista para blitear). */
  lift: { segId: string; doc: PDFDocumentProxy } | null;
  /** Segmento en arrastre (si coincide con el lift, se blitea su buffer). */
  draggingId: string | null;
}

/** Renderiza una página de pdf.js en un canvas offscreen (HiDPI). */
async function renderToBackBuffer(doc: PDFDocumentProxy, pageNum: number, scale: number, taskRef: { current: RenderTask | null }): Promise<HTMLCanvasElement | null> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const back = document.createElement('canvas');
  back.width = Math.floor(viewport.width * dpr);
  back.height = Math.floor(viewport.height * dpr);
  const ctx = back.getContext('2d');
  if (!ctx) return null;
  taskRef.current?.cancel();
  const task = page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  });
  taskRef.current = task;
  try {
    await task.promise;
  } catch {
    return null; // cancelado por un render más nuevo
  }
  return back;
}

export function PdfCanvas({ pdf, pageNum, scale, graph, onGraph, selectedId, onSelect, edits, onEdit, imageEdits, onImageEdit, widgetEdits, onWidgetEdit, locked, placing, onPlace, onDocOp, onRequestLink, onAddText, highlightColor, onHighlightColor, phantomSegments, onDragging, lift, draggingId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const liftTaskRef = useRef<RenderTask | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Snapshot de la página renderizada: los previews de imágenes movidas lo usan
  // como fuente de píxeles (crop por background-position).
  const [snapshot, setSnapshot] = useState<{ url: string; width: number; height: number } | null>(null);

  // DOUBLE BUFFER + LIFT (así lo hace el annotation editor de pdf.js: el canvas
  // no se toca durante un gesto). `mainBack` = último render del preview;
  // `liftBack` = la página sin el segmento seleccionado, pre-renderizada. El
  // visible SOLO recibe drawImage atómicos — nunca se limpia ni renderiza
  // en vivo, así ningún update se ve como un "refresh".
  const mainBackRef = useRef<HTMLCanvasElement | null>(null);
  const liftBackRef = useRef<{ segId: string; canvas: HTMLCanvasElement } | null>(null);
  const liftShownRef = useRef(false);
  const draggingRef = useRef<string | null>(null);
  draggingRef.current = draggingId;

  const blit = (src: HTMLCanvasElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== src.width || canvas.height !== src.height) {
      canvas.width = src.width;
      canvas.height = src.height;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${Math.floor(src.width / dpr)}px`;
    canvas.style.height = `${Math.floor(src.height / dpr)}px`;
    canvas.getContext('2d')?.drawImage(src, 0, 0);
  };

  // Render principal: preview → back buffer → blit → snapshot + grafo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const back = await renderToBackBuffer(pdf, pageNum, scale, renderTaskRef);
      if (cancelled || !back) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.floor(back.width / dpr);
      const h = Math.floor(back.height / dpr);
      mainBackRef.current = back;
      blit(back);
      liftShownRef.current = false; // el preview manda: el lift quedó atrás
      setSize({ w, h });
      try {
        setSnapshot({ url: back.toDataURL('image/jpeg', 0.7), width: w, height: h });
      } catch {
        setSnapshot(null);
      }
      const page = await pdf.getPage(pageNum);
      const g = await extractPageGraph(page as unknown as PdfJsPage);
      if (cancelled) return;
      // Muestrear el color de cada run del canvas ya pintado (para el display).
      try { sampleRunColors(g, back, scale); } catch { /* best-effort */ }
      onGraph(g);
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdf, pageNum, scale, onGraph]);

  // Render del LIFT (en background, mientras el usuario todavía no arrastra).
  // Nada de snapshot/grafo acá: es solo un buffer listo para blitear.
  useEffect(() => {
    if (!lift) {
      // Lift cancelado (drop no-op): si estaba en pantalla, restaurar el preview.
      if (liftShownRef.current && mainBackRef.current) {
        blit(mainBackRef.current);
        liftShownRef.current = false;
      }
      liftBackRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      const back = await renderToBackBuffer(lift.doc, pageNum, scale, liftTaskRef);
      if (cancelled || !back) return;
      liftBackRef.current = { segId: lift.segId, canvas: back };
      // ¿El drag ya arrancó mientras renderizábamos? Blitear ya mismo.
      if (draggingRef.current === lift.segId) {
        blit(back);
        liftShownRef.current = true;
      }
    })().catch(() => { /* doc del lift destruido a mitad de render — irrelevante */ });
    return () => {
      cancelled = true;
      liftTaskRef.current?.cancel();
    };
  }, [lift, pageNum, scale]);

  // Arrancó el arrastre → blit instantáneo del lift (si ya está listo).
  useEffect(() => {
    if (!draggingId) return;
    const lb = liftBackRef.current;
    if (lb && lb.segId === draggingId && !liftShownRef.current) {
      blit(lb.canvas);
      liftShownRef.current = true;
    }
  }, [draggingId]);

  return (
    <div className="pdf-stage" style={size ? { width: size.w, height: size.h } : undefined}>
      <canvas ref={canvasRef} />
      {graph && (
        <NodeOverlay
          graph={graph}
          scale={scale}
          selectedId={selectedId}
          onSelect={onSelect}
          edits={edits}
          onEdit={onEdit}
          imageEdits={imageEdits}
          onImageEdit={onImageEdit}
          widgetEdits={widgetEdits}
          onWidgetEdit={onWidgetEdit}
          locked={locked}
          placing={placing}
          onPlace={onPlace}
          snapshot={snapshot}
          onDocOp={onDocOp}
          onRequestLink={onRequestLink}
          onAddText={onAddText}
          highlightColor={highlightColor}
          onHighlightColor={onHighlightColor}
          phantomSegments={phantomSegments}
          onDragging={onDragging}
        />
      )}
    </div>
  );
}
