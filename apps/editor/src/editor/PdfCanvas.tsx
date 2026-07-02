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
  onDragging: (segId: string, active: boolean) => void;
}

export function PdfCanvas({ pdf, pageNum, scale, graph, onGraph, selectedId, onSelect, edits, onEdit, imageEdits, onImageEdit, widgetEdits, onWidgetEdit, locked, placing, onPlace, onDocOp, onRequestLink, onAddText, highlightColor, onHighlightColor, phantomSegments, onDragging }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Snapshot de la página renderizada: los previews de imágenes movidas lo usan
  // como fuente de píxeles (crop por background-position).
  const [snapshot, setSnapshot] = useState<{ url: string; width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);

      // DOUBLE BUFFER: pdf.js renderiza en un canvas FUERA de pantalla y el
      // visible se actualiza con UN drawImage al final. Renderizar directo
      // limpiaba el canvas (canvas.width = …) y la página quedaba en blanco
      // hasta terminar — cada update del preview se veía como un "refresh".
      const back = document.createElement('canvas');
      back.width = Math.floor(viewport.width * dpr);
      back.height = Math.floor(viewport.height * dpr);
      const backCtx = back.getContext('2d');
      if (!backCtx) return;

      renderTaskRef.current?.cancel();
      const task = page.render({
        canvasContext: backCtx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch {
        return; // render cancelado por un cambio de página/zoom — el nuevo ya corre
      }
      if (cancelled) return;

      // Blit atómico: la página vieja queda visible hasta este frame.
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== back.width || canvas.height !== back.height) {
        canvas.width = back.width;
        canvas.height = back.height;
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.getContext('2d')?.drawImage(back, 0, 0);
      setSize({ w, h });

      try {
        setSnapshot({ url: back.toDataURL('image/jpeg', 0.7), width: w, height: h });
      } catch {
        setSnapshot(null);
      }
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
