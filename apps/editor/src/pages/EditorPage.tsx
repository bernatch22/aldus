import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import { effectiveGeometry, mergeSegmentEdit, type ImageEdit, type PageGraph, type SegmentEdit, type WidgetEdit } from '@aldus/core';
import { api } from '../lib/api';
import { PdfCanvas } from '../editor/PdfCanvas';
import { Inspector } from '../editor/Inspector';

const r1 = (v: number) => Math.round(v * 10) / 10;

export function EditorPage() {
  const { id = '' } = useParams();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [docVersion, setDocVersion] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('aldus-zoom') || '');
    return Number.isFinite(saved) && saved >= 0.5 && saved <= 3 ? saved : 1.5;
  });
  const [graph, setGraph] = useState<PageGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Map<string, SegmentEdit>>(new Map());
  const [imageEdits, setImageEdits] = useState<Map<string, ImageEdit>>(new Map());
  const [widgetEdits, setWidgetEdits] = useState<Map<string, WidgetEdit>>(new Map());
  const [baking, setBaking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const task = getDocument({ url: `${api.pdfUrl(id)}?v=${docVersion}` });
    task.promise.then(
      doc => { if (!cancelled) setPdf(doc); else void doc.destroy(); },
      e => { if (!cancelled) setError(e instanceof Error ? e.message : 'No se pudo abrir el PDF'); },
    );
    return () => { cancelled = true; void task.destroy(); };
  }, [id, docVersion]);

  const onEdit = useCallback((edit: SegmentEdit | { segmentId: string; revert: true }) => {
    setEdits(prev => {
      const next = new Map(prev);
      if ('revert' in edit) next.delete(edit.segmentId);
      else next.set(edit.segmentId, edit);
      return next;
    });
  }, []);

  // Las ediciones de IMAGEN se aplican AL INSTANTE (bake inmediato + recarga):
  // son operaciones atómicas y seguras, y el preview intermedio (imagen
  // duplicada original+fantasma) confundía. El map solo retiene la edición
  // mientras el bake está en vuelo, para el feedback visual.
  const imgBusy = useRef(false);
  const onImageEdit = useCallback((edit: ImageEdit | { imageId: string; revert: true }) => {
    if ('revert' in edit) {
      setImageEdits(prev => {
        const next = new Map(prev);
        next.delete(edit.imageId);
        return next;
      });
      return;
    }
    if (imgBusy.current) return;
    imgBusy.current = true;
    setImageEdits(prev => new Map(prev).set(edit.imageId, edit));
    setError('');
    api.bake(id, [], [edit])
      .then(r => {
        setDocVersion(v => v + 1);
        setNotice(r.warnings.length ? `Imagen: ${r.warnings.join(' · ')}` : 'Imagen aplicada ✓');
      })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo aplicar la imagen'))
      .finally(() => {
        imgBusy.current = false;
        setImageEdits(prev => {
          const next = new Map(prev);
          next.delete(edit.imageId);
          return next;
        });
      });
  }, [id]);

  // Los WIDGETS (campos de formulario) también se aplican al instante: su
  // edición es reescribir el /Rect de la anotación — atómica y segura.
  const onWidgetEdit = useCallback((edit: WidgetEdit | { widgetId: string; revert: true }) => {
    if ('revert' in edit) {
      setWidgetEdits(prev => {
        const next = new Map(prev);
        next.delete(edit.widgetId);
        return next;
      });
      return;
    }
    if (imgBusy.current) return;
    imgBusy.current = true;
    setWidgetEdits(prev => new Map(prev).set(edit.widgetId, edit));
    setError('');
    api.bake(id, [], [], [edit])
      .then(r => {
        setDocVersion(v => v + 1);
        setNotice(r.warnings.length ? `Campo: ${r.warnings.join(' · ')}` : 'Campo aplicado ✓');
      })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo aplicar el campo'))
      .finally(() => {
        imgBusy.current = false;
        setWidgetEdits(prev => {
          const next = new Map(prev);
          next.delete(edit.widgetId);
          return next;
        });
      });
  }, [id]);

  // Teclado: con un segmento seleccionado las flechas hacen NUDGE (Shift = 5pt);
  // sin selección, ←/→ y PageUp/PageDown navegan páginas. Nunca mientras se tipea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;

      const seg = selectedId && graph ? graph.segments.find(s => s.id === selectedId) : null;
      if (seg && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 0.5;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        const cur = edits.get(seg.id) ?? null;
        const eff = effectiveGeometry(seg, cur);
        const nx = r1(eff.x + dx);
        const nb = r1(eff.baseline + dy);
        const merged = mergeSegmentEdit(seg, cur, {
          x: nx === r1(seg.x) ? null : nx,
          baseline: nb === r1(seg.baseline) ? null : nb,
        });
        onEdit(merged ?? { segmentId: seg.id, revert: true });
        return;
      }

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
  }, [pdf, pageNum, selectedId, graph, edits, onEdit]);

  const setZoom = useCallback((s: number) => {
    const clamped = Math.min(3, Math.max(0.5, Math.round(s * 100) / 100));
    setScale(clamped);
    localStorage.setItem('aldus-zoom', String(clamped));
  }, []);

  // Aplica las ediciones AL PDF (bake) y recarga el documento nuevo.
  const bake = useCallback(async () => {
    setBaking(true);
    setError('');
    setNotice('');
    try {
      const r = await api.bake(id, [...edits.values()], []);
      setEdits(new Map());
      setSelectedId(null);
      setDocVersion(v => v + 1);
      setNotice(r.warnings.length ? `Aplicado con avisos: ${r.warnings.join(' · ')}` : `Aplicado ✓ (${r.applied.length})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aplicar');
    } finally {
      setBaking(false);
    }
  }, [id, edits]);

  const numPages = pdf?.numPages ?? 0;
  const totalEdits = edits.size;
  const pageEdits = useMemo(
    () => new Map([...edits].filter(([, e]) => e.page === pageNum)),
    [edits, pageNum],
  );
  const pageImageEdits = useMemo(
    () => new Map([...imageEdits].filter(([, e]) => e.page === pageNum)),
    [imageEdits, pageNum],
  );
  const pageWidgetEdits = useMemo(
    () => new Map([...widgetEdits].filter(([, e]) => e.page === pageNum)),
    [widgetEdits, pageNum],
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
          {!error && notice && <span className="muted">{notice}</span>}
          <button className="primary" disabled={baking || totalEdits === 0} onClick={() => void bake()}>
            {baking ? 'Aplicando…' : `Aplicar al PDF${totalEdits ? ` (${totalEdits})` : ''}`}
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
              imageEdits={pageImageEdits}
              onImageEdit={onImageEdit}
              widgetEdits={pageWidgetEdits}
              onWidgetEdit={onWidgetEdit}
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
          imageEdits={imageEdits}
          onImageEdit={onImageEdit}
          widgetEdits={widgetEdits}
          onWidgetEdit={onWidgetEdit}
        />
      </div>
    </div>
  );
}
