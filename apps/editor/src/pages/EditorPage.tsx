import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import {
  effectiveGeometry, FIELD_DEFAULT_SIZE, mergeSegmentEdit,
  type ImageEdit, type PageGraph, type SegmentEdit, type WidgetEdit, type WidgetKind,
} from '@aldus/core';
import {
  MousePointer2, Pilcrow, List, TextCursorInput, SquareCheck, CircleDot,
  SquareChevronDown, Signature, ImagePlus, Droplets, PanelTop,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Check, type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { PdfCanvas } from '../editor/PdfCanvas';
import { Inspector } from '../editor/Inspector';
import { Button, IconButton, ToolButton, Toast, cx } from '../ui/primitives';
import { WatermarkDialog, HeaderFooterDialog, LinkDialog } from '../ui/dialogs';

const r1 = (v: number) => Math.round(v * 10) / 10;

type Placing =
  | { kind: 'field'; type: WidgetKind }
  | { kind: 'image'; file: File }
  | { kind: 'text'; bullet: boolean }
  | null;

type Dialog =
  | null
  | { kind: 'watermark' }
  | { kind: 'headerFooter' }
  | { kind: 'link'; target: { page: number; x: number; y: number; width: number; height: number } };

const INSERT_TOOLS: Array<{ id: string; icon: LucideIcon; label: string; placing: Placing }> = [
  { id: 'text', icon: Pilcrow, label: 'Párrafo de texto', placing: { kind: 'text', bullet: false } },
  { id: 'bullet', icon: List, label: 'Viñeta', placing: { kind: 'text', bullet: true } },
  { id: 'field-text', icon: TextCursorInput, label: 'Campo de texto', placing: { kind: 'field', type: 'text' } },
  { id: 'field-checkbox', icon: SquareCheck, label: 'Checkbox', placing: { kind: 'field', type: 'checkbox' } },
  { id: 'field-radio', icon: CircleDot, label: 'Radio', placing: { kind: 'field', type: 'radio' } },
  { id: 'field-select', icon: SquareChevronDown, label: 'Select', placing: { kind: 'field', type: 'select' } },
  { id: 'field-signature', icon: Signature, label: 'Campo de firma', placing: { kind: 'field', type: 'signature' } },
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
  const [baking, setBaking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);

  // Toast efímero.
  useEffect(() => {
    if (!notice && !error) return;
    const t = setTimeout(() => { setNotice(''); setError(''); }, 3200);
    return () => clearTimeout(t);
  }, [notice, error]);

  // ── LOCKS: un nodo bloqueado es invisible al mouse; persistido por documento. ──
  const [locked, setLocked] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`aldus-locks-${id}`) || '[]') as string[]); }
    catch { return new Set(); }
  });
  const toggleLock = useCallback((nodeId: string) => {
    setLocked(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
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
    const run = p.kind === 'field'
      ? api.createField(id, { type: p.type, page: pageNum, x: r1(x), y: r1(y - FIELD_DEFAULT_SIZE[p.type].height) })
      : p.kind === 'image'
        ? api.insertImage(id, p.file, { page: pageNum, x: r1(x), y: r1(y) })
        : api.docOp(id, 'addText', { page: pageNum, x: r1(x), y: r1(y), text: p.bullet ? '•  Elemento nuevo' : 'Texto nuevo' });
    run
      .then(() => { setDocVersion(v => v + 1); setNotice('Creado — doble click para editar'); })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo crear'));
  }, [placing, id, pageNum]);

  // Operaciones de documento instantáneas (highlight, links, watermark…).
  const docOp = useCallback((action: string, params: Record<string, unknown>) => {
    setError('');
    api.docOp(id, action, params)
      .then(() => { setDocVersion(v => v + 1); setNotice('Aplicado'); })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo aplicar'));
  }, [id]);

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
      if ('revert' in edit) next.delete(edit.segmentId); else next.set(edit.segmentId, edit);
      return next;
    });
  }, []);

  // Las ediciones de IMAGEN/CAMPO se aplican AL INSTANTE (bake inmediato + recarga).
  const imgBusy = useRef(false);
  const onImageEdit = useCallback((edit: ImageEdit | { imageId: string; revert: true }) => {
    if ('revert' in edit) {
      setImageEdits(prev => { const n = new Map(prev); n.delete(edit.imageId); return n; });
      return;
    }
    if (imgBusy.current) return;
    imgBusy.current = true;
    setImageEdits(prev => new Map(prev).set(edit.imageId, edit));
    setError('');
    api.bake(id, [], [edit])
      .then(r => { setDocVersion(v => v + 1); setNotice(r.warnings.length ? `Imagen: ${r.warnings.join(' · ')}` : 'Imagen aplicada'); })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo aplicar la imagen'))
      .finally(() => { imgBusy.current = false; setImageEdits(prev => { const n = new Map(prev); n.delete(edit.imageId); return n; }); });
  }, [id]);

  const onWidgetEdit = useCallback((edit: WidgetEdit | { widgetId: string; revert: true }) => {
    if ('revert' in edit) {
      setWidgetEdits(prev => { const n = new Map(prev); n.delete(edit.widgetId); return n; });
      return;
    }
    if (imgBusy.current) return;
    imgBusy.current = true;
    setWidgetEdits(prev => new Map(prev).set(edit.widgetId, edit));
    setError('');
    api.bake(id, [], [], [edit])
      .then(r => { setDocVersion(v => v + 1); setNotice(r.warnings.length ? `Campo: ${r.warnings.join(' · ')}` : 'Campo aplicado'); })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo aplicar el campo'))
      .finally(() => { imgBusy.current = false; setWidgetEdits(prev => { const n = new Map(prev); n.delete(edit.widgetId); return n; }); });
  }, [id]);

  // Convertir un segmento/rect en link: abre el modal (no más window.prompt).
  const requestLink = useCallback((target: { page: number; x: number; y: number; width: number; height: number }) => {
    setDialog({ kind: 'link', target });
  }, []);

  // Teclado: flechas = nudge del segmento / navegación; Delete = eliminar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.key === 'Escape') { setPlacing(null); return; }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && graph) {
        const seg = graph.segments.find(s => s.id === selectedId);
        if (seg) { e.preventDefault(); const m = mergeSegmentEdit(seg, edits.get(seg.id) ?? null, { remove: true }); if (m) onEdit(m); return; }
        const img = graph.images.find(i => i.id === selectedId);
        if (img) { e.preventDefault(); onImageEdit({ imageId: img.id, page: img.page, remove: true, original: { x: img.x, y: img.y, width: img.width, height: img.height } }); return; }
        const w = graph.widgets.find(x => x.id === selectedId);
        if (w) { e.preventDefault(); onWidgetEdit({ widgetId: w.id, page: w.page, remove: true, original: { fieldName: w.fieldName, x: w.x, y: w.y, width: w.width, height: w.height } }); return; }
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
  }, [pdf, pageNum, selectedId, graph, edits, onEdit, onImageEdit, onWidgetEdit]);

  const setZoom = useCallback((s: number) => {
    const clamped = Math.min(3, Math.max(0.5, Math.round(s * 100) / 100));
    setScale(clamped);
    localStorage.setItem('aldus-zoom', String(clamped));
  }, []);

  const bake = useCallback(async () => {
    setBaking(true);
    setError('');
    try {
      const r = await api.bake(id, [...edits.values()], []);
      setEdits(new Map());
      setSelectedId(null);
      setDocVersion(v => v + 1);
      setNotice(r.warnings.length ? `Aplicado con avisos: ${r.warnings.join(' · ')}` : `Aplicado (${r.applied.length})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aplicar');
    } finally {
      setBaking(false);
    }
  }, [id, edits]);

  const numPages = pdf?.numPages ?? 0;
  const totalEdits = edits.size;
  const pageEdits = useMemo(() => new Map([...edits].filter(([, e]) => e.page === pageNum)), [edits, pageNum]);
  const pageImageEdits = useMemo(() => new Map([...imageEdits].filter(([, e]) => e.page === pageNum)), [imageEdits, pageNum]);
  const pageWidgetEdits = useMemo(() => new Map([...widgetEdits].filter(([, e]) => e.page === pageNum)), [widgetEdits, pageNum]);

  const toolActive = (p: Placing): boolean =>
    !!placing && !!p && placing.kind === p.kind &&
    (p.kind !== 'field' || (placing.kind === 'field' && placing.type === p.type)) &&
    (p.kind !== 'text' || (placing.kind === 'text' && placing.bullet === p.bullet));

  return (
    <div className="flex h-full flex-col bg-neutral-50 text-neutral-800">
      {/* ── Top bar ── */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-3">
        <Link to="/" className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-neutral-900">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-blue-600 text-white text-[13px] font-bold">A</span>
          Aldus
        </Link>

        <div className="mx-1 h-6 w-px bg-neutral-200" />

        <div className="flex items-center gap-1">
          <IconButton icon={ChevronLeft} label="Página anterior" disabled={pageNum <= 1} onClick={() => { setPageNum(p => p - 1); setSelectedId(null); }} />
          <input
            className="h-8 w-12 rounded-md border border-neutral-200 text-center text-[13px] outline-none focus:border-blue-500"
            type="number" min={1} max={numPages || 1} value={pageNum}
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) { setPageNum(Math.min(Math.max(1, Math.round(v)), numPages || 1)); setSelectedId(null); } }}
          />
          <span className="text-[13px] text-neutral-400">/ {numPages || '…'}</span>
          <IconButton icon={ChevronRight} label="Página siguiente" disabled={pageNum >= numPages} onClick={() => { setPageNum(p => p + 1); setSelectedId(null); }} />
        </div>

        <div className="mx-1 h-6 w-px bg-neutral-200" />

        <div className="flex items-center gap-1">
          <IconButton icon={ZoomOut} label="Alejar" onClick={() => setZoom(scale - 0.15)} />
          <span className="w-11 text-center text-[13px] tabular-nums text-neutral-500">{Math.round(scale * 100)}%</span>
          <IconButton icon={ZoomIn} label="Acercar" onClick={() => setZoom(scale + 0.15)} />
        </div>

        <div className="flex-1" />

        {placing && <span className="text-[12px] text-blue-600">Click en la página · Esc cancela</span>}
        {graph && !placing && (
          <span className="hidden text-[12px] text-neutral-400 md:inline">
            {graph.segments.length} segmentos · {graph.images.length} img · {graph.widgets.length} campos
          </span>
        )}

        <Button variant="primary" disabled={baking || totalEdits === 0} onClick={() => void bake()}>
          <Check size={15} strokeWidth={2.5} />
          {baking ? 'Aplicando…' : `Aplicar${totalEdits ? ` (${totalEdits})` : ''}`}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── Rail de herramientas (izquierda) ── */}
        <nav className="flex w-13 shrink-0 flex-col items-center gap-1 border-r border-neutral-200 bg-white py-2" style={{ width: 52 }}>
          <ToolButton icon={MousePointer2} label="Seleccionar" active={!placing} onClick={() => setPlacing(null)} />
          <div className="my-1 h-px w-6 bg-neutral-200" />
          {INSERT_TOOLS.map(t => (
            <ToolButton key={t.id} icon={t.icon} label={t.label} active={toolActive(t.placing)}
              onClick={() => setPlacing(prev => (toolActive(t.placing) ? null : t.placing))} />
          ))}
          <ToolButton icon={ImagePlus} label="Insertar imagen (PNG/JPEG)" active={placing?.kind === 'image'} onClick={() => imageFileRef.current?.click()} />
          <input ref={imageFileRef} type="file" accept="image/png,image/jpeg" hidden
            onChange={e => { const f = e.target.files?.[0]; if (f) setPlacing({ kind: 'image', file: f }); e.target.value = ''; }} />
          <div className="my-1 h-px w-6 bg-neutral-200" />
          <ToolButton icon={Droplets} label="Marca de agua" onClick={() => setDialog({ kind: 'watermark' })} />
          <ToolButton icon={PanelTop} label="Encabezado y pie" onClick={() => setDialog({ kind: 'headerFooter' })} />
        </nav>

        {/* ── Área de la página ── */}
        <main className={cx('thin-scroll flex flex-1 justify-center overflow-auto p-8', placing && 'cursor-crosshair')}>
          {pdf ? (
            <div className="h-max">
              <PdfCanvas
                pdf={pdf} pageNum={pageNum} scale={scale}
                onGraph={setGraph} graph={graph?.page === pageNum ? graph : null}
                selectedId={selectedId} onSelect={setSelectedId}
                edits={pageEdits} onEdit={onEdit}
                imageEdits={pageImageEdits} onImageEdit={onImageEdit}
                widgetEdits={pageWidgetEdits} onWidgetEdit={onWidgetEdit}
                locked={locked} placing={placing != null} onPlace={onPlace}
              />
            </div>
          ) : (
            <p className="mt-24 text-[13px] text-neutral-400">{error || 'Abriendo el PDF…'}</p>
          )}
        </main>

        {/* ── Panel de propiedades (derecha) ── */}
        <Inspector
          graph={graph?.page === pageNum ? graph : null}
          selectedId={selectedId} onSelect={setSelectedId}
          edits={edits} onEdit={onEdit}
          imageEdits={imageEdits} onImageEdit={onImageEdit}
          widgetEdits={widgetEdits} onWidgetEdit={onWidgetEdit}
          locked={locked} onToggleLock={toggleLock}
          onDocOp={docOp} onRequestLink={requestLink}
        />
      </div>

      {/* ── Modales ── */}
      {dialog?.kind === 'watermark' && (
        <WatermarkDialog onClose={() => setDialog(null)} onApply={text => docOp('watermark', { text })} />
      )}
      {dialog?.kind === 'headerFooter' && (
        <HeaderFooterDialog onClose={() => setDialog(null)} onApply={v => docOp('headerFooter', v)} />
      )}
      {dialog?.kind === 'link' && (
        <LinkDialog onClose={() => setDialog(null)} onApply={url => docOp('addLink', { ...dialog.target, url })} />
      )}

      <Toast message={error || notice} tone={error ? 'error' : 'info'} />
    </div>
  );
}
