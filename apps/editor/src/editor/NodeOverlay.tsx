/**
 * NodeOverlay — los nodos del grafo como boxes sobre el canvas.
 *
 * La unidad de edición es el SEGMENTO (modelo Acrobat/Foxit): runs contiguos
 * anclados a su x. Un gap de columna/tab es la FRONTERA entre dos segmentos —
 * no existe como carácter ni como atom en el DOM, así que no hay nada que se
 * pueda perder al serializar, y la columna derecha queda anclada aunque el
 * texto de la izquierda crezca (tab-stop gratis). La segmentación y sus
 * umbrales viven en @aldus/core (tokens.ts).
 *
 * Pixel-perfect por construcción:
 *  - Cada box se posiciona desde su geometría PDF exacta (baseline +
 *    ascent/descent del font real) vía pdfRectToCss — una sola cuenta.
 *  - El texto del overlay usa la MISMA fuente embebida que el PDF (el FontFace
 *    que pdf.js registró bajo font.loadedName al renderizar el canvas), con
 *    line-height = alto del box: sin half-leading, la baseline del browser cae
 *    exactamente sobre la baseline del PDF.
 *
 * Serialización: innerText del segmento (solo texto plano adentro) — los
 * espacios múltiples se siembran como NBSP y se destejen al confirmar.
 *
 * Interacción: click = seleccionar (no mueve NADA), doble click = editar in situ.
 */

import { useEffect, useRef, useState } from 'react';
import {
  classifyGap,
  pdfRectToCss,
  type PageGraph,
  type SegmentEdit,
  type SegmentNode,
  type TextRunNode,
} from '@aldus/core';

interface Props {
  graph: PageGraph;
  scale: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  edits: Map<string, SegmentEdit>;
  onEdit: (edit: SegmentEdit | { segmentId: string; revert: true }) => void;
}

// Espacios múltiples se siembran como NBSP: un contentEditable colapsa espacios
// planos consecutivos al editar; la serialización los vuelve espacios reales.
const NBSP = ' ';
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/ {2,}/g, m => NBSP.repeat(m.length));

const serialize = (el: HTMLElement): string =>
  el.innerText.replace(/ /g, ' ').replace(/\n+/g, ' ').replace(/\s+$/, '');

function fallbackFamily(r: TextRunNode): string {
  return r.font.bucket === 'serif' ? "Georgia, 'Times New Roman', serif"
    : r.font.bucket === 'mono' ? "'Courier New', Courier, monospace"
    : 'Helvetica, Arial, sans-serif';
}

const family = (r: TextRunNode) => `'${r.font.loadedName}',${fallbackFamily(r)}`;

// ── Fit horizontal (la técnica del text layer de pdf.js) ────────────────────
// El PDF posiciona con ajustes que el browser no reproduce (Tc/Tw/Tz, TJ de
// justificado), así que el mismo texto con la misma fuente puede ocupar OTRO
// ancho. Medimos cada run con canvas.measureText y repartimos la diferencia
// contra el ancho REAL del PDF como letter-spacing → el run del overlay ocupa
// exactamente su espacio original (y no deforma glifos como scaleX).
let measureCtx: CanvasRenderingContext2D | null = null;

function measureWidth(text: string, cssFont: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 0;
  measureCtx.font = cssFont;
  return measureCtx.measureText(text).width;
}

function fitLetterSpacing(r: TextRunNode, text: string, scale: number): number {
  if (!text.length) return 0;
  const fontStyle = !r.font.embedded && r.font.italic ? 'italic ' : '';
  const fontWeight = !r.font.embedded && r.font.bold ? '700 ' : '';
  const measured = measureWidth(text, `${fontStyle}${fontWeight}${(r.fontSize * scale).toFixed(2)}px ${family(r)}`);
  if (measured <= 0) return 0;
  const spacing = (r.width * scale - measured) / text.length;
  // Un desvío enorme = la fuente ni siquiera está disponible (fallback lejano):
  // mejor sin tracking que glifos encimados.
  return Math.abs(spacing) > r.fontSize * scale * 0.4 ? 0 : spacing;
}

function runStyle(r: TextRunNode, scale: number, letterSpacing = 0): string {
  // Si el font está embebido, sus glifos YA son bold/italic — pedirle además
  // font-weight:bold al browser lo haría sintetizar un doble-bold.
  const weight = !r.font.embedded && r.font.bold ? 'font-weight:bold;' : '';
  const style = !r.font.embedded && r.font.italic ? 'font-style:italic;' : '';
  const tracking = letterSpacing !== 0 ? `letter-spacing:${letterSpacing.toFixed(3)}px;` : '';
  return `font-family:${family(r)};font-size:${(r.fontSize * scale).toFixed(2)}px;${weight}${style}${tracking}`;
}

