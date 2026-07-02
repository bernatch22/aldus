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
 * ESTILO POR TRAMO: bold/italic viven a nivel de StyledRun, nunca del segmento.
 * Los spans sembrados llevan data-b/data-i (la fuente embebida bold no "se ve"
 * bold para el browser, así que tags/font-weight solos no alcanzan); la
 * serialización preserva el estilo de cada tramo, y el render de un segmento
 * editado usa la fuente ORIGINAL del PDF que corresponde a cada estilo.
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
 * Interacción: click = seleccionar · seleccionado + arrastrar = mover ·
 *  doble click = editar texto in situ · grip = escalar.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  classifyGap,
  effectiveGeometry,
  mergeSegmentEdit,
  originalStyledRuns,
  pdfRectToCss,
  styledRunsEqual,
  styledText,
  toggleStyleRange,
  type FontBucket,
  type PageGraph,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
  type StyledRun,
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

// Espacios múltiples se siembran como NBSP (un contentEditable colapsa espacios
// planos consecutivos); la serialización los vuelve espacios reales.
// fromCharCode para que el carácter jamás se corrompa en el source.
const NBSP = String.fromCharCode(0xa0);
const NBSP_RE = new RegExp(NBSP, 'g');

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/ {2,}/g, m => NBSP.repeat(m.length));

const round1 = (v: number) => Math.round(v * 10) / 10;

function bucketFallback(b: FontBucket): string {
  return b === 'serif' ? "Georgia, 'Times New Roman', serif"
    : b === 'mono' ? "'Courier New', Courier, monospace"
    : 'Helvetica, Arial, sans-serif';
}

const family = (r: TextRunNode) => `'${r.font.loadedName}',${bucketFallback(r.font.bucket)}`;

// ── Fit horizontal (la técnica del text layer de pdf.js) ────────────────────
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
  return Math.abs(spacing) > r.fontSize * scale * 0.4 ? 0 : spacing;
}

function dominantRun(seg: SegmentNode): TextRunNode {
  return seg.runs.reduce((a, b) => (b.width > a.width ? b : a));
}

/** El run original cuyo estilo coincide (su familia embebida YA es bold/italic),
 *  o el dominante con estilo sintetizado si el segmento nunca tuvo ese estilo. */
function styleBase(seg: SegmentNode, bold: boolean, italic: boolean): { base: TextRunNode; exact: boolean } {
  const match = seg.runs.find(r => r.font.bold === bold && r.font.italic === italic);
  return { base: match ?? dominantRun(seg), exact: !!match };
}

function styledSpanStyle(seg: SegmentNode, sr: { bold: boolean; italic: boolean }, sizeRatio: number, scale: number): string {
  const { base, exact } = styleBase(seg, sr.bold, sr.italic);
  const synthBold = sr.bold && (!exact || !base.font.embedded);
  const synthItalic = sr.italic && (!exact || !base.font.embedded);
  return `font-family:${family(base)};font-size:${(base.fontSize * sizeRatio * scale).toFixed(2)}px;` +
    (synthBold ? 'font-weight:700;' : '') + (synthItalic ? 'font-style:italic;' : '');
}

/** Font shorthand para MEDIR un tramo (en pt: tamaño original × ratio). */
function measureFontFor(seg: SegmentNode, sr: { bold: boolean; italic: boolean }, sizeRatio: number): string {
  const { base, exact } = styleBase(seg, sr.bold, sr.italic);
  const st = (sr.italic && (!exact || !base.font.embedded)) ? 'italic ' : '';
  const wt = (sr.bold && (!exact || !base.font.embedded)) ? '700 ' : '';
  return `${st}${wt}${(base.fontSize * sizeRatio).toFixed(2)}px ${family(base)}`;
}

function runStyle(r: TextRunNode, scale: number, letterSpacing = 0): string {
  const weight = !r.font.embedded && r.font.bold ? 'font-weight:bold;' : '';
  const style = !r.font.embedded && r.font.italic ? 'font-style:italic;' : '';
  const tracking = letterSpacing !== 0 ? `letter-spacing:${letterSpacing.toFixed(3)}px;` : '';
  return `font-family:${family(r)};font-size:${(r.fontSize * scale).toFixed(2)}px;${weight}${style}${tracking}`;
}

