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
 *  - El texto usa la MISMA fuente embebida que el PDF (el FontFace que pdf.js
 *    registró bajo font.loadedName al renderizar el canvas), con line-height =
 *    alto del box: la baseline del browser cae sobre la baseline del PDF.
 *  - Fit horizontal a lo pdf.js-text-layer: cada run se mide y la diferencia
 *    contra su ancho PDF real se reparte como letter-spacing.
 *
 * Ediciones: SegmentEdit acumula overrides (texto, bold/italic, tamaño,
 *  familia, x/baseline) vía mergeSegmentEdit (core). Un segmento editado se
 *  dibuja en su geometría EFECTIVA y una máscara blanca tapa el lugar original.
 *
 * Interacción: click = seleccionar · seleccionado + arrastrar = mover ·
 *  doble click = editar texto in situ.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  classifyGap,
  effectiveGeometry,
  mergeSegmentEdit,
  pdfRectToCss,
  type FontBucket,
  type PageGraph,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
  type TextRunNode,
} from '@aldus/core';

export type EditAction = SegmentEdit | { segmentId: string; revert: true };

interface Props {
  graph: PageGraph;
  scale: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  edits: Map<string, SegmentEdit>;
  onEdit: (action: EditAction) => void;
}

// Espacios múltiples se siembran como NBSP: un contentEditable colapsa espacios
// planos consecutivos al editar; la serialización los vuelve espacios reales.
const NBSP = ' ';
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/ {2,}/g, m => NBSP.repeat(m.length));

const serialize = (el: HTMLElement): string =>
  el.innerText.replace(/ /g, ' ').replace(/\n+/g, ' ').replace(/\s+$/, '');

const round1 = (v: number) => Math.round(v * 10) / 10;

function bucketFallback(b: FontBucket): string {
  return b === 'serif' ? "Georgia, 'Times New Roman', serif"
    : b === 'mono' ? "'Courier New', Courier, monospace"
    : 'Helvetica, Arial, sans-serif';
}

const family = (r: TextRunNode) => `'${r.font.loadedName}',${bucketFallback(r.font.bucket)}`;

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

/** Tipografía del CONTENEDOR editable: la dominante del segmento con los
 *  overrides de la edición aplicados. Todo texto que el browser inserte fuera
 *  de los spans sembrados hereda esto — nunca el system font del UI. */
function containerStyle(seg: SegmentNode, edit: SegmentEdit | null, scale: number): CSSProperties {
  const dom = dominantRun(seg);
  const ratio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
  return {
    fontFamily: edit?.font ? bucketFallback(edit.font) : family(dom),
    fontSize: `${(dom.fontSize * ratio * scale).toFixed(2)}px`,
    fontWeight: (edit?.bold ?? (!dom.font.embedded && dom.font.bold)) ? 700 : 400,
    fontStyle: (edit?.italic ?? (!dom.font.embedded && dom.font.italic)) ? 'italic' : 'normal',
  };
}

/** HTML inicial del box. Sin edición: un span por run con su fuente real +
 *  letter-spacing de fit (ocupa EXACTAMENTE el ancho PDF del run); espacios de
 *  palabra como caracteres, micro-gaps de kerning como margin (solo render).
 *  Con edición: solo el texto — la tipografía la da el contenedor. */
function seedHtml(seg: SegmentNode, edit: SegmentEdit | null, scale: number): string {
  if (edit) return esc(edit.text) || '<br>';
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
          onStopEdit={() => setEditingId(null)}
          onPatch={patch => {
            const merged = mergeSegmentEdit(seg, edits.get(seg.id) ?? null, patch);
            onEdit(merged ?? { segmentId: seg.id, revert: true });
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
  onStopEdit: () => void;
  onPatch: (patch: SegmentPatch) => void;
}

function SegmentBox({ seg, pageHeight, scale, selected, editing, edit, onSelect, onStartEdit, onStopEdit, onPatch }: SegmentBoxProps) {
  const eff = effectiveGeometry(seg, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const originalRect = pdfRectToCss({ x: seg.x, y: seg.y, width: seg.width, height: seg.height }, pageHeight, scale);
  const editRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);

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

  return (
    <>
      {/* El segmento se movió/achicó: tapar los glifos originales del canvas. */}
      {edit != null && (
        <div className="seg-mask" style={{ left: originalRect.left, top: originalRect.top, width: originalRect.width, height: originalRect.height }} />
      )}
      <div
        className={`seg-box${selected ? ' selected' : ''}${masked ? ' masked' : ''}${edit ? ' edited' : ''}${editing ? ' editing' : ''}`}
        style={{
          left: rect.left,
          top: rect.top,
          minWidth: rect.width,
          height: rect.height,
          lineHeight: `${rect.height}px`,
          transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
        }}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        onDoubleClick={e => { e.stopPropagation(); onStartEdit(); }}
        onPointerDown={e => {
          // Mover: requiere estar SELECCIONADO (el primer click solo selecciona).
          if (editing || !selected || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragStart.current = { px: e.clientX, py: e.clientY, moved: false };
        }}
        onPointerMove={e => {
          const start = dragStart.current;
          if (!start) return;
          const dx = e.clientX - start.px;
          const dy = e.clientY - start.py;
          if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
          if (start.moved) setDrag({ dx, dy });
        }}
        onPointerUp={e => {
          const start = dragStart.current;
          dragStart.current = null;
          setDrag(null);
          if (!start?.moved) return;
          const nx = round1(eff.x + (e.clientX - start.px) / scale);
          const nb = round1(eff.baseline - (e.clientY - start.py) / scale);
          onPatch({
            x: nx === round1(seg.x) ? null : nx,
            baseline: nb === round1(seg.baseline) ? null : nb,
          });
        }}
        title={editing ? undefined : (edit?.text ?? seg.text)}
      >
        {masked && (
          <div
            ref={editRef}
            className="seg-text"
            style={containerStyle(seg, edit, scale)}
            contentEditable={editing}
            suppressContentEditableWarning
            spellCheck={false}
            dangerouslySetInnerHTML={{ __html: html }}
            onBlur={e => {
              if (!editing) return;
              onStopEdit();
              onPatch({ text: serialize(e.currentTarget) });
            }}
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
    </>
  );
}
