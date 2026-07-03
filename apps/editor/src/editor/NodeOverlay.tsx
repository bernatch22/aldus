/**
 * NodeOverlay — los nodos del grafo como boxes sobre el canvas.
 *
 * La unidad de edición es el SEGMENTO (modelo Acrobat/Foxit): runs contiguos
 * anclados a su x; los gaps de columna son FRONTERAS entre segmentos. El estilo
 * (bold/italic) vive POR TRAMO (StyledRun) y siempre viaja por el modelo — ver
 * styledDom.ts (proyección modelo↔DOM) y core/edits.ts (semántica).
 *
 * Interacción: click = seleccionar · seleccionado + arrastrar = mover ·
 *  doble click = editar in situ (Cmd/Ctrl+B/I = estilo a la selección) ·
 *  grip = escalar. El panel de propiedades aplica estilo a la selección vía
 *  el evento SELECTION_STYLE_EVENT cuando hay un box en edición.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from 'react';
import {
  applyTextDiff,
  cssPointToPdf,
  effectiveGeometry,
  effectiveImageRect,
  effectiveWidgetRect,
  mergeImageEdit,
  mergeSegmentEdit,
  mergeWidgetEdit,
  hasListMarker,
  isBareListMarker,
  LIST_GAP,
  nextListMarker,
  originalStyledRuns,
  setStyleRange,
  toggleListMarker,
  toggleStyleRange,
  pdfRectToCss,
  styledRunsEqual,
  styledText,
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
import { AlignLeft, AlignCenter, AlignRight, Bold, Italic, Underline, Highlighter, Link2, List, Trash2, SendToBack, BringToFront } from 'lucide-react';
import {
  activeEditingBox,
  bucketFallback,
  dominantRun,
  family,
  measureFontFor,
  measureWidth,
  round1,
  seedHtml,
  selectionStyle,
  SELECTION_STYLE_EVENT,
} from './styledDom';
import { stableFontFamily } from './fontRegistry';

// ── DEBUG temporal (pedido explícito): estado COMPLETO de estilos de un
//    segmento al agarrarlo, soltarlo y re-renderizarse editado. ──
export function dbgStyles(tag: string, seg: SegmentNode, edit: SegmentEdit | null, extra?: Record<string, unknown>): void {
  try {
    // TODO PLANO (una línea por run): el console colapsa objetos anidados.
    const lines = seg.runs.map(r => {
      const vivo = document.fonts.check(`12px '${r.font.loadedName}'`);
      const stable = r.font.postScriptName ? document.fonts.check(`12px '${stableFontFamily(r.font.postScriptName)}'`) : null;
      return `  run "${r.text.slice(0, 12)}" font=${r.font.loadedName}(${r.font.postScriptName ?? '?'}) emb=${r.font.embedded} ` +
        `b=${r.font.bold} i=${r.font.italic} size=${r.fontSize.toFixed(1)} color=${r.color ?? '-'} ` +
        `VIVO=${vivo} STABLE=${stable}`;
    });
    const e = edit
      ? `edit{x:${edit.x ?? '-'} y:${edit.baseline ?? '-'} size:${edit.fontSize ?? '-'} font:${edit.font ?? '-'} color:${edit.color ?? '-'} runs:${edit.runs ? edit.runs.map(r => `${r.text.slice(0, 8)}|b${+r.bold}i${+r.italic}c${r.color ?? '-'}`).join(',') : '-'}}`
      : 'edit:null';
    console.log(`[aldus:${tag}] ${seg.id} "${(edit?.text ?? seg.text).slice(0, 40)}" ${e} ${extra ? JSON.stringify(extra) : ''}\n${lines.join('\n')}`);
  } catch { /* solo debug */ }
}

export type EditAction = SegmentEdit | { segmentId: string; revert: true };
export type ImageEditAction = ImageEdit | { imageId: string; revert: true };
export type WidgetEditAction = WidgetEdit | { widgetId: string; revert: true };

/** Pedido de un ítem de LISTA nuevo (Enter al final de un ítem existente). */
export interface AddTextRequest {
  page: number;
  x: number;
  /** Baseline del ítem nuevo (una línea debajo del actual). */
  baseline: number;
  text: string;
  size: number;
  bucket: FontBucket;
}

interface Props {
  graph: PageGraph;
  scale: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  edits: Map<string, SegmentEdit>;
  onEdit: (action: EditAction) => void;
  imageEdits: Map<string, ImageEdit>;
  onImageEdit: (action: ImageEditAction) => void;
  widgetEdits: Map<string, WidgetEdit>;
  onWidgetEdit: (action: WidgetEditAction) => void;
  /** Nodos bloqueados: invisibles al mouse (ni hover ni drag). */
  locked: Set<string>;
  /** Modo colocación: el próximo click en la página crea un nodo. */
  placing: boolean;
  onPlace: (x: number, y: number) => void;
  /** Snapshot de la página renderizada (para previews de imágenes movidas). */
  snapshot: { url: string; width: number; height: number } | null;
  /** Operación de documento instantánea (highlight, addLink…). */
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  /** Abre el modal de link para un rect. */
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  /** Enter al final de un ítem de lista → crear el siguiente. */
  onAddText: (req: AddTextRequest) => void;
  /** Color del resaltador (persistido) + su setter. */
  highlightColor: string;
  onHighlightColor: (c: string) => void;
  /** Segmentos editados (extirpados del preview): se dibujan desde el cache. */
  phantomSegments: SegmentNode[];
  /** Arranque/fin del arrastre de un segmento. En el fin, `committed` dice si
      el drop produjo una edición (false = no-op → restaurar el canvas). */
  onDragging: (segId: string, active: boolean, committed?: boolean) => void;
  /** Ancho de ÁREA tipeable por segmento (pt) — el grip la amplía. */
  areaWidths: Map<string, number>;
  onAreaWidth: (segId: string, w: number | null) => void;
  /** Hay un editor de texto abierto (se usa para saltear el lift). */
  onEditingChange: (active: boolean) => void;
}

/** Botón chico de una toolbar flotante. */
function FbBtn({ label, onClick, active, danger, children }: { label: string; onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={label} aria-label={label}
      onMouseDown={e => e.preventDefault()}
      onClick={e => { e.stopPropagation(); onClick(); }}
      className={`fb-btn${active ? ' active' : ''}${danger ? ' danger' : ''}`}
    >{children}</button>
  );
}
const FbSep = () => <span className="fb-sep" />;

/** Contenedor de toolbar flotante posicionado sobre el rect. */
function FloatingWrap({ rect, children }: { rect: { left: number; top: number }; children: React.ReactNode }) {
  return (
    <div className="float-bar" style={{ left: rect.left, top: Math.max(2, rect.top - 36) }} onClick={e => e.stopPropagation()}>
      {children}
    </div>
  );
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
    color: edit?.color ?? dom.color ?? '#000',
  };
}

// Ningún drag puede dejar un nodo perdido fuera de la página: al soltar,
// siempre quedan al menos 24pt visibles.
const MIN_VISIBLE = 24;
const clampX = (x: number, w: number, pageW: number) => Math.min(Math.max(x, MIN_VISIBLE - w), pageW - MIN_VISIBLE);
const clampY = (y: number, h: number, pageH: number) => Math.min(Math.max(y, MIN_VISIBLE - h), pageH - MIN_VISIBLE);

