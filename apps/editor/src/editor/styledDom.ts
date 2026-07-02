/**
 * styledDom.ts — el puente entre el MODELO (StyledRun[]) y el DOM editable.
 *
 * Invariante: el DOM del box editable es siempre una proyección de runs
 * estilados — spans con data-b/data-i y la fuente real del PDF para ese
 * estilo. El texto lo muta el browser libremente (tipeo); el ESTILO pasa
 * SIEMPRE por el modelo (applySelectionStyle → toggleStyleRange → re-seed),
 * nunca por execCommand.
 *
 * Sin React: módulo puro de DOM, testeable con jsdom.
 */

import {
  classifyGap,
  originalStyledRuns,
  setStyleRange,
  styledText,
  toggleStyleRange,
  type FontBucket,
  type SegmentEdit,
  type SegmentNode,
  type StyledRun,
  type TextRunNode,
} from '@aldus/core';

// Espacios múltiples se siembran como NBSP (un contentEditable colapsa espacios
// planos consecutivos); la serialización los vuelve espacios reales.
// fromCharCode para que el carácter jamás se corrompa en el source.
export const NBSP = String.fromCharCode(0xa0);
const NBSP_RE = new RegExp(NBSP, 'g');

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/ {2,}/g, m => NBSP.repeat(m.length));

export const round1 = (v: number) => Math.round(v * 10) / 10;

export function bucketFallback(b: FontBucket): string {
  return b === 'serif' ? "Georgia, 'Times New Roman', serif"
    : b === 'mono' ? "'Courier New', Courier, monospace"
    : 'Helvetica, Arial, sans-serif';
}

export const family = (r: TextRunNode) => `'${r.font.loadedName}',${bucketFallback(r.font.bucket)}`;

// ── Medición (canvas; en jsdom no hay 2d context → 0, inofensivo) ───────────
let measureCtx: CanvasRenderingContext2D | null | false = null;

export function measureWidth(text: string, cssFont: string): number {
  if (measureCtx === false) return 0;
  if (!measureCtx) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d') ?? false;
    } catch {
      measureCtx = false;
    }
    if (!measureCtx) return 0;
  }
  measureCtx.font = cssFont;
  return measureCtx.measureText(text).width;
}

/** Fit horizontal (la técnica del text layer de pdf.js): la diferencia entre
 *  el ancho PDF real del run y el medido se reparte como letter-spacing. */
export function fitLetterSpacing(r: TextRunNode, text: string, scale: number): number {
  if (!text.length) return 0;
  const fontStyle = !r.font.embedded && r.font.italic ? 'italic ' : '';
  const fontWeight = !r.font.embedded && r.font.bold ? '700 ' : '';
  const measured = measureWidth(text, `${fontStyle}${fontWeight}${(r.fontSize * scale).toFixed(2)}px ${family(r)}`);
  if (measured <= 0) return 0;
  const spacing = (r.width * scale - measured) / text.length;
  return Math.abs(spacing) > r.fontSize * scale * 0.4 ? 0 : spacing;
}

export function dominantRun(seg: SegmentNode): TextRunNode {
  return seg.runs.reduce((a, b) => (b.width > a.width ? b : a));
}

/** El run original cuyo estilo coincide (su familia embebida YA es bold/italic),
 *  o el dominante con estilo sintetizado si el segmento nunca tuvo ese estilo. */
function styleBase(seg: SegmentNode, bold: boolean, italic: boolean): { base: TextRunNode; exact: boolean } {
  const match = seg.runs.find(r => r.font.bold === bold && r.font.italic === italic);
  return { base: match ?? dominantRun(seg), exact: !!match };
}

