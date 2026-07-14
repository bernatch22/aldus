/**
 * HostBoxLayer — cajas del HOST sobre la página (puntos PDF, origen abajo-izq).
 * (v1 COPY.) Genérico a propósito: un host e-sign las usa para cajas de firma
 * y campos asignados a firmantes (color + etiqueta por firmante), pero el lib
 * no sabe nada de esa semántica — recibe rects y reporta drags/resizes/selección.
 * No participa del bake: viven en la base de datos del host.
 */
import { useRef, useState, type ReactNode } from 'react';

export interface HostBox {
  id: string;
  page: number;
  /** Rect en PUNTOS PDF, origen abajo-izquierda (el sistema de Aldus). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Chip sobre la caja (ej: "Luis · Firma"). */
  label?: ReactNode;
  /** Color de acento (borde/chip). Default: azul del tema. */
  color?: string;
  /** Texto tenue centrado dentro de la caja (ej: "Firma del Comisionista"). */
  hint?: string;
  /** false = solo tinte visual (no se puede clickear/arrastrar). */
  interactive?: boolean;
}

interface Props {
  boxes: HostBox[];
  scale: number;
  /** Alto de la página en puntos PDF (para invertir el eje Y). */
  pageHeight: number;
  selectedId: string | null;
  onSelect?: (id: string | null) => void;
  onChange?: (box: { id: string; page: number; x: number; y: number; width: number; height: number }) => void;
  /** Click derecho sobre una caja → el host abre su menú contextual (borrar,
   *  reasignar…) en el punto del cursor. */
  onContextMenu?: (id: string, at: { x: number; y: number }) => void;
}

const MIN_PT = 14;

export function HostBoxLayer({ boxes, scale, pageHeight, selectedId, onSelect, onChange, onContextMenu }: Props) {
  // Delta del gesto en curso (px CSS) — se aplica como transform y se comitea
  // en puntos PDF al soltar.
  const [gesture, setGesture] = useState<{ id: string; dx: number; dy: number; dw: number; dh: number } | null>(null);
  const start = useRef<{ id: string; x0: number; y0: number; resize: boolean; moved: boolean } | null>(null);

  const begin = (e: React.PointerEvent, box: HostBox, resize: boolean) => {
    if (box.interactive === false) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { id: box.id, x0: e.clientX, y0: e.clientY, resize, moved: false };
    setGesture({ id: box.id, dx: 0, dy: 0, dw: 0, dh: 0 });
  };

  const move = (e: React.PointerEvent, box: HostBox) => {
    const s = start.current;
    if (!s || s.id !== box.id) return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (Math.abs(dx) + Math.abs(dy) > 2) s.moved = true;
    setGesture(s.resize
      ? { id: s.id, dx: 0, dy: 0, dw: dx, dh: dy }
      : { id: s.id, dx, dy, dw: 0, dh: 0 });
  };

  const end = (e: React.PointerEvent, box: HostBox) => {
    const s = start.current;
    if (!s || s.id !== box.id) return;
    start.current = null;
    const g = gesture;
    setGesture(null);
    if (!s.moved) {
      onSelect?.(box.id);
      return;
    }
    if (!g || !onChange) return;
    if (s.resize) {
      const w = Math.max(MIN_PT, box.width + g.dw / scale);
      const h = Math.max(MIN_PT, box.height + g.dh / scale);
      // El grip es abajo-derecha: crecer hacia abajo baja el y (origen abajo-izq).
      onChange({ id: box.id, page: box.page, x: box.x, y: box.y - (h - box.height), width: w, height: h });
    } else {
      onChange({ id: box.id, page: box.page, x: box.x + g.dx / scale, y: box.y - g.dy / scale, width: box.width, height: box.height });
    }
  };

  return (
    <div className="absolute inset-0" style={{ pointerEvents: 'none', zIndex: 30 }}>
      {boxes.map(box => {
        const g = gesture?.id === box.id ? gesture : null;
        const color = box.color || 'var(--accent, #2563eb)';
        const sel = selectedId === box.id;
        const w = (box.width + (g?.dw ?? 0) / scale) * scale;
        const h = (box.height + (g?.dh ?? 0) / scale) * scale;
        return (
          <div
            key={box.id}
            onPointerDown={e => begin(e, box, false)}
            onPointerMove={e => move(e, box)}
            onPointerUp={e => end(e, box)}
            onContextMenu={onContextMenu && box.interactive !== false
              ? e => { e.preventDefault(); e.stopPropagation(); onSelect?.(box.id); onContextMenu(box.id, { x: e.clientX, y: e.clientY }); }
              : undefined}
            style={{
              position: 'absolute',
              left: box.x * scale + (g?.dx ?? 0),
              top: (pageHeight - box.y - box.height) * scale + (g?.dy ?? 0),
              width: w,
              height: h,
              border: `1.5px dashed ${color}`,
              borderRadius: 4,
              background: `color-mix(in srgb, ${color} ${sel ? 14 : 8}%, transparent)`,
              boxShadow: sel ? `0 0 0 1.5px ${color}` : undefined,
              pointerEvents: box.interactive === false ? 'none' : 'auto',
              cursor: box.interactive === false ? undefined : 'move',
              touchAction: 'none',
            }}
          >
            {box.label != null && (
              <span style={{
                position: 'absolute', top: -17, left: -1.5,
                background: color, color: '#fff',
                font: '600 9.5px/1 ui-sans-serif, system-ui, sans-serif',
                letterSpacing: '.02em', padding: '3px 6px 3px',
                borderRadius: '4px 4px 4px 0', whiteSpace: 'nowrap', pointerEvents: 'none',
              }}>
                {box.label}
              </span>
            )}
            {box.hint && (
              <span style={{
                position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                font: '500 11px/1.2 ui-sans-serif, system-ui, sans-serif',
                color, opacity: .75, pointerEvents: 'none', padding: 4, textAlign: 'center',
              }}>
                {box.hint}
              </span>
            )}
            {box.interactive !== false && sel && (
              <span
                onPointerDown={e => begin(e, box, true)}
                onPointerMove={e => move(e, box)}
                onPointerUp={e => end(e, box)}
                style={{
                  position: 'absolute', right: -5, bottom: -5, width: 10, height: 10,
                  background: '#fff', border: `1.5px solid ${color}`, borderRadius: 2,
                  cursor: 'nwse-resize', touchAction: 'none',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