/** Toolbar flotante arriba del segmento seleccionado: alineación (relativa a
 *  la página), B/I, resaltar (+color), link, eliminar. */
function FloatingBar({ seg, edit, rect, pageWidth, onPatch, onDocOp, onRequestLink, highlightColor, onHighlightColor }: {
  seg: SegmentNode;
  edit: SegmentEdit | null;
  rect: { left: number; top: number };
  pageWidth: number;
  onPatch: (patch: SegmentPatch) => void;
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  highlightColor: string;
  onHighlightColor: (c: string) => void;
}) {
  const styled: StyledRun[] = edit?.runs ?? originalStyledRuns(seg);
  // Con el editor abierto, B/I reflejan el estilo BAJO LA SELECCIÓN (no el del
  // segmento entero) y el toggle aplica solo a esa parte.
  const [selSty, setSelSty] = useState<{ bold: boolean; italic: boolean; underline?: boolean } | null>(null);
  useEffect(() => {
    const update = () => {
      const el = activeEditingBox();
      // El editor es un TEXTAREA: el estilo bajo el caret/selección se lee de
      // los runs VIVOS de la sesión + los offsets planos del textarea.
      if (el instanceof HTMLTextAreaElement && liveEditRuns) {
        setSelSty(styleAtRange(liveEditRuns, el.selectionStart, el.selectionEnd));
        return;
      }
      setSelSty(el ? selectionStyle(el, seg, edit) : null);
    };
    update();
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [seg, edit]);
  const allBold = selSty ? selSty.bold : styled.length > 0 && styled.every(r => r.bold);
  const allItalic = selSty ? selSty.italic : styled.length > 0 && styled.every(r => r.italic);
  const allUnderline = selSty ? !!selSty.underline : styled.length > 0 && styled.every(r => !!r.underline);
  const toggle = (key: 'bold' | 'italic' | 'underline') => {
    const el = activeEditingBox();
    if (el) {
      // dispatchEvent es SÍNCRONO: el layer ya mutó los runs — refrescar el
      // estado del botón al toque.
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key } }));
      if (el instanceof HTMLTextAreaElement && liveEditRuns) {
        setSelSty(styleAtRange(liveEditRuns, el.selectionStart, el.selectionEnd));
      }
      return;
    }
    const next = key === 'bold' ? !allBold : key === 'italic' ? !allItalic : !allUnderline;
    onPatch({ runs: styled.map(r => ({ ...r, [key]: next })) });
  };
  const eff = effectiveGeometry(seg, edit);
  const MARGIN = 40;
  const alignTo = (x: number) => onPatch({ x: Math.abs(x - seg.x) < 0.05 ? null : round1(x) });
  // El highlight lleva el segmentId: si después movés el texto, el resaltado
  // LO SIGUE (se resuelve contra la geometría efectiva al previsualizar/aplicar).
  const bbox = { page: seg.page, segmentId: seg.id, x: eff.x, y: eff.y, width: eff.width, height: eff.height };

  const dom = dominantRun(seg);
  const textColor = edit?.color ?? dom.color ?? '#000000';
  const effSize = edit?.fontSize ?? seg.fontSize;
  // Con el editor abierto, el color va a la SELECCIÓN (por tramo); si no, al
  // segmento entero (override clásico).
  const applyColor = (v: string) => {
    if (activeEditingBox()) {
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key: 'color', color: v } }));
      return;
    }
    onPatch({ color: v.toLowerCase() === (dom.color ?? '#000000').toLowerCase() ? null : v });
  };

  // Lista = un FORMATO más del texto: toggle del marcador "•  " al frente
  // (Enter en edición continúa la lista con el marcador incrementado).
  // Con el editor ABIERTO, el toggle va por evento al TextEditLayer (muta el
  // textarea en vivo — mismo principio que B/I/color). Cerrado: por el modelo.
  const [, bumpListTick] = useState(0);
  const liveBox = activeEditingBox();
  const liveText = liveBox instanceof HTMLTextAreaElement ? liveBox.value : liveBox?.textContent;
  const isList = hasListMarker(liveText ?? styledText(styled));
  const toggleList = () => {
    if (activeEditingBox()) {
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key: 'list' } }));
      bumpListTick(t => t + 1); // refresca el estado del botón
      return;
    }
    const next = toggleListMarker(styled);
    if (next !== styled) {
      // VIÑETA COLGANTE (Word/Acrobat): el CONTENIDO no se mueve — la viñeta
      // cuelga a la izquierda (x se corre el ancho del marcador) y el texto
      // queda alineado con el resto del documento.
      const before = styledText(styled);
      const after = styledText(next);
      const adding = after.length > before.length;
      const markerText = adding ? after.slice(0, after.length - before.length) : before.slice(0, before.length - after.length);
      const mw = measureWidth(markerText, `${seg.fontSize}px ${family(dominantRun(seg))}`);
      const nx = round1(Math.max(4, eff.x + (adding ? -mw : mw)));
      onPatch({ runs: next, text: after, x: nx === round1(seg.x) ? null : nx });
    }
  };

  return (
    <FloatingWrap rect={rect}>
      <FbBtn label="Negrita" onClick={() => toggle('bold')} active={allBold}><Bold size={14} /></FbBtn>
      <FbBtn label="Itálica" onClick={() => toggle('italic')} active={allItalic}><Italic size={14} /></FbBtn>
      <FbBtn label="Subrayado" onClick={() => toggle('underline')} active={allUnderline}><Underline size={14} /></FbBtn>
      <FbBtn label="Lista con viñeta (Enter en edición agrega el siguiente ítem)" onClick={toggleList} active={isList}><List size={14} /></FbBtn>
      <select
        className="fb-input"
        style={{ width: 76 }}
        title="Familia tipográfica"
        value={edit?.font ?? 'original'}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onChange={e => onPatch({ font: e.target.value === 'original' ? null : (e.target.value as FontBucket) })}
      >
        <option value="original">Original</option>
        <option value="sans">Sans</option>
        <option value="serif">Serif</option>
        <option value="mono">Mono</option>
      </select>
      <input
        className="fb-input"
        type="number"
        step={0.5}
        min={4}
        title="Tamaño (pt)"
        key={`${seg.id}-${round1(effSize)}`}
        defaultValue={round1(effSize)}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onBlur={e => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= 4) onPatch({ fontSize: round1(v) === round1(seg.fontSize) ? null : round1(v) });
        }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <button className="fb-swatch" title="Color del texto (a la selección si estás editando)" style={{ background: textColor }} onMouseDown={e => e.preventDefault()} onClick={e => e.stopPropagation()}>
        <input type="color" value={textColor} onChange={e => applyColor(e.target.value)} />
      </button>
      <FbSep />
      <FbBtn label="Alinear a la izquierda" onClick={() => alignTo(MARGIN)}><AlignLeft size={14} /></FbBtn>
      <FbBtn label="Centrar en la página" onClick={() => alignTo((pageWidth - eff.width) / 2)}><AlignCenter size={14} /></FbBtn>
      <FbBtn label="Alinear a la derecha" onClick={() => alignTo(pageWidth - MARGIN - eff.width)}><AlignRight size={14} /></FbBtn>
      <FbSep />
      <FbBtn label="Resaltar (acumula, se escribe con Aplicar)" onClick={() => onDocOp('highlight', { ...bbox, color: highlightColor })}><Highlighter size={14} /></FbBtn>
      <button className="fb-swatch" title="Color del resaltador" style={{ background: highlightColor }} onMouseDown={e => e.preventDefault()} onClick={e => e.stopPropagation()}>
        <input type="color" value={highlightColor} onChange={e => onHighlightColor(e.target.value)} />
      </button>
      <FbBtn label="Link" onClick={() => onRequestLink(bbox)}><Link2 size={14} /></FbBtn>
      <FbSep />
      <FbBtn label="Eliminar" onClick={() => onPatch({ remove: true })} danger><Trash2 size={14} /></FbBtn>
    </FloatingWrap>
  );
}

