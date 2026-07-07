/**
 * NodeOverlay — los nodos del grafo como boxes sobre el canvas.
 *
 * La unidad de edición es el SEGMENTO (modelo Acrobat/Foxit): runs contiguos
 * anclados a su x; los gaps de columna son FRONTERAS entre segmentos. El estilo
 * (bold/italic) vive POR TRAMO (StyledRun) y siempre viaja por el modelo — ver
 * styledDom.ts (proyección modelo↔DOM) y core/edits.ts (semántica).
 *
 * Interacción: click = seleccionar · seleccionado + arrastrar = mover ·
 *  doble click = editar in situ (Cmd/Ctrl+B/I = estilo a la selección) ·
 *  grip = escalar. El panel de propiedades aplica estilo a la selección vía
 *  el evento SELECTION_STYLE_EVENT cuando hay un box en edición.
 *
 * Este archivo es la RAÍZ de composición: orquesta los boxes (SegmentBox,
 * ImageBox, WidgetBox, GroupBox), el editor singleton (TextEditLayer) y el
 * marquee de selección múltiple. Cada pieza vive en su propio módulo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cssPointToPdf,
  effectiveGeometry,
  effectiveHighlightRect,
  effectiveImageRect,
  effectiveLinkRect,
  effectiveWidgetRect,
  mergeHighlightEdit,
  mergeImageEdit,
  mergeLinkEdit,
  mergeSegmentEdit,
  mergeWidgetEdit,
  pdfRectToCss,
  type HighlightEdit,
  type HighlightNode,
  type ImageEdit,
  type LinkEdit,
  type PageGraph,
  type SegmentEdit,
  type SegmentNode,
  type WidgetEdit,
} from '@aldus/core';
import { activeEditingBox, round1 } from '../styledDom';
import { clampX, clampY, log } from './helpers';
import { GroupBox } from './GroupBox';
import { HighlightBox } from './HighlightBox';
import { ImageBox } from './ImageBox';
import { LinkBox } from './LinkBox';
import { SegmentBox } from './SegmentBox';
import { WidgetBox } from './WidgetBox';
import { TextEditLayer, type TextEditLayerHandle } from './TextEditLayer';
import type { AddTextRequest, EditAction, HighlightEditAction, ImageEditAction, LinkEditAction, OverlayHighlight, SavedHighlight, WidgetEditAction } from './types';

export type { AddTextRequest, EditAction, HighlightEditAction, ImageEditAction, LinkEditAction, WidgetEditAction } from './types';

interface Props {
  graph: PageGraph;
  scale: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  edits: Map<string, SegmentEdit>;
  onEdit: (action: EditAction) => void;
  imageEdits: Map<string, ImageEdit>;
  onImageEdit: (action: ImageEditAction) => void;
  widgetEdits: Map<string, WidgetEdit>;
  onWidgetEdit: (action: WidgetEditAction) => void;
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
  /** Ediciones (mover/borrar) de anotaciones GUARDADAS (/Annots del grafo). */
  highlightEdits: Map<string, HighlightEdit>;
  onHighlightEdit: (action: HighlightEditAction) => void;
  /** GLUE: sincroniza los highlightEdits de resaltados pegados a su segmento
   *  cuando éste se mueve — SIN empujar historial (piggyback del snapshot del
   *  movimiento del segmento). */
  onSyncHighlightEdits: (actions: HighlightEditAction[]) => void;
  linkEdits: Map<string, LinkEdit>;
  onLinkEdit: (action: LinkEditAction) => void;
  /** Color del resaltador (persistido) + su setter. */
  highlightColor: string;
  onHighlightColor: (c: string) => void;
  /** Segmentos editados (extirpados del preview): se dibujan desde el cache. */
  phantomSegments: SegmentNode[];
  /** Arranque/fin del arrastre de un segmento. En el fin, `committed` dice si
      el drop produjo una edición (false = no-op → restaurar el canvas). */
  onDragging: (segId: string, active: boolean, committed?: boolean) => void;
  /** Ancho de ÁREA tipeable por segmento (pt) — el grip la amplía. */
  areaWidths: Map<string, { w?: number; h?: number }>;
  onAreaWidth: (segId: string, area: { w?: number; h?: number } | null) => void;
  /** Hay un editor de texto abierto (se usa para saltear el lift). */
  onEditingChange: (active: boolean) => void;
}