function dominantRun(seg: SegmentNode): TextRunNode {
  return seg.runs.reduce((a, b) => (b.width > a.width ? b : a));
}

/** HTML inicial del box: un span por run con su fuente real + letter-spacing
 *  de fit (ocupa EXACTAMENTE el ancho PDF del run); espacios de palabra como
 *  caracteres, micro-gaps de kerning como margin (solo render). Con edición
 *  previa: el texto guardado con el estilo dominante (sin fit — el ancho
 *  original ya no aplica a un texto nuevo). */
function seedHtml(seg: SegmentNode, edit: SegmentEdit | null, scale: number): string {
  if (edit) {
    return `<span style="${runStyle(dominantRun(seg), scale)}">${esc(edit.text)}</span>` || '<br>';
  }
  const runs = seg.runs;
  let html = '';
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    let space = '';
    let margin = '';
    if (i > 0) {
      const prev = runs[i - 1];
      const gap = r.x - (prev.x + prev.width);
      const cls = classifyGap(gap, prev, r);
      if (cls === 'space') space = ' ';
      else if (gap > 0.5) margin = `margin-left:${(gap * scale).toFixed(2)}px;`;
    }
    html += `<span style="${margin}${runStyle(r, scale, fitLetterSpacing(r, r.text, scale))}">${esc(space + r.text)}</span>`;
  }
  return html || '<br>';
}

export function NodeOverlay({ graph, scale, selectedId, onSelect, edits, onEdit }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [graph.page]);

  return (
    <div className="node-overlay" onClick={() => onSelect(null)}>
      {graph.segments.map(seg => (
        <SegmentBox
          key={seg.id}
          seg={seg}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === seg.id}
          editing={editingId === seg.id}
          edit={edits.get(seg.id) ?? null}
          onSelect={() => onSelect(seg.id)}
          onStartEdit={() => { onSelect(seg.id); setEditingId(seg.id); }}
          onCommit={text => {
            setEditingId(null);
            if (text === seg.text) {
              onEdit({ segmentId: seg.id, revert: true });
              return;
            }
            onEdit({
              segmentId: seg.id,
              page: seg.page,
              text,
              original: { text: seg.text, x: seg.x, baseline: seg.baseline, width: seg.width, fontSize: seg.fontSize },
            });
          }}
        />
      ))}
    </div>
  );
}

interface SegmentBoxProps {
  seg: SegmentNode;
  pageHeight: number;
  scale: number;
  selected: boolean;
  editing: boolean;
  edit: SegmentEdit | null;
  onSelect: () => void;
  onStartEdit: () => void;
  onCommit: (text: string) => void;
}

function SegmentBox({ seg, pageHeight, scale, selected, editing, edit, onSelect, onStartEdit, onCommit }: SegmentBoxProps) {
  const rect = pdfRectToCss({ x: seg.x, y: seg.y, width: seg.width, height: seg.height }, pageHeight, scale);
  const editRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  // Con edición pendiente (o en curso) el box se vuelve opaco: tapa los glifos
  // originales del canvas y muestra el texto vivo con la fuente real del PDF.
  const masked = editing || edit != null;
  const html = seedHtml(seg, edit, scale);

  // El CONTENEDOR editable hereda la fuente dominante del segmento: cualquier
  // texto que el browser inserte FUERA de los spans sembrados (tipear al
  // principio/fin, seleccionar-todo-y-escribir) cae en esta fuente y tamaño —
  // nunca en el system font del UI (la causa del "salto" de tamaño al editar).
  const dom = dominantRun(seg);
  const inheritStyle = {
    fontFamily: family(dom),
    fontSize: `${(dom.fontSize * scale).toFixed(2)}px`,
    fontWeight: !dom.font.embedded && dom.font.bold ? 700 : 400,
    fontStyle: !dom.font.embedded && dom.font.italic ? 'italic' as const : 'normal' as const,
  };

  return (
    <div
      className={`seg-box${selected ? ' selected' : ''}${masked ? ' masked' : ''}${edit ? ' edited' : ''}`}
      style={{ left: rect.left, top: rect.top, minWidth: rect.width, height: rect.height, lineHeight: `${rect.height}px` }}
      onClick={e => { e.stopPropagation(); onSelect(); }}
      onDoubleClick={e => { e.stopPropagation(); onStartEdit(); }}
      title={editing ? undefined : seg.text}
    >
      {masked && (
        <div
          ref={editRef}
          className="seg-text"
          style={inheritStyle}
          contentEditable={editing}
          suppressContentEditableWarning
          spellCheck={false}
          dangerouslySetInnerHTML={{ __html: html }}
          onBlur={e => { if (editing) onCommit(serialize(e.currentTarget)); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === 'Escape') {
              e.currentTarget.innerHTML = seedHtml(seg, edit, scale);
              e.currentTarget.blur();
            }
          }}
        />
      )}
    </div>
  );
}