export function styledSpanStyle(seg: SegmentNode, sr: { bold: boolean; italic: boolean; color?: string }, sizeRatio: number, scale: number): string {
  const { base, exact } = styleBase(seg, sr.bold, sr.italic);
  // Sin run original con este estilo: NO usar la familia embebida (podría ser
  // la BOLD — des-boldear un segmento 100% bold quedaba en bold igual). Se cae
  // al fallback del bucket con weight/style sintéticos según el tramo.
  const fam = exact ? family(base) : bucketFallback(base.font.bucket);
  const synthBold = sr.bold && (!exact || !base.font.embedded);
  const synthItalic = sr.italic && (!exact || !base.font.embedded);
  const weight = exact ? (synthBold ? 'font-weight:700;' : '') : `font-weight:${sr.bold ? 700 : 400};`;
  const style = exact ? (synthItalic ? 'font-style:italic;' : '') : `font-style:${sr.italic ? 'italic' : 'normal'};`;
  const colorVal = sr.color ?? base.color;
  const color = colorVal ? `color:${colorVal};` : '';
  return `font-family:${fam};font-size:${(base.fontSize * sizeRatio * scale).toFixed(2)}px;${color}${weight}${style}`;
}

/** Font shorthand para MEDIR un tramo (en pt: tamaño original × ratio). */
function measureFontFor(seg: SegmentNode, sr: { bold: boolean; italic: boolean }, sizeRatio: number): string {
  const { base, exact } = styleBase(seg, sr.bold, sr.italic);
  const fam = exact ? family(base) : bucketFallback(base.font.bucket);
  const st = sr.italic && (!exact || !base.font.embedded) ? 'italic ' : '';
  const wt = sr.bold && (!exact || !base.font.embedded) ? '700 ' : '';
  return `${st}${wt}${(base.fontSize * sizeRatio).toFixed(2)}px ${fam}`;
}

export function runStyle(r: TextRunNode, scale: number, letterSpacing = 0): string {
  const weight = !r.font.embedded && r.font.bold ? 'font-weight:bold;' : '';
  const style = !r.font.embedded && r.font.italic ? 'font-style:italic;' : '';
  const tracking = letterSpacing !== 0 ? `letter-spacing:${letterSpacing.toFixed(3)}px;` : '';
  const color = r.color ? `color:${r.color};` : '';
  return `font-family:${family(r)};font-size:${(r.fontSize * scale).toFixed(2)}px;${color}${weight}${style}${tracking}`;
}

/** Runs estilados → el DOM canónico del box editable (un span por tramo, con
 *  data-b/data-i y la fuente real de ese estilo). */
export function runsToHtml(seg: SegmentNode, runs: StyledRun[], sizeRatio: number, scale: number): string {
  return runs.map(sr =>
    `<span data-b="${sr.bold ? 1 : 0}" data-i="${sr.italic ? 1 : 0}"${sr.color ? ` data-c="${sr.color}"` : ''} style="${styledSpanStyle(seg, sr, sizeRatio, scale)}">${esc(sr.text)}</span>`,
  ).join('') || '<br>';
}

/** HTML inicial del box. Sin edición: un span por run con su fuente real, su
 *  fit y su estilo en data-b/data-i. Con edición: un span por TRAMO estilado. */
