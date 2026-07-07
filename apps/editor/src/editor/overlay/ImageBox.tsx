/**
 * ImageBox — una imagen del grafo: seleccionar, arrastrar (mover), grip
 * (escalar), eliminar (desde el panel). Preview de mover/escalar: el box del
 * destino muestra los PÍXELES reales de la imagen (con transparencia, vía
 * cleanPixels); el original en el canvas se tapa con un velo mientras se
 * arrastra, y al aterrizar el re-bake lo muda de verdad. Eliminada: velo rojo
 * translúcido.
 */
import { useRef } from 'react';
import {
  effectiveImageRect,
  pdfRectToCss,
  type ImageEdit,
  type ImageNode,
  type ImagePatch,
} from '@aldus/core';
import { round1 } from '../styledDom';
import { clampX, clampY } from './helpers';
import { ObjectBar } from './ObjectBar';
import { useDragGesture } from './useDragGesture';
import { useGripResize } from './useGripResize';

interface ImageBoxProps {
  img: ImageNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  edit: ImageEdit | null;
  isLocked: boolean;
  snapshot: { url: string; width: number; height: number } | null;
  /** dataURL de los píxeles reales de la imagen (transparencia real). Si existe,
   *  el ghost lo usa directo (sin halo); si no, cae al crop del snapshot. */
  cleanPixels: string | null;
  groupMode?: boolean;
  onSelect: () => void;
  onPatch: (patch: ImagePatch) => void;
  /** Arranque/fin del arrastre (dispara/sostiene el lift, como el texto). */
  onDragging: (id: string, active: boolean, committed?: boolean) => void;
}

/** Una imagen del grafo: seleccionar, arrastrar (mover), grip (escalar),
 *  eliminar (desde el panel). Preview de mover/escalar: el box del destino
 *  muestra los PÍXELES reales de la imagen (con transparencia, vía cleanPixels);
 *  el original en el canvas se tapa con un velo mientras se arrastra, y al
 *  aterrizar el re-bake lo muda de verdad. Eliminada: velo rojo translúcido. */
