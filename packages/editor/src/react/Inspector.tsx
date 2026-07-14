/**
 * Inspector — el panel de propiedades (derecha), estilo Acrobat.
 *  - Sin selección: el esquema de la página (campos, links, imágenes, texto).
 *  - Con selección: propiedades del nodo en secciones (FORMATO / OBJETO / ACCIONES).
 *
 * v2: el nodo seleccionado se RESUELVE por el registry `INodeKind` (findNode —
 * muere la 6.ª cascada if-por-tipo de v1) y el sub-panel de propiedades se
 * elige por `kind.kind` en un mapa local (los paneles viven acá: son
 * presentación del Inspector, no de los boxes). Las mutaciones van al ledger
 * (patchSegment/patchRect hacen merge ?? revert adentro).
 */

import {
  effectiveRect, originalStyledRuns,
  type FontBucket, type HighlightNode, type HighlightPatch,
  type ImageNode, type ImagePatch,
  type LinkNode, type LinkPatch,
  type PageGraph, type SegmentEdit, type SegmentNode, type SegmentPatch,
  type WidgetNode, type WidgetPatch,
} from '@aldus/core';
import { Fragment, type ReactNode } from 'react';
import {
  X, Trash2, RotateCcw, Lock, Unlock, Highlighter,
  SendToBack, BringToFront, Type, Image as ImageIcon, TextCursorInput, Link as LinkIcon, Square,
} from 'lucide-react';
import type { EditLedgerAdapter } from '../core/index.js';
import { findNode } from './boxes/registry.js';
import { Button, NumberInput, Select, TextInput, cx } from './ui/primitives.js';

