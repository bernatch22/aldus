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
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  cssPointToPdf,
  effectiveGeometry,
  effectiveImageRect,
  effectiveWidgetRect,
  mergeImageEdit,
  mergeSegmentEdit,
  mergeWidgetEdit,
  nextListMarker,
  originalStyledRuns,
  pdfRectToCss,
  styledRunsEqual,
  styledText,
  type FontBucket,
  type ImageEdit,
  type ImageNode,
  type ImagePatch,
  type PageGraph,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
  type StyledRun,
  type WidgetEdit,
  type WidgetNode,
  type WidgetPatch,
} from '@aldus/core';
import { AlignLeft, AlignCenter, AlignRight, Bold, Italic, Highlighter, Link2, Trash2, SendToBack, BringToFront } from 'lucide-react';
import {
  activeEditingBox,
  applySelectionColor,
  applySelectionStyle,
  bucketFallback,
  dominantRun,
  family,
  round1,
  seedHtml,
  selectionStyle,
  serializeStyled,
  SELECTION_STYLE_EVENT,
} from './styledDom';

export type EditAction = SegmentEdit | { segmentId: string; revert: true };
export type ImageEditAction = ImageEdit | { imageId: string; revert: true };
export type WidgetEditAction = WidgetEdit | { widgetId: string; revert: true };

/** Pedido de un ítem de LISTA nuevo (Enter al final de un ítem existente). */
export interface AddTextRequest {
  page: number;
  x: number;
  /** Baseline del ítem nuevo (una línea debajo del actual). */
  baseline: number;
  text: string;
  size: number;
  bucket: FontBucket;
}

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
  /** Operación de documento instantánea (highlight, addLink…). */
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  /** Abre el modal de link para un rect. */
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  /** Enter al final de un ítem de lista → crear el siguiente. */
  onAddText: (req: AddTextRequest) => void;
  /** Color del resaltador (persistido) + su setter. */
  highlightColor: string;
  onHighlightColor: (c: string) => void;
  /** Segmentos editados (extirpados del preview): se dibujan desde el cache. */
  phantomSegments: SegmentNode[];
  /** Arranque/fin del arrastre de un segmento (extirpación temprana). */
  onDragging: (segId: string, active: boolean) => void;
}

/** Botón chico de una toolbar flotante. */
function FbBtn({ label, onClick, active, danger, children }: { label: string; onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={label} aria-label={label}
      onMouseDown={e => e.preventDefault()}
      onClick={e => { e.stopPropagation(); onClick(); }}
      className={`fb-btn${active ? ' active' : ''}${danger ? ' danger' : ''}`}
    >{children}</button>
  );
}
const FbSep = () => <span className="fb-sep" />;

/** Contenedor de toolbar flotante posicionado sobre el rect. */
function FloatingWrap({ rect, children }: { rect: { left: number; top: number }; children: React.ReactNode }) {
  return (
    <div className="float-bar" style={{ left: rect.left, top: Math.max(2, rect.top - 36) }} onClick={e => e.stopPropagation()}>
      {children}
    </div>
  );
}

/** Tipografía del CONTENEDOR editable: la dominante del segmento (con tamaño/
 *  familia de la edición). Todo texto que el browser inserte fuera de los spans
 *  hereda esto — nunca el system font del UI. */
function containerStyle(seg: SegmentNode, edit: SegmentEdit | null, scale: number): CSSProperties {
  const dom = dominantRun(seg);
  const ratio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
  return {
    fontFamily: edit?.font ? bucketFallback(edit.font) : family(dom),
    fontSize: `${(dom.fontSize * ratio * scale).toFixed(2)}px`,
    fontWeight: !dom.font.embedded && dom.font.bold ? 700 : 400,
    fontStyle: !dom.font.embedded && dom.font.italic ? 'italic' : 'normal',
    color: edit?.color ?? dom.color ?? '#000',
  };
}

// Ningún drag puede dejar un nodo perdido fuera de la página: al soltar,
// siempre quedan al menos 24pt visibles.
const MIN_VISIBLE = 24;
const clampX = (x: number, w: number, pageW: number) => Math.min(Math.max(x, MIN_VISIBLE - w), pageW - MIN_VISIBLE);
const clampY = (y: number, h: number, pageH: number) => Math.min(Math.max(y, MIN_VISIBLE - h), pageH - MIN_VISIBLE);

