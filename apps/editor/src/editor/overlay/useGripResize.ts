/**
 * useGripResize — el gesto del "grip" (esquina inferior-derecha) que redimensiona
 * un box. Se copiaba idéntico en la imagen y el campo (delta directo) y con una
 * variante en el segmento (el estado en vivo es un tamaño absoluto, no un delta).
 *
 * A diferencia de useDragGesture NO hay umbral: el grip reacciona desde el
 * primer pixel (no puede confundirse con un click porque nace de su propio
 * elemento). El pointerdown hace preventDefault + stopPropagation + capture;
 * move/up hacen stopPropagation. Cada sitio decide qué "estado vivo" mostrar
 * (`map` transforma el {dx,dy} crudo) y qué commitear (`onCommit`).
 *
 * WidgetBox/ImageBox: `map` = el delta tal cual (el box crece `rect + delta`).
 * SegmentBox: `map` = un tamaño absoluto {w,h} clampeado al contenido.
 */
import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

export interface UseGripResizeOptions<S> {
  /** Traduce el delta crudo (px desde el pointerdown) al estado vivo del box. */
  map: (dx: number, dy: number) => S;
  /** Soltó: commitear con el delta final (px). */
  onCommit: (dx: number, dy: number) => void;
}

export interface GripResize<S> {
  /** Estado vivo mientras se arrastra el grip, o null en reposo. */
  size: S | null;
  handlers: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onClick: (e: ReactMouseEvent) => void;
  };
}

export function useGripResize<S>(opts: UseGripResizeOptions<S>): GripResize<S> {
  const start = useRef<{ px: number; py: number } | null>(null);
  const [size, setSize] = useState<S | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!start.current) return;
    e.stopPropagation();
    setSize(opts.map(e.clientX - start.current.px, e.clientY - start.current.py));
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    e.stopPropagation();
    const s = start.current;
    start.current = null;
    setSize(null);
    if (!s) return;
    opts.onCommit(e.clientX - s.px, e.clientY - s.py);
  };

  const onClick = (e: ReactMouseEvent) => e.stopPropagation();

  return { size, handlers: { onPointerDown, onPointerMove, onPointerUp, onClick } };
}