/** Toolbar flotante para IMAGEN o CAMPO: alineación + (imagen) orden Z + eliminar. */
function ObjectBar({ rect, pageWidth, width, onAlign, onZ, onDelete }: {
  rect: { left: number; top: number };
  pageWidth: number;
  width: number;
  onAlign: (x: number) => void;
  onZ?: (o: 'front' | 'back') => void;
  onDelete: () => void;
}) {
  const MARGIN = 40;
  return (
    <FloatingWrap rect={rect}>
      <FbBtn label="Alinear a la izquierda" onClick={() => onAlign(MARGIN)}><AlignLeft size={14} /></FbBtn>
      <FbBtn label="Centrar en la página" onClick={() => onAlign((pageWidth - width) / 2)}><AlignCenter size={14} /></FbBtn>
      <FbBtn label="Alinear a la derecha" onClick={() => onAlign(pageWidth - MARGIN - width)}><AlignRight size={14} /></FbBtn>
      {onZ && <>
        <FbSep />
        <FbBtn label="Enviar al fondo" onClick={() => onZ('back')}><SendToBack size={14} /></FbBtn>
        <FbBtn label="Traer al frente" onClick={() => onZ('front')}><BringToFront size={14} /></FbBtn>
      </>}
      <FbSep />
      <FbBtn label="Eliminar" onClick={onDelete} danger><Trash2 size={14} /></FbBtn>
    </FloatingWrap>
  );
}

// ── TextEditLayer: EL editor de texto (singleton, imperativo) ────────────────
// Patrón textarea de Excalidraw + "edit box manager" de pdf.js: UN solo
// <textarea> PLANO montado UNA vez en la raíz del overlay, abierto/cerrado
// imperativamente. Un textarea nativo no colapsa espacios, no crea spans
// fantasma y su caret es indestructible; los ESTILOS por tramo viven en el
// MODELO (StyledRun[] de la sesión, offsets planos de selectionStart/End) y
// se sincronizan por diff en cada input — nunca en el DOM.
interface EditSession {
  seg: SegmentNode;
  edit: SegmentEdit | null;
  scale: number;
  pageHeight: number;
  /** min-width extra (px CSS) — el área tipeable ampliada por el grip. */
  minWidthCss: number;
  onPatch: (patch: SegmentPatch) => void;
}

interface LiveSession extends EditSession {
  /** Los tramos estilados EN VIVO (se re-mapean por diff en cada input). */
  runs: StyledRun[];
  seedText: string;
  seedRuns: StyledRun[];
  /** Font shorthand para medir el ancho del textarea. */
  fontCss: string;
  minW: number;
  /** Fit de ancho al abrir (px): el texto plano mide MENOS que el segmento
   *  real (gaps entre runs, ajustes del PDF) y se veía "más chico". El delta
   *  va a los espacios (word-spacing) o se reparte por carácter. */
  ws: number;
  ls: number;
  /** Ancla x (pt) al abrir + corrimiento acumulado por viñeta colgante. */
  anchorX: number;
  xShiftPt: number;
  /** Alto de línea (px CSS): 1 línea = el del segmento; multilínea = 1.2×size
   *  (el MISMO leading que hornea el bake — WYSIWYG). */
  lineH1: number;
  lineHN: number;
}

// Los runs EN VIVO de la sesión abierta (para el estado activo de B/I en la
// barra — con textarea no hay DOM que caminar). null = sin editor abierto.
let liveEditRuns: StyledRun[] | null = null;

/** Estilo uniforme del rango [start,end) sobre los runs (caret colapsado →
 *  el carácter anterior, la convención de todo editor). */
function styleAtRange(runs: StyledRun[], start: number, end: number): { bold: boolean; italic: boolean; underline: boolean } | null {
  if (end <= start) { start = Math.max(0, start - 1); end = start + 1; }
  let pos = 0, any = false, bold = true, italic = true, underline = true;
  for (const r of runs) {
    const a = Math.max(start, pos);
    const b = Math.min(end, pos + r.text.length);
    if (b > a) { any = true; bold = bold && r.bold; italic = italic && r.italic; underline = underline && !!r.underline; }
    pos += r.text.length;
  }
  return any ? { bold, italic, underline } : null;
}

/** Renumera los bloques NUMERADOS contiguos ("1. 3. 3." → "1. 2. 3."): acá el
 *  número se HORNEA al PDF (no hay motor markdown que lo normalice). El primer
 *  ítem de cada bloque conserva su número inicial; el resto incrementa. */
function renumberLines(text: string): string {
  let n: number | null = null;
  return text.split('\n').map(l => {
    const m = /^(\s*)(\d{1,3})([.)])(\s+)/.exec(l);
    if (!m) { n = null; return l; }
    n = n == null ? parseInt(m[2], 10) : n + 1;
    return `${m[1]}${n}${m[3]}${m[4]}${l.slice(m[0].length)}`;
  }).join('\n');
}

/** Rango de la PALABRA bajo el caret (colapsado); sin palabra → todo. */
function wordRangeAt(text: string, pos: number): [number, number] {
  const isW = (c: string | undefined) => !!c && /\S/.test(c);
  let a = pos, b = pos;
  if (!isW(text[pos]) && isW(text[pos - 1])) { a = pos - 1; b = pos; }
  while (a > 0 && isW(text[a - 1])) a--;
  while (b < text.length && isW(text[b])) b++;
  return a === b ? [0, text.length] : [a, b];
}

export interface TextEditLayerHandle {
  open(s: EditSession): void;
  isOpen(): boolean;
}