/** Toolbar flotante arriba del segmento seleccionado: alineación (relativa a
 *  la página), B/I, resaltar (+color), link, eliminar. */
function FloatingBar({ seg, edit, rect, pageWidth, onPatch, onDocOp, onRequestLink, highlightColor, onHighlightColor }: {
  seg: SegmentNode;
  edit: SegmentEdit | null;
  rect: { left: number; top: number };
  pageWidth: number;
  onPatch: (patch: SegmentPatch) => void;
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  highlightColor: string;
  onHighlightColor: (c: string) => void;
}) {
  const styled: StyledRun[] = edit?.runs ?? originalStyledRuns(seg);
  // Con el editor abierto, B/I reflejan el estilo BAJO LA SELECCIÓN (no el del
  // segmento entero) y el toggle aplica solo a esa parte.
  const [selSty, setSelSty] = useState<{ bold: boolean; italic: boolean } | null>(null);
  useEffect(() => {
    const update = () => {
      const el = activeEditingBox();
      setSelSty(el ? selectionStyle(el, seg, edit) : null);
    };
    update();
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [seg, edit]);
  const allBold = selSty ? selSty.bold : styled.length > 0 && styled.every(r => r.bold);
  const allItalic = selSty ? selSty.italic : styled.length > 0 && styled.every(r => r.italic);
  const toggle = (key: 'bold' | 'italic') => {
    if (activeEditingBox()) {
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key } }));
      return;
    }
    const next = key === 'bold' ? !allBold : !allItalic;
    onPatch({ runs: styled.map(r => ({ ...r, [key]: next })) });
  };
  const eff = effectiveGeometry(seg, edit);
  const MARGIN = 40;
  const alignTo = (x: number) => onPatch({ x: Math.abs(x - seg.x) < 0.05 ? null : round1(x) });
  // El highlight lleva el segmentId: si después movés el texto, el resaltado
  // LO SIGUE (se resuelve contra la geometría efectiva al previsualizar/aplicar).
  const bbox = { page: seg.page, segmentId: seg.id, x: eff.x, y: eff.y, width: eff.width, height: eff.height };

  const dom = dominantRun(seg);
  const textColor = edit?.color ?? dom.color ?? '#000000';
  const effSize = edit?.fontSize ?? seg.fontSize;
  // Con el editor abierto, el color va a la SELECCIÓN (por tramo); si no, al
  // segmento entero (override clásico).
  const applyColor = (v: string) => {
    if (activeEditingBox()) {
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key: 'color', color: v } }));
      return;
    }
    onPatch({ color: v.toLowerCase() === (dom.color ?? '#000000').toLowerCase() ? null : v });
  };

  return (
    <FloatingWrap rect={rect}>
      <FbBtn label="Negrita" onClick={() => toggle('bold')} active={allBold}><Bold size={14} /></FbBtn>
      <FbBtn label="Itálica" onClick={() => toggle('italic')} active={allItalic}><Italic size={14} /></FbBtn>
      <input
        className="fb-input"
        type="number"
        step={0.5}
        min={4}
        title="Tamaño (pt)"
        key={`${seg.id}-${round1(effSize)}`}
        defaultValue={round1(effSize)}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onBlur={e => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= 4) onPatch({ fontSize: round1(v) === round1(seg.fontSize) ? null : round1(v) });
        }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <button className="fb-swatch" title="Color del texto (a la selección si estás editando)" style={{ background: textColor }} onMouseDown={e => e.preventDefault()} onClick={e => e.stopPropagation()}>
        <input type="color" value={textColor} onChange={e => applyColor(e.target.value)} />
      </button>
      <FbSep />
      <FbBtn label="Alinear a la izquierda" onClick={() => alignTo(MARGIN)}><AlignLeft size={14} /></FbBtn>
      <FbBtn label="Centrar en la página" onClick={() => alignTo((pageWidth - eff.width) / 2)}><AlignCenter size={14} /></FbBtn>
      <FbBtn label="Alinear a la derecha" onClick={() => alignTo(pageWidth - MARGIN - eff.width)}><AlignRight size={14} /></FbBtn>
      <FbSep />
      <FbBtn label="Resaltar (acumula, se escribe con Aplicar)" onClick={() => onDocOp('highlight', { ...bbox, color: highlightColor })}><Highlighter size={14} /></FbBtn>
      <button className="fb-swatch" title="Color del resaltador" style={{ background: highlightColor }} onMouseDown={e => e.preventDefault()} onClick={e => e.stopPropagation()}>
        <input type="color" value={highlightColor} onChange={e => onHighlightColor(e.target.value)} />
      </button>
      <FbBtn label="Link" onClick={() => onRequestLink(bbox)}><Link2 size={14} /></FbBtn>
      <FbSep />
      <FbBtn label="Eliminar" onClick={() => onPatch({ remove: true })} danger><Trash2 size={14} /></FbBtn>
    </FloatingWrap>
  );
}

