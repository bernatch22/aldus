/**
 * WidgetBox — un campo de formulario (AcroForm): seleccionar, arrastrar (mover),
 * grip (escalar). La edición se aplica al instante (reescritura del /Rect de la
 * anotación).
 */
import {
  effectiveWidgetRect,
  pdfRectToCss,
  type WidgetEdit,
  type WidgetNode,
  type WidgetPatch,
} from '@aldus/core';
import { round1 } from '../styledDom';
import { clampX, clampY } from './helpers';
import { ObjectBar } from './ObjectBar';
import { useDragGesture } from './useDragGesture';
import { useGripResize } from './useGripResize';

interface WidgetBoxProps {
  widget: WidgetNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  edit: WidgetEdit | null;
  isLocked: boolean;
  snapshot: { url: string; width: number; height: number } | null;
  groupMode?: boolean;
  onSelect: () => void;
  onPatch: (patch: WidgetPatch) => void;
}

const WIDGET_LABEL: Record<WidgetNode['widgetType'], string> = {
  text: 'texto', checkbox: 'checkbox', radio: 'radio', select: 'select',
  list: 'lista', button: 'botón', signature: 'firma',
};

/** Un campo de formulario: seleccionar, arrastrar (mover), grip (escalar).
 *  La edición se aplica al instante (reescritura del /Rect de la anotación). */
export function WidgetBox({ widget, pageWidth, pageHeight, scale, selected, edit, isLocked, snapshot, groupMode, onSelect, onPatch }: WidgetBoxProps) {
  const eff = effectiveWidgetRect(widget, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const orig = pdfRectToCss({ x: widget.x, y: widget.y, width: widget.width, height: widget.height }, pageHeight, scale);

  const gesture = useDragGesture({
    onDown: () => { if (!selected) onSelect(); },
    onDrop: (_e, { dx, dy }) => {
      const nx = round1(clampX(eff.x + dx / scale, eff.width, pageWidth));
      const ny = round1(clampY(eff.y - dy / scale, eff.height, pageHeight));
      onPatch({
        x: nx === round1(widget.x) ? null : nx,
        y: ny === round1(widget.y) ? null : ny,
      });
    },
  });
  const drag = gesture.delta;

  const grip = useGripResize<{ dx: number; dy: number }>({
    map: (dx, dy) => ({ dx, dy }),
    onCommit: (dx, dy) => {
      const newW = Math.max(6, round1(eff.width + dx / scale));
      const newH = Math.max(6, round1(eff.height + dy / scale));
      const top = eff.y + eff.height;
      const newY = round1(top - newH);
      onPatch({
        width: newW === round1(widget.width) ? null : newW,
        height: newH === round1(widget.height) ? null : newH,
        y: newY === round1(widget.y) ? null : newY,
      });
    },
  });
  const gripDelta = grip.size;

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
      {selected && !isLocked && !groupMode && (
        <ObjectBar
          rect={rect} pageWidth={pageWidth} width={eff.width}
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
      {...gesture.handlers}
    >
      {selected && <span className="widget-label">{WIDGET_LABEL[widget.widgetType]} · {widget.fieldName}</span>}
      {!isLocked && !groupMode && (
        <div
          className="seg-grip"
          title="Arrastrar para redimensionar el campo"
          {...grip.handlers}
        />
      )}
    </div>
    </>
  );
}
