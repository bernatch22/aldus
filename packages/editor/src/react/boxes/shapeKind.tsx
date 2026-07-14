/**
 * shapeKind — la forma vectorial (banner/fondo/caja) como `INodeKind`.
 * `ShapeBox` VERBATIM de v1 (`overlay/ShapeBox.tsx`): seleccionar, arrastrar
 * (mover), grip (redimensionar), eliminar. Es un rect de color sólido, así que
 * el preview del drag es un simple div translúcido con ese color; al aterrizar,
 * el re-bake local mueve el rect de verdad (z-order y color intactos).
 */
import {
  effectiveRect,
  pdfRectToCss,
  type ShapeEdit,
  type ShapeNode,
  type ShapePatch,
} from '@aldus/core';
import { clampX, clampY, round1 } from '../../core/index.js';
import { ObjectBar } from '../ObjectBar.js';
import { useDragGesture } from './useDragGesture.js';
import { useGripResize } from './useGripResize.js';
import type { INodeKind, OverlayCtx } from './types.js';

/** v1 `effectiveShapeRect` = el genérico `effectiveRect` de core v2. */
const effectiveShapeRect = (shape: ShapeNode, edit: ShapeEdit | null) => effectiveRect(shape, edit);

interface ShapeBoxProps {
  shape: ShapeNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  edit: ShapeEdit | null;
  isLocked: boolean;
  onSelect: () => void;
  onPatch: (patch: ShapePatch) => void;
}

export function ShapeBox({ shape, pageWidth, pageHeight, scale, selected, edit, isLocked, onSelect, onPatch }: ShapeBoxProps) {
  const eff = effectiveShapeRect(shape, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);

  const gesture = useDragGesture({
    onDown: () => { if (!selected) onSelect(); },
    onDrop: (_e, { dx, dy }) => {
      const nx = round1(clampX(eff.x + dx / scale, eff.width, pageWidth));
      const ny = round1(clampY(eff.y - dy / scale, eff.height, pageHeight));
      if (nx === round1(eff.x) && ny === round1(eff.y)) return;
      onPatch({ x: nx === round1(shape.x) ? null : nx, y: ny === round1(shape.y) ? null : ny });
    },
  });
  const drag = gesture.delta;

  const grip = useGripResize<{ dx: number; dy: number }>({
    map: (dx, dy) => ({ dx, dy }),
    onCommit: (dx, dy) => {
      const newW = Math.max(2, round1(eff.width + dx / scale));
      const newH = Math.max(2, round1(eff.height + dy / scale));
      const top = eff.y + eff.height;
      onPatch({
        width: newW === round1(shape.width) ? null : newW,
        height: newH === round1(shape.height) ? null : newH,
        y: round1(top - newH) === round1(shape.y) ? null : round1(top - newH),
      });
    },
  });
  const gripDelta = grip.size;

  if (eff.removed) return null;

  return (
    <>
      {selected && !isLocked && (
        <ObjectBar
          pageWidth={pageWidth} width={eff.width}
          onAlign={x => onPatch({ x: round1(clampX(x, eff.width, pageWidth)) })}
          onDelete={() => onPatch({ remove: true })}
        />
      )}
      <div
        className={`shape-box${selected ? ' selected' : ''}${edit ? ' edited' : ''}${drag ? ' dragging' : ''}${isLocked ? ' locked' : ''}`}
        style={{
          left: rect.left,
          top: rect.top,
          width: gripDelta ? rect.width + gripDelta.dx : rect.width,
          height: gripDelta ? rect.height + gripDelta.dy : rect.height,
          transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
          // Durante el drag: preview translúcido del color; si no, transparente
          // (el rect real ya está pintado por el canvas debajo).
          backgroundColor: drag ? (shape.color ?? '#88888888') : undefined,
          opacity: drag ? 0.6 : undefined,
          zIndex: drag ? 34 : undefined,
        }}
        title={`Forma · ${Math.round(eff.width)}×${Math.round(eff.height)} pt`}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        {...gesture.handlers}
      >
        {!isLocked && (
          <div className="seg-grip" title="Arrastrar para redimensionar" {...grip.handlers} />
        )}
      </div>
    </>
  );
}

function ShapeKindBox({ ctx, node: shape }: { ctx: OverlayCtx; node: ShapeNode }) {
  return (
    <ShapeBox
      shape={shape}
      pageWidth={ctx.graph.width}
      pageHeight={ctx.graph.height}
      scale={ctx.scale}
      selected={ctx.selectedId === shape.id}
      edit={ctx.shapeEdits.get(shape.id) ?? null}
      isLocked={ctx.locked.has(shape.id)}
      onSelect={() => ctx.selectNode(shape.id)}
      onPatch={patch => ctx.ledger.patchRect(shape, patch)}
    />
  );
}

export const shapeKind: INodeKind<ShapeNode> = {
  kind: 'shape',
  find: (graph, id) => (graph.shapes ?? []).find(s => s.id === id) ?? null,
  effectiveRect(ledger, shape) {
    const e = ledger.effective(shape);
    return { x: e.x, y: e.y, width: e.width, height: e.height };
  },
  move(ledger, shape, dxPt, dyPt, pageW, pageH) {
    const e = ledger.effective(shape);
    ledger.patchRect(shape, {
      x: round1(clampX(e.x + dxPt, e.width, pageW)),
      y: round1(clampY(e.y + dyPt, e.height, pageH)),
    });
  },
  remove(ledger, shape) {
    ledger.patchRect(shape, { remove: true });
  },
  Box: ShapeKindBox,
};