/** Tipografía del CONTENEDOR editable: la dominante del segmento (con tamaño/
 *  familia de la edición). Todo texto que el browser inserte fuera de los spans
 *  hereda esto — nunca el system font del UI. */
function containerStyle(seg: SegmentNode, edit: SegmentEdit | null, scale: number): CSSProperties {
  const dom = dominantRun(seg);
  const ratio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
  return {
    fontFamily: edit?.font ? bucketFallback(edit.font) : family(dom),
    fontSize: `${(dom.fontSize * ratio * scale).toFixed(2)}px`,
    fontWeight: !dom.font.embedded && dom.font.bold ? 700 : 400,
    fontStyle: !dom.font.embedded && dom.font.italic ? 'italic' : 'normal',
  };
}

/** Runs estilados → el DOM canónico del box editable (un span por tramo, con
 *  data-b/data-i y la fuente real de ese estilo). */
function runsToHtml(seg: SegmentNode, runs: StyledRun[], sizeRatio: number, scale: number): string {
  return runs.map(sr =>
    `<span data-b="${sr.bold ? 1 : 0}" data-i="${sr.italic ? 1 : 0}" style="${styledSpanStyle(seg, sr, sizeRatio, scale)}">${esc(sr.text)}</span>`,
  ).join('') || '<br>';
}

/** HTML inicial del box. Sin edición: un span por run con su fuente real, su
 *  fit y su estilo en data-b/data-i. Con edición: un span por TRAMO estilado. */
function seedHtml(seg: SegmentNode, edit: SegmentEdit | null, scale: number): string {
  if (edit) {
    const ratio = (edit.fontSize ?? seg.fontSize) / seg.fontSize;
    const dom = dominantRun(seg);
    const source: StyledRun[] = edit.runs ?? [{ text: edit.text, bold: dom.font.bold, italic: dom.font.italic, dx: 0 }];
    return runsToHtml(seg, source, ratio, scale);
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
    html += `<span data-b="${r.font.bold ? 1 : 0}" data-i="${r.font.italic ? 1 : 0}" style="${margin}${runStyle(r, scale, fitLetterSpacing(r, r.text, scale))}">${esc(space + r.text)}</span>`;
  }
  return html || '<br>';
}

/** DOM editado → runs estilados. data-b/data-i de los spans sembrados manda;
 *  también se respetan <b>/<i>/font-weight por si el browser los inserta. */
function serializeStyled(root: HTMLElement, seg: SegmentNode, sizeRatio: number): StyledRun[] {
  const parts: Array<{ text: string; bold: boolean; italic: boolean }> = [];
  const push = (t: string, bold: boolean, italic: boolean) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && last.bold === bold && last.italic === italic) last.text += t;
    else parts.push({ text: t, bold, italic });
  };
  const walk = (node: Node, bold: boolean, italic: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      push((node.textContent ?? '').replace(NBSP_RE, ' ').replace(/\n+/g, ' '), bold, italic);
      return;
    }
    if (!(node instanceof HTMLElement) || node.tagName === 'BR') return;
    let b = bold, i = italic;
    if (node.tagName === 'B' || node.tagName === 'STRONG') b = true;
    if (node.tagName === 'I' || node.tagName === 'EM') i = true;
    const fw = node.style.fontWeight;
    if (fw) b = fw === 'bold' || fw === 'bolder' || parseInt(fw) >= 600;
    const fs = node.style.fontStyle;
    if (fs) i = fs === 'italic' || fs === 'oblique';
    if (node.dataset.b !== undefined) b = node.dataset.b === '1';
    if (node.dataset.i !== undefined) i = node.dataset.i === '1';
    node.childNodes.forEach(child => walk(child, b, i));
  };
  walk(root, false, false);
  while (parts.length && /^\s+$/.test(parts[parts.length - 1].text)) parts.pop();
  if (parts.length) parts[parts.length - 1].text = parts[parts.length - 1].text.replace(/\s+$/, '');

  // dx de cada tramo = suma de anchos medidos (pt) de los tramos anteriores.
  const out: StyledRun[] = [];
  let dx = 0;
  for (const p of parts) {
    out.push({ ...p, dx: round1(dx) });
    dx += measureWidth(p.text, measureFontFor(seg, p, sizeRatio));
  }
  return out;
}

