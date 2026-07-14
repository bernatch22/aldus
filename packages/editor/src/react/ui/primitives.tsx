/**
 * primitives.tsx — el sistema de UI de Aldus (estilo Acrobat, Tailwind + lucide).
 * Componentes chicos, sin estado propio salvo el necesario. Cero emojis.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

/** Encabezado de sección: MAYÚSCULAS, tracking, gris (FORMAT / OBJECTS…). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-4 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-400">{children}</div>;
}

/** Botón de la barra de herramientas vertical (icono + tooltip). */
export function ToolButton({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cx(
        'grid h-9 w-9 place-items-center rounded-lg transition-colors',
        active ? 'bg-blue-50 text-blue-600 ring-1 ring-blue-200' : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800',
      )}
    >
      <Icon size={17} strokeWidth={1.9} />
    </button>
  );
}

/** Botón chico de barra superior (icono, cuadrado). */
export function IconButton({ icon: Icon, label, onClick, disabled, active }: { icon: LucideIcon; label: string; onClick?: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'grid h-8 w-8 place-items-center rounded-md transition-colors disabled:opacity-30 disabled:cursor-default',
        active ? 'bg-blue-50 text-blue-600' : 'text-neutral-600 hover:bg-neutral-100',
      )}
    >
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}

/** Botón de texto (secundario / primario / peligro). */
export function Button({ children, onClick, variant = 'default', disabled, className, ...rest }:
  { children: ReactNode; onClick?: () => void; variant?: 'default' | 'primary' | 'danger' | 'ghost'; disabled?: boolean; className?: string } & Record<string, unknown>) {
  const styles = {
    default: 'border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50',
    primary: 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300',
    danger: 'border border-red-200 bg-white text-red-600 hover:bg-red-50',
    ghost: 'text-neutral-600 hover:bg-neutral-100',
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx('inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-default', styles, className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Toggle chico (B / I) que preserva la selección del contentEditable. */
export function Toggle({ children, active, onToggle, label }: { children: ReactNode; active?: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={e => e.preventDefault()}
      onClick={onToggle}
      className={cx(
        'grid h-8 w-8 place-items-center rounded-md border text-[13px] transition-colors',
        active ? 'border-blue-600 bg-blue-600 text-white' : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50',
      )}
    >
      {children}
    </button>
  );
}

/** Input de texto con label opcional a la izquierda. */
export function TextInput({ value, defaultValue, onCommit, placeholder, className, prefix }:
  { value?: string; defaultValue?: string; onCommit: (v: string) => void; placeholder?: string; className?: string; prefix?: ReactNode }) {
  return (
    <label className={cx('flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-100', className)}>
      {prefix && <span className="text-[11px] text-neutral-400">{prefix}</span>}
      <input
        className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-800 outline-none placeholder:text-neutral-300"
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        onChange={value !== undefined ? e => onCommit(e.target.value) : undefined}
        onBlur={value === undefined ? e => onCommit(e.target.value) : undefined}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
}

/** Input numérico compacto con label. */
export function NumberInput({ label, defaultValue, onCommit, step = 0.5, min }:
  { label?: ReactNode; defaultValue: number; onCommit: (v: number) => void; step?: number; min?: number }) {
  return (
    <label className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-100">
      {label && <span className="shrink-0 text-[10.5px] font-medium text-neutral-400">{label}</span>}
      <input
        type="number"
        step={step}
        min={min}
        defaultValue={defaultValue}
        onBlur={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onCommit(v); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="min-w-0 flex-1 bg-transparent text-right text-[13px] text-neutral-800 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
    </label>
  );
}

/** Select estilizado. */
export function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-[13px] text-neutral-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-100"
    >
      {children}
    </select>
  );
}

/** Muestra de color (abre el color picker nativo). */
export function ColorSwatch({ value, onChange, title }: { value: string; onChange: (v: string) => void; title: string }) {
  return (
    <label title={title} className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md border border-neutral-200 bg-white hover:bg-neutral-50">
      <span className="h-4 w-4 rounded-sm ring-1 ring-black/10" style={{ background: value }} />
      <input type="color" value={value} onChange={e => onChange(e.target.value)} className="sr-only" />
    </label>
  );
}

/** Modal centrado con overlay. Esc / click fuera cierran. */
export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-black/5"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-800">{title}</h2>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100"><X size={16} /></button>
        </div>
        <div className="space-y-3 px-4 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-neutral-100 bg-neutral-50 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Etiqueta de campo dentro de un modal/panel. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[12px] font-medium text-neutral-600">{children}</div>;
}

/** Toast efímero abajo-centro. */
export function Toast({ message, tone = 'info' }: { message: string; tone?: 'info' | 'error' }) {
  if (!message) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-40 -translate-x-1/2">
      <div className={cx(
        'rounded-lg px-4 py-2 text-[13px] font-medium shadow-lg ring-1',
        tone === 'error' ? 'bg-red-600 text-white ring-red-700' : 'bg-neutral-900 text-white ring-black/10',
      )}>
        {message}
      </div>
    </div>
  );
}
