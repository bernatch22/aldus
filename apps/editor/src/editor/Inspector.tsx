/**
 * Inspector — el panel de propiedades (derecha), estilo Acrobat.
 *  - Sin selección: el esquema de la página (campos, links, imágenes, texto).
 *  - Con selección: propiedades del nodo en secciones (FORMATO / OBJETO / ACCIONES).
 * Toda la lógica de edición (mergeSegmentEdit, selectionStyle, por-tramo…) se
 * conserva; solo cambió la presentación a Tailwind + lucide.
 */

import {
  effectiveImageRect, effectiveWidgetRect,
  mergeImageEdit, mergeSegmentEdit, mergeWidgetEdit, originalStyledRuns,
  type FontBucket, type ImageEdit, type ImageNode, type ImagePatch,
  type PageGraph, type SegmentEdit, type SegmentNode, type SegmentPatch,
  type WidgetEdit, type WidgetNode, type WidgetPatch,
} from '@aldus/core';
import type { ReactNode } from 'react';
import {
  X, Trash2, RotateCcw, Lock, Unlock,
  SendToBack, BringToFront, Type, Image as ImageIcon, TextCursorInput, Link as LinkIcon,
} from 'lucide-react';
import type { EditAction, ImageEditAction, WidgetEditAction } from './NodeOverlay';
import { Button, NumberInput, Select, TextInput, cx } from '../ui/primitives';

interface Props {
  graph: PageGraph | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  edits: Map<string, SegmentEdit>;
  onEdit: (action: EditAction) => void;
  imageEdits: Map<string, ImageEdit>;
  onImageEdit: (action: ImageEditAction) => void;
  widgetEdits: Map<string, WidgetEdit>;
  onWidgetEdit: (action: WidgetEditAction) => void;
  locked: Set<string>;
  onToggleLock: (nodeId: string) => void;
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
}

const WIDGET_TYPE_LABEL: Record<WidgetNode['widgetType'], string> = {
  text: 'Texto', checkbox: 'Checkbox', radio: 'Radio', select: 'Select',
  list: 'Lista', button: 'Botón', signature: 'Firma',
};
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

