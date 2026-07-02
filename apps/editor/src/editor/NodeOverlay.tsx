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
  originalStyledRuns,
  pdfRectToCss,
  styledRunsEqual,
  styledText,
  type ImageEdit,
  type ImageNode,
  type ImagePatch,
  type PageGraph,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
  type WidgetEdit,
  type WidgetNode,
  type WidgetPatch,
} from '@aldus/core';
import {
  applySelectionStyle,
  bucketFallback,
  dominantRun,
  family,
  round1,
  seedHtml,
  serializeStyled,
  SELECTION_STYLE_EVENT,
} from './styledDom';

export type EditAction = SegmentEdit | { segmentId: string; revert: true };
export type ImageEditAction = ImageEdit | { imageId: string; revert: true };
export type WidgetEditAction = WidgetEdit | { widgetId: string; revert: true };

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
  };
}

// Ningún drag puede dejar un nodo perdido fuera de la página: al soltar,
// siempre quedan al menos 24pt visibles.
const MIN_VISIBLE = 24;
const clampX = (x: number, w: number, pageW: number) => Math.min(Math.max(x, MIN_VISIBLE - w), pageW - MIN_VISIBLE);
const clampY = (y: number, h: number, pageH: number) => Math.min(Math.max(y, MIN_VISIBLE - h), pageH - MIN_VISIBLE);

export function NodeOverlay({ graph, scale, selectedId, onSelect, edits, onEdit, imageEdits, onImageEdit, widgetEdits, onWidgetEdit, locked, placing, onPlace, snapshot }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [graph.page]);

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
        onSelect(null);
      }}
    >
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
          onSelect={() => onSelect(w.id)}
          onPatch={patch => {
            const merged = mergeWidgetEdit(w, widgetEdits.get(w.id) ?? null, patch);
            onWidgetEdit(merged ?? { widgetId: w.id, revert: true });
          }}
        />
      ))}
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
          onSelect={() => onSelect(img.id)}
          onPatch={patch => {
            const merged = mergeImageEdit(img, imageEdits.get(img.id) ?? null, patch);
            onImageEdit(merged ?? { imageId: img.id, revert: true });
          }}
        />
      ))}
      {graph.segments.map(seg => (
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
          onSelect={() => onSelect(seg.id)}
          onStartEdit={() => { onSelect(seg.id); setEditingId(seg.id); }}
          onStopEdit={() => setEditingId(null)}
          onPatch={patch => {
            const merged = mergeSegmentEdit(seg, edits.get(seg.id) ?? null, patch);
            onEdit(merged ?? { segmentId: seg.id, revert: true });
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
  onSelect: () => void;
  onPatch: (patch: WidgetPatch) => void;
}

const WIDGET_LABEL: Record<WidgetNode['widgetType'], string> = {
  text: 'texto', checkbox: 'checkbox', radio: 'radio', select: 'select',
  list: 'lista', button: 'botón', signature: 'firma',
};

/** Un campo de formulario: seleccionar, arrastrar (mover), grip (escalar).
 *  La edición se aplica al instante (reescritura del /Rect de la anotación). */
function WidgetBox({ widget, pageWidth, pageHeight, scale, selected, edit, isLocked, onSelect, onPatch }: WidgetBoxProps) {
  const eff = effectiveWidgetRect(widget, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const dragStart = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const gripStart = useRef<{ px: number; py: number } | null>(null);
  const [gripDelta, setGripDelta] = useState<{ dx: number; dy: number } | null>(null);

  if (eff.removed) {
    return (
      <div
        className="img-removed"
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      >
        <span className="ghost-label">eliminando…</span>
      </div>
    );
  }

  return (
    <div
      className={`widget-box${selected ? ' selected' : ''}${edit ? ' edited' : ''}${isLocked ? ' locked' : ''}`}
      style={{
        left: rect.left,
        top: rect.top,
        width: gripDelta ? rect.width + gripDelta.dx : rect.width,
        height: gripDelta ? rect.height + gripDelta.dy : rect.height,
        transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
      }}
      title={`Campo ${WIDGET_LABEL[widget.widgetType]} · ${widget.fieldName}`}
      onClick={e => { e.stopPropagation(); onSelect(); }}
      onPointerDown={e => {
        if (!selected || e.button !== 0) return;
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

  if (eff.removed) {
    return (
      <div
        className={`img-removed${selected ? ' selected' : ''}`}
        style={{ left: orig.left, top: orig.top, width: orig.width, height: orig.height }}
        title="Eliminando imagen…"
        onClick={e => { e.stopPropagation(); onSelect(); }}
      >
        <span className="ghost-label">eliminando…</span>
      </div>
    );
  }

  const ghost = eff.moved;
  // Los píxeles del preview: crop del snapshot de la página, reescalado al
  // tamaño efectivo del box (background-position/size hacen el crop).
  const ghostPixels = ghost && snapshot && orig.width > 0 && orig.height > 0
    ? {
        backgroundImage: `url(${snapshot.url})`,
        backgroundSize: `${(snapshot.width * rect.width) / orig.width}px ${(snapshot.height * rect.height) / orig.height}px`,
        backgroundPosition: `${(-orig.left * rect.width) / orig.width}px ${(-orig.top * rect.height) / orig.height}px`,
      }
    : undefined;
  return (
    <>
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
          if (!selected || e.button !== 0) return;
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
        {ghost && <span className="ghost-label">aplicando…</span>}
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
  onSelect: () => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onPatch: (patch: SegmentPatch) => void;
}

function SegmentBox({ seg, pageWidth, pageHeight, scale, selected, editing, edit, isLocked, onSelect, onStartEdit, onStopEdit, onPatch }: SegmentBoxProps) {
  const eff = effectiveGeometry(seg, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const originalRect = pdfRectToCss({ x: seg.x, y: seg.y, width: seg.width, height: seg.height }, pageHeight, scale);
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
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    const onStyle = (ev: Event) => {
      const key = (ev as CustomEvent<{ key?: 'bold' | 'italic' }>).detail?.key;
      if (key === 'bold' || key === 'italic') applySelectionStyle(el, seg, edit, scale, key);
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
  }, [editing, seg, edit, scale]);

  const masked = editing || edit != null;
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
      {edit != null && (
        <div className="seg-mask" style={{ left: originalRect.left, top: originalRect.top, width: originalRect.width, height: originalRect.height }} />
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
          if (editing || !selected || e.button !== 0) return;
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
          const nb = round1(Math.min(Math.max(eff.baseline - (e.clientY - start.py) / scale, 8), pageHeight - 4));
          onPatch({
            x: nx === round1(seg.x) ? null : nx,
            baseline: nb === round1(seg.baseline) ? null : nb,
          });
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
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
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
