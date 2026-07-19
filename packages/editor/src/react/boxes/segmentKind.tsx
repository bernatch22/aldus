/**
 * segmentKind — el SEGMENTO (la unidad de edición) como `INodeKind`.
 *
 * `SegmentBox` viaja VERBATIM de v1 (`overlay/SegmentBox.tsx`): seleccionar,
 * arrastrar (mover), doble click (editar in situ vía el TextEditController),
 * grip (ampliar el área tipeable). El kind agrega el lado de DATOS del
 * contrato (find/effectiveRect/move/remove) que en v1 vivía repetido en 6
 * cascadas if-por-tipo.
 */
import { useEffect } from 'react';
import {
  effectiveGeometry,
  pdfRectToCss,
  type HighlightPatch,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
} from '@aldus/core';
import {
  clampX,
  clampY,
  containerStyle,
  dbgStyles,
  round1,
  seedHtml,
  type TextEditController,
} from '../../core/index.js';
import { FloatingBar } from '../FloatingBar.js';
import { useDragGesture } from './useDragGesture.js';
import { useGripResize } from './useGripResize.js';
import type { AddTextRequest, INodeKind, OverlayCtx, OverlayHighlight, SavedHighlight } from './types.js';

interface SegmentBoxProps {
  seg: SegmentNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  editing: boolean;
  edit: SegmentEdit | null;
  /** El segmento sigue en el grafo del preview (el canvas AÚN lo muestra) — el
   *  extirpado del re-bake no llegó todavía. Con edición pendiente, ese lapso
   *  necesita una máscara OPACA (si no, el original del canvas se transparenta
   *  bajo el fantasma y se ve "roto" unos ms). */
  onCanvas: boolean;
  isLocked: boolean;
  onDragging: (active: boolean, committed?: boolean) => void;
  /** Ancho de área tipeable (pt) fijado por el grip, o null (= ancho natural). */
  area: { w?: number; h?: number } | null;
  onArea: (a: { w?: number; h?: number } | null) => void;
  /** Selección múltiple activa: el box solo muestra highlight (la barra y el
   *  grip los maneja la caja de grupo). */
  groupMode?: boolean;
  controller: TextEditController;
  onSelect: () => void;
  onStartEdit: () => void;
  onPatch: (patch: SegmentPatch) => void;
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  onAddText: (req: AddTextRequest) => void;
  /** Resaltados pendientes de ESTE segmento (capa hija, detrás del texto): al
   *  ser hijos del box heredan su transform y lo siguen al arrastrar. */
  highlights: OverlayHighlight[] | null;
  /** Resaltados GUARDADOS (/Annots) PEGADOS a este segmento: capa hija (como
   *  los pendientes) → heredan el transform y lo siguen al arrastrar; su /Rect
   *  se sincroniza aparte (ver NodeOverlay). Se ubican por su offset ORIGINAL
   *  respecto del segmento (constante → quedan pegados aunque el box se mueva).
   *  Ya resueltos con color EFECTIVO (recolor aplicado). */
  savedHighlights: SavedHighlight[] | null;
  /** Patch sobre un resaltado guardado pegado (recolorear/toggle): la
   *  FloatingBar lo usa para recolorear o quitar el highlight del segmento. */
  onHighlightPatch: (hlId: string, patch: HighlightPatch) => void;
  highlightColor: string;
  onHighlightColor: (c: string) => void;
}

