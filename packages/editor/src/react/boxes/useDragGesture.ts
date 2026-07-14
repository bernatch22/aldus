/**
 * useDragGesture — el gesto de arrastre "pointerdown → move (con umbral) → up"
 * que se copiaba/pegaba en cada box (segmento, imagen, campo, grupo).
 * (v1: `apps/editor/src/editor/overlay/useDragGesture.ts`, COPY verbatim.)
 *
 * Semántica compartida: un `start` ref `{px,py,moved}` + un `delta` state
 * `{dx,dy}` para el translate en vivo; el umbral de ~3px (Manhattan) distingue
 * un CLICK de un DRAG — recién al cruzarlo el gesto "arranca" (onStart) y el
 * pointerup commitea (onDrop). Debajo del umbral, pointerup = click (onClick).
 *
 * Cada call-site difiere en los efectos (onDragging con distintos args,
 * dbgStyles, congelar un snapshot, onClick que deselecciona…) → van por
 * callbacks. El pointerdown por defecto hace preventDefault + stopPropagation +
 * setPointerCapture (lo que TODOS necesitaban); `onDown` corre ANTES para las
 * pre-acciones propias del sitio (p. ej. onSelect, congelar el snapshot).
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface DragDelta {
  dx: number;
  dy: number;
}

export interface UseDragGestureOptions {
  /** Umbral en px (Manhattan |dx|+|dy|) para pasar de click a drag. Def. 3. */
  threshold?: number;
  /** Corre en pointerdown ANTES del preventDefault/capture; devolver false
   *  aborta el gesto (p. ej. `editing`). Acá van onSelect, congelar snapshot… */
  onDown?: (e: ReactPointerEvent) => void | false;
  /** El gesto CRUZÓ el umbral (arrancó el drag). */
  onStart?: (e: ReactPointerEvent) => void;
  /** Movimiento en vivo (además del `delta` que ya expone el hook). */
  onMove?: (e: ReactPointerEvent, delta: DragDelta) => void;
  /** Soltó tras arrastrar (moved === true): commitear. */
  onDrop: (e: ReactPointerEvent, delta: DragDelta) => void;
  /** Soltó sin arrastrar (moved === false): click. */
  onClick?: (e: ReactPointerEvent) => void;
  /** pointercancel tras haber arrancado el drag. */
  onCancel?: (e: ReactPointerEvent) => void;
}

export interface DragGesture {
  /** translate en vivo, o null si no se está arrastrando. */
  delta: DragDelta | null;
  handlers: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onPointerCancel: (e: ReactPointerEvent) => void;
  };
}

export function useDragGesture(opts: UseDragGestureOptions): DragGesture {
  const threshold = opts.threshold ?? 3;
  const start = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const [delta, setDelta] = useState<DragDelta | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (opts.onDown?.(e) === false) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.px;
    const dy = e.clientY - s.py;
    if (!s.moved && Math.abs(dx) + Math.abs(dy) > threshold) {
      s.moved = true;
      opts.onStart?.(e);
    }
    if (s.moved) {
      setDelta({ dx, dy });
      opts.onMove?.(e, { dx, dy });
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const s = start.current;
    start.current = null;
    setDelta(null);
    if (!s) return;
    if (s.moved) opts.onDrop(e, { dx: e.clientX - s.px, dy: e.clientY - s.py });
    else opts.onClick?.(e);
  };

  const onPointerCancel = (e: ReactPointerEvent) => {
    const s = start.current;
    start.current = null;
    setDelta(null);
    if (s?.moved) opts.onCancel?.(e);
  };

  return { delta, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
}
