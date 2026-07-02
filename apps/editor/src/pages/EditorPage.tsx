import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import { effectiveGeometry, FIELD_DEFAULT_SIZE, mergeSegmentEdit, type ImageEdit, type PageGraph, type SegmentEdit, type WidgetEdit, type WidgetKind } from '@aldus/core';
import { api } from '../lib/api';
import { PdfCanvas } from '../editor/PdfCanvas';
import { Inspector } from '../editor/Inspector';

const r1 = (v: number) => Math.round(v * 10) / 10;

type Placing = { kind: 'field'; type: WidgetKind } | { kind: 'image'; file: File } | null;

const FIELD_TOOLS: Array<{ type: WidgetKind; icon: string; label: string }> = [
  { type: 'text', icon: 'T', label: 'Campo de texto' },
  { type: 'checkbox', icon: '☑', label: 'Checkbox' },
  { type: 'radio', icon: '◉', label: 'Radio' },
  { type: 'select', icon: '▾', label: 'Select' },
  { type: 'signature', icon: '✍', label: 'Campo de firma' },
];

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

  // ── LOCKS: un nodo bloqueado es invisible al mouse (ni hover ni drag);
  //    se desbloquea desde el panel/lista. Persistido por documento. ──
  const [locked, setLocked] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`aldus-locks-${id}`) || '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleLock = useCallback((nodeId: string) => {
    setLocked(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      localStorage.setItem(`aldus-locks-${id}`, JSON.stringify([...next]));
      return next;
    });
  }, [id]);

  // ── INSERTAR: paleta → modo colocación → click en la página crea el nodo. ──
  const [placing, setPlacing] = useState<Placing>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);
  const onPlace = useCallback((x: number, y: number) => {
    if (!placing) return;
    const p = placing;
    setPlacing(null);
    setError('');
    setNotice('');
    const run = p.kind === 'field'
      ? api.createField(id, { type: p.type, page: pageNum, x: r1(x), y: r1(y - FIELD_DEFAULT_SIZE[p.type].height) })
      : api.insertImage(id, p.file, { page: pageNum, x: r1(x), y: r1(y) });
    run
      .then(() => {
        setDocVersion(v => v + 1);
        setNotice(p.kind === 'field' ? 'Campo creado ✓' : 'Imagen insertada ✓');
      })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo crear'));
  }, [placing, id, pageNum]);
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

      if (e.key === 'Escape') {
        setPlacing(null);
        return;
      }

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
        <div className="toolbar-group palette">
          <span className="muted">Insertar:</span>
          {FIELD_TOOLS.map(t => (
            <button
              key={t.type}
              className={placing?.kind === 'field' && placing.type === t.type ? 'tool-active' : ''}
              title={t.label}
              onClick={() => setPlacing(p => (p?.kind === 'field' && p.type === t.type ? null : { kind: 'field', type: t.type }))}
            >{t.icon}</button>
          ))}
          <button
            className={placing?.kind === 'image' ? 'tool-active' : ''}
            title="Insertar imagen (PNG/JPEG)"
            onClick={() => imageFileRef.current?.click()}
          >🖼</button>
          <input
            ref={imageFileRef}
            type="file"
            accept="image/png,image/jpeg"
            hidden
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) setPlacing({ kind: 'image', file: f });
              e.target.value = '';
            }}
          />
          {placing && <span className="muted">click en la página (Esc cancela)</span>}
        </div>
        <div className="toolbar-group grow">
          {!placing && graph && <span className="muted">{graph.lines.length} líneas · {graph.segments.length} segmentos · {graph.runs.length} runs</span>}
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
              locked={locked}
              placing={placing != null}
              onPlace={onPlace}
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
          locked={locked}
          onToggleLock={toggleLock}
        />
      </div>
    </div>
  );
}