/** Escape mínimo para el backdrop (white-space:pre conserva los espacios). */
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TextEditLayer = forwardRef<TextEditLayerHandle, { onClosed: () => void }>(function TextEditLayer({ onClosed }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Backdrop: un div DETRÁS del textarea (transparente) que dibuja los tramos
  // estilados — el textarea no puede mostrar bold/italic/color, así que el
  // backdrop es lo que se VE, con el caret del textarea encima. Bold via
  // text-shadow (faux) para no cambiar el ancho → el caret queda alineado.
  const backdropRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<LiveSession | null>(null);

  const renderBackdrop = useCallback(() => {
    const s = sessionRef.current;
    const bd = backdropRef.current;
    if (!s || !bd) return;
    liveEditRuns = s.runs;
    bd.innerHTML = s.runs.map(r => {
      const st: string[] = [];
      if (r.bold) st.push('text-shadow:0.02em 0 0 currentColor,-0.02em 0 0 currentColor');
      if (r.italic) st.push('font-style:italic');
      if (r.underline) st.push('text-decoration:underline');
      if (r.color) st.push(`color:${r.color}`);
      return `<span${st.length ? ` style="${st.join(';')}"` : ''}>${escHtml(r.text)}</span>`;
    }).join('') || '&#8203;';
  }, []);

  const close = useCallback(() => {
    if (hostRef.current) hostRef.current.style.display = 'none';
    sessionRef.current = null;
    liveEditRuns = null;
    onClosed();
  }, [onClosed]);

  // Ancho al contenido (medido con la fuente real + el fit) — textarea y
  // backdrop comparten el mismo ancho para que el caret alinee con lo dibujado.
  const fit = useCallback(() => {
    const s = sessionRef.current;
    const ta = taRef.current;
    if (!s || !ta) return;
    // MULTILÍNEA: ancho = la línea más larga; alto = n líneas × line-height
    // (1 línea usa el alto real del segmento; 2+ usan el leading del bake).
    const lines = ta.value.split('\n');
    let maxW = 0;
    for (const line of lines) {
      const spaces = (line.match(/ /g) ?? []).length;
      maxW = Math.max(maxW, measureWidth(line, s.fontCss) + spaces * s.ws + line.length * s.ls);
    }
    const width = `${Math.max(s.minW, Math.ceil(maxW) + 8)}px`;
    const lineH = lines.length > 1 ? s.lineHN : s.lineH1;
    const height = `${Math.ceil(lines.length * lineH)}px`;
    for (const el of [ta, backdropRef.current, hostRef.current]) {
      if (!el) continue;
      // El HOST también: sus hijos son absolute (sin esto su fondo blanco no
      // cubre nada — "el grafo impreso muchas veces").
      el.style.width = width;
      el.style.height = height;
      if (el !== hostRef.current) el.style.lineHeight = `${lineH}px`;
    }
  }, []);

  // Un cambio de contenido o estilo: re-dibujar el backdrop + re-ajustar ancho.
  const refresh = useCallback(() => { renderBackdrop(); fit(); }, [renderBackdrop, fit]);

  const commit = useCallback(() => {
    const s = sessionRef.current;
    const ta = taRef.current;
    if (!s || !ta) return;
    const text = ta.value.replace(/\s+$/, '');
    let runs = applyTextDiff(s.runs, text);
    // dx REAL de cada tramo, POR LÍNEA (el bake posiciona con newX + dx: tras
    // un '\n' el acumulado arranca de cero). Medido con la fuente del estilo.
    const ratio = (s.edit?.fontSize ?? s.seg.fontSize) / s.seg.fontSize;
    let acc = 0;
    runs = runs.map(r => {
      const w = (t: string) => measureWidth(t, measureFontFor(s.seg, r, ratio));
      const nl = r.text.lastIndexOf('\n');
      const own = nl >= 0 ? w(r.text.slice(nl + 1)) : w(r.text);
      const piece = { ...r, dx: round1(acc), w: round1(own) };
      acc = nl >= 0 ? own : acc + own;
      return piece;
    });
    // Viñeta colgante aplicada EN VIVO: consolidar el corrimiento de x.
    const nx = round1(Math.max(4, s.anchorX + s.xShiftPt));
    s.onPatch({
      text,
      runs: styledRunsEqual(runs, originalStyledRuns(s.seg)) ? null : runs,
      ...(s.xShiftPt !== 0 ? { x: nx === round1(s.seg.x) ? null : nx } : {}),
    });
  }, []);

  useImperativeHandle(ref, () => ({
    open(s: EditSession) {
      const host = hostRef.current;
      const ta = taRef.current;
      if (!host || !ta) return;
      const seedRuns = s.edit?.runs ?? originalStyledRuns(s.seg);
      const seedText = styledText(seedRuns);
      // Ítem de lista pelado: sembrar el GAP (espacios REALES — el textarea no
      // los colapsa). Con tipeo detrás quedan interiores y se hornean; sin
      // tipeo, el commit los recorta = noop.
      const value = isBareListMarker(seedText) ? `${seedText.replace(/\s+$/, '')}${LIST_GAP}` : seedText;
      const eff = effectiveGeometry(s.seg, s.edit);
      const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, s.pageHeight, s.scale);
      const style = containerStyle(s.seg, s.edit, s.scale);
      const live: LiveSession = {
        ...s,
        seedText,
        seedRuns,
        runs: seedRuns,
        fontCss: `${style.fontStyle === 'italic' ? 'italic ' : ''}${style.fontWeight === 700 ? '700 ' : ''}${style.fontSize} ${style.fontFamily}`,
        minW: Math.max(rect.width, s.minWidthCss),
        ws: 0,
        ls: 0,
        anchorX: eff.x,
        xShiftPt: 0,
        lineH1: rect.height,
        lineHN: (s.edit?.fontSize ?? s.seg.fontSize) * 1.2 * s.scale,
      };
      // FIT de ancho: solo con el texto ORIGINAL intacto (con texto editado el
      // ancho efectivo ya no describe el contenido). El delta target−medido va
      // a los espacios (los gaps reales del PDF están ahí) o por carácter.
      if (seedText === s.seg.text) {
        const measured = measureWidth(value, live.fontCss);
        const spaces = (value.match(/ /g) ?? []).length;
        const delta = rect.width - measured;
        if (measured > 0 && Math.abs(delta) > 0.5 && value.length > 1) {
          if (delta > 0 && spaces > 0) live.ws = delta / spaces;
          else {
            const ls = delta / value.length;
            const sizePx = parseFloat(style.fontSize as string) || 12;
            if (Math.abs(ls) <= sizePx * 0.4) live.ls = ls;
          }
        }
      }
      sessionRef.current = live;
      host.style.display = 'block';
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.height = `${rect.height}px`;
      const bd = backdropRef.current;
      // Mismas métricas en textarea Y backdrop (font/size/spacing/altura).
      for (const el of [ta, bd]) {
        if (!el) continue;
        Object.assign(el.style, style);
        el.style.height = `${rect.height}px`;
        el.style.lineHeight = `${rect.height}px`;
        el.style.wordSpacing = live.ws ? `${live.ws.toFixed(2)}px` : '';
        el.style.letterSpacing = live.ls ? `${live.ls.toFixed(3)}px` : '';
      }
      // El texto del textarea es TRANSPARENTE (lo pinta el backdrop); solo el
      // caret queda visible, con el color real del segmento.
      ta.style.color = 'transparent';
      ta.style.caretColor = (style.color as string) ?? '#000';
      ta.value = value;
      live.runs = applyTextDiff(seedRuns, value);
      renderBackdrop();
      fit();
      ta.focus();
      ta.setSelectionRange(value.length, value.length);
      console.log('[aldus:edit-open]', s.seg.id, 'layer(textarea):', JSON.stringify(value.slice(0, 30)), 'focus:', document.activeElement === ta);
    },
    isOpen: () => sessionRef.current != null,
  }), [fit, renderBackdrop]);

  // Listeners nativos, atados UNA sola vez (nunca se re-atan).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const syncRuns = () => {
      const s = sessionRef.current;
      if (!s) return;
      s.runs = applyTextDiff(s.runs, ta.value);
      refresh();
    };
    const onBlur = () => {
      const s = sessionRef.current;
      if (!s) return;
      console.log('[aldus:blur] layer comitea y cierra', s.seg.id);
      commit();
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const s = sessionRef.current;
      if (!s) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // ENTER = BREAKLINE dentro del MISMO grafo (el PDF soporta bloques
        // multilínea; el bake emite cada línea con su leading). En una lista,
        // el marcador continúa incrementado en la línea nueva. Enter en un
        // ítem vacío (solo el marcador) = terminar la lista, como Word.
        const pos = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
        const curLine = ta.value.slice(lineStart, pos);
        if (isBareListMarker(curLine) && curLine.trim() !== '') {
          // ítem vacío: quitar el marcador huérfano y cerrar (commit + close).
          ta.setRangeText('', lineStart, pos, 'start');
          syncRuns();
          ta.blur();
          return;
        }
        const marker = nextListMarker(curLine);
        const insert = `\n${marker ?? ''}`;
        ta.setRangeText(insert, pos, ta.selectionEnd, 'end');
        // Lista numerada: renumerar el bloque (los ítems de abajo del insert
        // quedarían duplicados — el número acá se hornea, no es markdown).
        if (marker && /\d/.test(marker)) {
          const caret = ta.selectionStart;
          ta.value = renumberLines(ta.value);
          ta.setSelectionRange(caret, caret);
        }
        syncRuns();
        return;
      }
      if (e.key === 'Escape') {
        // Descartar lo de ESTA sesión: volver al seed y cerrar (commit noop).
        ta.value = s.seedText;
        s.runs = s.seedRuns;
        ta.blur();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'i' || e.key === 'u')) {
        e.preventDefault();
        const { selectionStart, selectionEnd } = ta;
        const [from, to] = selectionStart === selectionEnd
          ? wordRangeAt(ta.value, selectionStart)
          : [selectionStart, selectionEnd];
        s.runs = toggleStyleRange(s.runs, from, to, e.key === 'b' ? 'bold' : e.key === 'i' ? 'italic' : 'underline');
        refresh();
      }
    };
    const onStyle = (ev: Event) => {
      const s = sessionRef.current;
      if (!s) return;
      const detail = (ev as CustomEvent<{ key?: 'bold' | 'italic' | 'underline' | 'color' | 'list'; color?: string }>).detail;
      const selectionStart = ta.selectionStart;
      const selectionEnd = ta.selectionEnd;
      // Caret colapsado: aplicar a la PALABRA bajo el caret (consistente con
      // el estado que muestra el botón); sin palabra → segmento entero.
      const [from, to] = selectionStart === selectionEnd
        ? wordRangeAt(ta.value, selectionStart)
        : [selectionStart, selectionEnd];
      if (detail?.key === 'bold' || detail?.key === 'italic' || detail?.key === 'underline') {
        s.runs = toggleStyleRange(s.runs, from, to, detail.key);
        refresh();
      } else if (detail?.key === 'color' && detail.color) {
        s.runs = setStyleRange(s.runs, from, to, { color: detail.color });
        refresh();
      } else if (detail?.key === 'list') {
        // Toggle de viñeta POR LÍNEA (patrón de los editores markdown): si
        // TODAS las líneas con contenido ya tienen marcador → se quita de
        // todas; si no → se agrega a las que falte. La viñeta es COLGANTE:
        // el marcador de la 1.ª línea corre el ancla x del grafo (el
        // contenido no se mueve; se consolida en x al commit).
        const host = hostRef.current;
        const before = ta.selectionStart;
        const marker = `${String.fromCharCode(0x2022)}${LIST_GAP}`;
        const stripRe = /^(\s*)(?:[•·▪‣*-]|\d{1,3}[.)]|[a-zA-Z][.)])(\s*)/;
        // SOLO las líneas alcanzadas por la SELECCIÓN (expandida a límites de
        // línea) — no todo el nodo. Sin selección: la línea del caret.
        const selA = ta.selectionStart;
        const selB = ta.selectionEnd;
        const blockStart = ta.value.lastIndexOf('\n', selA - 1) + 1;
        let blockEnd = ta.value.indexOf('\n', selB);
        if (blockEnd < 0) blockEnd = ta.value.length;
        const head = ta.value.slice(0, blockStart);
        const tail = ta.value.slice(blockEnd);
        const lines = ta.value.slice(blockStart, blockEnd).split('\n');
        const content = (l: string) => l.trim() !== '';
        const removing = lines.filter(content).length > 0 && lines.filter(content).every(l => hasListMarker(l));
        const firstHad = hasListMarker(ta.value.split('\n')[0] ?? '');
        const out = lines.map(l => {
          if (removing) return l.replace(stripRe, '');
          return !content(l) || hasListMarker(l) ? l : marker + l;
        });
        ta.value = head + out.join('\n') + tail;
        // caret: best-effort, corrido por el delta del marcador.
        const delta = removing ? -marker.length : marker.length;
        const pos = Math.max(0, Math.min(ta.value.length, before + delta));
        ta.setSelectionRange(pos, pos);
        // ancla colgante según la 1.ª línea del NODO.
        const firstHas = hasListMarker(ta.value.split('\n')[0] ?? '');
        if (firstHad !== firstHas) {
          const mw = measureWidth(marker, s.fontCss) + (marker.match(/ /g) ?? []).length * s.ws + marker.length * s.ls;
          const dir = firstHas ? -1 : 1;
          s.xShiftPt += (dir * mw) / s.scale;
          if (host) host.style.left = `${parseFloat(host.style.left) + dir * mw}px`;
        }
        syncRuns();
      }
    };
    ta.addEventListener('blur', onBlur);
    ta.addEventListener('keydown', onKeyDown);
    ta.addEventListener('input', syncRuns);
    window.addEventListener(SELECTION_STYLE_EVENT, onStyle);
    return () => {
      ta.removeEventListener('blur', onBlur);
      ta.removeEventListener('keydown', onKeyDown);
      ta.removeEventListener('input', syncRuns);
      window.removeEventListener(SELECTION_STYLE_EVENT, onStyle);
    };
  }, [commit, close, fit, refresh]);

  return (
    // stopPropagation: un click DENTRO del editor no puede burbujear al
    // overlay (su click de fondo deselecciona y hasta forzaba el blur).
    <div
      ref={hostRef}
      className="seg-box editing masked"
      style={{ display: 'none', position: 'absolute', zIndex: 40 }}
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      {/* Backdrop (lo que se VE: tramos estilados) + textarea transparente
          encima (caret + input). Mismas métricas → alineados. */}
      <div ref={backdropRef} className="seg-text seg-backdrop" aria-hidden />
      <textarea
        ref={taRef}
        className="seg-text seg-textarea"
        rows={1}
        wrap="off"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  );
});

