/**
 * Inspector — dos modos:
 *  - Sin selección: el grafo de la página (líneas → segmentos, la vista
 *    "entender los grafos actuales del PDF").
 *  - Con selección: OBJECT PROPERTIES del segmento — texto, B/I, tamaño,
 *    familia, posición (x/baseline) — todo editable; los cambios se acumulan
 *    como overrides del SegmentEdit vía mergeSegmentEdit (core).
 */

import {
  effectiveImageRect,
  effectiveWidgetRect,
  mergeImageEdit,
  mergeSegmentEdit,
  mergeWidgetEdit,
  originalStyledRuns,
  type FontBucket,
  type ImageEdit,
  type ImageNode,
  type ImagePatch,
  type PageGraph,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
  type StyledRun,
  type WidgetEdit,
  type WidgetNode,
  type WidgetPatch,
} from '@aldus/core';
import { useEffect, useState } from 'react';
import type { EditAction, ImageEditAction, WidgetEditAction } from './NodeOverlay';
import { activeEditingBox, selectionStyle, SELECTION_STYLE_EVENT } from './styledDom';

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
}

/** Botón compartido de lock: un nodo bloqueado no responde al mouse en el
 *  lienzo; se administra desde acá. */
function LockButton({ nodeId, locked, onToggleLock }: { nodeId: string; locked: Set<string>; onToggleLock: (id: string) => void }) {
  const isLocked = locked.has(nodeId);
  return (
    <button className={isLocked ? 'tool-active' : ''} onClick={() => onToggleLock(nodeId)}>
      {isLocked ? '🔓 Desbloquear' : '🔒 Bloquear'}
    </button>
  );
}

const WIDGET_TYPE_LABEL: Record<WidgetNode['widgetType'], string> = {
  text: 'texto', checkbox: 'checkbox', radio: 'radio', select: 'select',
  list: 'lista', button: 'botón', signature: 'firma',
};

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** Texto de un segmento con su estilo REAL por tramo (negritas visibles). */
function StyledPreview({ seg, edit }: { seg: SegmentNode; edit: SegmentEdit | null }) {
  const styled = edit?.runs ?? originalStyledRuns(seg);
  if (!edit?.runs && edit) return <span className="mono">{edit.text}</span>;
  return (
    <span className="mono">
      {styled.map((r, i) => (
        <span key={i} style={{ fontWeight: r.bold ? 700 : 400, fontStyle: r.italic ? 'italic' : 'normal' }}>
          {r.text}
        </span>
      ))}
    </span>
  );
}

