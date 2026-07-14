/**
 * AldusEditor — el EDITOR como componente embebible y COMPOSITION ROOT real
 * (v1: `pages/EditorPage.tsx`, 636 LOC de composición + ~120 de orquestación).
 *
 * Acá se CONSTRUYEN los servicios de editor-core en orden de dependencia
 * (adapter → preview → lift → controller → fonts/colores/píxeles), UNA vez por
 * documento, y se DISPONEN al desmontar (DisposableList). Los gotchas de v1
 * mueren estructuralmente (audit §3.5): sin refs espejo (useLedger suscribe),
 * sin TDZ de callbacks (constructor injection), sin deps de effect que
 * envenenar (los servicios se suscriben una vez al ledger).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageGraph, SegmentNode } from '@aldus/core';
import {
  MousePointer2, Pilcrow, TextCursorInput, SquareCheck, CircleDot,
  SquareChevronDown, Signature, ImagePlus, Droplets, PanelTop,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Check, Undo2, Redo2, Sparkles,
  Bold, Italic, Underline, List, AlignLeft, Highlighter, Link2, Trash2, type LucideIcon,
} from 'lucide-react';
import {
  AldusApi,
  ColorSampler,
  EditLedgerAdapter,
  FontRegistryService,
  ImagePixelCache,
  LiftService,
  PreviewService,
  TextEditController,
  type LiftEntry,
  type PendingHighlight,
} from '../core/index.js';
import { FB_DOCK_ID } from './toolbar.js';
import { PdfCanvas } from './PdfCanvas.js';
import { NodeOverlay } from './overlay/NodeOverlay.js';
import { Inspector } from './Inspector.js';
import { AgentPanel } from './AgentPanel.js';
import { Button, IconButton, Toast, cx } from './ui/primitives.js';
import { WatermarkDialog, HeaderFooterDialog, LinkDialog } from './ui/dialogs.js';
import { HostBoxLayer, type HostBox } from './boxes/HostBoxLayer.js';
import { useLedger } from './hooks/useLedger.js';
import { useLocks } from './hooks/useLocks.js';
import { useAreaWidths } from './hooks/useAreaWidths.js';
import { usePlacement, type Placing } from './hooks/usePlacement.js';
import { useEditorHotkeys } from './hooks/useEditorHotkeys.js';
import { captureDebug, pdfDebugEnabled } from './debug/capture.js';

type Dialog =
  | null
  | { kind: 'watermark' }
  | { kind: 'headerFooter' }
  | { kind: 'link'; target: { page: number; x: number; y: number; width: number; height: number } };

interface NavTool { id: string; icon: LucideIcon; label: string; short: string; placing: Placing }
const NAV_GROUPS: Array<{ label: string; tools: NavTool[] }> = [
  {
    label: 'Texto',
    tools: [
      // Lista = un FORMATO del texto (toggle de viñeta en la barra flotante),
      // no un componente aparte.
      { id: 'text', icon: Pilcrow, short: 'Texto', label: 'Texto (la viñeta se activa desde la barra del objeto; Enter continúa listas)', placing: { kind: 'text' } },
    ],
  },
  {
    label: 'Forms',
    tools: [
      { id: 'field-text', icon: TextCursorInput, short: 'Texto', label: 'Campo de texto', placing: { kind: 'field', type: 'text' } },
      { id: 'field-checkbox', icon: SquareCheck, short: 'Check', label: 'Checkbox', placing: { kind: 'field', type: 'checkbox' } },
      { id: 'field-radio', icon: CircleDot, short: 'Radios', label: 'Grupo de radios (agregá opciones desde el panel)', placing: { kind: 'field', type: 'radio' } },
      { id: 'field-select', icon: SquareChevronDown, short: 'Select', label: 'Select (editá las opciones desde el panel)', placing: { kind: 'field', type: 'select' } },
      { id: 'field-signature', icon: Signature, short: 'Firma', label: 'Campo de firma', placing: { kind: 'field', type: 'signature' } },
    ],
  },
];

/** Ítem del rail: icono + label chico debajo + tooltip. El label visible hace el
 *  rail auto-explicativo (además del title nativo). */