export function seedHtml(seg: SegmentNode, edit: SegmentEdit | null, scale: number): string {
  if (edit) {
    const ratio = (edit.fontSize ?? seg.fontSize) / seg.fontSize;
    const dom = dominantRun(seg);
    const source: StyledRun[] = edit.runs ?? [{ text: edit.text, bold: dom.font.bold, italic: dom.font.italic, dx: 0 }];
    return runsToHtml(seg, source, ratio, scale);
  }
  const runs = seg.runs;
  // El espacio de un word-gap va al FINAL del run ANTERIOR — la MISMA regla que
  // originalStyledRuns (core). Si difieren, el roundtrip sembrar→serializar no
  // es idéntico: edits fantasma y fronteras de tramo corridas un espacio.
  const texts = runs.map(r => r.text);
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1];
    const gap = runs[i].x - (prev.x + prev.width);
    if (classifyGap(gap, prev, runs[i]) === 'space' && !texts[i - 1].endsWith(' ') && !texts[i].startsWith(' ')) {
      texts[i - 1] += ' ';
    }
  }
  let html = '';
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    let margin = '';
    if (i > 0) {
      const prev = runs[i - 1];
      const gap = r.x - (prev.x + prev.width);
      if (classifyGap(gap, prev, r) === 'none' && gap > 0.5) margin = `margin-left:${(gap * scale).toFixed(2)}px;`;
    }
    html += `<span data-b="${r.font.bold ? 1 : 0}" data-i="${r.font.italic ? 1 : 0}"${r.color ? ` data-c="${r.color}"` : ''} style="${margin}${runStyle(r, scale, fitLetterSpacing(r, r.text, scale))}">${esc(texts[i])}</span>`;
  }
  return html || '<br>';
}

/** DOM editado → runs estilados. data-b/data-i de los spans sembrados manda;
 *  también se respetan <b>/<i>/font-weight por si el browser los inserta. */
/** 'rgb(r, g, b)' o '#hex' → '#rrggbb' (o undefined si no se entiende). */
function cssColorToHex(v: string): string | undefined {
  const hex = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (hex) return v.trim().toLowerCase();
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(v.trim());
  if (!m) return undefined;
  const h = (n: string) => Math.min(255, parseInt(n, 10)).toString(16).padStart(2, '0');
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
}

export function serializeStyled(root: HTMLElement, seg: SegmentNode, sizeRatio: number): StyledRun[] {
  const parts: Array<{ text: string; bold: boolean; italic: boolean; color?: string }> = [];
  const push = (t: string, bold: boolean, italic: boolean, color?: string) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && last.bold === bold && last.italic === italic && last.color === color) last.text += t;
    else parts.push({ text: t, bold, italic, color });
  };
  const walk = (node: Node, bold: boolean, italic: boolean, color?: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      push((node.textContent ?? '').replace(NBSP_RE, ' ').replace(/\n+/g, ' '), bold, italic, color);
      return;
    }
    if (!(node instanceof HTMLElement) || node.tagName === 'BR') return;
    let b = bold, i = italic, c = color;
    if (node.tagName === 'B' || node.tagName === 'STRONG') b = true;
    if (node.tagName === 'I' || node.tagName === 'EM') i = true;
    const fw = node.style.fontWeight;
    if (fw) b = fw === 'bold' || fw === 'bolder' || parseInt(fw) >= 600;
    const fs = node.style.fontStyle;
    if (fs) i = fs === 'italic' || fs === 'oblique';
    if (node.dataset.b !== undefined) b = node.dataset.b === '1';
    if (node.dataset.i !== undefined) i = node.dataset.i === '1';
    if (node.dataset.c !== undefined) c = node.dataset.c || undefined;
    else if (node.style.color) c = cssColorToHex(node.style.color) ?? c;
    node.childNodes.forEach(child => walk(child, b, i, c));
  };
  walk(root, false, false, undefined);
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

/** Offset de un boundary point sobre el texto plano del root. Funciona con
 *  containers de TEXTO y de ELEMENTO (triple-click/select-all reportan
 *  (elemento, childIndex)) — Range.toString() resuelve ambos casos. */
function pointOffset(root: HTMLElement, container: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  try {
    r.setEnd(container, offset);
  } catch {
    return 0;
  }
  return r.toString().length;
}

/** Posición de la selección como offsets sobre el TEXTO PLANO del box.
 *  Clampea al root (un triple-click puede extender la selección afuera). */
export function flatOffsets(root: HTMLElement, range: Range): { start: number; end: number } {
  const total = (root.textContent ?? '').length;
  const start = root.contains(range.startContainer)
    ? pointOffset(root, range.startContainer, range.startOffset)
    : 0;
  const end = root.contains(range.endContainer)
    ? pointOffset(root, range.endContainer, range.endOffset)
    : total;
  return { start: Math.min(start, end, total), end: Math.min(end, total) };
}

