/**
 * NodeOverlay — los nodos del grafo como boxes sobre el canvas.
 *
 * La unidad de edición es el SEGMENTO (modelo Acrobat/Foxit): runs contiguos
 * anclados a su x; los gaps de columna son FRONTERAS entre segmentos. El estilo
 * (bold/italic) vive POR TRAMO (StyledRun) y siempre viaja por el modelo — ver
 * styledDom.ts (proyección modelo↔DOM).
 *
 * Este archivo es la RAÍZ de composición del overlay: consume el REGISTRY
 * `INodeKind` (v2 — mata las 4 cascadas if-por-tipo que tenía acá v1:
 * nodeCssRect, moveGroup, marquee test y group delete), el editor singleton
 * (TextEditController, montado UNA vez — inmune al churn de grafos/previews)
 * y el marquee de selección múltiple.
 *
 * Interacción: click = seleccionar · seleccionado + arrastrar = mover ·
 *  doble click = editar in situ (Cmd/Ctrl+B/I = estilo a la selección) ·
 *  grip = escalar.
 */
import { useEffect, useRef, useState } from 'react';
import {
  cssPointToPdf,
  pdfRectToCss,
  type HighlightEdit,
  type HighlightNode,
  type ImageEdit,
  type LinkEdit,
  type PageGraph,
  type RectNode,
  type SegmentEdit,
  type SegmentNode,
  type ShapeEdit,
  type WidgetEdit,
} from '@aldus/core';
import { log, round1, type EditLedgerAdapter, type HighlightSyncAction, type TextEditController } from '../../core/index.js';
import { effectiveRectOf, moveNode, nodeKinds, removeNode } from '../boxes/registry.js';
import { GroupBox } from '../boxes/GroupBox.js';
import type { AddTextRequest, OverlayCtx, OverlayHighlight } from '../boxes/types.js';

interface Props {
  graph: PageGraph;
  scale: number;
  ledger: EditLedgerAdapter;
  controller: TextEditController;
  /** Snapshot VIGENTE de las colecciones de edits (de `ledger.ledger.snapshot()`,
   *  re-derivado por el hook useLedger en cada cambio). */
  edits: ReadonlyMap<string, SegmentEdit>;
  imageEdits: ReadonlyMap<string, ImageEdit>;
  shapeEdits: ReadonlyMap<string, ShapeEdit>;
  widgetEdits: ReadonlyMap<string, WidgetEdit>;
  highlightEdits: ReadonlyMap<string, HighlightEdit>;
  linkEdits: ReadonlyMap<string, LinkEdit>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Nodos bloqueados: invisibles al mouse (ni hover ni drag). */
  locked: Set<string>;
  /** Modo colocación: el próximo click en la página crea un nodo. */
  placing: boolean;
  onPlace: (x: number, y: number) => void;
  /** Snapshot de la página renderizada (para previews de imágenes movidas). */
  snapshot: { url: string; width: number; height: number } | null;
  /** imageId → dataURL de píxeles limpios (transparencia real) para el ghost. */
  imagePixels: Map<string, string>;
  /** Operación de documento instantánea (highlight, addLink…). */
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  /** Abre el modal de link para un rect. */
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  /** Enter al final de un ítem de lista → crear el siguiente. */
  onAddText: (req: AddTextRequest) => void;
  /** Resaltados pendientes de la página (capa overlay, no horneada): anclados
   *  a su segmento lo siguen al arrastrar; los huérfanos se dibujan sueltos. */
  highlights: OverlayHighlight[];
  /** Color del resaltador (persistido) + su setter. */
  highlightColor: string;
  onHighlightColor: (c: string) => void;
  /** Segmentos editados (extirpados del preview): se dibujan desde el cache. */
  phantomSegments: SegmentNode[];
  /** Arranque/fin del arrastre de un nodo. En el fin, `committed` dice si
      el drop produjo una edición (false = no-op → restaurar el canvas). */
  onDragging: (segId: string, active: boolean, committed?: boolean) => void;
  /** Ancho de ÁREA tipeable por segmento (pt) — el grip la amplía. */
  areaWidths: Map<string, { w?: number; h?: number }>;
  onAreaWidth: (segId: string, area: { w?: number; h?: number } | null) => void;
  /** Hay un editor de texto abierto (se usa para saltear el lift). */
  onEditingChange: (active: boolean) => void;
}