export function NodeOverlay({ graph, scale, selectedId, onSelect, edits, onEdit, imageEdits, onImageEdit, widgetEdits, onWidgetEdit, locked, placing, onPlace, snapshot, onDocOp, onRequestLink, onAddText, highlightColor, onHighlightColor, phantomSegments, onDragging, areaWidths, onAreaWidth, onEditingChange }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => { onEditingChange(editingId != null); }, [editingId, onEditingChange]);
  // Cambio de página con editor abierto: cerrarlo (con commit) via blur.
  useEffect(() => { activeEditingBox()?.blur(); }, [graph.page]);

  // EL editor (singleton, imperativo). Los boxes solo piden abrirlo.
  const layerRef = useRef<TextEditLayerHandle>(null);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const onLayerClosed = useCallback(() => setEditingId(null), []);
  const openSegEditor = (seg: SegmentNode) => {
    const edit = editsRef.current.get(seg.id) ?? null;
    setEditingId(seg.id);
    layerRef.current?.open({
      seg,
      edit,
      scale,
      pageHeight: graph.height,
      minWidthCss: (areaWidths.get(seg.id) ?? 0) * scale,
      onPatch: patch => {
        const merged = mergeSegmentEdit(seg, editsRef.current.get(seg.id) ?? null, patch);
        onEdit(merged ?? { segmentId: seg.id, revert: true });
      },
    });
  };

  // Cuando una FontFace termina de cargar (las estables del fontRegistry son
  // async), re-render: los fantasmas re-siembran su HTML midiendo con la
  // fuente REAL — sin esto quedaban medidos/renderizados con el fallback.
  const [, setFontsTick] = useState(0);
  useEffect(() => {
    const bump = () => setFontsTick(t => t + 1);
    document.fonts.addEventListener('loadingdone', bump);
    return () => document.fonts.removeEventListener('loadingdone', bump);
  }, []);

  // Segmentos a dibujar: los del grafo del preview + los FANTASMAS editados
  // (extirpados del preview). Dedupe defensivo por id.
  const inGraph = new Set(graph.segments.map(s => s.id));
  const allSegments = [...graph.segments, ...phantomSegments.filter(s => !inGraph.has(s.id))];

  // Seleccionar OTRO nodo cierra (con commit) el editor de texto abierto — el
  // preventDefault de los pointerdown impide el blur natural, así que lo
  // forzamos acá. Sin esto, la B de la toolbar le pegaba al editor viejo.
  const selectNode = (nodeId: string | null) => {
    if (editingId && editingId !== nodeId) {
      console.log('[aldus:forceblur] cierro editor de', editingId, 'por selección de', nodeId ?? '(nada)');
      activeEditingBox()?.blur();
    }
    onSelect(nodeId);
  };

  return (
    <div
      className={`node-overlay${placing ? ' placing' : ''}`}
      onClick={e => {
        if (placing) {
          const r = e.currentTarget.getBoundingClientRect();
          const p = cssPointToPdf(e.clientX - r.left, e.clientY - r.top, graph.height, scale);
          onPlace(p.x, p.y);
          return;
        }
        selectNode(null);
      }}
    >
      {graph.images.map(img => (
        <ImageBox
          key={img.id}
          img={img}
          pageWidth={graph.width}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === img.id}
          edit={imageEdits.get(img.id) ?? null}
          isLocked={locked.has(img.id)}
          snapshot={snapshot}
          onSelect={() => selectNode(img.id)}
          onPatch={patch => {
            const merged = mergeImageEdit(img, imageEdits.get(img.id) ?? null, patch);
            onImageEdit(merged ?? { imageId: img.id, revert: true });
          }}
        />
      ))}
      {allSegments.map(seg => (
        <SegmentBox
          key={seg.id}
          seg={seg}
          pageWidth={graph.width}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === seg.id}
          editing={editingId === seg.id}
          edit={edits.get(seg.id) ?? null}
          isLocked={locked.has(seg.id)}
          onDragging={(active, committed) => onDragging(seg.id, active, committed)}
          areaWidth={areaWidths.get(seg.id) ?? null}
          onAreaWidth={w => onAreaWidth(seg.id, w)}
          onSelect={() => selectNode(seg.id)}
          onStartEdit={() => { selectNode(seg.id); openSegEditor(seg); }}
          onPatch={patch => {
            const merged = mergeSegmentEdit(seg, edits.get(seg.id) ?? null, patch);
            onEdit(merged ?? { segmentId: seg.id, revert: true });
          }}
          onDocOp={onDocOp}
          onRequestLink={onRequestLink}
          onAddText={onAddText}
          highlightColor={highlightColor}
          onHighlightColor={onHighlightColor}
        />
      ))}
      {/* Los widgets al FINAL del DOM = arriba de todo para el mouse (como en
          el PDF: las anotaciones se dibujan sobre el contenido). Una imagen
          full-page nunca puede taparles los clicks. */}
      {graph.widgets.map(w => (
        <WidgetBox
          key={w.id}
          widget={w}
          pageWidth={graph.width}
          pageHeight={graph.height}
          scale={scale}
          selected={selectedId === w.id}
          edit={widgetEdits.get(w.id) ?? null}
          isLocked={locked.has(w.id)}
          snapshot={snapshot}
          onSelect={() => selectNode(w.id)}
          onPatch={patch => {
            const merged = mergeWidgetEdit(w, widgetEdits.get(w.id) ?? null, patch);
            onWidgetEdit(merged ?? { widgetId: w.id, revert: true });
          }}
        />
      ))}
      {/* EL editor de texto: singleton imperativo, SIEMPRE montado — inmune al
          churn de grafos/previews (ver TextEditLayer arriba). */}
      <TextEditLayer ref={layerRef} onClosed={onLayerClosed} />
    </div>
  );
}