export function ImageBox({ img, pageWidth, pageHeight, scale, selected, edit, isLocked, snapshot, cleanPixels, groupMode, onSelect, onPatch, onDragging }: ImageBoxProps) {
  const eff = effectiveImageRect(img, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const orig = pdfRectToCss({ x: img.x, y: img.y, width: img.width, height: img.height }, pageHeight, scale);
  // Snapshot CONGELADO al arrancar el gesto (con la imagen en su posición
  // ORIGINAL) + su rect original. El ghost recorta de ACÁ, no del snapshot
  // vivo que muta cuando el re-bake aterriza → cero fragmentos.
  const dragSnap = useRef<{ snap: NonNullable<typeof snapshot>; origLeft: number; origTop: number; origW: number; origH: number } | null>(null);

  const gesture = useDragGesture({
    onDown: () => {
      if (!selected) onSelect();
      // Congelar el snapshot + rect original AHORA (imagen en su lugar).
      if (snapshot) dragSnap.current = { snap: snapshot, origLeft: orig.left, origTop: orig.top, origW: orig.width, origH: orig.height };
    },
    onStart: () => {
      // El gesto arrancó: PdfCanvas blitea el lift (página sin esta imagen)
      // — el original se esfuma al "levantarlo", sin velo blanco.
      onDragging(img.id, true);
    },
    onDrop: (_e, { dx, dy }) => {
      const nx = round1(clampX(eff.x + dx / scale, eff.width, pageWidth));
      const ny = round1(clampY(eff.y - dy / scale, eff.height, pageHeight));
      const noop = nx === round1(eff.x) && ny === round1(eff.y);
      if (noop) { onDragging(img.id, false, false); return; }
      onPatch({
        x: nx === round1(img.x) ? null : nx,
        y: ny === round1(img.y) ? null : ny,
      });
      // Commit + fin del arrastre en el mismo lote: el lift se sostiene hasta
      // que el preview re-horneado (imagen en su nuevo lugar) aterrice.
      onDragging(img.id, false, true);
    },
    onCancel: () => { onDragging(img.id, false, false); },
  });
  const drag = gesture.delta;

  const grip = useGripResize<{ dx: number; dy: number }>({
    map: (dx, dy) => ({ dx, dy }),
    onCommit: (dx, dy) => {
      const newW = Math.max(4, round1(eff.width + dx / scale));
      const newH = Math.max(4, round1(eff.height + dy / scale));
      // El grip SE agranda hacia abajo: el TOP queda fijo (y' = top − h').
      const top = eff.y + eff.height;
      const newY = round1(top - newH);
      onPatch({
        width: newW === round1(img.width) ? null : newW,
        height: newH === round1(img.height) ? null : newH,
        y: newY === round1(img.y) ? null : newY,
      });
    },
  });
  const gripDelta = grip.size;

  // Eliminada: el preview local ya la quitó del render (Ctrl+Z la restaura).
  if (eff.removed) return null;

  // MOVIDA: tiene una edición de posición/tamaño. El bake la reubica EN SU LUGAR
  // (z-order intacto), lo que puede dejarla TAPADA por contenido dibujado después
  // en el destino. Por eso el overlay la mantiene visible con un "sticker" de sus
  // píxeles limpios ARRIBA (z-index alto) de forma PERSISTENTE — no solo durante
  // el drag. Así "lo que ves es lo que hay" sin reordenar el stream (reordenar
  // rompería la identidad: pdf.js re-numera los objId por orden de pintado).
  const moved = !!edit && !edit.remove && (edit.x != null || edit.y != null || edit.width != null || edit.height != null);
  // TRANSITORIO: durante el drag y el lapso de re-bake (movePending) también se
  // acepta el crop del snapshot como fallback si no hay píxeles limpios.
  const movePending = !!edit && !edit.remove && (
    (edit.x != null && Math.abs(edit.x - img.x) > 0.7) ||
    (edit.y != null && Math.abs(edit.y - img.y) > 0.7) ||
    (edit.width != null && Math.abs(edit.width - img.width) > 0.7) ||
    (edit.height != null && Math.abs(edit.height - img.height) > 0.7)
  );
  const transient = drag != null || movePending;
  const ghost = drag != null || moved;
  // Píxeles del sticker: SIEMPRE los reales (`cleanPixels`, transparencia exacta,
  // sin halo). El crop del snapshot (con fondo) solo se usa como fallback TRANSITORIO
  // (mask/inline sin píxeles limpios) — nunca persistente, sería un recorte stale.
  const fs = dragSnap.current;
  const gSnap = fs?.snap ?? snapshot;
  const gL = fs?.origLeft ?? orig.left, gT = fs?.origTop ?? orig.top, gW = fs?.origW ?? orig.width, gH = fs?.origH ?? orig.height;
  const ghostPixels = !ghost
    ? undefined
    : cleanPixels
      ? { backgroundImage: `url(${cleanPixels})`, backgroundSize: '100% 100%' as const }
      : transient && gSnap && gW > 0 && gH > 0
        ? {
            backgroundImage: `url(${gSnap.url})`,
            backgroundSize: `${(gSnap.width * rect.width) / gW}px ${(gSnap.height * rect.height) / gH}px`,
            backgroundPosition: `${(-gL * rect.width) / gW}px ${(-gT * rect.height) / gH}px`,
          }
        : undefined;
  // El velo blanco del original ya NO se usa: el LIFT (re-bake sin la imagen)
  // muestra lo que hay detrás mientras se arrastra — sin rectángulo blanco.
  return (
    <>
      {selected && !isLocked && !groupMode && (
        <ObjectBar
          rect={rect} pageWidth={pageWidth} width={eff.width}
          onAlign={x => onPatch({ x: round1(clampX(x, eff.width, pageWidth)) })}
          onZ={o => onPatch({ zOrder: o })}
          onDelete={() => onPatch({ remove: true })}
        />
      )}
      <div
        className={`img-box${selected ? ' selected' : ''}${edit ? ' edited' : ''}${ghost ? ' ghost' : ''}${transient ? ' dragging' : ''}${isLocked ? ' locked' : ''}`}
        style={{
          left: rect.left,
          top: rect.top,
          width: gripDelta ? rect.width + gripDelta.dx : rect.width,
          height: gripDelta ? rect.height + gripDelta.dy : rect.height,
          transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
          // Al mover/moverse: AL FRENTE de todo el overlay (no se pierde detrás
          // de otros nodos ni del canvas).
          zIndex: ghost ? 36 : undefined,
          ...ghostPixels,
        }}
        title={`Imagen · ${Math.round(eff.width)}×${Math.round(eff.height)} pt`}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        {...gesture.handlers}
      >
        {!isLocked && !groupMode && (
          <div
            className="seg-grip"
            title="Arrastrar para escalar la imagen"
            {...grip.handlers}
          />
        )}
      </div>
    </>
  );
}
