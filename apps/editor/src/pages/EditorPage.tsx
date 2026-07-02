import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import {
  effectiveGeometry, FIELD_DEFAULT_SIZE, mergeSegmentEdit,
  type ImageEdit, type PageGraph, type SegmentEdit, type SegmentNode, type WidgetEdit, type WidgetKind,
} from '@aldus/core';
import {
  MousePointer2, Pilcrow, List, TextCursorInput, SquareCheck, CircleDot,
  SquareChevronDown, Signature, ImagePlus, Droplets, PanelTop,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Check, Undo2, Redo2, type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { PdfCanvas } from '../editor/PdfCanvas';
import { Inspector } from '../editor/Inspector';
import type { AddTextRequest } from '../editor/NodeOverlay';
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

interface PendingHighlight { page: number; segmentId?: string; x: number; y: number; width: number; height: number; color?: string }

interface NavTool { id: string; icon: LucideIcon; label: string; placing: Placing }
const NAV_GROUPS: Array<{ label: string; tools: NavTool[] }> = [
  {
    label: 'Texto',
    tools: [
      { id: 'text', icon: Pilcrow, label: 'Párrafo de texto (Enter continúa listas)', placing: { kind: 'text', bullet: false } },
      { id: 'bullet', icon: List, label: 'Lista con viñeta (Enter agrega el siguiente ítem)', placing: { kind: 'text', bullet: true } },
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
  const [pendingHighlights, setPendingHighlights] = useState<PendingHighlight[]>([]);
  const [baseBytes, setBaseBytes] = useState<Uint8Array | null>(null);
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

  // El estilo DOMINANTE de la página (mediana de tamaño + bucket más común):
  // el texto nuevo nace pareciéndose a los grafos existentes, no a Helvetica 11.
  const pageTextStyle = useMemo(() => {
    if (!graph?.segments.length) return { size: 11, bucket: 'sans' as const };
    const sizes = graph.segments.map(s => s.fontSize).sort((a, b) => a - b);
    const size = r1(sizes[Math.floor(sizes.length / 2)]);
    const counts = new Map<string, number>();
    for (const s of graph.segments) {
      const b = s.runs[0]?.font.bucket ?? 'sans';
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    const bucket = ([...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'sans') as 'sans' | 'serif' | 'mono';
    return { size, bucket };
  }, [graph]);

  // ── Historial UNIFICADO (texto + imágenes + campos + highlights): Ctrl+Z
  //    deshace, Ctrl+Shift+Z / Ctrl+Y rehace. Snapshots de los cuatro maps.
  //    Definido ANTES de docOp/onEdit porque esos lo usan. ──
  interface Snap { e: Map<string, SegmentEdit>; i: Map<string, ImageEdit>; w: Map<string, WidgetEdit>; h: PendingHighlight[] }
  const editsRef = useRef(edits);
  const imageEditsRef = useRef(imageEdits);
  const widgetEditsRef = useRef(widgetEdits);
  const highlightsRef = useRef(pendingHighlights);
  editsRef.current = edits;
  imageEditsRef.current = imageEdits;
  widgetEditsRef.current = widgetEdits;
  highlightsRef.current = pendingHighlights;
  const snapNow = (): Snap => ({ e: editsRef.current, i: imageEditsRef.current, w: widgetEditsRef.current, h: highlightsRef.current });
  const restoreSnap = (s: Snap) => {
    setEdits(s.e);
    setImageEdits(s.i);
    setWidgetEdits(s.w);
    setPendingHighlights(s.h);
  };
  const undoStack = useRef<Snap[]>([]);
  const redoStack = useRef<Snap[]>([]);
  const [histTick, setHistTick] = useState(0); // fuerza re-render para habilitar botones
  const pushHistory = useCallback(() => {
    undoStack.current.push(snapNow());
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
    setHistTick(t => t + 1);
  }, []);
  const undo = useCallback(() => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    redoStack.current.push(snapNow());
    restoreSnap(snap);
    setSelectedId(null);
    setHistTick(t => t + 1);
  }, []);
  const redo = useCallback(() => {
    const snap = redoStack.current.pop();
    if (!snap) return;
    undoStack.current.push(snapNow());
    restoreSnap(snap);
    setSelectedId(null);
    setHistTick(t => t + 1);
  }, []);
  void histTick;

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
        : api.docOp(id, 'addText', {
            page: pageNum, x: r1(x), y: r1(y),
            text: p.bullet ? '•  Elemento nuevo' : 'Texto nuevo',
            size: pageTextStyle.size, bucket: pageTextStyle.bucket,
          });
    run
      .then(() => { setDocVersion(v => v + 1); setNotice('Creado — doble click para editar'); })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo crear'));
  }, [placing, id, pageNum, pageTextStyle]);

  // Enter al final de un ítem de lista → crear el siguiente ítem debajo.
  const onAddText = useCallback((req: AddTextRequest) => {
    api.docOp(id, 'addText', { page: req.page, x: r1(req.x), y: r1(req.baseline + req.size), text: req.text, size: req.size, bucket: req.bucket })
      .then(() => { setDocVersion(v => v + 1); setNotice('Ítem agregado — doble click para editarlo'); })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo agregar'));
  }, [id]);

  // Operaciones de documento. HIGHLIGHT acumula (preview local, se escribe con
  // Aplicar); el resto (links, watermark, enc/pie, texto nuevo) son acciones
  // deliberadas de diálogo y van directo.
  const docOp = useCallback((action: string, params: Record<string, unknown>) => {
    if (action === 'highlight') {
      pushHistory();
      setPendingHighlights(prev => [...prev, params as unknown as PendingHighlight]);
      return;
    }
    setError('');
    api.docOp(id, action, params)
      .then(() => { setDocVersion(v => v + 1); setNotice('Aplicado'); })
      .catch(e => setError(e instanceof Error ? e.message : 'No se pudo aplicar'));
  }, [id, pushHistory]);

  // Los BYTES base del documento (lo que el server tiene persistido).
  useEffect(() => {
    let cancelled = false;
    fetch(`${api.pdfUrl(id)}?v=${docVersion}`)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then(buf => { if (!cancelled) setBaseBytes(new Uint8Array(buf)); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'No se pudo abrir el PDF'); });
    return () => { cancelled = true; };
  }, [id, docVersion]);

  // Un highlight atado a un segmento SIGUE al texto: su rect se resuelve
  // contra la geometría efectiva (con la edición pendiente aplicada).
  // IDENTIDAD ESTABLE (lee por refs): jamás va en deps de effects — meter
  // `graph` en la cadena de deps del preview causaba un loop de re-render
  // (render → extract → graph nuevo → effect → render…) = pantalla parpadeando.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const resolveHighlights = useCallback((): PendingHighlight[] => {
    const g = graphRef.current;
    return highlightsRef.current.map(h => {
      if (!h.segmentId || !g || g.page !== h.page) return h;
      const seg = g.segments.find(s => s.id === h.segmentId);
      if (!seg) return h;
      const eff = effectiveGeometry(seg, editsRef.current.get(seg.id) ?? null);
      return { ...h, x: eff.x, y: eff.y, width: eff.width, height: eff.height };
    });
  }, []);
  // Buscar un segmento por id: primero el grafo del preview; si fue editado
  // (extirpado del preview), el cache de fantasmas.
  const findSeg = useCallback(
    (sid: string): SegmentNode | null =>
      graphRef.current?.segments.find(s => s.id === sid) ?? segCache.current.get(sid) ?? null,
    [],
  );

  // ── PREVIEW HORNEADO LOCALMENTE: las ediciones pendientes de imágenes,
  //    campos y highlights se aplican EN EL BROWSER (el mismo bake de core)
  //    sobre una copia, y se renderiza ESO. WYSIWYG real, sin máscaras ni
  //    duplicados, y el server no se toca hasta Aplicar. El texto sigue como
  //    overlay editable aparte. ──
  useEffect(() => {
    if (!baseBytes) return;
    let cancelled = false;
    (async () => {
      let bytes: Uint8Array = baseBytes;
      if (edits.size || imageEdits.size || widgetEdits.size || pendingHighlights.length) {
        const { bakeSegmentEdits, addHighlight } = await import('@aldus/core/bake');
        // Los segmentos editados se EXTIRPAN del preview (sus ops desaparecen
        // — sin máscaras ni velos en la posición original); el overlay dibuja
        // el estado nuevo como fantasma transparente desde el cache.
        const textRemovals: SegmentEdit[] = [...edits.values()].map(e => ({
          segmentId: e.segmentId, page: e.page, text: e.original.text, remove: true, original: e.original,
        }));
        const r = await bakeSegmentEdits(baseBytes.slice(), textRemovals, [...imageEdits.values()], [...widgetEdits.values()]);
        bytes = r.pdf;
        for (const h of resolveHighlights()) ({ pdf: bytes } = await addHighlight(bytes, h));
      }
      if (cancelled) return;
      // pdf.js TRANSFIERE el buffer al worker → siempre una copia.
      const task = getDocument({ data: bytes.slice() });
      const doc = await task.promise;
      if (cancelled) { void doc.destroy(); return; }
      setPdf(prev => { void prev?.destroy(); return doc; });
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'No se pudo generar el preview'); });
    return () => { cancelled = true; };
    // resolveHighlights es estable (lee refs) — NUNCA va en deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseBytes, edits, imageEdits, widgetEdits, pendingHighlights]);

  // Cache del NODO original de cada segmento editado: el preview extirpa sus
  // ops (desaparece del grafo extraído), así que el overlay lo dibuja como
  // "fantasma" desde acá (con la edición aplicada, transparente).
  const segCache = useRef(new Map<string, SegmentNode>());
  const onEdit = useCallback((edit: SegmentEdit | { segmentId: string; revert: true }) => {
    pushHistory();
    if (!('revert' in edit) && !segCache.current.has(edit.segmentId)) {
      const s = graphRef.current?.segments.find(x => x.id === edit.segmentId);
      if (s) segCache.current.set(edit.segmentId, s);
    }
    setEdits(prev => {
      const next = new Map(prev);
      if ('revert' in edit) next.delete(edit.segmentId); else next.set(edit.segmentId, edit);
      return next;
    });
  }, [pushHistory]);

  // Las ediciones de IMAGEN y CAMPO también ACUMULAN (nada se guarda solo):
  // el documento se escribe únicamente con el botón Aplicar. El preview en el
  // lienzo usa píxeles reales del snapshot, así que se ven movidas de verdad.
  const onImageEdit = useCallback((edit: ImageEdit | { imageId: string; revert: true }) => {
    pushHistory();
    setImageEdits(prev => {
      const next = new Map(prev);
      if ('revert' in edit) next.delete(edit.imageId); else next.set(edit.imageId, edit);
      return next;
    });
  }, [pushHistory]);

  const onWidgetEdit = useCallback((edit: WidgetEdit | { widgetId: string; revert: true }) => {
    pushHistory();
    setWidgetEdits(prev => {
      const next = new Map(prev);
      if ('revert' in edit) next.delete(edit.widgetId); else next.set(edit.widgetId, edit);
      return next;
    });
  }, [pushHistory]);

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
      }

      const seg = selectedId ? findSeg(selectedId) : null;
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
  }, [pdf, pageNum, selectedId, graph, edits, onEdit, onImageEdit, onWidgetEdit, undo, redo, findSeg]);

  const setZoom = useCallback((s: number) => {
    const clamped = Math.min(3, Math.max(0.5, Math.round(s * 100) / 100));
    setScale(clamped);
    localStorage.setItem('aldus-zoom', String(clamped));
  }, []);

  const bake = useCallback(async () => {
    setBaking(true);
    setError('');
    try {
      const r = await api.bake(id, [...edits.values()], [...imageEdits.values()], [...widgetEdits.values()], resolveHighlights() as unknown as Array<Record<string, unknown>>);
      setEdits(new Map());
      setImageEdits(new Map());
      setWidgetEdits(new Map());
      setPendingHighlights([]);
      segCache.current.clear();
      undoStack.current = [];
      redoStack.current = [];
      setSelectedId(null);
      setDocVersion(v => v + 1);
      setNotice(r.warnings.length ? `Aplicado con avisos: ${r.warnings.join(' · ')}` : `Aplicado (${r.applied.length})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aplicar');
    } finally {
      setBaking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, edits, imageEdits, widgetEdits, pendingHighlights]);

  const numPages = pdf?.numPages ?? 0;
  const totalEdits = edits.size + imageEdits.size + widgetEdits.size + pendingHighlights.length;
  const pageEdits = useMemo(() => new Map([...edits].filter(([, e]) => e.page === pageNum)), [edits, pageNum]);
  const pageImageEdits = useMemo(() => new Map([...imageEdits].filter(([, e]) => e.page === pageNum)), [imageEdits, pageNum]);
  const pageWidgetEdits = useMemo(() => new Map([...widgetEdits].filter(([, e]) => e.page === pageNum)), [widgetEdits, pageNum]);
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
  }, [edits, pageNum]);

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

        <div className="mx-1 h-6 w-px bg-neutral-200" />

        <div className="flex items-center gap-1">
          <IconButton icon={Undo2} label="Deshacer (Ctrl+Z)" disabled={undoStack.current.length === 0} onClick={undo} />
          <IconButton icon={Redo2} label="Rehacer (Ctrl+Shift+Z)" disabled={redoStack.current.length === 0} onClick={redo} />
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
                onGraph={setGraph} graph={graph?.page === pageNum ? graph : null}
                selectedId={selectedId} onSelect={setSelectedId}
                edits={pageEdits} onEdit={onEdit}
                imageEdits={pageImageEdits} onImageEdit={onImageEdit}
                widgetEdits={pageWidgetEdits} onWidgetEdit={onWidgetEdit}
                locked={locked} placing={placing != null} onPlace={onPlace}
                onDocOp={docOp} onRequestLink={requestLink} onAddText={onAddText}
                highlightColor={highlightColor} onHighlightColor={setHl}
                phantomSegments={phantomSegments}
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
