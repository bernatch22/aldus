/**
 * Primitivas compartidas de las toolbars flotantes (FloatingBar / ObjectBar):
 * el botón chico, el separador y el contenedor posicionado sobre el rect.
 */
import type { ReactNode } from 'react';

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

/** Contenedor de toolbar flotante posicionado sobre el rect. */
export function FloatingWrap({ rect, children }: { rect: { left: number; top: number }; children: ReactNode }) {
  return (
    <div className="float-bar" style={{ left: rect.left, top: Math.max(2, rect.top - 36) }} onClick={e => e.stopPropagation()}>
      {children}
    </div>
  );
}
