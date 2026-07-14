/**
 * Primitivas compartidas de las toolbars del objeto seleccionado (FloatingBar /
 * ObjectBar): el botón chico, el separador y el contenedor. La barra ya NO
 * flota sobre el nodo: se ACOPLA (portal) al grupo del header, a la derecha de
 * Rehacer. Sin nodo dockeable seleccionado, el header muestra el placeholder
 * deshabilitado (ver AldusEditor). El id del dock es la única fuente de verdad
 * (contrato implícito preservado de v1 — audit §4 riesgo 6).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Id del contenedor en el header donde se acoplan FloatingBar / ObjectBar. */
export const FB_DOCK_ID = 'aldus-fb-dock';

/** Botón chico de una toolbar flotante. */
export function FbBtn({ label, onClick, active, danger, children }: { label: string; onClick: () => void; active?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button
      title={label} aria-label={label}
      onMouseDown={e => e.preventDefault()}
      onClick={e => { e.stopPropagation(); onClick(); }}
      className={`fb-btn${active ? ' active' : ''}${danger ? ' danger' : ''}`}
    >{children}</button>
  );
}

export const FbSep = () => <span className="fb-sep" />;

/** Acopla la toolbar del objeto seleccionado al grupo del header (portal al
 *  dock). El dock vive SIEMPRE montado en el header, así que el target existe
 *  antes de que un nodo se seleccione; el efecto lo re-resuelve por las dudas. */
export function FloatingWrap({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<HTMLElement | null>(() => document.getElementById(FB_DOCK_ID));
  useEffect(() => { if (!dock) setDock(document.getElementById(FB_DOCK_ID)); }, [dock]);
  if (!dock) return null;
  return createPortal(
    <div className="float-bar float-bar--docked" onClick={e => e.stopPropagation()}>{children}</div>,
    dock,
  );
}
