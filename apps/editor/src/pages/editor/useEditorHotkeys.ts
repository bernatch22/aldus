import { useEffect } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  effectiveGeometry, mergeSegmentEdit,
  type HighlightEdit, type ImageEdit, type LinkEdit, type PageGraph, type SegmentEdit, type SegmentNode, type WidgetEdit,
} from '@aldus/core';
import { clampX, clampY } from '../../editor/overlay/helpers';

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Teclado global del editor: Esc cancela la colocación; Ctrl/Cmd+Z deshace
 * (Shift/Y rehace); Delete elimina el nodo seleccionado; flechas = nudge del
 * segmento (Shift = 5pt) o navegación de páginas.
 */
export function useEditorHotkeys(opts: {
  pdf: PDFDocumentProxy | null;
  pageNum: number;
  setPageNum: (fn: (p: number) => number) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  graph: PageGraph | null;
  edits: Map<string, SegmentEdit>;
  highlightEdits: Map<string, HighlightEdit>;
  onEdit: (edit: SegmentEdit | { segmentId: string; revert: true }) => void;
  onImageEdit: (edit: ImageEdit) => void;
  onWidgetEdit: (edit: WidgetEdit) => void;
  onHighlightEdit: (edit: HighlightEdit) => void;
  onLinkEdit: (edit: LinkEdit) => void;
  undo: () => void;
  redo: () => void;
  findSeg: (sid: string) => SegmentNode | null;
  cancelPlacing: () => void;
}) {
  const { pdf, pageNum, setPageNum, selectedId, setSelectedId, graph, edits, highlightEdits, onEdit, onImageEdit, onWidgetEdit, onHighlightEdit, onLinkEdit, undo, redo, findSeg, cancelPlacing } = opts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.key === 'Escape') { cancelPlacing(); return; }

      // Undo / redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z o Ctrl/Cmd+Y).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && graph) {
        const seg = findSeg(selectedId);
        if (seg) { e.preventDefault(); const m = mergeSegmentEdit(seg, edits.get(seg.id) ?? null, { remove: true }); if (m) onEdit(m); return; }
        const img = graph.images.find(i => i.id === selectedId);
        if (img) { e.preventDefault(); onImageEdit({ imageId: img.id, page: img.page, remove: true, original: { x: img.x, y: img.y, width: img.width, height: img.height } }); return; }
        const w = graph.widgets.find(x => x.id === selectedId);
        if (w) { e.preventDefault(); onWidgetEdit({ widgetId: w.id, page: w.page, remove: true, original: { fieldName: w.fieldName, x: w.x, y: w.y, width: w.width, height: w.height } }); return; }
        const hl = graph.highlights.find(x => x.id === selectedId);
        if (hl) { e.preventDefault(); onHighlightEdit({ highlightId: hl.id, page: hl.page, remove: true, original: { x: hl.x, y: hl.y, width: hl.width, height: hl.height, color: hl.color } }); return; }
        const lk = graph.links.find(x => x.id === selectedId);
        if (lk) { e.preventDefault(); onLinkEdit({ linkId: lk.id, page: lk.page, remove: true, original: { url: lk.url, x: lk.x, y: lk.y, width: lk.width, height: lk.height } }); return; }
      }

      const seg = selectedId ? findSeg(selectedId) : null;
      if (seg && graph && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 0.5;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        const cur = edits.get(seg.id) ?? null;
        const eff = effectiveGeometry(seg, cur);
        const nx = r1(clampX(eff.x + dx, eff.width, graph.width));
        // Clampear el bbox entero (glifos suben desde baseline) → mapear a baseline.
        const ny = clampY(eff.y + dy, eff.height, graph.height);
        const nb = r1(eff.baseline + (ny - eff.y));
        const merged = mergeSegmentEdit(seg, cur, { x: nx === r1(seg.x) ? null : nx, baseline: nb === r1(seg.baseline) ? null : nb });
        onEdit(merged ?? { segmentId: seg.id, revert: true });
        return;
      }

      const numPages = pdf?.numPages ?? 0;
      if ((e.key === 'ArrowRight' || e.key === 'PageDown') && pageNum < numPages) { e.preventDefault(); setPageNum(p => p + 1); setSelectedId(null); }
      else if ((e.key === 'ArrowLeft' || e.key === 'PageUp') && pageNum > 1) { e.preventDefault(); setPageNum(p => p - 1); setSelectedId(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pdf, pageNum, setPageNum, selectedId, setSelectedId, graph, edits, highlightEdits, onEdit, onImageEdit, onWidgetEdit, onHighlightEdit, onLinkEdit, undo, redo, findSeg, cancelPlacing]);
}
