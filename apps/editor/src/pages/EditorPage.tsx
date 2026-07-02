import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import type { PageGraph, SegmentEdit } from '@aldus/core';
import { api } from '../lib/api';
import { PdfCanvas } from '../editor/PdfCanvas';
import { Inspector } from '../editor/Inspector';

export function EditorPage() {
  const { id = '' } = useParams();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('aldus-zoom') || '');
    return Number.isFinite(saved) && saved >= 0.5 && saved <= 3 ? saved : 1.5;
  });
  const [graph, setGraph] = useState<PageGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Map<string, SegmentEdit>>(new Map());
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const task = getDocument({ url: api.pdfUrl(id) });
    task.promise.then(
      doc => { if (!cancelled) setPdf(doc); else void doc.destroy(); },
      e => { if (!cancelled) setError(e instanceof Error ? e.message : 'No se pudo abrir el PDF'); },
    );
    api.loadEdits(id).then(saved => {
      if (cancelled || !saved.edits.length) return;
      setEdits(new Map(saved.edits.map(e => [e.segmentId, e])));
      setSavedAt(saved.savedAt);
    }).catch(() => { /* sin edits previos */ });
    return () => { cancelled = true; void task.destroy(); };
  }, [id]);

  // Navegación por teclado (←/→, PageUp/PageDown) — nunca mientras se tipea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const numPages = pdf?.numPages ?? 0;
      if ((e.key === 'ArrowRight' || e.key === 'PageDown') && pageNum < numPages) {
        e.preventDefault();
        setPageNum(p => p + 1);
        setSelectedId(null);
      } else if ((e.key === 'ArrowLeft' || e.key === 'PageUp') && pageNum > 1) {
        e.preventDefault();
        setPageNum(p => p - 1);
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pdf, pageNum]);

  const setZoom = useCallback((s: number) => {
    const clamped = Math.min(3, Math.max(0.5, Math.round(s * 100) / 100));
    setScale(clamped);
    localStorage.setItem('aldus-zoom', String(clamped));
  }, []);

  const onEdit = useCallback((edit: SegmentEdit | { segmentId: string; revert: true }) => {
    setEdits(prev => {
      const next = new Map(prev);
      if ('revert' in edit) next.delete(edit.segmentId);
      else next.set(edit.segmentId, edit);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      await api.saveEdits(id, [...edits.values()]);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  }, [id, edits]);

  const numPages = pdf?.numPages ?? 0;
  const pageEdits = useMemo(
    () => new Map([...edits].filter(([, e]) => e.page === pageNum)),
    [edits, pageNum],
  );

  return (
    <div className="editor-shell">
      <header className="toolbar">
        <Link to="/" className="brand">Aldus</Link>
        <div className="toolbar-group">
          <button disabled={pageNum <= 1} onClick={() => { setPageNum(p => p - 1); setSelectedId(null); }}>‹</button>
          <input
            className="page-input"
            type="number"
            min={1}
            max={numPages || 1}
            value={pageNum}
            onChange={e => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              setPageNum(Math.min(Math.max(1, Math.round(v)), numPages || 1));
              setSelectedId(null);
            }}
          />
          <span className="muted">/ {numPages || '…'}</span>
          <button disabled={pageNum >= numPages} onClick={() => { setPageNum(p => p + 1); setSelectedId(null); }}>›</button>
        </div>
        <div className="toolbar-group">
          <button onClick={() => setZoom(scale - 0.15)}>−</button>
          <span>{Math.round(scale * 100)}%</span>
          <button onClick={() => setZoom(scale + 0.15)}>+</button>
        </div>
        <div className="toolbar-group grow">
          {graph && <span className="muted">{graph.lines.length} líneas · {graph.segments.length} segmentos · {graph.runs.length} runs</span>}
        </div>
        <div className="toolbar-group">
          {error && <span className="error">{error}</span>}
          {savedAt && !edits.size && <span className="muted">guardado</span>}
          <button className="primary" disabled={saving || edits.size === 0} onClick={() => void save()}>
            {saving ? 'Guardando…' : `Guardar${edits.size ? ` (${edits.size})` : ''}`}
          </button>
        </div>
      </header>

      <div className="editor-body">
        <main className="page-area">
          {pdf ? (
            <PdfCanvas
              pdf={pdf}
              pageNum={pageNum}
              scale={scale}
              onGraph={setGraph}
              graph={graph?.page === pageNum ? graph : null}
              selectedId={selectedId}
              onSelect={setSelectedId}
              edits={pageEdits}
              onEdit={onEdit}
            />
          ) : (
            <p className="muted center">{error || 'Abriendo el PDF…'}</p>
          )}
        </main>
        <Inspector
          graph={graph?.page === pageNum ? graph : null}
          selectedId={selectedId}
          onSelect={setSelectedId}
          edits={edits}
          onEdit={onEdit}
        />
      </div>
    </div>
  );
}