// ── átomos del panel ─────────────────────────────────────────────────────────
function Panel({ children }: { children: ReactNode }) {
  return <aside className="thin-scroll flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-neutral-200 bg-white">{children}</aside>;
}
function Header({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-neutral-800">{title}</div>
        {subtitle && <div className="truncate text-[11px] text-neutral-400">{subtitle}</div>}
      </div>
      {onClose && <button onClick={onClose} className="grid h-6 w-6 shrink-0 place-items-center rounded text-neutral-400 hover:bg-neutral-100"><X size={15} /></button>}
    </div>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-neutral-100 px-3 py-3">
      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-400">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2">{children}</div>;
}

/** Texto de un segmento con su estilo REAL por tramo (negritas visibles). */
function StyledPreview({ seg, edit }: { seg: SegmentNode; edit: SegmentEdit | null }) {
  const styled = edit?.runs ?? originalStyledRuns(seg);
  if (!edit?.runs && edit) return <span>{edit.text}</span>;
  return <span>{styled.map((r, i) => <span key={i} style={{ fontWeight: r.bold ? 700 : 400, fontStyle: r.italic ? 'italic' : 'normal' }}>{r.text}</span>)}</span>;
}

/** Fila clickeable del esquema, con toggle de candado a la derecha. */
function OutlineItem({ icon, label, meta, active, edited, onClick, right, lockable }:
  {
    icon: ReactNode; label: ReactNode; meta?: string; active?: boolean; edited?: boolean;
    onClick?: () => void; right?: ReactNode;
    lockable?: { locked: boolean; onToggle: () => void };
  }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter') onClick?.(); }}
      className={cx('group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors', active ? 'bg-blue-50' : 'hover:bg-neutral-50')}
    >
      <span className={cx('shrink-0', edited ? 'text-amber-600' : 'text-neutral-400')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate text-[12.5px]', edited ? 'text-amber-700' : 'text-neutral-700')}>{label}</span>
        {meta && <span className="block truncate text-[10.5px] tabular-nums text-neutral-400">{meta}</span>}
      </span>
      {lockable && (
        <button
          title={lockable.locked ? 'Desbloquear' : 'Bloquear'}
          aria-label={lockable.locked ? 'Desbloquear' : 'Bloquear'}
          onClick={e => { e.stopPropagation(); lockable.onToggle(); }}
          className={cx(
            'grid h-6 w-6 shrink-0 place-items-center rounded transition-opacity hover:bg-neutral-200/60',
            lockable.locked ? 'text-blue-600 opacity-100' : 'text-neutral-400 opacity-0 group-hover:opacity-100',
          )}
        >
          {lockable.locked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>
      )}
      {right}
    </div>
  );
}

// ── panel raíz ───────────────────────────────────────────────────────────────
export function Inspector(props: Props) {
  const { graph, selectedId, onSelect, edits, imageEdits, widgetEdits, locked, onToggleLock } = props;
  if (!graph) return <Panel />;
  const seg = graph.segments.find(s => s.id === selectedId) ?? null;
  const img = graph.images.find(i => i.id === selectedId) ?? null;
  const wid = graph.widgets.find(w => w.id === selectedId) ?? null;

  const lockRow = (nodeId: string) => (
    <Section title="Estado">
      <Button variant={locked.has(nodeId) ? 'primary' : 'default'} className="w-full" onClick={() => onToggleLock(nodeId)}>
        {locked.has(nodeId) ? <><Unlock size={14} /> Desbloquear</> : <><Lock size={14} /> Bloquear</>}
      </Button>
    </Section>
  );

  if (wid) return (
    <Panel>
      <Header title={wid.fieldName || 'Campo'} subtitle={WIDGET_TYPE_LABEL[wid.widgetType]} onClose={() => onSelect(null)} />
      <WidgetProps widget={wid} edit={widgetEdits.get(wid.id) ?? null} onWidgetEdit={props.onWidgetEdit} onDocOp={props.onDocOp} />
      {lockRow(wid.id)}
    </Panel>
  );
  if (img) return (
    <Panel>
      <Header title="Imagen" subtitle={`${Math.round(img.width)}×${Math.round(img.height)} pt`} onClose={() => onSelect(null)} />
      <ImageProps img={img} edit={imageEdits.get(img.id) ?? null} onImageEdit={props.onImageEdit} />
      {lockRow(img.id)}
    </Panel>
  );
  if (seg) return (
    <Panel>
      <Header title="Texto" subtitle={`${n1(seg.fontSize)} pt`} onClose={() => onSelect(null)} />
      <TextProps seg={seg} edit={edits.get(seg.id) ?? null} onEdit={props.onEdit} />
      {lockRow(seg.id)}
    </Panel>
  );

  // ── esquema de la página (sin selección) ──
  return (
    <Panel>
      <Header title={`Página ${graph.page}`} subtitle={`${graph.width.toFixed(0)}×${graph.height.toFixed(0)} pt`} />
      {graph.widgets.length > 0 && (
        <Section title={`Campos (${graph.widgets.length})`}>
          {graph.widgets.map(w => (
            <OutlineItem key={w.id} icon={<TextCursorInput size={14} />} onClick={() => onSelect(w.id)}
              edited={widgetEdits.has(w.id)}
              lockable={{ locked: locked.has(w.id), onToggle: () => onToggleLock(w.id) }}
              label={w.fieldName || '(sin nombre)'} meta={`${WIDGET_TYPE_LABEL[w.widgetType]} · x ${n1(w.x)} · y ${n1(w.y)}`} />
          ))}
        </Section>
      )}
      {graph.links.length > 0 && (
        <Section title={`Links (${graph.links.length})`}>
          {graph.links.map(l => (
            <OutlineItem key={l.id} icon={<LinkIcon size={14} />} label={l.url} meta={`x ${n1(l.x)} · y ${n1(l.y)}`}
              right={<button title="Borrar link" onClick={e => { e.stopPropagation(); props.onDocOp('removeLink', { page: l.page, x: l.x, y: l.y, width: l.width, height: l.height }); }}
                className="grid h-6 w-6 shrink-0 place-items-center rounded text-neutral-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={13} /></button>} />
          ))}
        </Section>
      )}
      {graph.images.length > 0 && (
        <Section title={`Imágenes (${graph.images.length})`}>
          {graph.images.map(im => (
            <OutlineItem key={im.id} icon={<ImageIcon size={14} />} onClick={() => onSelect(im.id)}
              edited={imageEdits.has(im.id)}
              lockable={{ locked: locked.has(im.id), onToggle: () => onToggleLock(im.id) }}
              label={`${Math.round(im.width)}×${Math.round(im.height)} pt${imageEdits.get(im.id)?.remove ? ' · eliminada' : ''}`}
              meta={`x ${n1(im.x)} · y ${n1(im.y)}${im.rotated ? ' · rotada' : ''}`} />
          ))}
        </Section>
      )}
      <Section title={`Texto (${graph.segments.length})`}>
        {graph.lines.map(l => l.segments.map(s => (
          <OutlineItem key={s.id} icon={<Type size={14} />} onClick={() => onSelect(s.id)} edited={edits.has(s.id)}
            lockable={{ locked: locked.has(s.id), onToggle: () => onToggleLock(s.id) }}
            label={<StyledPreview seg={s} edit={edits.get(s.id) ?? null} />} meta={`x ${n1(s.x)} · y ${n1(s.baseline)} · ${n1(s.fontSize)} pt`} />
        )))}
      </Section>
    </Panel>
  );
}

// ── propiedades de TEXTO (sección FORMATO estilo Acrobat) ────────────────────
function TextProps({ seg, edit, onEdit }:
  { seg: SegmentNode; edit: SegmentEdit | null; onEdit: (a: EditAction) => void }) {
  const commit = (patch: SegmentPatch) => { const m = mergeSegmentEdit(seg, edit, patch); onEdit(m ?? { segmentId: seg.id, revert: true }); };
  const dom = seg.runs.reduce((a, b) => (b.width > a.width ? b : a));
  const curFont: FontBucket | 'original' = edit?.font ?? 'original';
  const numOv = (key: 'x' | 'baseline', original: number) => (v: number) => {
    const r = Math.round(v * 10) / 10;
    commit({ [key]: r === Math.round(original * 10) / 10 ? null : r });
  };
  const isRemoved = edit?.remove === true;

  // El FORMATO (B/I, tamaño, color, resaltar, link, eliminar) vive en la
  // toolbar flotante sobre el objeto — acá quedan contenido, familia,
  // avanzado y posición.
  return (
    <>
      <Section title="Contenido">
        <TextInput defaultValue={edit?.text ?? seg.text} onCommit={v => commit({ text: v })} />
      </Section>

      <Section title="Avanzado">
        <Select value={curFont} onChange={v => commit({ font: v === 'original' ? null : (v as FontBucket) })}>
          <option value="original">{dom.font.postScriptName} (original)</option>
          <option value="sans">Sans</option>
          <option value="serif">Serif</option>
          <option value="mono">Mono</option>
        </Select>
        <Row>
          <NumberInput label="AV" step={0.1} defaultValue={edit?.charSpacing ?? 0} onCommit={v => commit({ charSpacing: v === 0 ? null : v })} />
          <NumberInput label="↔ %" step={1} min={10} defaultValue={edit?.hScale ?? 100} onCommit={v => commit({ hScale: v <= 0 || v === 100 ? null : v })} />
        </Row>
      </Section>

      <Section title="Posición (pt)">
        <Row>
          <NumberInput label="X" defaultValue={edit?.x ?? seg.x} onCommit={numOv('x', seg.x)} />
          <NumberInput label="Y" defaultValue={edit?.baseline ?? seg.baseline} onCommit={numOv('baseline', seg.baseline)} />
        </Row>
      </Section>

      <Section title="Acciones">
        {isRemoved && (
          <Button variant="danger" className="w-full" onClick={() => commit({ remove: null })}>
            <RotateCcw size={14} /> Restaurar
          </Button>
        )}
        {edit && <Button variant="ghost" className="w-full" onClick={() => onEdit({ segmentId: seg.id, revert: true })}><RotateCcw size={14} /> Revertir cambios</Button>}
        {!edit && <div className="text-[11px] text-neutral-400">Formato y acciones: en la barra sobre el objeto.</div>}
      </Section>
    </>
  );
}

// ── propiedades de IMAGEN ────────────────────────────────────────────────────
function ImageProps({ img, edit, onImageEdit }: { img: ImageNode; edit: ImageEdit | null; onImageEdit: (a: ImageEditAction) => void }) {
  const commit = (patch: ImagePatch) => { const m = mergeImageEdit(img, edit, patch); onImageEdit(m ?? { imageId: img.id, revert: true }); };
  const eff = effectiveImageRect(img, edit);
  const num = (key: 'x' | 'y' | 'width' | 'height', original: number) => (v: number) => {
    const r = Math.round(v * 10) / 10;
    commit({ [key]: r === Math.round(original * 10) / 10 ? null : r });
  };
  return (
    <>
      {img.rotated && <div className="border-b border-neutral-100 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">Imagen con rotación: mover/escalar no soportado aún.</div>}
      <Section title="Geometría (pt)">
        <Row><NumberInput label="X" defaultValue={eff.x} onCommit={num('x', img.x)} /><NumberInput label="Y" defaultValue={eff.y} onCommit={num('y', img.y)} /></Row>
        <Row><NumberInput label="W" defaultValue={eff.width} onCommit={num('width', img.width)} /><NumberInput label="H" defaultValue={eff.height} onCommit={num('height', img.height)} /></Row>
      </Section>
      <Section title="Orden">
        <Row>
          <Button className="flex-1" onClick={() => commit({ zOrder: 'back' })}><SendToBack size={14} /> Al fondo</Button>
          <Button className="flex-1" onClick={() => commit({ zOrder: 'front' })}><BringToFront size={14} /> Al frente</Button>
        </Row>
      </Section>
      <Section title="Acciones">
        <Button variant="danger" className="w-full" onClick={() => commit({ remove: eff.removed ? null : true })}>
          {eff.removed ? <><RotateCcw size={14} /> Restaurar imagen</> : <><Trash2 size={14} /> Eliminar imagen</>}
        </Button>
        {edit && <Button variant="ghost" className="w-full" onClick={() => onImageEdit({ imageId: img.id, revert: true })}><RotateCcw size={14} /> Revertir</Button>}
      </Section>
    </>
  );
}

// ── propiedades de CAMPO ─────────────────────────────────────────────────────
function WidgetProps({ widget, edit, onWidgetEdit, onDocOp }: { widget: WidgetNode; edit: WidgetEdit | null; onWidgetEdit: (a: WidgetEditAction) => void; onDocOp: (a: string, p: Record<string, unknown>) => void }) {
  const commit = (patch: WidgetPatch) => { const m = mergeWidgetEdit(widget, edit, patch); onWidgetEdit(m ?? { widgetId: widget.id, revert: true }); };
  const eff = effectiveWidgetRect(widget, edit);
  const num = (key: 'x' | 'y' | 'width' | 'height', original: number) => (v: number) => {
    const r = Math.round(v * 10) / 10;
    commit({ [key]: r === Math.round(original * 10) / 10 ? null : r });
  };
  return (
    <>
      <Section title="Campo">
        <div className="flex justify-between text-[12px]"><span className="text-neutral-400">Tipo</span><span className="text-neutral-700">{WIDGET_TYPE_LABEL[widget.widgetType]}</span></div>
        <div className="flex justify-between text-[12px]"><span className="text-neutral-400">Nombre</span><span className="truncate pl-2 text-neutral-700">{widget.fieldName || '(sin nombre)'}</span></div>
        {widget.readOnly && <div className="flex justify-between text-[12px]"><span className="text-neutral-400">Flags</span><span className="text-neutral-700">read-only</span></div>}
      </Section>
      <Section title="Geometría (pt)">
        <Row><NumberInput label="X" defaultValue={eff.x} onCommit={num('x', widget.x)} /><NumberInput label="Y" defaultValue={eff.y} onCommit={num('y', widget.y)} /></Row>
        <Row><NumberInput label="W" defaultValue={eff.width} onCommit={num('width', widget.width)} /><NumberInput label="H" defaultValue={eff.height} onCommit={num('height', widget.height)} /></Row>
      </Section>
      {(widget.widgetType === 'select' || widget.widgetType === 'list') && (
        <Section title="Opciones (una por línea)">
          <textarea
            defaultValue={(widget.options ?? []).join('\n')}
            rows={4}
            className="w-full resize-y rounded-md border border-neutral-200 px-2 py-1.5 text-[13px] outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-100"
            onBlur={e => {
              const options = e.target.value.split('\n').map(o => o.trim()).filter(Boolean);
              if (options.length && options.join('\n') !== (widget.options ?? []).join('\n')) {
                onDocOp('setFieldOptions', { fieldName: widget.fieldName, options });
              }
            }}
          />
          <div className="text-[11px] text-neutral-400">Se guardan al salir del campo.</div>
        </Section>
      )}
      {widget.widgetType === 'radio' && (
        <Section title="Grupo de radios">
          <div className="text-[11px] text-neutral-400">Las opciones del mismo grupo comparten el nombre "{widget.fieldName}" — se selecciona una sola a la vez.</div>
          <Button className="w-full" onClick={() => onDocOp('addRadioOption', { fieldName: widget.fieldName, page: widget.page, x: widget.x, y: widget.y - widget.height - 8 })}>
            Agregar opción al grupo
          </Button>
        </Section>
      )}
      <Section title="Acciones">
        <Button variant="danger" className="w-full" onClick={() => commit({ remove: edit?.remove ? null : true })}>
          {edit?.remove
            ? <><RotateCcw size={14} /> Restaurar campo</>
            : <><Trash2 size={14} /> {widget.widgetType === 'radio' ? 'Eliminar grupo completo' : 'Eliminar campo'}</>}
        </Button>
      </Section>
    </>
  );
}
