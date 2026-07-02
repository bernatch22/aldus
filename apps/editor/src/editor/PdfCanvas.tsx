/**
 * PdfCanvas — renderiza UNA página a canvas (nítido en HiDPI) y extrae su grafo.
 *
 * Orden importante: primero el render a canvas (pdf.js registra ahí las fuentes
 * embebidas como FontFace bajo su loadedName), después extractPageGraph — así el
 * overlay ya puede usar esas familias y dibujar con los glifos REALES del PDF.
 */

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { extractPageGraph, type ImageEdit, type PageGraph, type PdfJsPage, type SegmentEdit } from '@aldus/core';
import { NodeOverlay, type EditAction, type ImageEditAction } from './NodeOverlay';

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
}

export function PdfCanvas({ pdf, pageNum, scale, graph, onGraph, selectedId, onSelect, edits, onEdit, imageEdits, onImageEdit }: Props) {
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
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      setSize({ w: Math.floor(viewport.width), h: Math.floor(viewport.height) });

      renderTaskRef.current?.cancel();
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const task = page.render({
        canvasContext: ctx,
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
      try {
        setSnapshot({ url: canvas.toDataURL('image/jpeg', 0.7), width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
      } catch {
        setSnapshot(null);
      }
      const g = await extractPageGraph(page as unknown as PdfJsPage);
      if (!cancelled) onGraph(g);
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
          snapshot={snapshot}
        />
      )}
    </div>
  );
}
