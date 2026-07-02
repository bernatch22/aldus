/**
 * Inspector — el grafo de la página, legible: líneas → segmentos (la unidad de
 * edición, anclada a su x), y el detalle del segmento seleccionado con sus runs
 * (fuente PostScript real, tamaño, geometría). Esta es la vista "entender los
 * grafos actuales del PDF".
 */

import type { PageGraph, SegmentEdit } from '@aldus/core';

interface Props {
  graph: PageGraph | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  edits: Map<string, SegmentEdit>;
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

export function Inspector({ graph, selectedId, onSelect, edits }: Props) {
  if (!graph) return <aside className="inspector" />;
  const selected = graph.segments.find(s => s.id === selectedId) ?? null;

  return (
    <aside className="inspector">
      {selected ? (
        <>
          <div className="insp-head">
            <h3>Segmento {selected.id}</h3>
            <button onClick={() => onSelect(null)}>×</button>
          </div>
          <dl className="insp-props">
            <dt>texto</dt><dd className="mono">{edits.get(selected.id)?.text ?? selected.text}</dd>
            <dt>x (ancla)</dt><dd>{n1(selected.x)} pt</dd>
            <dt>baseline</dt><dd>{n1(selected.baseline)} pt</dd>
            <dt>ancho</dt><dd>{n1(selected.width)} pt</dd>
            <dt>alto</dt><dd>{n1(selected.height)} pt</dd>
            <dt>tamaño</dt><dd>{n1(selected.fontSize)} pt</dd>
            {edits.has(selected.id) && (<><dt>original</dt><dd className="mono muted">{selected.text}</dd></>)}
          </dl>
          <h4>Runs ({selected.runs.length})</h4>
          <ul className="run-list">
            {selected.runs.map(r => (
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