export function restoreSelection(root: HTMLElement, start: number, end: number): void {
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

/** Aplica bold/italic a la SELECCIÓN actual del box (o a todo el contenido si
 *  no hay selección), vía el modelo: serializar → toggleStyleRange → re-seed
 *  del DOM canónico → restaurar la selección. El ÚNICO camino de estilo. */
export function applySelectionStyle(
  el: HTMLElement,
  seg: SegmentNode,
  edit: SegmentEdit | null,
  scale: number,
  key: 'bold' | 'italic',
): void {
  const sizeRatio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
  const runs = serializeStyled(el, seg, sizeRatio);
  const total = styledText(runs).length;
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const within = range && el.contains(range.commonAncestorContainer);
  let { start, end } = within ? flatOffsets(el, range) : { start: 0, end: total };
  if (end <= start) {
    // Sin selección (caret solo): el toggle aplica a todo el box.
    start = 0;
    end = total;
  }
  if (end <= start) return;
  const next = toggleStyleRange(runs, start, end, key);
  el.innerHTML = runsToHtml(seg, next, sizeRatio, scale);
  restoreSelection(el, start, end);
}

/** Color a la SELECCIÓN actual (o a todo el box si no hay selección), vía el
 *  modelo: setStyleRange + re-seed + restauración. null = quitar el override. */
export function applySelectionColor(
  el: HTMLElement,
  seg: SegmentNode,
  edit: SegmentEdit | null,
  scale: number,
  color: string | null,
): void {
  const sizeRatio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
  const runs = serializeStyled(el, seg, sizeRatio);
  const total = styledText(runs).length;
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const within = range && el.contains(range.commonAncestorContainer);
  let { start, end } = within ? flatOffsets(el, range) : { start: 0, end: total };
  if (end <= start) {
    start = 0;
    end = total;
  }
  if (end <= start) return;
  const next = setStyleRange(runs, start, end, { color });
  el.innerHTML = runsToHtml(seg, next, sizeRatio, scale);
  restoreSelection(el, start, end);
}

/** ¿Hay un box de segmento en edición con el foco? (para que el panel derive
 *  el estilo a la selección en vez de al modelo del segmento entero). */
export function activeEditingBox(): HTMLElement | null {
  const a = document.activeElement;
  return a instanceof HTMLElement && a.classList.contains('seg-text') && a.isContentEditable ? a : null;
}

/** Estilo de la selección actual dentro del box en edición (para encender los
 *  toggles del panel): con caret colapsado, el estilo del carácter ANTERIOR
 *  (la convención de todo editor de texto). null = sin selección en el box. */
export function selectionStyle(
  el: HTMLElement,
  seg: SegmentNode,
  edit: SegmentEdit | null,
): { bold: boolean; italic: boolean } | null {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (!range || !el.contains(range.commonAncestorContainer)) return null;
  const sizeRatio = (edit?.fontSize ?? seg.fontSize) / seg.fontSize;
  const runs = serializeStyled(el, seg, sizeRatio);
  let { start, end } = flatOffsets(el, range);
  if (end <= start) {
    start = Math.max(0, start - 1);
    end = start + 1;
  }
  let bold = true;
  let italic = true;
  let any = false;
  let pos = 0;
  for (const r of runs) {
    const from = pos;
    const to = pos + r.text.length;
    if (to > start && from < end) {
      any = true;
      bold = bold && r.bold;
      italic = italic && r.italic;
    }
    pos = to;
  }
  return any ? { bold, italic } : { bold: false, italic: false };
}

/** Nombre del evento con el que el panel le pide al box en edición aplicar
 *  estilo a la selección. */
export const SELECTION_STYLE_EVENT = 'aldus:selection-style';
