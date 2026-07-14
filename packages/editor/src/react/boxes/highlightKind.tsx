/**
 * highlightKind — el resaltado GUARDADO (HighlightNode de /Annots) como
 * `INodeKind`. `HighlightBox` VERBATIM de v1 (`overlay/HighlightBox.tsx`):
 * seleccionar, arrastrar (mover) y borrar. A diferencia del resaltado
 * PENDIENTE (capa hija del SegmentBox, anclada al texto), éste es un objeto
 * independiente — una vez aplicado, se mueve por su cuenta (como en Acrobat).
 * El editor lo dibuja acá (no pdf.js: el preview los oculta con el flag
 * Hidden) para poder editarlo.
 *
 * OJO z-order: en el overlay, el `Box` de este kind SOLO dibuja los HUÉRFANOS
 * (sin texto debajo) — los pegados a un segmento los dibuja su SegmentBox
 * (capa hija que sigue al texto). El NodeOverlay filtra antes de renderizar.
 */
import {
  effectiveRect,
  pdfRectToCss,
  type HighlightEdit,
  type HighlightNode,
  type HighlightPatch,
} from '@aldus/core';
import { Trash2 } from 'lucide-react';
import { clampX, clampY, round1 } from '../../core/index.js';
import { useDragGesture } from './useDragGesture.js';
import type { INodeKind, OverlayCtx } from './types.js';

/** v1 `effectiveHighlightRect` = el genérico `effectiveRect` de core v2. */
const effectiveHighlightRect = (hl: HighlightNode, edit: HighlightEdit | null) => effectiveRect(hl, edit);

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

  if (eff.removed) return null; // eliminado: el preview local lo saca (Ctrl+Z lo restaura)

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

function HighlightKindBox({ ctx, node: hl }: { ctx: OverlayCtx; node: HighlightNode }) {
  return (
    <HighlightBox
      hl={hl}
      pageHeight={ctx.graph.height}
      scale={ctx.scale}
      selected={ctx.selectedId === hl.id || ctx.multiSel.has(hl.id)}
      edit={ctx.highlightEdits.get(hl.id) ?? null}
      isLocked={ctx.locked.has(hl.id)}
      groupMode={ctx.multiSel.size > 1}
      onSelect={() => ctx.selectNode(hl.id)}
      onPatch={patch => ctx.ledger.patchRect(hl, patch)}
    />
  );
}

export const highlightKind: INodeKind<HighlightNode> = {
  kind: 'highlight',
  find: (graph, id) => graph.highlights.find(h => h.id === id) ?? null,
  effectiveRect(ledger, hl) {
    const e = ledger.effective(hl);
    return { x: e.x, y: e.y, width: e.width, height: e.height };
  },
  move(ledger, hl, dxPt, dyPt, pageW, pageH) {
    const e = ledger.effective(hl);
    ledger.patchRect(hl, {
      x: round1(clampX(e.x + dxPt, e.width, pageW)),
      y: round1(clampY(e.y + dyPt, e.height, pageH)),
    });
  },
  remove(ledger, hl) {
    ledger.patchRect(hl, { remove: true });
  },
  Box: HighlightKindBox,
};