function RailItem({ icon: Icon, label, hint, active, onClick }:
  { icon: LucideIcon; label: string; hint?: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      title={hint ?? label}
      aria-label={hint ?? label}
      onClick={onClick}
      className={cx(
        'flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 transition-colors',
        active ? 'bg-blue-50 text-blue-600 ring-1 ring-blue-200' : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800',
      )}
    >
      <Icon size={18} strokeWidth={1.8} />
      <span className="text-[9.5px] font-medium leading-none tracking-tight">{label}</span>
    </button>
  );
}

/** Encabezado de grupo del rail (chico, gris, con línea sutil). */
function RailGroup({ label }: { label: string }) {
  return <div className="mt-3 mb-1 w-full px-1 text-center text-[8.5px] font-semibold uppercase tracking-[0.12em] text-neutral-300 select-none">{label}</div>;
}

/** Props del COMPONENTE embebible (la API pública de `aldus-editor`): un host
 *  monta el editor completo dentro de SU app — sin router, sin marca impuesta. */
export interface AldusEditorProps {
  /** Id del documento en el host (se interpola en las rutas del API). */
  docId: string;
  /** El cliente del wire (default: la instancia compartida `aldusApi`,
   *  configurable con `configureAldusApi`). */
  api?: AldusApi;
  /** Botón "volver" del header — el host decide a dónde. Ausente → brand. */
  onExit?: () => void;
  /** Nodo de marca en el header (default: "Aldus"). */
  brand?: ReactNode;
  /** Botón/panel del agente LLM (default true). */
  agent?: boolean;
  /** Grupo de herramientas de CAMPOS del rail (default true — un e-sign host
   *  coloca campos con su propia semántica de firmantes y lo apaga). */
  formTools?: boolean;
  /** Tabs del HOST en el panel derecho (Firmantes, Wax…) — se suman a la tab
   *  "Campos" (el Inspector de propiedades del nodo). Sin tabs = panel clásico. */
  panelTabs?: Array<{ id: string; label: ReactNode; content: ReactNode }>;
  /** false = sin la tab "Campos" del Inspector (el host trae sus propias tabs). */
  inspectorTab?: boolean;
  /** Tab activa del panel (controlada por el host). Con onPanelTabChange = controlled. */
  panelTab?: string | null;
  onPanelTabChange?: (id: string | null) => void;
  /** Nodo fijo al PIE del panel derecho (ej: el input del agente del host). */
  panelFooter?: ReactNode;
  /** Controles del HOST en la top bar, JUSTO a la izquierda de "Aplicar"
   *  (ej: un toggle de mostrar/ocultar etiquetas). */
  headerActions?: ReactNode;
  /** Cajas del HOST sobre la página (firmas/campos por firmante) — ver HostBoxLayer. */
  hostBoxes?: HostBox[];
  selectedHostBoxId?: string | null;
  onHostBoxSelect?: (id: string | null) => void;
  onHostBoxChange?: (box: { id: string; page: number; x: number; y: number; width: number; height: number }) => void;
  /** Click derecho sobre una caja del host → menú contextual del host. */
  onHostBoxContextMenu?: (id: string, at: { x: number; y: number }) => void;
  /** Herramientas del HOST en el rail (grupo "Campos"): click → modo colocación →
   *  click en la página reporta el punto en puntos PDF. */
  hostTools?: Array<{ id: string; label: string; icon: LucideIcon }>;
  onHostToolPlace?: (toolId: string, at: { page: number; x: number; y: number }) => void;
  /** Bump = recargar el documento del server (el host lo editó por fuera). */
  refreshKey?: number;
}

/** El paquete de servicios de UNA sesión de documento — construido en orden de
 *  dependencia, dispuesto entero al desmontar/cambiar de doc. */
interface Session {
  api: AldusApi;
  adapter: EditLedgerAdapter;
  preview: PreviewService;
  lift: LiftService;
  controller: TextEditController;
  fonts: FontRegistryService;
  colors: ColorSampler;
  pixels: ImagePixelCache;
  dispose(): void;
}