interface Props {
  graph: PageGraph | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  ledger: EditLedgerAdapter;
  /** Snapshot vigente de las colecciones (badges "editado" del esquema). */
  edits: ReadonlyMap<string, SegmentEdit>;
  imageEdits: ReadonlyMap<string, unknown>;
  widgetEdits: ReadonlyMap<string, unknown>;
  highlightEdits: ReadonlyMap<string, { remove?: boolean; color?: string }>;
  linkEdits: ReadonlyMap<string, { remove?: boolean }>;
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
function Panel({ children }: { children?: ReactNode }) {
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
  const { graph, selectedId, onSelect, ledger, edits, imageEdits, widgetEdits, highlightEdits, linkEdits, locked, onToggleLock } = props;
  if (!graph) return <Panel />;
  // El registry resuelve QUÉ es el id seleccionado (v1: 5 finds a mano).
  const hit = selectedId ? findNode(graph, selectedId) : null;

  const lockRow = (nodeId: string) => (
    <Section title="Estado">
      <Button variant={locked.has(nodeId) ? 'primary' : 'default'} className="w-full" onClick={() => onToggleLock(nodeId)}>
        {locked.has(nodeId) ? <><Unlock size={14} /> Desbloquear</> : <><Lock size={14} /> Bloquear</>}
      </Button>
    </Section>
  );

  // ── esquema de la página (siempre visible: solo, o debajo de las props) ──
  // El nodo SELECCIONADO va primero (y resaltado); después los BLOQUEADOS;
  // el sort es estable → el resto conserva su orden natural.
  const lockFirst = <T,>(items: T[], idOf: (t: T) => string): T[] =>
    [...items].sort((a, b) => {
      const rank = (t: T) => (idOf(t) === selectedId ? 0 : locked.has(idOf(t)) ? 1 : 2);
      return rank(a) - rank(b);
    });
  const segsInOrder = graph.lines.flatMap(l => l.segments);

  // Secciones ordenadas por CANTIDAD ascendente: las de pocos componentes
  // (imágenes, links) arriba; texto/campos (que se hacen "infinitos") al final.
  const sections: Array<{ key: string; count: number; node: ReactNode }> = [];
  if (graph.links.length > 0) sections.push({
    key: 'links', count: graph.links.length,
    node: (
      <Section title={`Links (${graph.links.length})`}>
        {lockFirst(graph.links, l => l.id).map(l => (
          <OutlineItem key={l.id} icon={<LinkIcon size={14} />} onClick={() => onSelect(l.id)}
            active={selectedId === l.id}
            edited={linkEdits.has(l.id)}
            lockable={{ locked: locked.has(l.id), onToggle: () => onToggleLock(l.id) }}
            label={`${l.url}${linkEdits.get(l.id)?.remove ? ' · eliminado' : ''}`}
            meta={`x ${n1(l.x)} · y ${n1(l.y)}`}
            // Borrado PENDIENTE (mismo pipeline que el canvas; Ctrl+Z lo restaura).
            right={<button title="Borrar link (se escribe con Aplicar)" onClick={e => {
              e.stopPropagation();
              ledger.patchRect(l, { remove: true });
            }}
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-neutral-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={13} /></button>} />
        ))}
      </Section>
    ),
  });
  if (graph.highlights.length > 0) sections.push({
    key: 'highlights', count: graph.highlights.length,
    node: (
      <Section title={`Resaltados (${graph.highlights.length})`}>
        {lockFirst(graph.highlights, h => h.id).map(h => (
          <OutlineItem key={h.id} onClick={() => onSelect(h.id)}
            active={selectedId === h.id}
            edited={highlightEdits.has(h.id)}
            lockable={{ locked: locked.has(h.id), onToggle: () => onToggleLock(h.id) }}
            icon={<span className="grid place-items-center"><span className="h-3.5 w-3.5 rounded-[3px]" style={{ background: h.color }} /></span>}
            label={`${Math.round(h.width)}×${Math.round(h.height)} pt${highlightEdits.get(h.id)?.remove ? ' · eliminado' : ''}`}
            meta={`x ${n1(h.x)} · y ${n1(h.y)}`} />
        ))}
      </Section>
    ),
  });
  if (graph.images.length > 0) sections.push({
    key: 'images', count: graph.images.length,
    node: (
      <Section title={`Imágenes (${graph.images.length})`}>
        {lockFirst(graph.images, im => im.id).map(im => (
          <OutlineItem key={im.id} icon={<ImageIcon size={14} />} onClick={() => onSelect(im.id)}
            active={selectedId === im.id}
            edited={imageEdits.has(im.id)}
            lockable={{ locked: locked.has(im.id), onToggle: () => onToggleLock(im.id) }}
            label={`${Math.round(im.width)}×${Math.round(im.height)} pt${(imageEdits.get(im.id) as { remove?: boolean } | undefined)?.remove ? ' · eliminada' : ''}`}
            meta={`x ${n1(im.x)} · y ${n1(im.y)}${im.rotated ? ' · rotada' : ''}`} />
        ))}
      </Section>
    ),
  });
  // Formas vectoriales (fondos/banners) — informativas: se listan pero no se
  // editan desde el esquema.
  if ((graph.shapes ?? []).length > 0) sections.push({
    key: 'shapes', count: graph.shapes.length,
    node: (
      <Section title={`Formas (${graph.shapes.length})`}>
        {graph.shapes.map(sh => (
          <OutlineItem key={sh.id} icon={<Square size={14} />} onClick={() => { /* no seleccionable aún */ }}
            active={false}
            label={<span className="flex items-center gap-1.5">{sh.color && <span className="inline-block h-3 w-3 rounded-sm border border-neutral-300" style={{ backgroundColor: sh.color }} />}{`${Math.round(sh.width)}×${Math.round(sh.height)} pt`}</span>}
            meta={`x ${n1(sh.x)} · y ${n1(sh.y)} · no editable`} />
        ))}
      </Section>
    ),
  });
  if (graph.widgets.length > 0) sections.push({
    key: 'widgets', count: graph.widgets.length,
    node: (
      <Section title={`Campos (${graph.widgets.length})`}>
        {lockFirst(graph.widgets, w => w.id).map(w => (
          <OutlineItem key={w.id} icon={<TextCursorInput size={14} />} onClick={() => onSelect(w.id)}
            active={selectedId === w.id}
            edited={widgetEdits.has(w.id)}
            lockable={{ locked: locked.has(w.id), onToggle: () => onToggleLock(w.id) }}
            label={w.fieldName || '(sin nombre)'} meta={`${WIDGET_TYPE_LABEL[w.widgetType]} · x ${n1(w.x)} · y ${n1(w.y)}`} />
        ))}
      </Section>
    ),
  });
  if (graph.segments.length > 0) sections.push({
    key: 'text', count: graph.segments.length,
    node: (
      <Section title={`Texto (${graph.segments.length})`}>
        {lockFirst(segsInOrder, s => s.id).map(s => (
          <OutlineItem key={s.id} icon={<Type size={14} />} onClick={() => onSelect(s.id)} edited={edits.has(s.id)}
            active={selectedId === s.id}
            lockable={{ locked: locked.has(s.id), onToggle: () => onToggleLock(s.id) }}
            label={<StyledPreview seg={s} edit={edits.get(s.id) ?? null} />} meta={`x ${n1(s.x)} · y ${n1(s.baseline)} · ${n1(s.fontSize)} pt`} />
        ))}
      </Section>
    ),
  });
  sections.sort((a, b) => a.count - b.count);
  const outline = <>{sections.map(s => <Fragment key={s.key}>{s.node}</Fragment>)}</>;

  if (hit) {
    const kind = hit.kind.kind;
    if (kind === 'widget') {
      const wid = hit.node as WidgetNode;
      return (
        <Panel>
          <Header title={wid.fieldName || 'Campo'} subtitle={WIDGET_TYPE_LABEL[wid.widgetType]} onClose={() => onSelect(null)} />
          <WidgetProps widget={wid} ledger={ledger} onDocOp={props.onDocOp} />
          {lockRow(wid.id)}
          {outline}
        </Panel>
      );
    }
    if (kind === 'image') {
      const img = hit.node as ImageNode;
      return (
        <Panel>
          <Header title="Imagen" subtitle={`${Math.round(img.width)}×${Math.round(img.height)} pt`} onClose={() => onSelect(null)} />
          <ImageProps img={img} ledger={ledger} />
          {lockRow(img.id)}
          {outline}
        </Panel>
      );
    }
    if (kind === 'segment') {
      const seg = hit.node as SegmentNode;
      return (
        <Panel>
          <Header title="Texto" subtitle={`${n1(seg.fontSize)} pt`} onClose={() => onSelect(null)} />
          <TextProps seg={seg} edit={edits.get(seg.id) ?? null} ledger={ledger} />
          {lockRow(seg.id)}
          {outline}
        </Panel>
      );
    }
    if (kind === 'highlight') {
      const hl = hit.node as HighlightNode;
      return (
        <Panel>
          <Header title="Resaltado" subtitle={hl.color} onClose={() => onSelect(null)} />
          <HighlightProps hl={hl} ledger={ledger} />
          {lockRow(hl.id)}
          {outline}
        </Panel>
      );
    }
    if (kind === 'link') {
      const lnk = hit.node as LinkNode;
      return (
        <Panel>
          <Header title="Link" subtitle={lnk.url} onClose={() => onSelect(null)} />
          <LinkProps link={lnk} ledger={ledger} />
          {lockRow(lnk.id)}
          {outline}
        </Panel>
      );
    }
  }

  return (
    <Panel>
      <Header title={`Página ${graph.page}`} subtitle={`${graph.width.toFixed(0)}×${graph.height.toFixed(0)} pt`} />
      {outline}
    </Panel>
  );
}

// ── propiedades de TEXTO (sección FORMATO estilo Acrobat) ────────────────────
function TextProps({ seg, edit, ledger }:
  { seg: SegmentNode; edit: SegmentEdit | null; ledger: EditLedgerAdapter }) {
  const commit = (patch: SegmentPatch) => { ledger.patchSegment(seg, patch); };
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
        {edit && <Button variant="ghost" className="w-full" onClick={() => ledger.revertSegment(seg.id)}><RotateCcw size={14} /> Revertir cambios</Button>}
        {!edit && <div className="text-[11px] text-neutral-400">Formato y acciones: en la barra sobre el objeto.</div>}
      </Section>
    </>
  );
}

