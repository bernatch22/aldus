import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { promoteMovedImages, type PageGraph, type SegmentNode } from '@aldus/core';
import {
  MousePointer2, Pilcrow, TextCursorInput, SquareCheck, CircleDot,
  SquareChevronDown, Signature, ImagePlus, Droplets, PanelTop,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Check, Undo2, Redo2, Sparkles, type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { PdfCanvas } from '../editor/PdfCanvas';
import { clearColorCache } from '../editor/sampleColor';
import { clearImagePixelCache } from '../editor/imagePixels';
import { Inspector } from '../editor/Inspector';
import { AgentPanel } from '../editor/AgentPanel';
import { Button, IconButton, ToolButton, Toast, cx } from '../ui/primitives';
import { WatermarkDialog, HeaderFooterDialog, LinkDialog } from '../ui/dialogs';
import { usePendingEdits, type PendingHighlight } from './editor/usePendingEdits';
import { useLocalPreview } from './editor/useLocalPreview';
import { useLift } from './editor/useLift';
import { useLocks } from './editor/useLocks';
import { useAreaWidths } from './editor/useAreaWidths';
import { usePlacement, type Placing } from './editor/usePlacement';
import { useEditorHotkeys } from './editor/useEditorHotkeys';

type Dialog =
  | null
  | { kind: 'watermark' }
  | { kind: 'headerFooter' }
  | { kind: 'link'; target: { page: number; x: number; y: number; width: number; height: number } };

interface NavTool { id: string; icon: LucideIcon; label: string; placing: Placing }
const NAV_GROUPS: Array<{ label: string; tools: NavTool[] }> = [
  {
    label: 'Texto',
    tools: [
      // Lista = un FORMATO del texto (toggle de viñeta en la barra flotante),
      // no un componente aparte.
      { id: 'text', icon: Pilcrow, label: 'Texto (la viñeta se activa desde la barra del objeto; Enter continúa listas)', placing: { kind: 'text' } },
    ],
  },
  {
    label: 'Forms',
    tools: [
      { id: 'field-text', icon: TextCursorInput, label: 'Campo de texto', placing: { kind: 'field', type: 'text' } },
      { id: 'field-checkbox', icon: SquareCheck, label: 'Checkbox', placing: { kind: 'field', type: 'checkbox' } },
      { id: 'field-radio', icon: CircleDot, label: 'Grupo de radios (agregá opciones desde el panel)', placing: { kind: 'field', type: 'radio' } },
      { id: 'field-select', icon: SquareChevronDown, label: 'Select (editá las opciones desde el panel)', placing: { kind: 'field', type: 'select' } },
      { id: 'field-signature', icon: Signature, label: 'Campo de firma', placing: { kind: 'field', type: 'signature' } },
    ],
  },
];

/**
 * La página del editor — SOLO composición y layout: cada comportamiento vive
 * en su hook bajo ./editor/ (pendientes+historial, preview local, lift,
 * locks, áreas, colocación, teclado).
 */
export function EditorPage() {
  const { id = '' } = useParams();
  useEffect(() => { clearColorCache(); clearImagePixelCache(); }, [id]); // caches por documento

  const [docVersion, setDocVersion] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('aldus-zoom') || '');
    return Number.isFinite(saved) && saved >= 0.5 && saved <= 3 ? saved : 1.5;
  });
  const [graph, setGraph] = useState<PageGraph | null>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  // Editor de texto ABIERTO: el lift se congela (ver useLift).
  const [editingActive, setEditingActive] = useState(false);
  const [baking, setBaking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [highlightColor, setHighlightColor] = useState<string>(() => localStorage.getItem('aldus-hl') || '#ffd400');
  const setHl = useCallback((c: string) => { setHighlightColor(c); localStorage.setItem('aldus-hl', c); }, []);

  // Toast efímero.
  useEffect(() => {
    if (!notice && !error) return;
    const t = setTimeout(() => { setNotice(''); setError(''); }, 3200);
    return () => clearTimeout(t);
  }, [notice, error]);

  // ── Estado pendiente + historial + fantasmas ──
  const {
    edits, imageEdits, widgetEdits, pendingHighlights, highlightEdits, linkEdits,
    editsRef, highlightsRef, segCache,
    onEdit, onImageEdit, onWidgetEdit, onHighlightEdit, onLinkEdit, syncHighlightEdits, applyAgentEdits, addHighlights, removePendingHighlightsFor,
    findSeg, clearAll, history,
  } = usePendingEdits(graphRef, () => setSelectedId(null));

  // Las operaciones INSTANTÁNEAS de server (crear texto/imagen/campo,
  // watermark, encabezado, links) entran al historial como COMANDOS:
  // deshacer = restaurar la revisión previa del server; rehacer = re-ejecutar
  // la operación. Sin esto, Ctrl+Z no deshacía haber creado un nodo.
  const { pushCommand } = history;
  const registerServerOp = useCallback((redo: () => Promise<unknown>) => {
    pushCommand({
      undo: () => api.revert(id)
        .then(() => setDocVersion(v => v + 1))
        .catch(e => setError(e instanceof Error ? e.message : 'No se pudo deshacer')),
      redo: () => redo()
        .then(() => setDocVersion(v => v + 1))
        .catch(e => setError(e instanceof Error ? e.message : 'No se pudo rehacer')),
    });
  }, [pushCommand, id]);

  const { locked, toggleLock } = useLocks(id, graph);
  const { areaWidths, onAreaWidth } = useAreaWidths(id);

  // ── Preview local (bytes base + bake en el browser) ──
  const { pdf, baseBytes, bakePending, resolveHighlights } = useLocalPreview({
    id, docVersion, edits, imageEdits, widgetEdits, pendingHighlights,
    editsRef, highlightsRef, graphRef, segCache,
    onError: setError,
  });

  // ── Lift / drag ──
  const { lift, draggingId, onDragging, onPreviewLanded } = useLift({
    selectedId, editingActive, baseBytes, bakePending,
    edits, imageEdits, pendingHighlights, graphRef, segCache,
  });

  // ── Colocación (paleta → click) ──
  const { placing, setPlacing, imageFileRef, onPlace, onAddText, matchInsertedText } = usePlacement({
    id, pageNum, graph,
    onBumpDoc: () => setDocVersion(v => v + 1),
    onNotice: setNotice,
    onError: setError,
    onAreaWidth,
    onSelect: setSelectedId,
    onServerOp: registerServerOp,
  });

  // El grafo nuevo llegó = el preview aterrizó.
  const handleGraph = useCallback((g: PageGraph) => {
    setGraph(g);
    onPreviewLanded();
    matchInsertedText(g);
  }, [onPreviewLanded, matchInsertedText]);

  // Operaciones de documento. HIGHLIGHT acumula (preview local, se escribe con
  // Aplicar); el resto (links, watermark, enc/pie, texto nuevo) son acciones
  // deliberadas de diálogo y van directo.
  const docOp = useCallback((action: string, params: Record<string, unknown>) => {
    if (action === 'highlight') {
      // Uno solo (FloatingBar) o varios de una (grupo: { items: [...] }).
      const items = Array.isArray(params.items)
        ? (params.items as PendingHighlight[])
        : [params as unknown as PendingHighlight];
      addHighlights(items);
      return;
    }
    if (action === 'unhighlight') {
      // Toggle "quitar" del pendiente (aún sin Aplicar) — no apila.
      removePendingHighlightsFor(params.segmentId as string);
      return;
    }
    setError('');
    const run = () => api.docOp(id, action, params);
    run()
      .then(() => {
        setDocVersion(v => v + 1);
        setNotice('Aplicado');
        registerServerOp(run); // undoable: Ctrl+Z revierte la escritura
      })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo aplicar'));
  }, [id, addHighlights, removePendingHighlightsFor, registerServerOp]);

  // Convertir un segmento/rect en link: abre el modal (no más window.prompt).
  const requestLink = useCallback((target: { page: number; x: number; y: number; width: number; height: number }) => {
    setDialog({ kind: 'link', target });
  }, []);

  const cancelPlacing = useCallback(() => setPlacing(null), [setPlacing]);
  useEditorHotkeys({
    pdf, pageNum, setPageNum, selectedId, setSelectedId, graph, edits, highlightEdits,
    onEdit, onImageEdit, onWidgetEdit, onHighlightEdit, onLinkEdit,
    undo: history.undo, redo: history.redo, findSeg, cancelPlacing,
  });

  const setZoom = useCallback((s: number) => {
    const clamped = Math.min(3, Math.max(0.5, Math.round(s * 100) / 100));
    setScale(clamped);
    localStorage.setItem('aldus-zoom', String(clamped));
  }, []);

  const bake = useCallback(async () => {
    setBaking(true);
    setError('');
    try {
      // AL GUARDAR, subir al frente las imágenes MOVIDAS/ESCALADAS (regla
      // compartida en core con el agente — promoteMovedImages): el bake las
      // reubica EN SU LUGAR, lo que puede dejarlas tapadas por contenido
      // posterior → "desaparecen al guardar". El save es definitivo (no hay
      // re-extracción después) → reordenar acá es seguro.
      const imgEditsForSave = promoteMovedImages([...imageEdits.values()]);
      const r = await api.bake(
        id,
        [...edits.values()],
        imgEditsForSave,
        [...widgetEdits.values()],
        resolveHighlights() as unknown as Array<Record<string, unknown>>,
        [...highlightEdits.values()],
        [...linkEdits.values()],
      );
      clearAll();
      setSelectedId(null);
      setDocVersion(v => v + 1);
      setNotice(r.warnings.length ? `Aplicado con avisos: ${r.warnings.join(' · ')}` : `Aplicado (${r.applied.length})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aplicar');
    } finally {
      setBaking(false);
    }
  }, [id, edits, imageEdits, widgetEdits, highlightEdits, linkEdits, resolveHighlights, clearAll]);

  const numPages = pdf?.numPages ?? 0;
  const totalEdits = edits.size + imageEdits.size + widgetEdits.size + pendingHighlights.length + highlightEdits.size + linkEdits.size;
  const pageEdits = useMemo(() => new Map([...edits].filter(([, e]) => e.page === pageNum)), [edits, pageNum]);
  const pageImageEdits = useMemo(() => new Map([...imageEdits].filter(([, e]) => e.page === pageNum)), [imageEdits, pageNum]);
  const pageWidgetEdits = useMemo(() => new Map([...widgetEdits].filter(([, e]) => e.page === pageNum)), [widgetEdits, pageNum]);
  // Highlights PENDIENTES de la página = capa overlay (no horneada; ver
  // useLocalPreview): se anclan a su segmento y lo siguen al arrastrar.
  const pageHighlights = useMemo(() => pendingHighlights.filter(h => h.page === pageNum), [pendingHighlights, pageNum]);
  // Ediciones de anotaciones GUARDADAS de la página (mover/borrar /Annots).
  const pageHighlightEdits = useMemo(() => new Map([...highlightEdits].filter(([, e]) => e.page === pageNum)), [highlightEdits, pageNum]);
  const pageLinkEdits = useMemo(() => new Map([...linkEdits].filter(([, e]) => e.page === pageNum)), [linkEdits, pageNum]);
  // Segmentos editados = extirpados del preview → el overlay los dibuja como
  // FANTASMAS (nodo original cacheado + edición aplicada, transparente).
  const phantomSegments = useMemo(() => {
    const out: SegmentNode[] = [];
    for (const e of edits.values()) {
      if (e.page !== pageNum) continue;
      const s = segCache.current.get(e.segmentId);
      if (s) out.push(s);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, pageNum]);

  const toolActive = (p: Placing): boolean =>
    !!placing && !!p && placing.kind === p.kind &&
    (p.kind !== 'field' || (placing.kind === 'field' && placing.type === p.type));

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

        <div className="mx-1 h-6 w-px bg-neutral-200" />

        <div className="flex items-center gap-1">
          <IconButton icon={Undo2} label="Deshacer (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo} />
          <IconButton icon={Redo2} label="Rehacer (Ctrl+Shift+Z)" disabled={!history.canRedo} onClick={history.redo} />
        </div>

        <div className="flex-1" />

        {placing && <span className="text-[12px] text-blue-600">Click en la página · Esc cancela</span>}
        {graph && !placing && (
          <span className="hidden text-[12px] text-neutral-400 md:inline">
            {graph.segments.length} segmentos · {graph.images.length} img · {graph.widgets.length} campos
          </span>
        )}

        <button
          onClick={() => setAiOpen(o => !o)}
          title="Aldus AI — preguntá o pedí cambios"
          className={cx('flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors',
            aiOpen ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50')}
        >
          <Sparkles size={15} /> AI
        </button>

        <Button variant="primary" disabled={baking || totalEdits === 0} onClick={() => void bake()}>
          <Check size={15} strokeWidth={2.5} />
          {baking ? 'Aplicando…' : `Aplicar${totalEdits ? ` (${totalEdits})` : ''}`}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── Rail de herramientas (izquierda), agrupado por categoría ── */}
        <nav className="thin-scroll flex shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-neutral-200 bg-white py-2" style={{ width: 56 }}>
          <ToolButton icon={MousePointer2} label="Seleccionar (Esc)" active={!placing} onClick={() => setPlacing(null)} />
          {NAV_GROUPS.map(g => (
            <div key={g.label} className="flex w-full flex-col items-center gap-0.5">
              <div className="mt-2 mb-0.5 w-full text-center text-[8.5px] font-semibold uppercase tracking-[0.1em] text-neutral-300 select-none">{g.label}</div>
              {g.tools.map(t => (
                <ToolButton key={t.id} icon={t.icon} label={t.label} active={toolActive(t.placing)}
                  onClick={() => setPlacing(() => (toolActive(t.placing) ? null : t.placing))} />
              ))}
            </div>
          ))}
          <div className="mt-2 mb-0.5 w-full text-center text-[8.5px] font-semibold uppercase tracking-[0.1em] text-neutral-300 select-none">Objetos</div>
          <ToolButton icon={ImagePlus} label="Insertar imagen (PNG/JPEG)" active={placing?.kind === 'image'} onClick={() => imageFileRef.current?.click()} />
          <input ref={imageFileRef} type="file" accept="image/png,image/jpeg" hidden
            onChange={e => { const f = e.target.files?.[0]; if (f) setPlacing({ kind: 'image', file: f }); e.target.value = ''; }} />
          <div className="mt-2 mb-0.5 w-full text-center text-[8.5px] font-semibold uppercase tracking-[0.1em] text-neutral-300 select-none">Doc</div>
          <ToolButton icon={Droplets} label="Marca de agua (todas las páginas)" onClick={() => setDialog({ kind: 'watermark' })} />
          <ToolButton icon={PanelTop} label="Encabezado y pie de página" onClick={() => setDialog({ kind: 'headerFooter' })} />
        </nav>

        {/* ── Área de la página ── */}
        <main className={cx('thin-scroll flex flex-1 justify-center overflow-auto p-8', placing && 'cursor-crosshair')}>
          {pdf ? (
            <div className="h-max">
              <PdfCanvas
                pdf={pdf} pageNum={pageNum} scale={scale}
                onGraph={handleGraph} graph={graph?.page === pageNum ? graph : null}
                selectedId={selectedId} onSelect={setSelectedId}
                edits={pageEdits} onEdit={onEdit}
                imageEdits={pageImageEdits} onImageEdit={onImageEdit}
                widgetEdits={pageWidgetEdits} onWidgetEdit={onWidgetEdit}
                locked={locked} placing={placing != null} onPlace={onPlace}
                onDocOp={docOp} onRequestLink={requestLink} onAddText={onAddText}
                highlights={pageHighlights}
                highlightEdits={pageHighlightEdits} onHighlightEdit={onHighlightEdit} onSyncHighlightEdits={syncHighlightEdits}
                linkEdits={pageLinkEdits} onLinkEdit={onLinkEdit}
                highlightColor={highlightColor} onHighlightColor={setHl}
                phantomSegments={phantomSegments}
                onDragging={onDragging}
                lift={lift} draggingId={draggingId}
                areaWidths={areaWidths} onAreaWidth={onAreaWidth}
                onEditingChange={setEditingActive}
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
          highlightEdits={highlightEdits} onHighlightEdit={onHighlightEdit}
          linkEdits={linkEdits} onLinkEdit={onLinkEdit}
          locked={locked} onToggleLock={toggleLock}
          onDocOp={docOp} onRequestLink={requestLink}
        />

        {/* ── Panel del agente (derecha, toggleable) ── */}
        {aiOpen && (
          <AgentPanel
            docId={id}
            edits={edits}
            imageEdits={imageEdits}
            onApply={applyAgentEdits}
            onReload={() => { clearAll(); setSelectedId(null); setDocVersion(v => v + 1); }}
            onClose={() => setAiOpen(false)}
          />
        )}
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