/** Toolbar flotante para IMAGEN o CAMPO: alineación + (imagen) orden Z + eliminar. */
function ObjectBar({ rect, pageWidth, width, onAlign, onZ, onDelete }: {
  rect: { left: number; top: number };
  pageWidth: number;
  width: number;
  onAlign: (x: number) => void;
  onZ?: (o: 'front' | 'back') => void;
  onDelete: () => void;
}) {
  const MARGIN = 40;
  return (
    <FloatingWrap rect={rect}>
      <FbBtn label="Alinear a la izquierda" onClick={() => onAlign(MARGIN)}><AlignLeft size={14} /></FbBtn>
      <FbBtn label="Centrar en la página" onClick={() => onAlign((pageWidth - width) / 2)}><AlignCenter size={14} /></FbBtn>
      <FbBtn label="Alinear a la derecha" onClick={() => onAlign(pageWidth - MARGIN - width)}><AlignRight size={14} /></FbBtn>
      {onZ && <>
        <FbSep />
        <FbBtn label="Enviar al fondo" onClick={() => onZ('back')}><SendToBack size={14} /></FbBtn>
        <FbBtn label="Traer al frente" onClick={() => onZ('front')}><BringToFront size={14} /></FbBtn>
      </>}
      <FbSep />
      <FbBtn label="Eliminar" onClick={onDelete} danger><Trash2 size={14} /></FbBtn>
    </FloatingWrap>
  );
}

export function NodeOverlay({ graph, scale, selectedId, onSelect, edits, onEdit, imageEdits, onImageEdit, widgetEdits, onWidgetEdit, locked, placing, onPlace, snapshot, onDocOp, onRequestLink, onAddText, highlightColor, onHighlightColor, phantomSegments, onDragging }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [graph.page]);

  // Segmentos a dibujar: los del grafo del preview + los FANTASMAS editados
  // (extirpados del preview). Dedupe defensivo por id.
  const inGraph = new Set(graph.segments.map(s => s.id));
  const allSegments = [...graph.segments, ...phantomSegments.filter(s => !inGraph.has(s.id))];

  // Seleccionar OTRO nodo cierra (con commit) el editor de texto abierto — el
  // preventDefault de los pointerdown impide el blur natural, así que lo
  // forzamos acá. Sin esto, la B de la toolbar le pegaba al editor viejo.
  const selectNode = (nodeId: string | null) => {
    if (editingId && editingId !== nodeId) activeEditingBox()?.blur();
    onSelect(nodeId);
  };

  return (
    <div
      className={`node-overlay${placing ? ' placing' : ''}`}
      onClick={e => {
        if (placing) {
          const r = e.currentTarget.getBoundingClientRect();
          const p = cssPointToPdf(e.clientX - r.left, e.clientY - r.top, graph.height, scale);
          onPlace(p.x, p.y);
          return;
        }
        selectNode(null);
      }}
    >
      {graph.images.map(img => (
        <ImageBox
          key={img.id}
          img={img}
          pageWidth={graph.width}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === img.id}
          edit={imageEdits.get(img.id) ?? null}
          isLocked={locked.has(img.id)}
          snapshot={snapshot}
          onSelect={() => selectNode(img.id)}
          onPatch={patch => {
            const merged = mergeImageEdit(img, imageEdits.get(img.id) ?? null, patch);
            onImageEdit(merged ?? { imageId: img.id, revert: true });
          }}
        />
      ))}
      {allSegments.map(seg => (
        <SegmentBox
          key={seg.id}
          seg={seg}
          pageWidth={graph.width}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === seg.id}
          editing={editingId === seg.id}
          edit={edits.get(seg.id) ?? null}
          isLocked={locked.has(seg.id)}
          onDragging={active => onDragging(seg.id, active)}
          onSelect={() => selectNode(seg.id)}
          onStartEdit={() => { selectNode(seg.id); setEditingId(seg.id); }}
          onStopEdit={() => setEditingId(null)}
          onPatch={patch => {
            const merged = mergeSegmentEdit(seg, edits.get(seg.id) ?? null, patch);
            onEdit(merged ?? { segmentId: seg.id, revert: true });
          }}
          onDocOp={onDocOp}
          onRequestLink={onRequestLink}
          onAddText={onAddText}
          highlightColor={highlightColor}
          onHighlightColor={onHighlightColor}
        />
      ))}
      {/* Los widgets al FINAL del DOM = arriba de todo para el mouse (como en
          el PDF: las anotaciones se dibujan sobre el contenido). Una imagen
          full-page nunca puede taparles los clicks. */}
      {graph.widgets.map(w => (
        <WidgetBox
          key={w.id}
          widget={w}
          pageWidth={graph.width}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === w.id}
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
    </div>
  );
}