export function NodeOverlay({ graph, scale, selectedId, onSelect, edits, onEdit, imageEdits, onImageEdit, widgetEdits, onWidgetEdit, locked, placing, onPlace, snapshot, imagePixels, onDocOp, onRequestLink, onAddText, highlights, highlightEdits, onHighlightEdit, onSyncHighlightEdits, linkEdits, onLinkEdit, highlightColor, onHighlightColor, phantomSegments, onDragging, areaWidths, onAreaWidth, onEditingChange }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => { onEditingChange(editingId != null); }, [editingId, onEditingChange]);
  // Cambio de página con editor abierto: cerrarlo (con commit) via blur.
  useEffect(() => { activeEditingBox()?.blur(); }, [graph.page]);

  // EL editor (singleton, imperativo). Los boxes solo piden abrirlo.
  const layerRef = useRef<TextEditLayerHandle>(null);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const onLayerClosed = useCallback(() => setEditingId(null), []);
  const openSegEditor = (seg: SegmentNode) => {
    const edit = editsRef.current.get(seg.id) ?? null;
    setEditingId(seg.id);
    layerRef.current?.open({
      seg,
      edit,
      scale,
      pageHeight: graph.height,
      minWidthCss: (areaWidths.get(seg.id)?.w ?? 0) * scale,
      minHeightCss: (areaWidths.get(seg.id)?.h ?? 0) * scale,
      onPatch: patch => {
        const merged = mergeSegmentEdit(seg, editsRef.current.get(seg.id) ?? null, patch);
        onEdit(merged ?? { segmentId: seg.id, revert: true });
      },
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
  // guarda de igualdad; sin pushHistory (piggyback del snapshot del segmento).
  useEffect(() => {
    const actions: HighlightEditAction[] = [];
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
        const m = mergeHighlightEdit(hl, cur, { x: wantX === round1(hl.x) ? null : wantX, y: wantY === round1(hl.y) ? null : wantY });
        actions.push(m ?? { highlightId: hl.id, revert: true });
      }
    }
    if (actions.length) onSyncHighlightEdits(actions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, highlightEdits, graph]);

  // Seleccionar OTRO nodo cierra (con commit) el editor de texto abierto — el
  // preventDefault de los pointerdown impide el blur natural, así que lo
  // forzamos acá. Sin esto, la B de la toolbar le pegaba al editor viejo.
  const selectNode = (nodeId: string | null) => {
    if (editingId && editingId !== nodeId) {
      log('[aldus:forceblur] cierro editor de', editingId, 'por selección de', nodeId ?? '(nada)');
      activeEditingBox()?.blur();
    }
    if (multiSel.size) setMultiSel(new Set());
    onSelect(nodeId);
  };

  // ── MULTI-SELECCIÓN (marquee sobre el fondo → grupo movible) ──
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());
  useEffect(() => setMultiSel(new Set()), [graph.page]);
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const marqueeStart = useRef<{ x: number; y: number; hostL: number; hostT: number } | null>(null);

  // Rect CSS de CUALQUIER nodo por id (segmento/imagen/campo), con su edición.
  const nodeCssRect = (nid: string): { left: number; top: number; width: number; height: number } | null => {
    const s = allSegments.find(x => x.id === nid);
    if (s) { const e = effectiveGeometry(s, edits.get(s.id) ?? null); return pdfRectToCss({ x: e.x, y: e.y, width: e.width, height: e.height }, graph.height, scale); }
    const im = graph.images.find(x => x.id === nid);
    if (im) { const e = effectiveImageRect(im, imageEdits.get(im.id) ?? null); return pdfRectToCss({ x: e.x, y: e.y, width: e.width, height: e.height }, graph.height, scale); }
    const w = graph.widgets.find(x => x.id === nid);
    if (w) { const e = effectiveWidgetRect(w, widgetEdits.get(w.id) ?? null); return pdfRectToCss({ x: e.x, y: e.y, width: e.width, height: e.height }, graph.height, scale); }
    const hl = graph.highlights.find(x => x.id === nid);
    if (hl) { const e = effectiveHighlightRect(hl, highlightEdits.get(hl.id) ?? null); return pdfRectToCss({ x: e.x, y: e.y, width: e.width, height: e.height }, graph.height, scale); }
    const lk = graph.links.find(x => x.id === nid);
    if (lk) { const e = effectiveLinkRect(lk, linkEdits.get(lk.id) ?? null); return pdfRectToCss({ x: e.x, y: e.y, width: e.width, height: e.height }, graph.height, scale); }
    return null;
  };

  // Mover TODO el grupo (delta CSS): a cada nodo su patch de posición. CSS
  // hacia abajo = y del PDF baja (baseline/y decrecen).
  const moveGroup = (dxCss: number, dyCss: number) => {
    const dxPt = round1(dxCss / scale);
    const dyPt = round1(-dyCss / scale);
    // Clamp por nodo: ninguno puede salir de página (lo de afuera se pierde al
    // re-extraer). cx/cy mantienen el bbox entero dentro de [0, pageDim].
    const cx = (x: number, w: number) => round1(clampX(x + dxPt, w, graph.width));
    for (const nid of multiSel) {
      const s = allSegments.find(x => x.id === nid);
      if (s) { const e = effectiveGeometry(s, edits.get(s.id) ?? null); const ny = clampY(e.y + dyPt, e.height, graph.height); const m = mergeSegmentEdit(s, edits.get(s.id) ?? null, { x: cx(e.x, e.width), baseline: round1(e.baseline + (ny - e.y)) }); onEdit(m ?? { segmentId: s.id, revert: true }); continue; }
      const im = graph.images.find(x => x.id === nid);
      if (im) { const e = effectiveImageRect(im, imageEdits.get(im.id) ?? null); const m = mergeImageEdit(im, imageEdits.get(im.id) ?? null, { x: cx(e.x, e.width), y: round1(clampY(e.y + dyPt, e.height, graph.height)) }); onImageEdit(m ?? { imageId: im.id, revert: true }); continue; }
      const w = graph.widgets.find(x => x.id === nid);
      if (w) { const e = effectiveWidgetRect(w, widgetEdits.get(w.id) ?? null); const m = mergeWidgetEdit(w, widgetEdits.get(w.id) ?? null, { x: cx(e.x, e.width), y: round1(clampY(e.y + dyPt, e.height, graph.height)) }); onWidgetEdit(m ?? { widgetId: w.id, revert: true }); continue; }
      const hl = graph.highlights.find(x => x.id === nid);
      if (hl) { const e = effectiveHighlightRect(hl, highlightEdits.get(hl.id) ?? null); const m = mergeHighlightEdit(hl, highlightEdits.get(hl.id) ?? null, { x: cx(e.x, e.width), y: round1(clampY(e.y + dyPt, e.height, graph.height)) }); onHighlightEdit(m ?? { highlightId: hl.id, revert: true }); continue; }
      const lk = graph.links.find(x => x.id === nid);
      if (lk) { const e = effectiveLinkRect(lk, linkEdits.get(lk.id) ?? null); const m = mergeLinkEdit(lk, linkEdits.get(lk.id) ?? null, { x: cx(e.x, e.width), y: round1(clampY(e.y + dyPt, e.height, graph.height)) }); onLinkEdit(m ?? { linkId: lk.id, revert: true }); }
    }
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

  return (
    <div
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
        allSegments.forEach(s => test(s.id));
        graph.images.forEach(im => test(im.id));
        graph.widgets.forEach(w => test(w.id));
        graph.highlights.forEach(hl => { if (!gluedHlIds.has(hl.id)) test(hl.id); });
        graph.links.forEach(lk => test(lk.id));
        setMultiSel(hit);
        // 1 nodo = selección normal (con su barra); 2+ = grupo (sin primario).
        onSelect(hit.size === 1 ? [...hit][0] : null);
      }}
    >
      {graph.images.map(img => (
        <ImageBox
          key={img.id}
          groupMode={multiSel.size > 1}
          img={img}
          pageWidth={graph.width}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === img.id || multiSel.has(img.id)}
          edit={imageEdits.get(img.id) ?? null}
          isLocked={locked.has(img.id)}
          snapshot={snapshot}
          cleanPixels={imagePixels.get(img.id) ?? null}
          onSelect={() => selectNode(img.id)}
          onPatch={patch => {
            const merged = mergeImageEdit(img, imageEdits.get(img.id) ?? null, patch);
            onImageEdit(merged ?? { imageId: img.id, revert: true });
          }}
          onDragging={onDragging}
        />
      ))}
      {allSegments.map(seg => (
        <SegmentBox
          key={seg.id}
          groupMode={multiSel.size > 1}
          seg={seg}
          pageWidth={graph.width}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === seg.id || multiSel.has(seg.id)}
          editing={editingId === seg.id}
          edit={edits.get(seg.id) ?? null}
          onCanvas={inGraph.has(seg.id)}
          isLocked={locked.has(seg.id)}
          onDragging={(active, committed) => onDragging(seg.id, active, committed)}
          area={areaWidths.get(seg.id) ?? null}
          onArea={a => onAreaWidth(seg.id, a)}
          onSelect={() => selectNode(seg.id)}
          onStartEdit={() => { selectNode(seg.id); openSegEditor(seg); }}
          onPatch={patch => {
            const merged = mergeSegmentEdit(seg, edits.get(seg.id) ?? null, patch);
            onEdit(merged ?? { segmentId: seg.id, revert: true });
          }}
          onDocOp={onDocOp}
          onRequestLink={onRequestLink}
          onAddText={onAddText}
          highlights={hlBySeg.get(seg.id) ?? null}
          savedHighlights={(savedHlBySeg.get(seg.id) ?? []).flatMap((hl): SavedHighlight[] => {
            const e = highlightEdits.get(hl.id) ?? null;
            if (e?.remove) return []; // borrado: no dibujar la capa hija
            return [{ id: hl.id, x: hl.x, y: hl.y, width: hl.width, height: hl.height, color: e?.color ?? hl.color }];
          })}
          onHighlightPatch={(hlId, patch) => {
            const hl = graph.highlights.find(h => h.id === hlId);
            if (!hl) return;
            const m = mergeHighlightEdit(hl, highlightEdits.get(hlId) ?? null, patch);
            onHighlightEdit(m ?? { highlightId: hlId, revert: true });
          }}
          highlightColor={highlightColor}
          onHighlightColor={onHighlightColor}
        />
      ))}
      {/* Links GUARDADOS (nodos /Annots): boxes movibles/borrables. */}
      {graph.links.map(lk => (
        <LinkBox
          key={lk.id}
          link={lk}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === lk.id || multiSel.has(lk.id)}
          edit={linkEdits.get(lk.id) ?? null}
          isLocked={locked.has(lk.id)}
          groupMode={multiSel.size > 1}
          onSelect={() => selectNode(lk.id)}
          onPatch={patch => {
            const merged = mergeLinkEdit(lk, linkEdits.get(lk.id) ?? null, patch);
            onLinkEdit(merged ?? { linkId: lk.id, revert: true });
          }}
        />
      ))}
      {/* Resaltados GUARDADOS HUÉRFANOS (sin texto debajo): box independiente,
          movible/borrable. Los pegados a un segmento los dibuja su SegmentBox
          (siguen al texto) — no acá. */}
      {orphanSavedHls.map(hl => (
        <HighlightBox
          key={hl.id}
          hl={hl}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === hl.id || multiSel.has(hl.id)}
          edit={highlightEdits.get(hl.id) ?? null}
          isLocked={locked.has(hl.id)}
          groupMode={multiSel.size > 1}
          onSelect={() => selectNode(hl.id)}
          onPatch={patch => {
            const merged = mergeHighlightEdit(hl, highlightEdits.get(hl.id) ?? null, patch);
            onHighlightEdit(merged ?? { highlightId: hl.id, revert: true });
          }}
        />
      ))}
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
      {/* Los widgets al FINAL del DOM = arriba de todo para el mouse (como en
          el PDF: las anotaciones se dibujan sobre el contenido). Una imagen
          full-page nunca puede taparles los clicks. */}
      {graph.widgets.map(w => (
        <WidgetBox
          key={w.id}
          groupMode={multiSel.size > 1}
          widget={w}
          pageWidth={graph.width}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === w.id || multiSel.has(w.id)}
          edit={widgetEdits.get(w.id) ?? null}
          isLocked={locked.has(w.id)}
          snapshot={snapshot}
          onSelect={() => selectNode(w.id)}
          onPatch={patch => {
            const merged = mergeWidgetEdit(w, widgetEdits.get(w.id) ?? null, patch);
            onWidgetEdit(merged ?? { widgetId: w.id, revert: true });
          }}
        />
      ))}
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
            const e = effectiveGeometry(s, edits.get(s.id) ?? null);
            return { page: s.page, segmentId: s.id, x: e.x, y: e.y, width: e.width, height: e.height, color: highlightColor };
          }),
        });
      })()} onDelete={() => {
        for (const nid of multiSel) {
          const s = allSegments.find(x => x.id === nid);
          if (s) { const m = mergeSegmentEdit(s, edits.get(s.id) ?? null, { remove: true }); if (m) onEdit(m); continue; }
          const im = graph.images.find(x => x.id === nid);
          if (im) { const m = mergeImageEdit(im, imageEdits.get(im.id) ?? null, { remove: true }); if (m) onImageEdit(m); continue; }
          const w = graph.widgets.find(x => x.id === nid);
          if (w) { const m = mergeWidgetEdit(w, widgetEdits.get(w.id) ?? null, { remove: true }); if (m) onWidgetEdit(m); continue; }
          const hl = graph.highlights.find(x => x.id === nid);
          if (hl) { const m = mergeHighlightEdit(hl, highlightEdits.get(hl.id) ?? null, { remove: true }); if (m) onHighlightEdit(m); continue; }
          const lk = graph.links.find(x => x.id === nid);
          if (lk) { const m = mergeLinkEdit(lk, linkEdits.get(lk.id) ?? null, { remove: true }); if (m) onLinkEdit(m); }
        }
        setMultiSel(new Set());
      }} onClear={() => { setMultiSel(new Set()); onSelect(null); }} />}
      {/* EL editor de texto: singleton imperativo, SIEMPRE montado — inmune al
          churn de grafos/previews (ver TextEditLayer). */}
      <TextEditLayer ref={layerRef} onClosed={onLayerClosed} />
    </div>
  );
}
