/**
 * Inspector — dos modos:
 *  - Sin selección: el grafo de la página (líneas → segmentos, la vista
 *    "entender los grafos actuales del PDF").
 *  - Con selección: OBJECT PROPERTIES del segmento — texto, B/I, tamaño,
 *    familia, posición (x/baseline) — todo editable; los cambios se acumulan
 *    como overrides del SegmentEdit vía mergeSegmentEdit (core).
 */

import { mergeSegmentEdit, type FontBucket, type PageGraph, type SegmentEdit, type SegmentNode, type SegmentPatch } from '@aldus/core';
import type { EditAction } from './NodeOverlay';

interface Props {
  graph: PageGraph | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  edits: Map<string, SegmentEdit>;
  onEdit: (action: EditAction) => void;
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

export function Inspector({ graph, selectedId, onSelect, edits, onEdit }: Props) {
  if (!graph) return <aside className="inspector" />;
  const selected = graph.segments.find(s => s.id === selectedId) ?? null;

  return (
    <aside className="inspector">
      {selected ? (
        <ObjectProperties
          key={selected.id}
          seg={selected}
          edit={edits.get(selected.id) ?? null}
          onClose={() => onSelect(null)}
          onEdit={onEdit}
        />
      ) : (
        <>
          <div className="insp-head">
            <h3>Grafo — página {graph.page}</h3>
          </div>
          <p className="muted">
            {graph.width.toFixed(0)}×{graph.height.toFixed(0)} pt · {graph.lines.length} líneas
            · {graph.segments.length} segmentos · {graph.runs.length} runs
            {edits.size > 0 && <> · {edits.size} edición{edits.size > 1 ? 'es' : ''} pendiente{edits.size > 1 ? 's' : ''}</>}
          </p>
          <ul className="line-list">
            {graph.lines.map(l => (
              <li key={l.id} className="line-group">
                {l.segments.map(s => (
                  <div
                    key={s.id}
                    className={`seg-item${edits.has(s.id) ? ' edited' : ''}`}
                    onClick={() => onSelect(s.id)}
                  >
                    <span className="mono">{edits.get(s.id)?.text ?? s.text}</span>
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
  const curBold = edit?.bold ?? dom.font.bold;
  const curItalic = edit?.italic ?? dom.font.italic;
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
          className={`toggle${curBold ? ' active' : ''}`}
          title="Bold"
          onClick={() => {
            const next = !curBold;
            commit({ bold: next === dom.font.bold ? null : next });
          }}
        ><strong>B</strong></button>
        <button
          className={`toggle${curItalic ? ' active' : ''}`}
          title="Italic"
          onClick={() => {
            const next = !curItalic;
            commit({ italic: next === dom.font.italic ? null : next });
          }}
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
