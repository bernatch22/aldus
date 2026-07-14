/**
 * linkKind — el link GUARDADO (LinkNode de /Annots) como `INodeKind`.
 * `LinkBox` VERBATIM de v1 (`overlay/LinkBox.tsx`): seleccionar, arrastrar
 * (mover el área clickeable) y borrar. Misma capa y mismas capacidades que
 * HighlightBox — las anotaciones son objetos, no píxeles. La URL se muestra
 * como tag al seleccionar.
 */
import {
  effectiveRect,
  pdfRectToCss,
  type LinkEdit,
  type LinkNode,
  type LinkPatch,
} from '@aldus/core';
import { Link2, Trash2 } from 'lucide-react';
import { clampX, clampY, round1 } from '../../core/index.js';
import { useDragGesture } from './useDragGesture.js';
import type { INodeKind, OverlayCtx } from './types.js';

/** v1 `effectiveLinkRect` = el genérico `effectiveRect` de core v2. */
const effectiveLinkRect = (link: LinkNode, edit: LinkEdit | null) => effectiveRect(link, edit);

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
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);

  const gesture = useDragGesture({
    onDown: () => { if (!selected) onSelect(); },
    onDrop: (_e, { dx, dy }) => {
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // click, no drag
      onPatch({ x: round1(eff.x + dx / scale), y: round1(eff.y - dy / scale) });
    },
  });
  const drag = gesture.delta;

  if (eff.removed) return null; // eliminado: pendiente de Aplicar (Ctrl+Z lo restaura)

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

function LinkKindBox({ ctx, node: lk }: { ctx: OverlayCtx; node: LinkNode }) {
  return (
    <LinkBox
      link={lk}
      pageHeight={ctx.graph.height}
      scale={ctx.scale}
      selected={ctx.selectedId === lk.id || ctx.multiSel.has(lk.id)}
      edit={ctx.linkEdits.get(lk.id) ?? null}
      isLocked={ctx.locked.has(lk.id)}
      groupMode={ctx.multiSel.size > 1}
      onSelect={() => ctx.selectNode(lk.id)}
      onPatch={patch => ctx.ledger.patchRect(lk, patch)}
    />
  );
}

export const linkKind: INodeKind<LinkNode> = {
  kind: 'link',
  find: (graph, id) => graph.links.find(l => l.id === id) ?? null,
  effectiveRect(ledger, lk) {
    const e = ledger.effective(lk);
    return { x: e.x, y: e.y, width: e.width, height: e.height };
  },
  move(ledger, lk, dxPt, dyPt, pageW, pageH) {
    const e = ledger.effective(lk);
    ledger.patchRect(lk, {
      x: round1(clampX(e.x + dxPt, e.width, pageW)),
      y: round1(clampY(e.y + dyPt, e.height, pageH)),
    });
  },
  remove(ledger, lk) {
    ledger.patchRect(lk, { remove: true });
  },
  Box: LinkKindBox,
};