interface WidgetBoxProps {
  widget: WidgetNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  edit: WidgetEdit | null;
  isLocked: boolean;
  snapshot: { url: string; width: number; height: number } | null;
  onSelect: () => void;
  onPatch: (patch: WidgetPatch) => void;
}

const WIDGET_LABEL: Record<WidgetNode['widgetType'], string> = {
  text: 'texto', checkbox: 'checkbox', radio: 'radio', select: 'select',
  list: 'lista', button: 'botón', signature: 'firma',
};

/** Un campo de formulario: seleccionar, arrastrar (mover), grip (escalar).
 *  La edición se aplica al instante (reescritura del /Rect de la anotación). */
function WidgetBox({ widget, pageWidth, pageHeight, scale, selected, edit, isLocked, snapshot, onSelect, onPatch }: WidgetBoxProps) {
  const eff = effectiveWidgetRect(widget, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const orig = pdfRectToCss({ x: widget.x, y: widget.y, width: widget.width, height: widget.height }, pageHeight, scale);
  const dragStart = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const gripStart = useRef<{ px: number; py: number } | null>(null);
  const [gripDelta, setGripDelta] = useState<{ dx: number; dy: number } | null>(null);

  // Eliminado: el preview local ya lo removió del render — nada que dibujar
  // (Ctrl+Z lo trae de vuelta).
  if (eff.removed) return null;

  // SOLO durante el gesto de drag: el box viaja con los píxeles reales y el
  // origen se enmascara. Al soltar, el preview local re-renderiza el widget
  // realmente movido — sin cajas blancas remanentes.
  const showPixels = drag != null;
  const pixels = showPixels && snapshot && orig.width > 0 && orig.height > 0
    ? {
        backgroundImage: `url(${snapshot.url})`,
        backgroundSize: `${(snapshot.width * rect.width) / orig.width}px ${(snapshot.height * rect.height) / orig.height}px`,
        backgroundPosition: `${(-orig.left * rect.width) / orig.width}px ${(-orig.top * rect.height) / orig.height}px`,
      }
    : undefined;
  return (
    <>
      {showPixels && (
        <div className="seg-mask" style={{ left: orig.left, top: orig.top, width: orig.width, height: orig.height }} />
      )}
      {selected && !isLocked && (
        <ObjectBar
          rect={rect} pageWidth={pageWidth} width={eff.width}
          onAlign={x => onPatch({ x: round1(clampX(x, eff.width, pageWidth)) })}
          onDelete={() => onPatch({ remove: true })}
        />
      )}
    <div
      className={`widget-box${selected ? ' selected' : ''}${edit ? ' edited' : ''}${isLocked ? ' locked' : ''}`}
      style={{
        left: rect.left,
        top: rect.top,
        width: gripDelta ? rect.width + gripDelta.dx : rect.width,
        height: gripDelta ? rect.height + gripDelta.dy : rect.height,
        transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
        ...pixels,
      }}
      title={`Campo ${WIDGET_LABEL[widget.widgetType]} · ${widget.fieldName}`}
      onClick={e => { e.stopPropagation(); onSelect(); }}
      onPointerDown={e => {
        if (e.button !== 0) return;
        if (!selected) onSelect();
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragStart.current = { px: e.clientX, py: e.clientY, moved: false };
      }}
      onPointerMove={e => {
        const start = dragStart.current;
        if (!start) return;
        const dx = e.clientX - start.px;
        const dy = e.clientY - start.py;
        if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
        if (start.moved) setDrag({ dx, dy });
      }}
      onPointerUp={e => {
        const start = dragStart.current;
        dragStart.current = null;
        setDrag(null);
        if (!start?.moved) return;
        const nx = round1(clampX(eff.x + (e.clientX - start.px) / scale, eff.width, pageWidth));
        const ny = round1(clampY(eff.y - (e.clientY - start.py) / scale, eff.height, pageHeight));
        onPatch({
          x: nx === round1(widget.x) ? null : nx,
          y: ny === round1(widget.y) ? null : ny,
        });
      }}
    >
      {selected && <span className="widget-label">{WIDGET_LABEL[widget.widgetType]} · {widget.fieldName}</span>}
      {selected && (
        <div
          className="seg-grip"
          title="Arrastrar para redimensionar el campo"
          onPointerDown={e => {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            gripStart.current = { px: e.clientX, py: e.clientY };
          }}
          onPointerMove={e => {
            if (!gripStart.current) return;
            e.stopPropagation();
            setGripDelta({ dx: e.clientX - gripStart.current.px, dy: e.clientY - gripStart.current.py });
          }}
          onPointerUp={e => {
            e.stopPropagation();
            const start = gripStart.current;
            gripStart.current = null;
            setGripDelta(null);
            if (!start) return;
            const newW = Math.max(6, round1(eff.width + (e.clientX - start.px) / scale));
            const newH = Math.max(6, round1(eff.height + (e.clientY - start.py) / scale));
            const top = eff.y + eff.height;
            const newY = round1(top - newH);
            onPatch({
              width: newW === round1(widget.width) ? null : newW,
              height: newH === round1(widget.height) ? null : newH,
              y: newY === round1(widget.y) ? null : newY,
            });
          }}
          onClick={e => e.stopPropagation()}
        />
      )}
    </div>
    </>
  );
}

interface ImageBoxProps {
  img: ImageNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  edit: ImageEdit | null;
  isLocked: boolean;
  snapshot: { url: string; width: number; height: number } | null;
  onSelect: () => void;
  onPatch: (patch: ImagePatch) => void;
}

/** Una imagen del grafo: seleccionar, arrastrar (mover), grip (escalar),
 *  eliminar (desde el panel). Preview de mover/escalar: el box del destino
 *  muestra los PÍXELES reales (crop del snapshot de la página); el original
 *  queda visible hasta Aplicar (ahí se muda de verdad). Eliminada: velo rojo
 *  translúcido — nunca una máscara opaca que taparía el texto de arriba. */
function ImageBox({ img, pageWidth, pageHeight, scale, selected, edit, isLocked, snapshot, onSelect, onPatch }: ImageBoxProps) {
  const eff = effectiveImageRect(img, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const orig = pdfRectToCss({ x: img.x, y: img.y, width: img.width, height: img.height }, pageHeight, scale);
  const dragStart = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const gripStart = useRef<{ px: number; py: number } | null>(null);
  const [gripDelta, setGripDelta] = useState<{ dx: number; dy: number } | null>(null);

  // Eliminada: el preview local ya la quitó del render (Ctrl+Z la restaura).
  if (eff.removed) return null;

  // SOLO durante el drag: píxeles reales viajando + máscara del origen. Una
  // imagen casi full-page NO puede enmascararse (taparía el texto) → ahí el
  // ghost es solo un marco punteado (sin píxeles = sin duplicado); al soltar,
  // el preview local renderiza la verdad.
  const ghost = drag != null;
  const coverage = (img.width * img.height) / (pageWidth * pageHeight);
  const canMask = coverage < 0.8;
  const ghostPixels = ghost && canMask && snapshot && orig.width > 0 && orig.height > 0
    ? {
        backgroundImage: `url(${snapshot.url})`,
        backgroundSize: `${(snapshot.width * rect.width) / orig.width}px ${(snapshot.height * rect.height) / orig.height}px`,
        backgroundPosition: `${(-orig.left * rect.width) / orig.width}px ${(-orig.top * rect.height) / orig.height}px`,
      }
    : undefined;
  const maskOriginal = ghost && canMask;
  return (
    <>
      {maskOriginal && (
        <div className="seg-mask" style={{ left: orig.left, top: orig.top, width: orig.width, height: orig.height }} />
      )}
      {selected && !isLocked && (
        <ObjectBar
          rect={rect} pageWidth={pageWidth} width={eff.width}
          onAlign={x => onPatch({ x: round1(clampX(x, eff.width, pageWidth)) })}
          onZ={o => onPatch({ zOrder: o })}
          onDelete={() => onPatch({ remove: true })}
        />
      )}
      <div
        className={`img-box${selected ? ' selected' : ''}${edit ? ' edited' : ''}${ghost ? ' ghost' : ''}${isLocked ? ' locked' : ''}`}
        style={{
          left: rect.left,
          top: rect.top,
          width: gripDelta ? rect.width + gripDelta.dx : rect.width,
          height: gripDelta ? rect.height + gripDelta.dy : rect.height,
          transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
          ...ghostPixels,
        }}
        title={`Imagen · ${Math.round(eff.width)}×${Math.round(eff.height)} pt`}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        onPointerDown={e => {
          if (e.button !== 0) return;
          if (!selected) onSelect();
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragStart.current = { px: e.clientX, py: e.clientY, moved: false };
        }}
        onPointerMove={e => {
          const start = dragStart.current;
          if (!start) return;
          const dx = e.clientX - start.px;
          const dy = e.clientY - start.py;
          if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
          if (start.moved) setDrag({ dx, dy });
        }}
        onPointerUp={e => {
          const start = dragStart.current;
          dragStart.current = null;
          setDrag(null);
          if (!start?.moved) return;
          const nx = round1(clampX(eff.x + (e.clientX - start.px) / scale, eff.width, pageWidth));
          const ny = round1(clampY(eff.y - (e.clientY - start.py) / scale, eff.height, pageHeight));
          onPatch({
            x: nx === round1(img.x) ? null : nx,
            y: ny === round1(img.y) ? null : ny,
          });
        }}
      >
        {selected && (
          <div
            className="seg-grip"
            title="Arrastrar para escalar la imagen"
            onPointerDown={e => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              gripStart.current = { px: e.clientX, py: e.clientY };
            }}
            onPointerMove={e => {
              if (!gripStart.current) return;
              e.stopPropagation();
              setGripDelta({ dx: e.clientX - gripStart.current.px, dy: e.clientY - gripStart.current.py });
            }}
            onPointerUp={e => {
              e.stopPropagation();
              const start = gripStart.current;
              gripStart.current = null;
              setGripDelta(null);
              if (!start) return;
              const newW = Math.max(4, round1(eff.width + (e.clientX - start.px) / scale));
              const newH = Math.max(4, round1(eff.height + (e.clientY - start.py) / scale));
              // El grip SE agranda hacia abajo: el TOP queda fijo (y' = top − h').
              const top = eff.y + eff.height;
              const newY = round1(top - newH);
              onPatch({
                width: newW === round1(img.width) ? null : newW,
                height: newH === round1(img.height) ? null : newH,
                y: newY === round1(img.y) ? null : newY,
              });
            }}
            onClick={e => e.stopPropagation()}
          />
        )}
      </div>
    </>
  );
}

interface SegmentBoxProps {
  seg: SegmentNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  editing: boolean;
  edit: SegmentEdit | null;
  isLocked: boolean;
  onDragging: (active: boolean) => void;
  onSelect: () => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onPatch: (patch: SegmentPatch) => void;
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  onAddText: (req: AddTextRequest) => void;
  highlightColor: string;
  onHighlightColor: (c: string) => void;
}

function SegmentBox({ seg, pageWidth, pageHeight, scale, selected, editing, edit, isLocked, onDragging, onSelect, onStartEdit, onStopEdit, onPatch, onDocOp, onRequestLink, onAddText, highlightColor, onHighlightColor }: SegmentBoxProps) {
  const eff = effectiveGeometry(seg, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const editRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const gripStart = useRef<number | null>(null);
  const [gripRatio, setGripRatio] = useState<number | null>(null);

  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  // El panel de propiedades pide "estilo a la selección" con un evento: solo
  // el box EN EDICIÓN lo atiende (el botón preserva la selección con
  // preventDefault en su mousedown). Y `beforeinput` intercepta el formato que
  // llega SIN teclado (menú Formato del sistema, menú contextual, dictado):
  // inputType formatBold/formatItalic → nuestro modelo; el resto de format* y
  // el undo nativo se bloquean — el browser jamás muta el DOM por su cuenta.
  useEffect(() => {
    // Solo el box editando Y seleccionado atiende el evento de estilo — evita
    // que un editor viejo (aún abierto) reciba la B destinada a otro nodo.
    if (!editing || !selected) return;
    const el = editRef.current;
    if (!el) return;
    const onStyle = (ev: Event) => {
      const detail = (ev as CustomEvent<{ key?: 'bold' | 'italic' | 'color'; color?: string }>).detail;
      if (detail?.key === 'bold' || detail?.key === 'italic') applySelectionStyle(el, seg, edit, scale, detail.key);
      else if (detail?.key === 'color' && detail.color) applySelectionColor(el, seg, edit, scale, detail.color);
    };
    const onBeforeInput = (ev: InputEvent) => {
      const t = ev.inputType || '';
      if (t === 'formatBold' || t === 'formatItalic') {
        ev.preventDefault();
        applySelectionStyle(el, seg, edit, scale, t === 'formatBold' ? 'bold' : 'italic');
      } else if (t.startsWith('format') || t === 'historyUndo' || t === 'historyRedo') {
        ev.preventDefault();
      }
    };
    window.addEventListener(SELECTION_STYLE_EVENT, onStyle);
    el.addEventListener('beforeinput', onBeforeInput as EventListener);
    return () => {
      window.removeEventListener(SELECTION_STYLE_EVENT, onStyle);
      el.removeEventListener('beforeinput', onBeforeInput as EventListener);
    };
  }, [editing, selected, seg, edit, scale]);

  // Sin velos ni masks: la extirpación del original arranca CON el gesto
  // (onDragging) — para cuando el usuario suelta, el canvas ya no tiene los
  // glifos viejos. El único transitorio es el original desvaneciéndose una
  // fracción de segundo al arrancar el drag (el bake local aterrizando).

  // Segmento eliminado: el preview local lo extirpa — nada que dibujar
  // (Ctrl+Z lo restaura).
  if (edit?.remove) return null;

  // Un segmento con edición pendiente fue EXTIRPADO del preview: este box
  // fantasma dibuja el estado nuevo (transparente — flota sobre lo que haya).
  const masked = editing || edit != null || drag != null;
  const html = seedHtml(seg, edit, scale);

  const commitFromDom = (el: HTMLElement) => {
    const sizeRatio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
    const runs = serializeStyled(el, seg, sizeRatio);
    onPatch({
      text: styledText(runs),
      runs: styledRunsEqual(runs, originalStyledRuns(seg)) ? null : runs,
    });
  };

  return (
    <>
      {selected && !isLocked && (
        <FloatingBar seg={seg} edit={edit} rect={rect} pageWidth={pageWidth} onPatch={onPatch} onDocOp={onDocOp} onRequestLink={onRequestLink} highlightColor={highlightColor} onHighlightColor={onHighlightColor} />
      )}
      <div
        className={`seg-box${selected ? ' selected' : ''}${masked ? ' masked' : ''}${edit ? ' edited' : ''}${editing ? ' editing' : ''}${isLocked ? ' locked' : ''}`}
        style={{
          left: rect.left,
          top: rect.top,
          minWidth: rect.width,
          height: rect.height,
          lineHeight: `${rect.height}px`,
          transform: drag
            ? `translate(${drag.dx}px, ${drag.dy}px)`
            : gripRatio
              ? `scale(${gripRatio})`
              : undefined,
          transformOrigin: 'left bottom',
        }}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        onDoubleClick={e => { e.stopPropagation(); onStartEdit(); }}
        onPointerDown={e => {
          // Arrastrar directo, sin pre-seleccionar: el pointerdown selecciona
          // Y arma el drag en el mismo gesto.
          if (editing || e.button !== 0) return;
          if (!selected) onSelect();
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragStart.current = { px: e.clientX, py: e.clientY, moved: false };
        }}
        onPointerMove={e => {
          const start = dragStart.current;
          if (!start) return;
          const dx = e.clientX - start.px;
          const dy = e.clientY - start.py;
          if (!start.moved && Math.abs(dx) + Math.abs(dy) > 3) {
            start.moved = true;
            // Extirpación TEMPRANA: el preview borra el original apenas
            // arranca el gesto — el texto viaja sin quedar duplicado atrás.
            onDragging(true);
          }
          if (start.moved) setDrag({ dx, dy });
        }}
        onPointerUp={e => {
          const start = dragStart.current;
          dragStart.current = null;
          setDrag(null);
          if (!start?.moved) return;
          const nx = round1(clampX(eff.x + (e.clientX - start.px) / scale, eff.width, pageWidth));
          const nb = round1(Math.min(Math.max(eff.baseline - (e.clientY - start.py) / scale, 8), pageHeight - 4));
          // El commit y el fin del arrastre van en el MISMO lote de estado:
          // la extirpación en vuelo la releva el edit sin re-bake visible.
          onPatch({
            x: nx === round1(seg.x) ? null : nx,
            baseline: nb === round1(seg.baseline) ? null : nb,
          });
          onDragging(false);
        }}
        onPointerCancel={() => {
          const start = dragStart.current;
          dragStart.current = null;
          setDrag(null);
          if (start?.moved) onDragging(false);
        }}
        title={editing ? undefined : (edit?.text ?? seg.text)}
      >
        {masked && (
          <div
            ref={editRef}
            className="seg-text"
            style={containerStyle(seg, edit, scale)}
            contentEditable={editing}
            suppressContentEditableWarning
            spellCheck={false}
            dangerouslySetInnerHTML={{ __html: html }}
            onBlur={e => {
              if (!editing) return;
              onStopEdit();
              commitFromDom(e.currentTarget);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                // Enter en un ítem de LISTA → commit + crear el SIGUIENTE ítem
                // con el marcador incrementado (• → •, "3." → "4.", "b)" → "c)").
                const el = e.currentTarget;
                const sizeRatio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
                const marker = nextListMarker(styledText(serializeStyled(el, seg, sizeRatio)));
                el.blur();
                if (marker) {
                  const effNow = effectiveGeometry(seg, edit);
                  const size = edit?.fontSize ?? seg.fontSize;
                  onAddText({
                    page: seg.page,
                    x: effNow.x,
                    baseline: round1(effNow.baseline - size * 1.4),
                    text: marker,
                    size,
                    bucket: dominantRun(seg).font.bucket,
                  });
                }
                return;
              }
              if (e.key === 'Escape') {
                e.currentTarget.innerHTML = seedHtml(seg, edit, scale);
                e.currentTarget.blur();
              }
              // Cmd/Ctrl+B / +I: estilo a la SELECCIÓN, vía el modelo — nunca
              // el execCommand del browser (parte los spans y pierde data-b).
              if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'i')) {
                e.preventDefault();
                applySelectionStyle(e.currentTarget, seg, edit, scale, e.key === 'b' ? 'bold' : 'italic');
              }
            }}
          />
        )}
        {selected && !editing && (
          <div
            className="seg-grip"
            title="Arrastrar para escalar el texto"
            onPointerDown={e => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              gripStart.current = e.clientX;
            }}
            onPointerMove={e => {
              if (gripStart.current == null) return;
              e.stopPropagation();
              const ratio = Math.max(0.2, (rect.width + e.clientX - gripStart.current) / rect.width);
              setGripRatio(ratio);
            }}
            onPointerUp={e => {
              e.stopPropagation();
              const start = gripStart.current;
              gripStart.current = null;
              setGripRatio(null);
              if (start == null) return;
              const ratio = Math.max(0.2, (rect.width + e.clientX - start) / rect.width);
              const size = Math.max(4, round1(eff.fontSize * ratio));
              onPatch({ fontSize: size === round1(seg.fontSize) ? null : size });
            }}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
          />
        )}
      </div>
    </>
  );
}