// ── propiedades de IMAGEN ────────────────────────────────────────────────────
function ImageProps({ img, ledger }: { img: ImageNode; ledger: EditLedgerAdapter }) {
  const snap = ledger.ledger.snapshot();
  const edit = snap.images.get(img.id) ?? null;
  const commit = (patch: ImagePatch & { zOrder?: 'front' | 'back' }) => { ledger.patchRect(img, patch); };
  const eff = effectiveRect(img, edit);
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
        {edit && <Button variant="ghost" className="w-full" onClick={() => ledger.revertRect(img)}><RotateCcw size={14} /> Revertir</Button>}
      </Section>
    </>
  );
}

// ── propiedades de RESALTADO (anotación /Highlight — capa aparte) ────────────
function HighlightProps({ hl, ledger }: { hl: HighlightNode; ledger: EditLedgerAdapter }) {
  const snap = ledger.ledger.snapshot();
  const edit = snap.highlights.get(hl.id) ?? null;
  const commit = (patch: HighlightPatch) => { ledger.patchRect(hl, patch); };
  const eff = effectiveRect(hl, edit);
  const num = (key: 'x' | 'y' | 'width' | 'height', original: number) => (v: number) => {
    const r = Math.round(v * 10) / 10;
    commit({ [key]: r === Math.round(original * 10) / 10 ? null : r });
  };
  return (
    <>
      <Section title="Anotación">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-neutral-400">Color</span>
          <label className="flex cursor-pointer items-center gap-1.5 text-neutral-700" title="Cambiar el color del resaltado">
            <span className="h-3.5 w-3.5 rounded-[3px] ring-1 ring-black/10" style={{ background: eff.color }} />
            {eff.color}
            <input type="color" className="sr-only" value={eff.color} onChange={e => commit({ color: e.target.value.toLowerCase() === hl.color.toLowerCase() ? null : e.target.value })} />
          </label>
        </div>
        <div className="text-[11px] text-neutral-400">Capa /Annots: se mueve, recolorea y borra sin tocar el contenido — incluso después de Aplicar.</div>
      </Section>
      <Section title="Geometría (pt)">
        <Row><NumberInput label="X" defaultValue={eff.x} onCommit={num('x', hl.x)} /><NumberInput label="Y" defaultValue={eff.y} onCommit={num('y', hl.y)} /></Row>
        <Row><NumberInput label="W" defaultValue={eff.width} onCommit={num('width', hl.width)} /><NumberInput label="H" defaultValue={eff.height} onCommit={num('height', hl.height)} /></Row>
      </Section>
      <Section title="Acciones">
        <Button variant="danger" className="w-full" onClick={() => commit({ remove: eff.removed ? null : true })}>
          {eff.removed ? <><RotateCcw size={14} /> Restaurar resaltado</> : <><Highlighter size={14} /> Eliminar resaltado</>}
        </Button>
        {edit && <Button variant="ghost" className="w-full" onClick={() => ledger.revertRect(hl)}><RotateCcw size={14} /> Revertir</Button>}
      </Section>
    </>
  );
}

