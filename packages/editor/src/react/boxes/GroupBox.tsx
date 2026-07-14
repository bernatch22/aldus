/**
 * GroupBox — la caja que envuelve una selección múltiple: arrastrar la mueve
 * entera; su tag resalta los segmentos del grupo y borra todos los nodos.
 * (v1 COPY.) NO es un `INodeKind`: es la selección múltiple sintética del
 * overlay, no un tipo de nodo del grafo.
 */
import { Highlighter, Trash2 } from 'lucide-react';
import { useDragGesture } from './useDragGesture.js';

/** Caja que envuelve una selección múltiple: arrastrar la mueve entera. */
export function GroupBox({ bbox, count, onMove, onHighlight, onDelete, onClear }: {
  bbox: { left: number; top: number; width: number; height: number } | null;
  count: number;
  onMove: (dxCss: number, dyCss: number) => void;
  /** Resaltar los SEGMENTOS del grupo (ausente = no hay texto seleccionado). */
  onHighlight?: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const gesture = useDragGesture({
    onDrop: (_e, { dx, dy }) => onMove(dx, dy),
    onClick: () => onClear(), // click sin arrastrar = deseleccionar el grupo
  });
  const drag = gesture.delta;
  if (!bbox) return null;
  const PAD = 4;
  return (
    <div
      className="group-box"
      style={{ left: bbox.left - PAD, top: bbox.top - PAD, width: bbox.width + PAD * 2, height: bbox.height + PAD * 2, transform: drag ? `translate(${drag.dx}px,${drag.dy}px)` : undefined }}
      onClick={e => e.stopPropagation()}
      {...gesture.handlers}
    >
      <div className="group-tag" onPointerDown={e => e.stopPropagation()}>
        {count} seleccionados
        {onHighlight && (
          <button title="Resaltar los textos del grupo (acumula, se escribe con Aplicar)" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onHighlight(); }}><Highlighter size={12} /></button>
        )}
        <button title="Eliminar todos" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDelete(); }}><Trash2 size={12} /></button>
      </div>
    </div>
  );
}