interface WidgetBoxProps {
  widget: WidgetNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  edit: WidgetEdit | null;
  isLocked: boolean;
  snapshot: { url: string; width: number; height: number } | null;
  onSelect: () => void;
  onPatch: (patch: WidgetPatch) => void;
}

const WIDGET_LABEL: Record<WidgetNode['widgetType'], string> = {
  text: 'texto', checkbox: 'checkbox', radio: 'radio', select: 'select',
  list: 'lista', button: 'botón', signature: 'firma',
};

/** Un campo de formulario: seleccionar, arrastrar (mover), grip (escalar).
 *  La edición se aplica al instante (reescritura del /Rect de la anotación). */
function WidgetBox({ widget, pageWidth, pageHeight, scale, selected, edit, isLocked, snapshot, onSelect, onPatch }: WidgetBoxProps) {
  const eff = effectiveWidgetRect(widget, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const orig = pdfRectToCss({ x: widget.x, y: widget.y, width: widget.width, height: widget.height }, pageHeight, scale);
  const dragStart = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const gripStart = useRef<{ px: number; py: number } | null>(null);
  const [gripDelta, setGripDelta] = useState<{ dx: number; dy: number } | null>(null);

  // Eliminado: el preview local ya lo removió del render — nada que dibujar
  // (Ctrl+Z lo trae de vuelta).
  if (eff.removed) return null;

  // SOLO durante el gesto de drag: el box viaja con los píxeles reales y el
  // origen se enmascara. Al soltar, el preview local re-renderiza el widget
  // realmente movido — sin cajas blancas remanentes.
  const showPixels = drag != null;
  const pixels = showPixels && snapshot && orig.width > 0 && orig.height > 0
    ? {
        backgroundImage: `url(${snapshot.url})`,
        backgroundSize: `${(snapshot.width * rect.width) / orig.width}px ${(snapshot.height * rect.height) / orig.height}px`,
        backgroundPosition: `${(-orig.left * rect.width) / orig.width}px ${(-orig.top * rect.height) / orig.height}px`,
      }
    : undefined;
  return (
    <>
      {showPixels && (
        <div className="seg-mask" style={{ left: orig.left, top: orig.top, width: orig.width, height: orig.height }} />
      )}
      {selected && !isLocked && (
        <ObjectBar
          rect={rect} pageWidth={pageWidth} width={eff.width}
          onAlign={x => onPatch({ x: round1(clampX(x, eff.width, pageWidth)) })}
          onDelete={() => onPatch({ remove: true })}
        />
      )}
    <div
      className={`widget-box${selected ? ' selected' : ''}${edit ? ' edited' : ''}${isLocked ? ' locked' : ''}`}
      style={{
        left: rect.left,
        top: rect.top,
        width: gripDelta ? rect.width + gripDelta.dx : rect.width,
        height: gripDelta ? rect.height + gripDelta.dy : rect.height,
        transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
        ...pixels,
      }}
      title={`Campo ${WIDGET_LABEL[widget.widgetType]} · ${widget.fieldName}`}
      onClick={e => { e.stopPropagation(); onSelect(); }}
      onPointerDown={e => {
        if (e.button !== 0) return;
        if (!selected) onSelect();
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
        const nx = round1(clampX(eff.x + (e.clientX - start.px) / scale, eff.width, pageWidth));
        const ny = round1(clampY(eff.y - (e.clientY - start.py) / scale, eff.height, pageHeight));
        onPatch({
          x: nx === round1(widget.x) ? null : nx,
          y: ny === round1(widget.y) ? null : ny,
        });
      }}
    >
      {selected && <span className="widget-label">{WIDGET_LABEL[widget.widgetType]} · {widget.fieldName}</span>}
      {!isLocked && (
        <div
          className="seg-grip"
          title="Arrastrar para redimensionar el campo"
          onPointerDown={e => {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            gripStart.current = { px: e.clientX, py: e.clientY };
          }}
          onPointerMove={e => {
            if (!gripStart.current) return;
            e.stopPropagation();
            setGripDelta({ dx: e.clientX - gripStart.current.px, dy: e.clientY - gripStart.current.py });
          }}
          onPointerUp={e => {
            e.stopPropagation();
            const start = gripStart.current;
            gripStart.current = null;
            setGripDelta(null);
            if (!start) return;
            const newW = Math.max(6, round1(eff.width + (e.clientX - start.px) / scale));
            const newH = Math.max(6, round1(eff.height + (e.clientY - start.py) / scale));
            const top = eff.y + eff.height;
            const newY = round1(top - newH);
            onPatch({
              width: newW === round1(widget.width) ? null : newW,
              height: newH === round1(widget.height) ? null : newH,
              y: newY === round1(widget.y) ? null : newY,
            });
          }}
          onClick={e => e.stopPropagation()}
        />
      )}
    </div>
    </>
  );
}

interface ImageBoxProps {
  img: ImageNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  edit: ImageEdit | null;
  isLocked: boolean;
  snapshot: { url: string; width: number; height: number } | null;
  onSelect: () => void;
  onPatch: (patch: ImagePatch) => void;
}

/** Una imagen del grafo: seleccionar, arrastrar (mover), grip (escalar),
 *  eliminar (desde el panel). Preview de mover/escalar: el box del destino
 *  muestra los PÍXELES reales (crop del snapshot de la página); el original
 *  queda visible hasta Aplicar (ahí se muda de verdad). Eliminada: velo rojo
 *  translúcido — nunca una máscara opaca que taparía el texto de arriba. */
function ImageBox({ img, pageWidth, pageHeight, scale, selected, edit, isLocked, snapshot, onSelect, onPatch }: ImageBoxProps) {
  const eff = effectiveImageRect(img, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const orig = pdfRectToCss({ x: img.x, y: img.y, width: img.width, height: img.height }, pageHeight, scale);
  const dragStart = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const gripStart = useRef<{ px: number; py: number } | null>(null);
  const [gripDelta, setGripDelta] = useState<{ dx: number; dy: number } | null>(null);

  // Eliminada: el preview local ya la quitó del render (Ctrl+Z la restaura).
  if (eff.removed) return null;

  // SOLO durante el drag: píxeles reales viajando + máscara del origen. Una
  // imagen casi full-page NO puede enmascararse (taparía el texto) → ahí el
  // ghost es solo un marco punteado (sin píxeles = sin duplicado); al soltar,
  // el preview local renderiza la verdad.
  const ghost = drag != null;
  const coverage = (img.width * img.height) / (pageWidth * pageHeight);
  const canMask = coverage < 0.8;
  const ghostPixels = ghost && canMask && snapshot && orig.width > 0 && orig.height > 0
    ? {
        backgroundImage: `url(${snapshot.url})`,
        backgroundSize: `${(snapshot.width * rect.width) / orig.width}px ${(snapshot.height * rect.height) / orig.height}px`,
        backgroundPosition: `${(-orig.left * rect.width) / orig.width}px ${(-orig.top * rect.height) / orig.height}px`,
      }
    : undefined;
  const maskOriginal = ghost && canMask;
  return (
    <>
      {maskOriginal && (
        <div className="seg-mask" style={{ left: orig.left, top: orig.top, width: orig.width, height: orig.height }} />
      )}
      {selected && !isLocked && (
        <ObjectBar
          rect={rect} pageWidth={pageWidth} width={eff.width}
          onAlign={x => onPatch({ x: round1(clampX(x, eff.width, pageWidth)) })}
          onZ={o => onPatch({ zOrder: o })}
          onDelete={() => onPatch({ remove: true })}
        />
      )}
      <div
        className={`img-box${selected ? ' selected' : ''}${edit ? ' edited' : ''}${ghost ? ' ghost' : ''}${isLocked ? ' locked' : ''}`}
        style={{
          left: rect.left,
          top: rect.top,
          width: gripDelta ? rect.width + gripDelta.dx : rect.width,
          height: gripDelta ? rect.height + gripDelta.dy : rect.height,
          transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
          ...ghostPixels,
        }}
        title={`Imagen · ${Math.round(eff.width)}×${Math.round(eff.height)} pt`}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        onPointerDown={e => {
          if (e.button !== 0) return;
          if (!selected) onSelect();
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
          const nx = round1(clampX(eff.x + (e.clientX - start.px) / scale, eff.width, pageWidth));
          const ny = round1(clampY(eff.y - (e.clientY - start.py) / scale, eff.height, pageHeight));
          onPatch({
            x: nx === round1(img.x) ? null : nx,
            y: ny === round1(img.y) ? null : ny,
          });
        }}
      >
        {!isLocked && (
          <div
            className="seg-grip"
            title="Arrastrar para escalar la imagen"
            onPointerDown={e => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              gripStart.current = { px: e.clientX, py: e.clientY };
            }}
            onPointerMove={e => {
              if (!gripStart.current) return;
              e.stopPropagation();
              setGripDelta({ dx: e.clientX - gripStart.current.px, dy: e.clientY - gripStart.current.py });
            }}
            onPointerUp={e => {
              e.stopPropagation();
              const start = gripStart.current;
              gripStart.current = null;
              setGripDelta(null);
              if (!start) return;
              const newW = Math.max(4, round1(eff.width + (e.clientX - start.px) / scale));
              const newH = Math.max(4, round1(eff.height + (e.clientY - start.py) / scale));
              // El grip SE agranda hacia abajo: el TOP queda fijo (y' = top − h').
              const top = eff.y + eff.height;
              const newY = round1(top - newH);
              onPatch({
                width: newW === round1(img.width) ? null : newW,
                height: newH === round1(img.height) ? null : newH,
                y: newY === round1(img.y) ? null : newY,
              });
            }}
            onClick={e => e.stopPropagation()}
          />
        )}
      </div>
    </>
  );
}

interface SegmentBoxProps {
  seg: SegmentNode;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  selected: boolean;
  editing: boolean;
  edit: SegmentEdit | null;
  isLocked: boolean;
  onDragging: (active: boolean, committed?: boolean) => void;
  /** Ancho de área tipeable (pt) fijado por el grip, o null (= ancho natural). */
  areaWidth: number | null;
  onAreaWidth: (w: number | null) => void;
  onSelect: () => void;
  onStartEdit: () => void;
  onPatch: (patch: SegmentPatch) => void;
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  onAddText: (req: AddTextRequest) => void;
  highlightColor: string;
  onHighlightColor: (c: string) => void;
}

function SegmentBox({ seg, pageWidth, pageHeight, scale, selected, editing, edit, isLocked, onDragging, areaWidth, onAreaWidth, onSelect, onStartEdit, onPatch, onDocOp, onRequestLink, onAddText, highlightColor, onHighlightColor }: SegmentBoxProps) {
  const eff = effectiveGeometry(seg, edit);
  const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, pageHeight, scale);
  const dragStart = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const gripStart = useRef<number | null>(null);
  // Ancho de área en vivo mientras se arrastra el grip (px CSS).
  const [gripW, setGripW] = useState<number | null>(null);

  // La EDICIÓN vive en el TextEditLayer (singleton imperativo, arriba) — este
  // box solo la solicita (onStartEdit) y se cubre con el layer mientras dura.

  // DEBUG temporal: cada vez que un segmento EDITADO se re-renderiza (cambia
  // el edit o llega el seg fantasma del grafo nuevo), volcar sus estilos.
  useEffect(() => {
    if (edit) dbgStyles('render-edited', seg, edit, { editing, drag: drag != null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, seg]);

  // Sin velos ni masks: la extirpación del original arranca CON el gesto
  // (onDragging) — para cuando el usuario suelta, el canvas ya no tiene los
  // glifos viejos. El único transitorio es el original desvaneciéndose una
  // fracción de segundo al arrancar el drag (el bake local aterrizando).

  // Segmento eliminado: el preview local lo extirpa — nada que dibujar
  // (Ctrl+Z lo restaura).
  if (edit?.remove) return null;

  // Un segmento con edición pendiente fue EXTIRPADO del preview: este box
  // fantasma dibuja el estado nuevo (transparente — flota sobre lo que haya).
  // Mientras el TextEditLayer está abierto sobre él, su fondo blanco lo cubre.
  const masked = editing || edit != null || drag != null;
  const html = seedHtml(seg, edit, scale);
  // MULTILÍNEA (breaklines): la caja debe cubrir TODAS las líneas — si no, el
  // click/mask solo tomaba la primera. Alto = n × leading (1.2×size, el mismo
  // del bake); una sola línea usa el alto natural del segmento.
  const nLines = (edit?.text ?? seg.text).split('\n').length;
  const lineHpx = eff.fontSize * 1.2 * scale;
  const boxHeight = nLines > 1 ? nLines * lineHpx : rect.height;
  const boxLineH = nLines > 1 ? lineHpx : rect.height;

  return (
    <>
      {selected && !isLocked && (
        <FloatingBar seg={seg} edit={edit} rect={rect} pageWidth={pageWidth} onPatch={onPatch} onDocOp={onDocOp} onRequestLink={onRequestLink} highlightColor={highlightColor} onHighlightColor={onHighlightColor} />
      )}
      <div
        className={`seg-box${selected ? ' selected' : ''}${masked ? ' masked' : ''}${edit ? ' edited' : ''}${editing ? ' editing' : ''}${isLocked ? ' locked' : ''}`}
        style={{
          left: rect.left,
          top: rect.top,
          // El ÁREA tipeable: el grip la amplía más allá del ancho natural del
          // texto (espacio para escribir en la línea sin que "salte").
          minWidth: gripW ?? Math.max(rect.width, areaWidth != null ? areaWidth * scale : 0),
          height: boxHeight,
          lineHeight: `${boxLineH}px`,
          transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
          transformOrigin: 'left bottom',
        }}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        onDoubleClick={e => { e.stopPropagation(); onStartEdit(); }}
        onPointerDown={e => {
          // Arrastrar directo, sin pre-seleccionar: el pointerdown selecciona
          // Y arma el drag en el mismo gesto.
          if (editing || e.button !== 0) return;
          if (!selected) onSelect();
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
          if (!start.moved && Math.abs(dx) + Math.abs(dy) > 3) {
            start.moved = true;
            dbgStyles('drag-start', seg, edit);
            // El gesto arrancó: PdfCanvas blitea el lift pre-horneado (la
            // página sin este texto) — el original se esfuma al "levantarlo".
            onDragging(true);
          }
          if (start.moved) setDrag({ dx, dy });
        }}
        onPointerUp={e => {
          const start = dragStart.current;
          dragStart.current = null;
          setDrag(null);
          if (!start?.moved) return;
          const nx = round1(clampX(eff.x + (e.clientX - start.px) / scale, eff.width, pageWidth));
          const nb = round1(Math.min(Math.max(eff.baseline - (e.clientY - start.py) / scale, 8), pageHeight - 4));
          const noop = edit == null && nx === round1(seg.x) && nb === round1(seg.baseline);
          if (noop) {
            // Soltó donde estaba: nada que commitear — cancelar el lift.
            onDragging(false, false);
            return;
          }
          dbgStyles('drop', seg, edit, { drop: { nx, nb } });
          // El commit y el fin del arrastre van en el MISMO lote de estado: el
          // preview re-horneado tendrá píxeles idénticos al lift ya visible.
          onPatch({
            x: nx === round1(seg.x) ? null : nx,
            baseline: nb === round1(seg.baseline) ? null : nb,
          });
          onDragging(false, true);
        }}
        onPointerCancel={() => {
          const start = dragStart.current;
          dragStart.current = null;
          setDrag(null);
          if (start?.moved) onDragging(false, false);
        }}
        title={editing ? undefined : (edit?.text ?? seg.text)}
      >
        {masked && (
          <div
            className="seg-text"
            style={containerStyle(seg, edit, scale)}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {!editing && !isLocked && (
          <div
            className="seg-grip"
            title="Ampliar el área de texto (la letra no cambia; el tamaño se ajusta en la barra)"
            onPointerDown={e => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              gripStart.current = e.clientX;
            }}
            onPointerMove={e => {
              if (gripStart.current == null) return;
              e.stopPropagation();
              const from = Math.max(rect.width, areaWidth != null ? areaWidth * scale : 0);
              setGripW(Math.max(rect.width, from + e.clientX - gripStart.current));
            }}
            onPointerUp={e => {
              e.stopPropagation();
              const start = gripStart.current;
              gripStart.current = null;
              setGripW(null);
              if (start == null) return;
              const from = Math.max(rect.width, areaWidth != null ? areaWidth * scale : 0);
              const w = Math.max(rect.width, from + e.clientX - start);
              const wPt = round1(w / scale);
              // Volver al ancho natural (o menos) limpia el área extendida.
              onAreaWidth(wPt <= round1(eff.width) + 1 ? null : wPt);
            }}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
          />
        )}
      </div>
    </>
  );
}
