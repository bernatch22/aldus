/**
 * Teclado global del editor: Esc cancela la colocación; Ctrl/Cmd+Z deshace
 * (Shift/Y rehace); Delete elimina el nodo seleccionado; flechas = nudge del
 * segmento (Shift = 5pt) o navegación de páginas.
 *
 * v2: Delete y el nudge van por el REGISTRY (`removeNode`/`moveNode` sobre el
 * grafo del overlay, fantasmas incluidos) — muere la 5.ª cascada if-por-tipo
 * de v1. El nudge sigue aplicando SOLO a segmentos (v1: flechas sobre otro
 * nodo = navegación de páginas).
 */
import { useEffect } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageGraph, SegmentNode } from '@aldus/core';
import type { EditLedgerAdapter } from '../../core/index.js';
import { moveNode, removeNode } from '../boxes/registry.js';

export function useEditorHotkeys(opts: {
  pdf: PDFDocumentProxy | null;
  pageNum: number;
  setPageNum: (fn: (p: number) => number) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  /** El grafo del OVERLAY (segments = grafo + fantasmas). */
  graph: PageGraph | null;
  ledger: EditLedgerAdapter;
  findSeg: (sid: string) => SegmentNode | null;
  cancelPlacing: () => void;
}) {
  const { pdf, pageNum, setPageNum, selectedId, setSelectedId, graph, ledger, findSeg, cancelPlacing } = opts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.key === 'Escape') { cancelPlacing(); return; }

      // Undo / redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z o Ctrl/Cmd+Y).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) ledger.history.redo(); else ledger.history.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        ledger.history.redo();
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && graph) {
        e.preventDefault();
        removeNode(graph, ledger, selectedId);
        return;
      }

      const seg = selectedId ? findSeg(selectedId) : null;
      if (seg && graph && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 0.5;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        moveNode(graph, ledger, seg.id, dx, dy);
        return;
      }

      const numPages = pdf?.numPages ?? 0;
      if ((e.key === 'ArrowRight' || e.key === 'PageDown') && pageNum < numPages) { e.preventDefault(); setPageNum(p => p + 1); setSelectedId(null); }
      else if ((e.key === 'ArrowLeft' || e.key === 'PageUp') && pageNum > 1) { e.preventDefault(); setPageNum(p => p - 1); setSelectedId(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pdf, pageNum, setPageNum, selectedId, setSelectedId, graph, ledger, findSeg, cancelPlacing]);
}