export function SegmentBox({ seg, pageWidth, pageHeight, scale, selected, editing, edit, onCanvas, isLocked, onDragging, area, onArea, groupMode, controller, onSelect, onStartEdit, onPatch, onDocOp, onRequestLink, highlights, savedHighlights, onHighlightPatch, highlightColor, onHighlightColor }: SegmentBoxProps) {
  const eff = effectiveGeometry(seg, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);

  // La EDICIÓN vive en el TextEditController (singleton imperativo, arriba) —
  // este box solo la solicita (onStartEdit) y se cubre con el layer mientras dura.

  // Multilínea (breaklines) + área tipeable: derivados usados por el render Y
  // por el grip (su map/commit clampea a estos límites).
  const html = seedHtml(seg, edit, scale);
  // MULTILÍNEA (breaklines): la caja debe cubrir TODAS las líneas — si no, el
  // click/mask solo tomaba la primera. Alto = n × leading (1.2×size, el mismo
  // del bake); una sola línea usa el alto natural del segmento.
  const nLines = (edit?.text ?? seg.text).split('\n').length;
  const lineHpx = eff.fontSize * 1.2 * scale;
  const contentH = nLines > 1 ? nLines * lineHpx : rect.height;
  const boxLineH = nLines > 1 ? lineHpx : rect.height;
  // Área tipeable (afordance): el grip la amplía ancho Y ALTO más allá del
  // contenido. En vivo = gripSize; persistido = area {w,h} (pt).
  const areaWpx = Math.max(rect.width, area?.w != null ? area.w * scale : 0);
  const areaHpx = Math.max(contentH, area?.h != null ? area.h * scale : 0);

  const gesture = useDragGesture({
    onDown: () => {
      // Arrastrar directo, sin pre-seleccionar: el pointerdown selecciona
      // Y arma el drag en el mismo gesto.
      if (editing) return false;
      if (!selected) onSelect();
    },
    onStart: () => {
      dbgStyles('drag-start', seg, edit);
      // El gesto arrancó: PdfCanvas blitea el lift pre-horneado (la
      // página sin este texto) — el original se esfuma al "levantarlo".
      onDragging(true);
    },
    onDrop: (_e, { dx, dy }) => {
      const nx = round1(clampX(eff.x + dx / scale, eff.width, pageWidth));
      // Clampear el BBOX entero (no la baseline sola): los glifos suben desde la
      // baseline, así que clampear baseline≤pageH dejaba el texto salir por
      // arriba → pdf.js no lo re-extrae y "se pierde". clampY sobre eff.y (borde
      // inferior) mantiene toda la caja dentro; el delta se traslada a baseline.
      const ny = clampY(eff.y - dy / scale, eff.height, pageHeight);
      const nb = round1(eff.baseline + (ny - eff.y));
      const noop = edit == null && nx === round1(seg.x) && nb === round1(seg.baseline);
      if (noop) {
        // Soltó donde estaba: nada que commitear — cancelar el lift.
        onDragging(false, false);
        return;
      }
      dbgStyles('drop', seg, edit, { drop: { nx, nb } });
      // El commit y el fin del arrastre van en el MISMO lote de estado: el
      // preview re-horneado tendrá píxeles idénticos al lift ya visible.
      onPatch({
        x: nx === round1(seg.x) ? null : nx,
        baseline: nb === round1(seg.baseline) ? null : nb,
      });
      onDragging(false, true);
    },
    onCancel: () => { onDragging(false, false); },
  });
  const drag = gesture.delta;

  const grip = useGripResize<{ w: number; h: number }>({
    map: (dx, dy) => ({
      w: Math.max(rect.width, areaWpx + dx),
      h: Math.max(contentH, areaHpx + dy),
    }),
    onCommit: (dx, dy) => {
      const w = Math.max(rect.width, areaWpx + dx);
      const h = Math.max(contentH, areaHpx + dy);
      const wPt = round1(w / scale);
      const hPt = round1(h / scale);
      // Volver al tamaño natural (o menos) limpia esa dimensión.
      onArea({
        w: wPt <= round1(eff.width) + 1 ? undefined : wPt,
        h: hPt <= round1(contentH / scale) + 1 ? undefined : hPt,
      });
    },
  });
  const gripSize = grip.size;

  // DEBUG temporal: cada vez que un segmento EDITADO se re-renderiza (cambia
  // el edit o llega el seg fantasma del grafo nuevo), volcar sus estilos.
  useEffect(() => {
    if (edit) dbgStyles('render-edited', seg, edit, { editing, drag: drag != null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, seg]);

  // Sin velos ni masks: la extirpación del original arranca CON el gesto
  // (onDragging) — para cuando el usuario suelta, el canvas ya no tiene los
  // glifos viejos. El único transitorio es el original desvaneciéndose una
  // fracción de segundo al arrancar el drag (el bake local aterrizando).

  // Segmento eliminado: el preview local lo extirpa — nada que dibujar
  // (Ctrl+Z lo restaura).
  if (edit?.remove) return null;

  // Un segmento con edición pendiente fue EXTIRPADO del preview: este box
  // fantasma dibuja el estado nuevo (transparente — flota sobre lo que haya).
  // Mientras el TextEditController está abierto sobre él, su fondo blanco lo cubre.
  const masked = editing || edit != null || drag != null;
  const boxHeight = gripSize?.h ?? areaHpx;
  // ¿La edición MUEVE el segmento? El box está en la posición NUEVA — su fondo
  // NO debe ser blanco (taparía el destino con un flash). Solo un edit EN EL
  // LUGAR (texto/estilo, misma posición) usa el fondo opaco para tapar lo viejo
  // hasta el extirpado; el original de un movido lo oculta el lift.
  const moved = !!edit && (edit.x != null || edit.baseline != null);

  return (
    <>
      {selected && !isLocked && !groupMode && (
        <FloatingBar
          seg={seg} edit={edit} pageWidth={pageWidth} frameWpt={areaWpx / scale}
          controller={controller}
          onPatch={onPatch} onDocOp={onDocOp} onRequestLink={onRequestLink}
          savedHighlights={savedHighlights ?? null}
          hasPendingHighlight={!!highlights?.length}
          onHighlightPatch={onHighlightPatch}
          highlightColor={highlightColor} onHighlightColor={onHighlightColor}
        />
      )}
      <div
        className={`seg-box${selected ? ' selected' : ''}${masked ? ' masked' : ''}${edit ? ' edited' : ''}${editing ? ' editing' : ''}${isLocked ? ' locked' : ''}${edit && onCanvas && !moved ? ' on-canvas' : ''}`}
        style={{
          left: rect.left,
          top: rect.top,
          // El ÁREA tipeable: el grip la amplía más allá del contenido (ancho
          // y alto — espacio para escribir sin que "salte"). Alineado = ancho
          // DEFINIDO (el frame del text-align).
          minWidth: gripSize?.w ?? areaWpx,
          ...(edit?.align ? { width: gripSize?.w ?? areaWpx } : {}),
          height: boxHeight,
          lineHeight: `${boxLineH}px`,
          transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
          transformOrigin: 'left bottom',
        }}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        onDoubleClick={e => { e.stopPropagation(); onStartEdit(); }}
        {...gesture.handlers}
        title={editing ? undefined : (edit?.text ?? seg.text)}
      >
        {/* Capa de RESALTADO (detrás del texto): cubre la línea del segmento;
            al ser hija hereda el transform del drag → sigue al texto. */}
        {highlights?.map((h, i) => (
          <div
            key={`hl-${i}`}
            className="seg-hl"
            style={{ width: rect.width + 2, height: rect.height + 2, background: h.color ?? '#ffd400' }}
          />
        ))}
        {/* Resaltados GUARDADOS pegados: ubicados por su offset ORIGINAL respecto
            del segmento (no del box efectivo) → quedan glued al moverse. */}
        {savedHighlights?.map(hl => {
          const segOrig = pdfRectToCss({ x: seg.x, y: seg.y, width: seg.width, height: seg.height }, pageHeight, scale);
          const hlCss = pdfRectToCss({ x: hl.x, y: hl.y, width: hl.width, height: hl.height }, pageHeight, scale);
          return (
            <div
              key={hl.id}
              className="seg-hl"
              style={{ left: hlCss.left - segOrig.left, top: hlCss.top - segOrig.top, width: hlCss.width, height: hlCss.height, background: hl.color || '#ffd400' }}
            />
          );
        })}
        {masked && !editing && (
          // El FANTASMA (estado nuevo dibujado por el box). NUNCA mientras se
          // EDITA: el TextEditController ya dibuja el texto vivo en su backdrop,
          // y este fantasma — posicionado por dx — puede ser MÁS ANCHO que la
          // tapa del controller (una línea unida que desborda la columna): su
          // cola asomaba por la derecha como texto "duplicado" flotante.
          <div
            className="seg-text"
            style={{ position: 'relative', zIndex: 1, ...containerStyle(seg, edit, scale), ...(edit?.align ? { width: '100%', textAlign: edit.align } : {}) }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {!editing && !isLocked && !groupMode && (
          <div
            className="seg-grip"
            title="Ampliar el área de texto (ancho y alto; la letra no cambia)"
            {...grip.handlers}
            onDoubleClick={e => e.stopPropagation()}
          />
        )}
      </div>
    </>
  );
}

/** Adaptador ctx→props del box verbatim. */
function SegmentKindBox({ ctx, node: seg }: { ctx: OverlayCtx; node: SegmentNode }) {
  const edit = ctx.edits.get(seg.id) ?? null;
  return (
    <SegmentBox
      groupMode={ctx.multiSel.size > 1}
      seg={seg}
      pageWidth={ctx.graph.width}
      pageHeight={ctx.graph.height}
      scale={ctx.scale}
      selected={ctx.selectedId === seg.id || ctx.multiSel.has(seg.id)}
      editing={ctx.editingId === seg.id}
      edit={edit}
      onCanvas={ctx.inGraph.has(seg.id)}
      isLocked={ctx.locked.has(seg.id)}
      controller={ctx.controller}
      onDragging={(active, committed) => ctx.onDragging(seg.id, active, committed)}
      area={ctx.areaWidths.get(seg.id) ?? null}
      onArea={a => ctx.onAreaWidth(seg.id, a)}
      onSelect={() => ctx.selectNode(seg.id)}
      onStartEdit={() => ctx.onStartEdit(seg)}
      onPatch={patch => ctx.ledger.patchSegment(seg, patch)}
      onDocOp={ctx.onDocOp}
      onRequestLink={ctx.onRequestLink}
      onAddText={ctx.onAddText}
      highlights={ctx.hlBySeg.get(seg.id) ?? null}
      savedHighlights={(ctx.savedHlBySeg.get(seg.id) ?? []).flatMap((hl): SavedHighlight[] => {
        const e = ctx.highlightEdits.get(hl.id) ?? null;
        if (e?.remove) return []; // borrado: no dibujar la capa hija
        return [{ id: hl.id, x: hl.x, y: hl.y, width: hl.width, height: hl.height, color: e?.color ?? hl.color }];
      })}
      onHighlightPatch={(hlId, patch) => {
        const hl = ctx.graph.highlights.find(h => h.id === hlId);
        if (hl) ctx.ledger.patchRect(hl, patch);
      }}
      highlightColor={ctx.highlightColor}
      onHighlightColor={ctx.onHighlightColor}
    />
  );
}

export const segmentKind: INodeKind<SegmentNode> = {
  kind: 'segment',
  find: (graph, id) => graph.segments.find(s => s.id === id) ?? null,
  effectiveRect(ledger, seg) {
    const e = ledger.effective(seg);
    return { x: e.x, y: e.y, width: e.width, height: e.height };
  },
  // Clamp por nodo: ninguno puede salir de página (lo de afuera se pierde al
  // re-extraer). El bbox ENTERO queda dentro de [0, pageDim]; el delta de y se
  // traslada a baseline (los glifos suben desde ella).
  move(ledger, seg, dxPt, dyPt, pageW, pageH) {
    const e = ledger.effective(seg);
    const nx = round1(clampX(e.x + dxPt, e.width, pageW));
    const ny = clampY(e.y + dyPt, e.height, pageH);
    const nb = round1(e.baseline + (ny - e.y));
    ledger.patchSegment(seg, {
      x: nx === round1(seg.x) ? null : nx,
      baseline: nb === round1(seg.baseline) ? null : nb,
    });
  },
  remove(ledger, seg) {
    ledger.patchSegment(seg, { remove: true });
  },
  Box: SegmentKindBox,
};
