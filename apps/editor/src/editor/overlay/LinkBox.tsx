/**
 * LinkBox — un link GUARDADO (LinkNode de /Annots) como box overlay:
 * seleccionar, arrastrar (mover el área clickeable) y borrar. Misma capa y
 * mismas capacidades que HighlightBox — las anotaciones son objetos, no
 * píxeles. La URL se muestra como tag al seleccionar.
 */
import {
  effectiveLinkRect,
  pdfRectToCss,
  type LinkEdit,
  type LinkNode,
  type LinkPatch,
} from '@aldus/core';
import { Link2, Trash2 } from 'lucide-react';
import { round1 } from '../styledDom';
import { useDragGesture } from './useDragGesture';

export function LinkBox({ link, pageHeight, scale, selected, edit, isLocked, groupMode, onSelect, onPatch }: {
  link: LinkNode;
  pageHeight: number;
  scale: number;
  selected: boolean;
  edit: LinkEdit | null;
  isLocked: boolean;
  groupMode?: boolean;
  onSelect: () => void;
  onPatch: (patch: LinkPatch) => void;
}) {
  const eff = effectiveLinkRect(link, edit);
  if (eff.removed) return null; // eliminado: pendiente de Aplicar (Ctrl+Z lo restaura)
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);

  const gesture = useDragGesture({
    onDown: () => { if (!selected) onSelect(); },
    onDrop: (_e, { dx, dy }) => {
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // click, no drag
      onPatch({ x: round1(eff.x + dx / scale), y: round1(eff.y - dy / scale) });
    },
  });
  const drag = gesture.delta;

  return (
    <div
      className={`link-box${selected ? ' selected' : ''}${isLocked ? ' locked' : ''}`}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
      }}
      title={`Link → ${link.url} (arrastrá para mover, Supr para borrar)`}
      onClick={e => { e.stopPropagation(); onSelect(); }}
      {...gesture.handlers}
    >
      {selected && !isLocked && !groupMode && (
        <div className="link-tag" onPointerDown={e => e.stopPropagation()}>
          <Link2 size={11} />
          <span>{link.url.length > 36 ? `${link.url.slice(0, 34)}…` : link.url}</span>
          <button
            title="Eliminar link"
            onClick={e => { e.stopPropagation(); onPatch({ remove: true }); }}
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