function buildSession(id: string, api: AldusApi, onError: (m: string) => void): Session {
  const adapter = new EditLedgerAdapter();
  const preview = new PreviewService({ id, api, ledger: adapter, onError });
  const lift = new LiftService({ preview, ledger: adapter });
  const controller = new TextEditController();
  const fonts = new FontRegistryService();
  const colors = new ColorSampler();
  const pixels = new ImagePixelCache();
  return {
    api, adapter, preview, lift, controller, fonts, colors, pixels,
    dispose() {
      // Orden inverso a la construcción.
      pixels.dispose();
      colors.dispose();
      fonts.dispose();
      controller.dispose();
      lift.dispose();
      preview.dispose();
      adapter.dispose();
    },
  };
}

/** La instancia COMPARTIDA del cliente (la que `configureAldusApi` reconfigura
 *  y la que usa el modo forense — una sola, audit §1.1). */
const defaultApiBase = (): string => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_API_BASE?.replace(/\/+$/, '')
    ?? `${(env?.BASE_URL ?? '').replace(/\/+$/, '')}/api`;
};
export const aldusApi = new AldusApi({ apiBase: defaultApiBase() });

/** Configuración del editor embebido — llamar ANTES de montar <AldusEditor>. */
export function configureAldusApi(opts: { apiBase: string }): void {
  aldusApi.configure(opts);
}

/**
 * El EDITOR como componente. Router-free: el host provee docId/salida.
 */