export function Inspector({ graph, selectedId, onSelect, edits, onEdit, imageEdits, onImageEdit, widgetEdits, onWidgetEdit, locked, onToggleLock }: Props) {
  if (!graph) return <aside className="inspector" />;
  const selected = graph.segments.find(s => s.id === selectedId) ?? null;
  const selectedImage = graph.images.find(i => i.id === selectedId) ?? null;
  const selectedWidget = graph.widgets.find(w => w.id === selectedId) ?? null;

  return (
    <aside className="inspector">
      {selectedWidget ? (
        <>
          <WidgetProperties
            key={selectedWidget.id}
            widget={selectedWidget}
            edit={widgetEdits.get(selectedWidget.id) ?? null}
            onClose={() => onSelect(null)}
            onWidgetEdit={onWidgetEdit}
          />
          <LockButton nodeId={selectedWidget.id} locked={locked} onToggleLock={onToggleLock} />
        </>
      ) : selectedImage ? (
        <>
          <ImageProperties
            key={selectedImage.id}
            img={selectedImage}
            edit={imageEdits.get(selectedImage.id) ?? null}
            onClose={() => onSelect(null)}
            onImageEdit={onImageEdit}
          />
          <LockButton nodeId={selectedImage.id} locked={locked} onToggleLock={onToggleLock} />
        </>
      ) : selected ? (
        <>
          <ObjectProperties
            key={selected.id}
            seg={selected}
            edit={edits.get(selected.id) ?? null}
            onClose={() => onSelect(null)}
            onEdit={onEdit}
          />
          <LockButton nodeId={selected.id} locked={locked} onToggleLock={onToggleLock} />
        </>
      ) : (
        <>
          <div className="insp-head">
            <h3>Grafo — página {graph.page}</h3>
          </div>
          <p className="muted">
            {graph.width.toFixed(0)}×{graph.height.toFixed(0)} pt · {graph.lines.length} líneas
            · {graph.segments.length} segmentos · {graph.runs.length} runs
            {graph.images.length > 0 && <> · {graph.images.length} imagen{graph.images.length > 1 ? 'es' : ''}</>}
            {(edits.size + imageEdits.size) > 0 && <> · {edits.size + imageEdits.size} edición{edits.size + imageEdits.size > 1 ? 'es' : ''} pendiente{edits.size + imageEdits.size > 1 ? 's' : ''}</>}
          </p>
          {graph.widgets.length > 0 && (
            <>
              <h4>Campos</h4>
              <ul className="line-list">
                {graph.widgets.map(w => (
                  <li key={w.id} className="line-group">
                    <div
                      className={`seg-item${widgetEdits.has(w.id) ? ' edited' : ''}`}
                      onClick={() => onSelect(w.id)}
                    >
                      <span className="mono">{locked.has(w.id) ? '🔒 ' : ''}▭ {w.fieldName || '(sin nombre)'} · {WIDGET_TYPE_LABEL[w.widgetType]}</span>
                      <span className="muted">x={n1(w.x)} · y={n1(w.y)} · {n1(w.width)}×{n1(w.height)}pt</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {graph.images.length > 0 && (
            <>
              <h4>Imágenes</h4>
              <ul className="line-list">
                {graph.images.map(img => (
                  <li key={img.id} className="line-group">
                    <div
                      className={`seg-item${imageEdits.has(img.id) ? ' edited' : ''}`}
                      onClick={() => onSelect(img.id)}
                    >
                      <span className="mono">{locked.has(img.id) ? '🔒 ' : ''}🖼 {Math.round(img.width)}×{Math.round(img.height)} pt{imageEdits.get(img.id)?.remove ? ' · eliminada' : ''}</span>
                      <span className="muted">x={n1(img.x)} · y={n1(img.y)}{img.rotated ? ' · rotada' : ''}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul className="line-list">
            {graph.lines.map(l => (
              <li key={l.id} className="line-group">
                {l.segments.map(s => (
                  <div
                    key={s.id}
                    className={`seg-item${edits.has(s.id) ? ' edited' : ''}`}
                    onClick={() => onSelect(s.id)}
                  >
                    <StyledPreview seg={s} edit={edits.get(s.id) ?? null} />
                    <span className="muted">x={n1(s.x)} · y={n1(s.baseline)} · {n1(s.fontSize)}pt</span>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

interface WidgetPropsPanelProps {
  widget: WidgetNode;
  edit: WidgetEdit | null;
  onClose: () => void;
  onWidgetEdit: (action: WidgetEditAction) => void;
}

function WidgetProperties({ widget, edit, onClose, onWidgetEdit }: WidgetPropsPanelProps) {
  const commit = (patch: WidgetPatch) => {
    const merged = mergeWidgetEdit(widget, edit, patch);
    onWidgetEdit(merged ?? { widgetId: widget.id, revert: true });
  };
  const eff = effectiveWidgetRect(widget, edit);

  const numPatch = (key: 'x' | 'y' | 'width' | 'height', originalValue: number) => (raw: string) => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    const rounded = Math.round(v * 10) / 10;
    commit({ [key]: rounded === Math.round(originalValue * 10) / 10 ? null : rounded });
  };

  const fields: Array<['x' | 'y' | 'width' | 'height', string, number, number]> = [
    ['x', 'x', eff.x, widget.x],
    ['y', 'y', eff.y, widget.y],
    ['width', 'ancho', eff.width, widget.width],
    ['height', 'alto', eff.height, widget.height],
  ];

  return (
    <>
      <div className="insp-head">
        <h3>Campo — {widget.fieldName || widget.id}</h3>
        <button onClick={onClose}>×</button>
      </div>
      <dl className="insp-props">
        <dt>tipo</dt><dd>{WIDGET_TYPE_LABEL[widget.widgetType]}</dd>
        <dt>nombre</dt><dd className="mono">{widget.fieldName || '(sin nombre)'}</dd>
        {widget.readOnly && (<><dt>flags</dt><dd>read-only</dd></>)}
      </dl>
      <label className="prop-label">Geometría (pt)</label>
      <div className="prop-grid2">
        {fields.map(([key, label, value, original]) => (
          <label key={key} className="prop-cell">
            <span className="muted">{label}</span>
            <input
              className="prop-input num"
              type="number"
              step="0.5"
              defaultValue={n1(value)}
              onBlur={e => numPatch(key, original)(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </label>
        ))}
      </div>
      <button className="danger" onClick={() => commit({ remove: true })}>
        Eliminar campo
      </button>
    </>
  );
}

interface ImagePropsPanelProps {
  img: ImageNode;
  edit: ImageEdit | null;
  onClose: () => void;
  onImageEdit: (action: ImageEditAction) => void;
}

function ImageProperties({ img, edit, onClose, onImageEdit }: ImagePropsPanelProps) {
  const commit = (patch: ImagePatch) => {
    const merged = mergeImageEdit(img, edit, patch);
    onImageEdit(merged ?? { imageId: img.id, revert: true });
  };
  const eff = effectiveImageRect(img, edit);

  const numPatch = (key: 'x' | 'y' | 'width' | 'height', originalValue: number) => (raw: string) => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    const rounded = Math.round(v * 10) / 10;
    commit({ [key]: rounded === Math.round(originalValue * 10) / 10 ? null : rounded });
  };

  const fields: Array<['x' | 'y' | 'width' | 'height', string, number, number]> = [
    ['x', 'x', eff.x, img.x],
    ['y', 'y', eff.y, img.y],
    ['width', 'ancho', eff.width, img.width],
    ['height', 'alto', eff.height, img.height],
  ];

  return (
    <>
      <div className="insp-head">
        <h3>Imagen — {img.id}</h3>
        <button onClick={onClose}>×</button>
      </div>
      {img.rotated && <p className="muted">Imagen con rotación: mover/escalar aún no soportado en el bake.</p>}
      <label className="prop-label">Geometría (pt)</label>
      <div className="prop-grid2">
        {fields.map(([key, label, value, original]) => (
          <label key={key} className="prop-cell">
            <span className="muted">{label}</span>
            <input
              className="prop-input num"
              type="number"
              step="0.5"
              defaultValue={n1(value)}
              disabled={eff.removed}
              onBlur={e => numPatch(key, original)(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </label>
        ))}
      </div>
      <label className="prop-label">Orden (z)</label>
      <div className="prop-row">
        <button onClick={() => commit({ zOrder: 'back' })}>Enviar al fondo</button>
        <button onClick={() => commit({ zOrder: 'front' })}>Traer al frente</button>
      </div>
      <button
        className="danger"
        onClick={() => commit({ remove: eff.removed ? null : true })}
      >
        {eff.removed ? 'Restaurar imagen' : 'Eliminar imagen'}
      </button>
      {edit && (
        <button className="danger" onClick={() => onImageEdit({ imageId: img.id, revert: true })}>
          Revertir cambios
        </button>
      )}
    </>
  );
}

interface PropsPanelProps {
  seg: SegmentNode;
  edit: SegmentEdit | null;
  onClose: () => void;
  onEdit: (action: EditAction) => void;
}

function ObjectProperties({ seg, edit, onClose, onEdit }: PropsPanelProps) {
  const commit = (patch: SegmentPatch) => {
    const merged = mergeSegmentEdit(seg, edit, patch);
    onEdit(merged ?? { segmentId: seg.id, revert: true });
  };

  const dom = seg.runs.reduce((a, b) => (b.width > a.width ? b : a));
  // El estilo vive POR TRAMO: los toggles globales aplican a todos los tramos;
  // cada tramo tiene además sus propios B/I (quitar la negrita a UNA parte no
  // toca el resto).
  const styled: StyledRun[] = edit?.runs ?? originalStyledRuns(seg);
  const setRuns = (runs: StyledRun[]) => commit({ runs });

  // Con un box en edición, los toggles se encienden según el estilo BAJO EL
  // CURSOR/selección (recalculado en cada selectionchange); sin edición, según
  // el estilo de todos los tramos del segmento.
  const [selSty, setSelSty] = useState<{ bold: boolean; italic: boolean } | null>(null);
  useEffect(() => {
    const update = () => {
      const el = activeEditingBox();
      setSelSty(el ? selectionStyle(el, seg, edit) : null);
    };
    update();
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [seg, edit]);
  const allBold = selSty ? selSty.bold : styled.length > 0 && styled.every(r => r.bold);
  const allItalic = selSty ? selSty.italic : styled.length > 0 && styled.every(r => r.italic);
  /** Con un box EN EDICIÓN, el toggle va a la SELECCIÓN (el mousedown del botón
   *  hace preventDefault, así el editable no pierde foco ni selección). */
  const toggleStyle = (key: 'bold' | 'italic', fallback: () => void) => {
    if (activeEditingBox()) {
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key } }));
      return;
    }
    fallback();
  };
  const curSize = edit?.fontSize ?? seg.fontSize;
  const curFont: FontBucket | 'original' = edit?.font ?? 'original';
  const curX = edit?.x ?? seg.x;
  const curBaseline = edit?.baseline ?? seg.baseline;

  const numPatch = (key: 'fontSize' | 'x' | 'baseline', originalValue: number) => (raw: string) => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0) return;
    const rounded = Math.round(v * 10) / 10;
    commit({ [key]: rounded === Math.round(originalValue * 10) / 10 ? null : rounded });
  };

  return (
    <>
      <div className="insp-head">
        <h3>Propiedades — {seg.id}</h3>
        <button onClick={onClose}>×</button>
      </div>

      <label className="prop-label">Texto</label>
      <input
        className="prop-input"
        defaultValue={edit?.text ?? seg.text}
        onBlur={e => commit({ text: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />

      <label className="prop-label">Estilo</label>
      <div className="prop-row">
        <button
          className={`toggle${allBold ? ' active' : ''}`}
          title="Bold (a la selección si estás editando; si no, todo el segmento)"
          onMouseDown={e => e.preventDefault()}
          onClick={() => toggleStyle('bold', () => setRuns(styled.map(r => ({ ...r, bold: !allBold }))))}
        ><strong>B</strong></button>
        <button
          className={`toggle${allItalic ? ' active' : ''}`}
          title="Italic (a la selección si estás editando; si no, todo el segmento)"
          onMouseDown={e => e.preventDefault()}
          onClick={() => toggleStyle('italic', () => setRuns(styled.map(r => ({ ...r, italic: !allItalic }))))}
        ><em>I</em></button>
        <input
          className="prop-input num"
          type="number"
          step="0.5"
          min="4"
          title="Tamaño (pt)"
          defaultValue={n1(curSize)}
          onBlur={e => numPatch('fontSize', seg.fontSize)(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <select
          className="prop-input"
          value={curFont}
          title="Familia"
          onChange={e => commit({ font: e.target.value === 'original' ? null : (e.target.value as FontBucket) })}
        >
          <option value="original">{dom.font.postScriptName} (original)</option>
          <option value="sans">Sans</option>
          <option value="serif">Serif</option>
          <option value="mono">Mono</option>
        </select>
      </div>

      {styled.length > 1 && (
        <>
          <label className="prop-label">Tramos (estilo por parte)</label>
          <ul className="tramo-list">
            {styled.map((r, i) => (
              <li key={i}>
                <span
                  className="mono tramo-text"
                  style={{ fontWeight: r.bold ? 700 : 400, fontStyle: r.italic ? 'italic' : 'normal' }}
                >{r.text || '·'}</span>
                <button
                  className={`toggle mini${r.bold ? ' active' : ''}`}
                  title="Bold de este tramo"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setRuns(styled.map((s, j) => (j === i ? { ...s, bold: !s.bold } : s)))}
                ><strong>B</strong></button>
                <button
                  className={`toggle mini${r.italic ? ' active' : ''}`}
                  title="Italic de este tramo"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setRuns(styled.map((s, j) => (j === i ? { ...s, italic: !s.italic } : s)))}
                ><em>I</em></button>
              </li>
            ))}
          </ul>
        </>
      )}

      <label className="prop-label">Posición (pt)</label>
      <div className="prop-row">
        <span className="muted">x</span>
        <input
          className="prop-input num"
          type="number"
          step="0.5"
          defaultValue={n1(curX)}
          onBlur={e => numPatch('x', seg.x)(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <span className="muted">baseline</span>
        <input
          className="prop-input num"
          type="number"
          step="0.5"
          defaultValue={n1(curBaseline)}
          onBlur={e => numPatch('baseline', seg.baseline)(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>

      <dl className="insp-props">
        <dt>ancho</dt><dd>{n1(seg.width)} pt</dd>
        <dt>alto</dt><dd>{n1(seg.height)} pt</dd>
        {edit && (<><dt>original</dt><dd className="mono muted">{seg.text}</dd></>)}
      </dl>

      {edit && (
        <button className="danger" onClick={() => onEdit({ segmentId: seg.id, revert: true })}>
          Revertir cambios
        </button>
      )}

      <h4>Runs ({seg.runs.length})</h4>
      <ul className="run-list">
        {seg.runs.map(r => (
          <li key={r.id}>
            <span className="mono">“{r.text}”</span>
            <span className="muted">
              {r.font.postScriptName} · {n1(r.fontSize)}pt · x={n1(r.x)} w={n1(r.width)}
              {r.font.embedded ? ' · embebida' : ' · estándar'}
              {r.font.bold ? ' · bold' : ''}{r.font.italic ? ' · italic' : ''}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