// ── propiedades de LINK (anotación /Link — capa aparte) ──────────────────────
function LinkProps({ link, ledger }: { link: LinkNode; ledger: EditLedgerAdapter }) {
  const snap = ledger.ledger.snapshot();
  const edit = snap.links.get(link.id) ?? null;
  const commit = (patch: LinkPatch) => { ledger.patchRect(link, patch); };
  const eff = effectiveRect(link, edit);
  const num = (key: 'x' | 'y' | 'width' | 'height', original: number) => (v: number) => {
    const r = Math.round(v * 10) / 10;
    commit({ [key]: r === Math.round(original * 10) / 10 ? null : r });
  };
  return (
    <>
      <Section title="Destino">
        <a href={link.url} target="_blank" rel="noreferrer" className="block truncate text-[12.5px] text-blue-600 hover:underline">{link.url}</a>
      </Section>
      <Section title="Geometría (pt)">
        <Row><NumberInput label="X" defaultValue={eff.x} onCommit={num('x', link.x)} /><NumberInput label="Y" defaultValue={eff.y} onCommit={num('y', link.y)} /></Row>
        <Row><NumberInput label="W" defaultValue={eff.width} onCommit={num('width', link.width)} /><NumberInput label="H" defaultValue={eff.height} onCommit={num('height', link.height)} /></Row>
      </Section>
      <Section title="Acciones">
        <Button variant="danger" className="w-full" onClick={() => commit({ remove: eff.removed ? null : true })}>
          {eff.removed ? <><RotateCcw size={14} /> Restaurar link</> : <><Trash2 size={14} /> Eliminar link</>}
        </Button>
        {edit && <Button variant="ghost" className="w-full" onClick={() => ledger.revertRect(link)}><RotateCcw size={14} /> Revertir</Button>}
      </Section>
    </>
  );
}

// ── propiedades de CAMPO ─────────────────────────────────────────────────────
function WidgetProps({ widget, ledger, onDocOp }: { widget: WidgetNode; ledger: EditLedgerAdapter; onDocOp: (a: string, p: Record<string, unknown>) => void }) {
  const snap = ledger.ledger.snapshot();
  const edit = snap.widgets.get(widget.id) ?? null;
  const commit = (patch: WidgetPatch) => { ledger.patchRect(widget, patch); };
  const eff = effectiveRect(widget, edit);
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
