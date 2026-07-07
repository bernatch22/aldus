/**
 * HighlightBox — un resaltado GUARDADO (HighlightNode de /Annots) como box
 * overlay: seleccionar, arrastrar (mover) y borrar. A diferencia del resaltado
 * PENDIENTE (capa hija del SegmentBox, anclada al texto), éste es un objeto
 * independiente — una vez aplicado, se mueve por su cuenta (como en Acrobat).
 * El editor lo dibuja acá (no pdf.js: el render del canvas desactiva las
 * anotaciones) para poder editarlo.
 */
import {
  effectiveHighlightRect,
  pdfRectToCss,
  type HighlightEdit,
  type HighlightNode,
  type HighlightPatch,
} from '@aldus/core';
import { Trash2 } from 'lucide-react';
import { round1 } from '../styledDom';
import { useDragGesture } from './useDragGesture';

export function HighlightBox({ hl, pageHeight, scale, selected, edit, isLocked, groupMode, onSelect, onPatch }: {
  hl: HighlightNode;
  pageHeight: number;
  scale: number;
  selected: boolean;
  edit: HighlightEdit | null;
  isLocked: boolean;
  groupMode?: boolean;
  onSelect: () => void;
  onPatch: (patch: HighlightPatch) => void;
}) {
  const eff = effectiveHighlightRect(hl, edit);
  if (eff.removed) return null; // eliminado: el preview local lo saca (Ctrl+Z lo restaura)
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);

  const gesture = useDragGesture({
    onDown: () => { if (!selected) onSelect(); },
    onDrop: (_e, { dx, dy }) => {
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // click, no drag
      // CSS abajo (dy>0) = y del PDF baja. x directo.
      onPatch({ x: round1(eff.x + dx / scale), y: round1(eff.y - dy / scale) });
    },
  });
  const drag = gesture.delta;

  return (
    <div
      className={`hl-box${selected ? ' selected' : ''}${isLocked ? ' locked' : ''}`}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        background: hl.color || '#ffd400',
        transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
      }}
      title="Resaltado — arrastrá para mover, Supr para borrar"
      onClick={e => { e.stopPropagation(); onSelect(); }}
      {...gesture.handlers}
    >
      {selected && !isLocked && !groupMode && (
        <button
          className="hl-del"
          title="Eliminar resaltado"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onPatch({ remove: true }); }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}