export function NodeOverlay({ graph, scale, ledger, controller, edits, imageEdits, shapeEdits, widgetEdits, highlightEdits, linkEdits, selectedId, onSelect, locked, placing, onPlace, snapshot, imagePixels, onDocOp, onRequestLink, onAddText, highlights, highlightColor, onHighlightColor, phantomSegments, onDragging, areaWidths, onAreaWidth, onEditingChange }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => { onEditingChange(editingId != null); }, [editingId, onEditingChange]);
  // Cambio de página con editor abierto: cerrarlo (con commit) — llamada
  // EXPLÍCITA al controller (v1 forzaba el blur del DOM).
  useEffect(() => { controller.commitAndClose(); /* no-op si está cerrado */ }, [graph.page, controller]);

  // EL editor (singleton, imperativo, SIN React): su host se monta UNA sola
  // vez en el overlay — inmune al churn de grafos/previews.
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = overlayRef.current;
    if (!root) return;
    root.appendChild(controller.el);
    return () => { if (controller.el.parentNode === root) root.removeChild(controller.el); };
  }, [controller]);
  // El controller avisa su ciclo de vida por el evento de estilo: null = cerró.
  useEffect(() => {
    const sub = controller.onStyleStateChanged(state => { if (state == null) setEditingId(null); });
    return () => sub.dispose();
  }, [controller]);

  const openSegEditor = (seg: SegmentNode) => {
    const edit = edits.get(seg.id) ?? null;
    setEditingId(seg.id);
    controller.open({
      seg,
      edit,
      scale,
      pageHeight: graph.height,
      minWidthCss: (areaWidths.get(seg.id)?.w ?? 0) * scale,
      minHeightCss: (areaWidths.get(seg.id)?.h ?? 0) * scale,
      onPatch: patch => ledger.patchSegment(seg, patch),
    });
  };

  // Cuando una FontFace termina de cargar (las estables del fontRegistry son
  // async), re-render: los fantasmas re-siembran su HTML midiendo con la
  // fuente REAL — sin esto quedaban medidos/renderizados con el fallback.
  const [, setFontsTick] = useState(0);
  useEffect(() => {
    const bump = () => setFontsTick(t => t + 1);
    document.fonts.addEventListener('loadingdone', bump);
    return () => document.fonts.removeEventListener('loadingdone', bump);
  }, []);

  // Segmentos a dibujar: los del grafo del preview + los FANTASMAS editados
  // (extirpados del preview). Dedupe defensivo por id.
  const inGraph = new Set(graph.segments.map(s => s.id));
  const allSegments = [...graph.segments, ...phantomSegments.filter(s => !inGraph.has(s.id))];
  // El grafo que ve el REGISTRY: los fantasmas cuentan como segmentos (para
  // marquee/move/delete/rects) — una sola vez, acá.
  const overlayGraph: PageGraph = { ...graph, segments: allSegments };

  // Resaltados pendientes por segmento (los renderiza su SegmentBox como capa
  // hija → heredan su transform y lo siguen al arrastrar). Los que no matchean
  // ningún segmento presente ("huérfanos") se dibujan sueltos, quietos.
  const segIds = new Set(allSegments.map(s => s.id));
  const hlBySeg = new Map<string, OverlayHighlight[]>();
  const orphanHls: OverlayHighlight[] = [];
  for (const h of highlights) {
    if (h.segmentId && segIds.has(h.segmentId)) {
      hlBySeg.set(h.segmentId, [...(hlBySeg.get(h.segmentId) ?? []), h]);
    } else {
      orphanHls.push(h);
    }
  }

  // ── RESALTADOS GUARDADOS pegados a su texto ──
  // Un HighlightNode de /Annots se ASOCIA por geometría (solape de rects
  // ORIGINALES — estable: no cambia al mover) al segmento que resalta. Pegado:
  // se dibuja como capa hija de ESE SegmentBox (hereda su transform → sigue al
  // texto en vivo) y su edición /Rect se sincroniza con el movimiento del
  // segmento (abajo). Sin segmento debajo = "huérfano" → box independiente.
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => {
    const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return ix * iy;
  };
  const savedHlBySeg = new Map<string, HighlightNode[]>();
  const orphanSavedHls: HighlightNode[] = [];
  for (const hl of graph.highlights) {
    if (highlightEdits.get(hl.id)?.remove) continue; // borrado: el preview lo saca
    let best: SegmentNode | null = null, bestA = 0;
    for (const s of allSegments) best = overlap(hl, s) > bestA ? ((bestA = overlap(hl, s)), s) : best;
    if (best && bestA > hl.width * hl.height * 0.3) savedHlBySeg.set(best.id, [...(savedHlBySeg.get(best.id) ?? []), hl]);
    else orphanSavedHls.push(hl);
  }
  // Ids de resaltados pegados: excluidos del marquee (los mueve su segmento).
  const gluedHlIds = new Set([...savedHlBySeg.values()].flat().map(h => h.id));

  // GLUE (persistencia): cuando el segmento ancla se mueve, corré cada
  // resaltado pegado por el MISMO delta (x, y↔baseline). Idempotente vía la
  // guarda de igualdad (round1); SIN pushHistory — el adaptador lo documenta
  // en el contrato (`syncHighlightEdits`): piggyback del snapshot del segmento.
  useEffect(() => {
    const actions: HighlightSyncAction[] = [];
    const nodes = new Map<string, RectNode>();
    for (const [segId, hls] of savedHlBySeg) {
      const s = allSegments.find(x => x.id === segId);
      if (!s) continue;
      const se = edits.get(segId) ?? null;
      const dx = round1((se?.x ?? s.x) - s.x);
      const dy = round1((se?.baseline ?? s.baseline) - s.baseline); // y del PDF sigue a baseline
      if (dx === 0 && dy === 0) continue; // segmento sin mover: no tocar (respeta ediciones manuales)
      for (const hl of hls) {
        const cur = highlightEdits.get(hl.id) ?? null;
        const wantX = round1(hl.x + dx);
        const wantY = round1(hl.y + dy);
        if (round1(cur?.x ?? hl.x) === wantX && round1(cur?.y ?? hl.y) === wantY) continue;
        nodes.set(hl.id, hl);
        actions.push({ highlightId: hl.id, x: wantX === round1(hl.x) ? null : wantX, y: wantY === round1(hl.y) ? null : wantY });
      }
    }
    if (actions.length) ledger.syncHighlightEdits(actions, nodes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, highlightEdits, graph]);

  // Seleccionar OTRO nodo cierra (con commit) el editor de texto abierto — el
  // preventDefault de los pointerdown impide el blur natural: la coordinación
  // ya no viaja por el focus del DOM sino por la llamada explícita (audit §3.5).
  const clickLogRef = useRef<{ id: string | null }>({ id: null });
  const selectNode = (nodeId: string | null) => {
    if (editingId && editingId !== nodeId) {
      log('[aldus:forceblur] cierro editor de', editingId, 'por selección de', nodeId ?? '(nada)');
      controller.commitAndClose();
    }
    if (multiSel.size) setMultiSel(new Set());
    onSelect(nodeId);
    // DEBUG: al clickear un nodo de texto, dump del texto TAL CUAL (JSON pretty).
    // selectNode se dispara VARIAS veces por click (pointerdown para el drag +
    // onClick, a veces separados por un re-render lento) → deduplicamos por
    // CAMBIO de selección: solo loguea al pasar a un nodo DISTINTO del anterior
    // (deseleccionar resetea, así re-clickear el mismo nodo vuelve a loguear).
    const dup = clickLogRef.current.id === nodeId;
    clickLogRef.current.id = nodeId;
    if (nodeId && !dup) {
      const seg = allSegments.find(s => s.id === nodeId);
      if (seg) console.log(
        '%c[aldus] CLICK →', 'color:#2563eb;font-weight:700',
        '\n' + JSON.stringify({
          id: seg.id,
          text: seg.text,
          runs: seg.runs.map(r => r.text),
        }, null, 2),
      );
    }
  };

  // ── MULTI-SELECCIÓN (marquee sobre el fondo → grupo movible) ──
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());
  useEffect(() => setMultiSel(new Set()), [graph.page]);
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const marqueeStart = useRef<{ x: number; y: number; hostL: number; hostT: number } | null>(null);

  // Rect CSS de CUALQUIER nodo por id — UNA función vía el registry (v1: 5 ramas).
  const nodeCssRect = (nid: string): { left: number; top: number; width: number; height: number } | null => {
    const e = effectiveRectOf(overlayGraph, ledger, nid);
    return e ? pdfRectToCss({ x: e.x, y: e.y, width: e.width, height: e.height }, graph.height, scale) : null;
  };

  // Mover TODO el grupo (delta CSS): a cada nodo su patch de posición, vía el
  // registry. CSS hacia abajo = y del PDF baja (baseline/y decrecen).
  const moveGroup = (dxCss: number, dyCss: number) => {
    const dxPt = round1(dxCss / scale);
    const dyPt = round1(-dyCss / scale);
    for (const nid of multiSel) moveNode(overlayGraph, ledger, nid, dxPt, dyPt);
  };

  const groupBBox = () => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const nid of multiSel) {
      const cr = nodeCssRect(nid);
      if (!cr) continue;
      l = Math.min(l, cr.left); t = Math.min(t, cr.top);
      r = Math.max(r, cr.left + cr.width); b = Math.max(b, cr.top + cr.height);
    }
    return l === Infinity ? null : { left: l, top: t, width: r - l, height: b - t };
  };

  // El CONTEXTO que consumen los Box de cada kind (una sola vez por render).
  const ctx: OverlayCtx = {
    graph, allSegments, inGraph, scale, ledger, controller,
    edits, imageEdits, shapeEdits, widgetEdits, highlightEdits, linkEdits,
    selectedId, multiSel, locked, editingId, snapshot, imagePixels,
    highlightColor, onHighlightColor, hlBySeg, savedHlBySeg,
    areaWidths, onAreaWidth, selectNode,
    onStartEdit: seg => { selectNode(seg.id); openSegEditor(seg); },
    onDragging, onDocOp, onRequestLink, onAddText,
  };

  // Qué dibuja cada kind (el z-order lo da el ORDEN de `nodeKinds`):
  //  - segment: TODOS los del overlay (grafo + fantasmas).
  //  - highlight: SOLO los huérfanos (los pegados los dibuja su SegmentBox).
  //  - el resto: los del grafo.
  const nodesFor = (kind: string): Array<{ id: string }> => {
    switch (kind) {
      case 'segment': return allSegments;
      case 'image': return graph.images;
      case 'widget': return graph.widgets;
      case 'link': return graph.links;
      case 'highlight': return orphanSavedHls;
      case 'shape': return graph.shapes ?? [];
      default: return [];
    }
  };

  return (
    <div
      ref={overlayRef}
      className={`node-overlay${placing ? ' placing' : ''}`}
      onClick={e => {
        if (placing) {
          const r = e.currentTarget.getBoundingClientRect();
          const p = cssPointToPdf(e.clientX - r.left, e.clientY - r.top, graph.height, scale);
          onPlace(p.x, p.y);
        }
      }}
      onPointerDown={e => {
        // Solo en el FONDO (los nodos hacen stopPropagation): arranca marquee.
        if (placing || e.button !== 0 || e.target !== e.currentTarget) return;
        const host = e.currentTarget.getBoundingClientRect();
        marqueeStart.current = { x: e.clientX - host.left, y: e.clientY - host.top, hostL: host.left, hostT: host.top };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const st = marqueeStart.current;
        if (!st) return;
        const x = e.clientX - st.hostL, y = e.clientY - st.hostT;
        setMarquee({ l: Math.min(st.x, x), t: Math.min(st.y, y), w: Math.abs(x - st.x), h: Math.abs(y - st.y) });
      }}
      onPointerUp={e => {
        const st = marqueeStart.current;
        marqueeStart.current = null;
        if (!st) return;
        const x = e.clientX - st.hostL, y = e.clientY - st.hostT;
        const dragged = Math.abs(x - st.x) + Math.abs(y - st.y) > 4;
        setMarquee(null);
        if (!dragged) { selectNode(null); return; } // click vacío = deseleccionar
        const box = { l: Math.min(st.x, x), t: Math.min(st.y, y), r: Math.max(st.x, x), b: Math.max(st.y, y) };
        const hit = new Set<string>();
        const test = (nid: string) => {
          if (locked.has(nid)) return;
          const cr = nodeCssRect(nid);
          if (cr && cr.left < box.r && cr.left + cr.width > box.l && cr.top < box.b && cr.top + cr.height > box.t) hit.add(nid);
        };
        // Mismo universo que v1: segmentos (con fantasmas), imágenes, campos,
        // resaltados NO pegados (los pegados los mueve su segmento), links.
        // Las formas quedan fuera del marquee (v1 tampoco las incluía).
        allSegments.forEach(s => test(s.id));
        graph.images.forEach(im => test(im.id));
        graph.widgets.forEach(w => test(w.id));
        graph.highlights.forEach(hl => { if (!gluedHlIds.has(hl.id)) test(hl.id); });
        graph.links.forEach(lk => test(lk.id));
        setMultiSel(hit);
        // 1 nodo = selección normal (con su barra); 2+ = grupo (sin primario).
        onSelect(hit.size === 1 ? [...hit][0]! : null);
      }}
    >
      {nodeKinds.map(kind => nodesFor(kind.kind).map(node => (
        <kind.Box key={node.id} ctx={ctx} node={node} />
      )))}
      {/* Resaltados PENDIENTES HUÉRFANOS (su segmento no está en esta página/grafo):
          capa suelta, quieta, en su rect guardado. */}
      {orphanHls.map((h, i) => {
        const r = pdfRectToCss({ x: h.x, y: h.y, width: h.width, height: h.height }, graph.height, scale);
        return (
          <div
            key={`hl-${i}`}
            className="seg-hl"
            style={{ position: 'absolute', left: r.left, top: r.top, width: r.width, height: r.height, background: h.color ?? '#ffd400' }}
          />
        );
      })}
      {/* Marquee de selección múltiple (mientras se arrastra en el fondo). */}
      {marquee && (
        <div className="marquee" style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }} />
      )}
      {/* Caja de GRUPO (2+ seleccionados): arrastrar mueve todos; resalta los
          segmentos (UN solo item de historial — { items }); borra todos. */}
      {multiSel.size > 1 && <GroupBox bbox={groupBBox()} count={multiSel.size} onMove={moveGroup} onHighlight={(() => {
        const segs = [...multiSel].map(nid => allSegments.find(x => x.id === nid)).filter((s): s is SegmentNode => !!s);
        if (!segs.length) return undefined;
        return () => onDocOp('highlight', {
          items: segs.map(s => {
            const e = ledger.effective(s);
            return { page: s.page, segmentId: s.id, x: e.x, y: e.y, width: e.width, height: e.height, color: highlightColor };
          }),
        });
      })()} onDelete={() => {
        for (const nid of multiSel) removeNode(overlayGraph, ledger, nid);
        setMultiSel(new Set());
      }} onClear={() => { setMultiSel(new Set()); onSelect(null); }} />}
    </div>
  );
}