export function AldusEditor({
  docId, api: apiProp, onExit, brand, agent = true, formTools = true, panelTabs, inspectorTab = true,
  panelTab, onPanelTabChange, panelFooter, headerActions,
  hostBoxes, selectedHostBoxId, onHostBoxSelect, onHostBoxChange, onHostBoxContextMenu,
  hostTools, onHostToolPlace, refreshKey,
}: AldusEditorProps) {
  const id = docId;
  const api = apiProp ?? aldusApi;

  const [docVersion, setDocVersion] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('aldus-zoom') || '');
    return Number.isFinite(saved) && saved >= 0.5 && saved <= 3 ? saved : 1.5;
  });
  const [graph, setGraph] = useState<PageGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // El panel del agente arranca ABIERTO (es el corazón del producto); el toggle
  // de la toolbar sigue permitiendo cerrarlo.
  const [aiOpen, setAiOpen] = useState(true);
  // Tab activa del panel derecho cuando el host inyecta panelTabs (null = "Campos").
  // Controlada si el host pasa panelTab+onPanelTabChange; si no, interna.
  const [hostTabState, setHostTabState] = useState<string | null>(() => panelTabs?.length ? panelTabs[0]!.id : null);
  const hostTab = panelTab !== undefined ? panelTab : hostTabState;
  const setHostTab = useCallback((t: string | null) => {
    if (onPanelTabChange) onPanelTabChange(t);
    if (panelTab === undefined) setHostTabState(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPanelTabChange, panelTab]);
  // Colocación de una herramienta del HOST (rail "Campos" del host).
  const [hostPlacing, setHostPlacing] = useState<string | null>(null);
  // Editor de texto ABIERTO: el lift se congela (ver LiftService).
  const [editingActive, setEditingActive] = useState(false);
  const [baking, setBaking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [highlightColor, setHighlightColor] = useState<string>(() => localStorage.getItem('aldus-hl') || '#ffd400');
  const setHl = useCallback((c: string) => { setHighlightColor(c); localStorage.setItem('aldus-hl', c); }, []);
  const errorRef = useRef(setError);
  errorRef.current = setError;

  // ── LA SESIÓN: los servicios por documento, con dispose al desmontar ──
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const s = buildSession(id, api, m => errorRef.current(m));
    setSession(s);
    setGraph(null);
    setSelectedId(null);
    setPdf(null);
    return () => s.dispose();
  }, [id, api]);

  // El host editó el doc por fuera (su API / su agente) → recargar del server.
  const refreshSeen = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey !== refreshSeen.current) {
      refreshSeen.current = refreshKey;
      setDocVersion(v => v + 1);
    }
  }, [refreshKey]);
  // Nueva revisión del server (op instantánea / Aplicar / refreshKey).
  useEffect(() => {
    if (session && docVersion > 0) void session.preview.reload(docVersion);
  }, [session, docVersion]);

  // El documento del preview (bytes re-horneados, parseado) — evento → estado.
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  useEffect(() => {
    if (!session) return;
    setPdf(session.preview.currentPdf);
    const sub = session.preview.onPreviewReady(doc => setPdf(doc));
    return () => sub.dispose();
  }, [session]);

  // El LIFT vigente (evento del servicio → estado que consume PdfCanvas).
  const [liftEntry, setLiftEntry] = useState<LiftEntry | null>(null);
  useEffect(() => {
    if (!session) return;
    setLiftEntry(session.lift.current);
    const sub = session.lift.onLiftChanged(e => setLiftEntry(e));
    return () => sub.dispose();
  }, [session]);
  // Selección/edición → preparar (u olvidar) el lift.
  useEffect(() => {
    session?.lift.select(selectedId, editingActive);
  }, [session, selectedId, editingActive]);
  // Nodo en ARRASTRE (estado de render del gesto; la máquina vive en LiftService).
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const handleDragging = useCallback((segId: string, active: boolean, committed = false) => {
    setDraggingId(active ? segId : null);
    session?.lift.onDragging(segId, active, committed);
  }, [session]);

  // Toast efímero.
  useEffect(() => {
    if (!notice && !error) return;
    const t = setTimeout(() => { setNotice(''); setError(''); }, 3200);
    return () => clearTimeout(t);
  }, [notice, error]);

  // ── Estado pendiente (suscripción al ledger) ──
  const adapter = session?.adapter ?? null;
  const view = useLedger(adapter ?? fallbackAdapter());

  // Las operaciones INSTANTÁNEAS de server (crear texto/imagen/campo,
  // watermark, encabezado, links) entran al historial como COMANDOS:
  // deshacer = restaurar la revisión previa del server; rehacer = re-ejecutar
  // la operación. Sin esto, Ctrl+Z no deshacía haber creado un nodo.
  const registerServerOp = useCallback((redo: () => Promise<unknown>) => {
    adapter?.history.pushCommand({
      undo: () => api.revert(id)
        .then(() => setDocVersion(v => v + 1))
        .catch(e => setError(e instanceof Error ? e.message : 'No se pudo deshacer')),
      redo: () => redo()
        .then(() => setDocVersion(v => v + 1))
        .catch(e => setError(e instanceof Error ? e.message : 'No se pudo rehacer')),
    });
  }, [adapter, api, id]);

  const { locked, toggleLock } = useLocks(id, graph);
  const { areaWidths, onAreaWidth } = useAreaWidths(id);

  // ── Modo forense 🐞 (server ALDUS_DEBUG=1 + ?debug=1 en la URL) ──
  // Captura el estado COMPLETO (grafo al click, nodo, edits pendientes, trace)
  // → bundle en /tmp/aldus-debug/ con un repro.mts pre-armado. Ctrl+Alt+D o el botón.
  const debugMode = useMemo(() => pdfDebugEnabled(), []);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const captureForensics = useCallback(async () => {
    try {
      await captureDebug(api, {
        docId: id, page: pageNum, nodeId: selectedId, graph: graphRef.current,
        edits: view.edits, imageEdits: view.imageEdits, widgetEdits: view.widgetEdits,
        highlightEdits: view.highlightEdits, linkEdits: view.linkEdits,
        pendingHighlights: [...view.pendingHighlights],
      });
      setNotice('🐞 Copiado al portapapeles — pegáselo a Claude en el chat (y describí el síntoma).');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'La captura forense falló.');
    }
  }, [api, id, pageNum, selectedId, view]);
  useEffect(() => {
    if (!debugMode) return;
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'd') { e.preventDefault(); void captureForensics(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [debugMode, captureForensics]);

  // ── Colocación (paleta → click) ──
  const { placing, setPlacing, imageFileRef, onPlace, onAddText, matchInsertedText } = usePlacement({
    api, id, pageNum, graph,
    onBumpDoc: () => setDocVersion(v => v + 1),
    onNotice: setNotice,
    onError: setError,
    onAreaWidth,
    onSelect: setSelectedId,
    onServerOp: registerServerOp,
  });

  // El grafo nuevo llegó = el preview aterrizó (el canvas ya blitteó el
  // render nuevo → recién ahora es seguro soltar el lift).
  const handleGraph = useCallback((g: PageGraph) => {
    setGraph(g);
    adapter?.setGraph(g);
    session?.lift.previewLanded();
    matchInsertedText(g);
  }, [adapter, session, matchInsertedText]);

  // Operaciones de documento. HIGHLIGHT acumula (preview local, se escribe con
  // Aplicar); el resto (links, watermark, enc/pie, texto nuevo) son acciones
  // deliberadas de diálogo y van directo.
  const docOp = useCallback((action: string, params: Record<string, unknown>) => {
    if (action === 'highlight') {
      // Uno solo (FloatingBar) o varios de una (grupo: { items: [...] }).
      const items = Array.isArray(params.items)
        ? (params.items as PendingHighlight[])
        : [params as unknown as PendingHighlight];
      adapter?.addHighlights(items);
      return;
    }
    if (action === 'unhighlight') {
      // Toggle "quitar" del pendiente (aún sin Aplicar) — no apila.
      adapter?.removePendingHighlightsFor(params.segmentId as string);
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
  }, [adapter, api, id, registerServerOp]);

  // Convertir un segmento/rect en link: abre el modal (no más window.prompt).
  const requestLink = useCallback((target: { page: number; x: number; y: number; width: number; height: number }) => {
    setDialog({ kind: 'link', target });
  }, []);

  const cancelPlacing = useCallback(() => { setPlacing(null); setHostPlacing(null); }, [setPlacing]);
  // Click en la página: una herramienta del host activa gana; si no, el flujo normal.
  const handlePlace = useCallback((x: number, y: number) => {
    if (hostPlacing) {
      const tool = hostPlacing;
      setHostPlacing(null);
      onHostToolPlace?.(tool, { page: pageNum, x, y });
      return;
    }
    onPlace(x, y);
  }, [hostPlacing, onHostToolPlace, pageNum, onPlace]);

  // Segmentos editados = extirpados del preview → el overlay los dibuja como
  // FANTASMAS (nodo original cacheado + edición aplicada, transparente).
  const phantomSegments = useMemo(() => {
    if (!adapter) return [];
    const out: SegmentNode[] = [];
    for (const e of view.edits.values()) {
      if (e.page !== pageNum) continue;
      const s = adapter.findSeg(e.segmentId);
      if (s) out.push(s);
    }
    return out;
  }, [adapter, view.edits, pageNum]);

  // El grafo que ven hotkeys/registry: fantasmas incluidos (dedupe por id).
  const overlayGraph = useMemo(() => {
    if (!graph) return null;
    const inGraph = new Set(graph.segments.map(s => s.id));
    return { ...graph, segments: [...graph.segments, ...phantomSegments.filter(s => !inGraph.has(s.id))] };
  }, [graph, phantomSegments]);

  useEditorHotkeys({
    pdf, pageNum, setPageNum, selectedId, setSelectedId,
    graph: graph?.page === pageNum ? overlayGraph : null,
    ledger: adapter ?? fallbackAdapter(),
    findSeg: sid => adapter?.findSeg(sid) ?? null,
    cancelPlacing,
  });

  const setZoom = useCallback((s: number) => {
    const clamped = Math.min(3, Math.max(0.5, Math.round(s * 100) / 100));
    setScale(clamped);
    localStorage.setItem('aldus-zoom', String(clamped));
  }, []);

  const bake = useCallback(async () => {
    if (!session || !adapter) return;
    setBaking(true);
    setError('');
    try {
      // `toBakeInput()` ya aplica promoteMovedImages (regla en UN solo sitio,
      // core): las imágenes movidas/escaladas suben al frente al guardar.
      const all = adapter.toBakeInput();
      const pick = <K extends typeof all[number]['kind']>(k: K) =>
        all.filter(e => e.kind === k).map(({ kind: _kind, ...rest }) => rest);
      const r = await api.bake(
        id,
        pick('segment') as never,
        pick('image') as never,
        pick('widget') as never,
        session.preview.resolveHighlights() as unknown as Array<Record<string, unknown>>,
        pick('highlight') as never,
        pick('link') as never,
        pick('shape') as never,
      );
      adapter.clearAll();
      setSelectedId(null);
      setDocVersion(v => v + 1);
      setNotice(r.warnings.length ? `Aplicado con avisos: ${r.warnings.join(' · ')}` : `Aplicado (${r.applied.length})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aplicar');
    } finally {
      setBaking(false);
    }
  }, [session, adapter, api, id]);

  const numPages = pdf?.numPages ?? 0;
  const totalEdits = view.totalEdits;
  // Highlights PENDIENTES de la página = capa overlay (no horneada; ver
  // PreviewService): se anclan a su segmento y lo siguen al arrastrar.
  const pageHighlights = useMemo(() => view.pendingHighlights.filter(h => h.page === pageNum), [view.pendingHighlights, pageNum]);

  // ¿Hay un nodo DOCKEABLE seleccionado (segmento/imagen/campo/forma, no
  // bloqueado)? Su barra (FloatingBar / ObjectBar) se acopla al grupo del
  // header vía portal; si no, el header muestra el placeholder deshabilitado.
  // Links/resaltados tienen su propio control inline → también van al placeholder.
  const dockActive = useMemo(() => {
    if (!selectedId || locked.has(selectedId) || !graph) return false;
    return graph.segments.some(s => s.id === selectedId)
      || phantomSegments.some(s => s.id === selectedId)
      || graph.images.some(i => i.id === selectedId)
      || graph.widgets.some(w => w.id === selectedId)
      || (graph.shapes ?? []).some(sh => sh.id === selectedId);
  }, [selectedId, locked, graph, phantomSegments]);

  const toolActive = (p: Placing): boolean =>
    !!placing && !!p && placing.kind === p.kind &&
    (p.kind !== 'field' || (placing.kind === 'field' && placing.type === p.type));

  // El Inspector como COLUMNA reutilizable: solo, o embebido como tab "Campos"
  // cuando el host inyecta panelTabs (aldus-panel-embed lo desviste vía CSS).
  const InspectorColumn = () => (adapter ? (
    <Inspector
      graph={graph?.page === pageNum ? graph : null}
      selectedId={selectedId} onSelect={setSelectedId}
      ledger={adapter}
      edits={view.edits}
      imageEdits={view.imageEdits}
      widgetEdits={view.widgetEdits}
      highlightEdits={view.highlightEdits}
      linkEdits={view.linkEdits}
      locked={locked} onToggleLock={toggleLock}
      onDocOp={docOp} onRequestLink={requestLink}
    />
  ) : null);

  return (
    // `aldus-editor` = scope del mini-reset de la build de librería (styles-lib.css).
    <div className="aldus-editor flex h-full flex-col bg-neutral-50 text-neutral-800">
      {/* ── Modo forense 🐞: captura el nodo seleccionado + estado → /tmp (Ctrl+Alt+D) ── */}
      {debugMode && (
        <button
          onClick={() => void captureForensics()}
          title={`Capturar bundle forense en /tmp/aldus-debug (Ctrl+Alt+D)${selectedId ? ` — nodo ${selectedId}` : ' — sin nodo seleccionado (captura la página)'}`}
          className="fixed bottom-4 left-4 z-[70] flex h-9 items-center gap-1.5 rounded-full border border-amber-400 bg-amber-100 px-3 text-[12px] font-semibold text-amber-800 shadow hover:bg-amber-200"
        >
          🐞 {selectedId ? `capturar ${selectedId}` : 'capturar página'}
        </button>
      )}
      {/* ── Top bar ── */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-3">
        {onExit && (
          // Embebido en un host: "volver" regresa a la app del host. Compacto
          // (un chevron + texto chico) para no robarle aire a la top bar.
          <button onClick={onExit} title="Volver" className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-[13px] font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800">
            <ChevronLeft size={16} /> Volver
          </button>
        )}
        {brand ?? (!onExit && (
          <span className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-neutral-900">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-blue-600 text-white text-[13px] font-bold">A</span>
            Aldus
          </span>
        ))}

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
          <IconButton icon={Undo2} label="Deshacer (Ctrl+Z)" disabled={!view.canUndo} onClick={() => adapter?.history.undo()} />
          <IconButton icon={Redo2} label="Rehacer (Ctrl+Shift+Z)" disabled={!view.canRedo} onClick={() => adapter?.history.redo()} />
        </div>

        <div className="mx-1 h-6 w-px bg-neutral-200" />

        {/* ── Barra del objeto seleccionado, ACOPLADA al header ──
            El dock vive SIEMPRE montado (target estable del portal de
            FloatingBar/ObjectBar). Sin nodo dockeable → placeholder gris. */}
        <div className="relative flex items-center">
          <div id={FB_DOCK_ID} className="flex items-center gap-1" />
          {!dockActive && (
            <div className="fb-dock-ph" aria-hidden title="Seleccioná un texto u objeto para editarlo">
              {[Bold, Italic, Underline, List].map((Icon, i) => <span key={i} className="fb-btn"><Icon size={14} /></span>)}
              <span className="fb-sep" />
              <span className="fb-btn"><AlignLeft size={14} /></span>
              <span className="fb-sep" />
              {[Highlighter, Link2, Trash2].map((Icon, i) => <span key={i} className="fb-btn"><Icon size={14} /></span>)}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {(placing || hostPlacing) && <span className="hidden text-[12px] text-blue-600 lg:inline">Click en la página · Esc cancela</span>}

        {agent && (
          <button
            onClick={() => setAiOpen(o => !o)}
            title="Aldus AI — preguntá o pedí cambios"
            className={cx('flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors',
              aiOpen ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50')}
          >
            <Sparkles size={15} /> AI
          </button>
        )}

        {headerActions}

        <Button variant="primary" disabled={baking || totalEdits === 0} onClick={() => void bake()}>
          <Check size={15} strokeWidth={2.5} />
          {baking ? 'Aplicando…' : `Aplicar${totalEdits ? ` (${totalEdits})` : ''}`}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── Rail de herramientas (izquierda), agrupado por categoría ── */}
        <nav className="thin-scroll flex shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-neutral-200 bg-white px-1.5 py-2.5" style={{ width: 72 }}>
          <RailItem icon={MousePointer2} label="Elegir" hint="Seleccionar (Esc)" active={!placing && !hostPlacing} onClick={() => { setPlacing(null); setHostPlacing(null); }} />
          {NAV_GROUPS.filter(g => formTools || g.label !== 'Forms').map(g => (
            <div key={g.label} className="flex w-full flex-col items-center gap-1">
              <RailGroup label={g.label} />
              {g.tools.map(t => (
                <RailItem key={t.id} icon={t.icon} label={t.short} hint={t.label} active={toolActive(t.placing)}
                  onClick={() => setPlacing(() => (toolActive(t.placing) ? null : t.placing))} />
              ))}
            </div>
          ))}
          {/* Herramientas del HOST (campos con semántica del host: firmas, fechas…) */}
          {hostTools?.length ? (
            <div className="flex w-full flex-col items-center gap-1">
              <RailGroup label="Campos" />
              {hostTools.map(t => (
                <RailItem key={t.id} icon={t.icon} label={t.label} active={hostPlacing === t.id}
                  onClick={() => { setPlacing(null); setHostPlacing(p => (p === t.id ? null : t.id)); }} />
              ))}
            </div>
          ) : null}
          <RailGroup label="Objetos" />
          <RailItem icon={ImagePlus} label="Imagen" hint="Insertar imagen (PNG/JPEG)" active={placing?.kind === 'image'} onClick={() => imageFileRef.current?.click()} />
          <input ref={imageFileRef} type="file" accept="image/png,image/jpeg" hidden
            onChange={e => { const f = e.target.files?.[0]; if (f) setPlacing({ kind: 'image', file: f }); e.target.value = ''; }} />
          <RailGroup label="Doc" />
          <RailItem icon={Droplets} label="Marca" hint="Marca de agua (todas las páginas)" onClick={() => setDialog({ kind: 'watermark' })} />
          <RailItem icon={PanelTop} label="Encab." hint="Encabezado y pie de página" onClick={() => setDialog({ kind: 'headerFooter' })} />
        </nav>

        {/* ── Área de la página ── */}
        <main className={cx('thin-scroll flex flex-1 justify-center overflow-auto p-8', placing && 'cursor-crosshair')}>
          {pdf && session && adapter ? (
            <div className="h-max">
              <PdfCanvas
                pdf={pdf} pageNum={pageNum} scale={scale}
                services={{ fonts: session.fonts, colors: session.colors, pixels: session.pixels }}
                onGraph={handleGraph}
                lift={liftEntry} draggingId={draggingId}
              >
                {({ snapshot, imagePixels }) => (
                  <>
                    {graph?.page === pageNum && graph && (
                      <NodeOverlay
                        graph={graph}
                        scale={scale}
                        ledger={adapter}
                        controller={session.controller}
                        edits={view.edits}
                        imageEdits={view.imageEdits}
                        shapeEdits={view.shapeEdits}
                        widgetEdits={view.widgetEdits}
                        highlightEdits={view.highlightEdits}
                        linkEdits={view.linkEdits}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        locked={locked}
                        placing={placing != null || hostPlacing != null}
                        onPlace={handlePlace}
                        snapshot={snapshot}
                        imagePixels={imagePixels}
                        onDocOp={docOp}
                        onRequestLink={requestLink}
                        onAddText={onAddText}
                        highlights={pageHighlights}
                        highlightColor={highlightColor}
                        onHighlightColor={setHl}
                        phantomSegments={phantomSegments}
                        onDragging={handleDragging}
                        areaWidths={areaWidths}
                        onAreaWidth={onAreaWidth}
                        onEditingChange={setEditingActive}
                      />
                    )}
                    {graph && hostBoxes?.length ? (
                      <HostBoxLayer
                        boxes={hostBoxes.filter(b => b.page === pageNum)}
                        scale={scale}
                        pageHeight={graph.height}
                        selectedId={selectedHostBoxId ?? null}
                        onSelect={boxId => { setSelectedId(null); onHostBoxSelect?.(boxId); }}
                        onChange={onHostBoxChange}
                        onContextMenu={onHostBoxContextMenu}
                      />
                    ) : null}
                  </>
                )}
              </PdfCanvas>
            </div>
          ) : (
            <p className="mt-24 text-[13px] text-neutral-400">{error || 'Abriendo el PDF…'}</p>
          )}
        </main>

        {/* ── Panel derecho: tabs del host + "Campos" (Inspector) ── */}
        {panelTabs?.length ? (
          <div className="flex w-[300px] shrink-0 flex-col border-l border-neutral-200 bg-white">
            <div className="flex shrink-0 border-b border-neutral-200">
              {[...panelTabs.map(t => ({ id: t.id as string | null, label: t.label })), ...(inspectorTab ? [{ id: null as string | null, label: 'Campos' as ReactNode }] : [])].map(t => (
                <button
                  key={String(t.id)}
                  onClick={() => setHostTab(t.id)}
                  className={cx('flex-1 border-b-2 py-2 text-[12px] transition-colors',
                    hostTab === t.id ? 'border-blue-600 font-medium text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600')}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="aldus-panel-embed thin-scroll min-h-0 flex-1 overflow-y-auto">
              {hostTab != null
                ? panelTabs.find(t => t.id === hostTab)?.content
                : (inspectorTab ? <InspectorColumn /> : null)}
            </div>
            {panelFooter && <div className="shrink-0 border-t border-neutral-200">{panelFooter}</div>}
          </div>
        ) : (
          <InspectorColumn />
        )}
        {/* ── Panel del agente (derecha, toggleable) ── */}
        {agent && aiOpen && adapter && (
          <AgentPanel
            api={api}
            docId={id}
            page={pageNum}
            edits={view.edits}
            imageEdits={view.imageEdits}
            onApply={(segEdits, imgEdits) => adapter.applyAgentEdits(segEdits, imgEdits)}
            onReload={() => { adapter.clearAll(); setSelectedId(null); setDocVersion(v => v + 1); }}
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

// Un adaptador vacío ESTABLE para el primer render (la sesión real llega en el
// primer effect) — evita `null` en los hooks que exigen un adapter.
let _fallback: EditLedgerAdapter | null = null;
function fallbackAdapter(): EditLedgerAdapter {
  if (!_fallback) _fallback = new EditLedgerAdapter();
  return _fallback;
}