/** Posición de la selección como offsets sobre el TEXTO PLANO del box. */
function flatOffsets(root: HTMLElement, range: Range): { start: number; end: number } {
  let start = -1;
  let end = -1;
  let pos = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (n === range.startContainer) start = pos + range.startOffset;
    if (n === range.endContainer) end = pos + range.endOffset;
    pos += len;
  }
  if (start < 0) start = 0; // contenedor de elemento (triple click) → todo
  if (end < 0) end = pos;
  return { start: Math.min(start, pos), end: Math.min(end, pos) };
}

function restoreSelection(root: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let pos = 0;
  let startSet = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (!startSet && start <= pos + len) {
      range.setStart(n, Math.max(0, start - pos));
      startSet = true;
    }
    if (startSet && end <= pos + len) {
      range.setEnd(n, Math.max(0, end - pos));
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    pos += len;
  }
  if (startSet) {
    range.setEnd(root, root.childNodes.length);
    sel.removeAllRanges();
    sel.addRange(range);
  }
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
  const gripStart = useRef<number | null>(null);
  const [gripRatio, setGripRatio] = useState<number | null>(null);

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

  const masked = editing || edit != null;
  const html = seedHtml(seg, edit, scale);

  const commitFromDom = (el: HTMLElement) => {
    const sizeRatio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
    const runs = serializeStyled(el, seg, sizeRatio);
    onPatch({
      text: styledText(runs),
      runs: styledRunsEqual(runs, originalStyledRuns(seg)) ? null : runs,
    });
  };

  return (
    <>
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
          transform: drag
            ? `translate(${drag.dx}px, ${drag.dy}px)`
            : gripRatio
              ? `scale(${gripRatio})`
              : undefined,
          transformOrigin: 'left bottom',
        }}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        onDoubleClick={e => { e.stopPropagation(); onStartEdit(); }}
        onPointerDown={e => {
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
              commitFromDom(e.currentTarget);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === 'Escape') {
                e.currentTarget.innerHTML = seedHtml(seg, edit, scale);
                e.currentTarget.blur();
              }
              // Cmd/Ctrl+B / +I: estilo a la SELECCIÓN, vía el modelo — nunca
              // el execCommand del browser (parte los spans y pierde data-b).
              if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'i')) {
                e.preventDefault();
                const el = e.currentTarget;
                const sel = window.getSelection();
                if (!sel || sel.rangeCount === 0) return;
                const range = sel.getRangeAt(0);
                if (!el.contains(range.commonAncestorContainer)) return;
                const { start, end } = flatOffsets(el, range);
                if (end <= start) return;
                const sizeRatio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
                const runs = serializeStyled(el, seg, sizeRatio);
                const next = toggleStyleRange(runs, start, end, e.key === 'b' ? 'bold' : 'italic');
                el.innerHTML = runsToHtml(seg, next, sizeRatio, scale);
                restoreSelection(el, start, end);
              }
            }}
          />
        )}
        {selected && !editing && (
          <div
            className="seg-grip"
            title="Arrastrar para escalar el texto"
            onPointerDown={e => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              gripStart.current = e.clientX;
            }}
            onPointerMove={e => {
              if (gripStart.current == null) return;
              e.stopPropagation();
              const ratio = Math.max(0.2, (rect.width + e.clientX - gripStart.current) / rect.width);
              setGripRatio(ratio);
            }}
            onPointerUp={e => {
              e.stopPropagation();
              const start = gripStart.current;
              gripStart.current = null;
              setGripRatio(null);
              if (start == null) return;
              const ratio = Math.max(0.2, (rect.width + e.clientX - start) / rect.width);
              const size = Math.max(4, round1(eff.fontSize * ratio));
              onPatch({ fontSize: size === round1(seg.fontSize) ? null : size });
            }}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
          />
        )}
      </div>
    </>
  );
}
