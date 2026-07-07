/**
 * TextEditLayer — EL editor de texto del overlay.
 *
 * Es un SINGLETON imperativo: un ÚNICO <textarea> plano montado UNA sola vez en
 * la raíz del overlay, que los boxes abren/cierran por handle (nunca N editores,
 * uno por box). ¿Por qué singleton? Porque así el editor es INMUNE al churn de
 * grafos/previews: el overlay se re-renderiza en cada edición (nuevo PageGraph,
 * fantasmas que aparecen/desaparecen), pero el textarea y su caret NO se
 * desmontan — un editor por box se destruiría/re-crearía en cada tecla y
 * perdería foco/selección. Patrón textarea de Excalidraw + "edit box manager"
 * de pdf.js: un textarea nativo no colapsa espacios, no crea spans fantasma y su
 * caret es indestructible; los ESTILOS por tramo viven en el MODELO (StyledRun[]
 * de la sesión, offsets planos de selectionStart/End) y se sincronizan por diff
 * en cada input — nunca en el DOM.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import {
  applyTextDiff,
  effectiveGeometry,
  hasListMarker,
  isBareListMarker,
  LIST_GAP,
  nextListMarker,
  originalStyledRuns,
  setStyleRange,
  styledRunsEqual,
  styledText,
  toggleStyleRange,
  pdfRectToCss,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
  type StyledRun,
} from '@aldus/core';
import { applyAlign, measureWidth, round1, SELECTION_STYLE_EVENT } from '../styledDom';
import { containerStyle, log } from './helpers';

interface EditSession {
  seg: SegmentNode;
  edit: SegmentEdit | null;
  scale: number;
  pageHeight: number;
  /** min-width / min-height (px CSS) — el área tipeable ampliada por el grip.
   *  El alto hace que el textarea calce con el mask del box. */
  minWidthCss: number;
  minHeightCss: number;
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
  /** Alineación del texto dentro del área (display CSS + dx del bake). */
  align: 'left' | 'center' | 'right';
}

// Los runs EN VIVO de la sesión abierta (para el estado activo de B/I en la
// barra — con textarea no hay DOM que caminar). null = sin editor abierto.
export let liveEditRuns: StyledRun[] | null = null;

/** Estilo uniforme del rango [start,end) sobre los runs (caret colapsado →
 *  el carácter anterior, la convención de todo editor). */
export function styleAtRange(runs: StyledRun[], start: number, end: number): { bold: boolean; italic: boolean; underline: boolean } | null {
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

export const TextEditLayer = forwardRef<TextEditLayerHandle, { onClosed: () => void }>(function TextEditLayer({ onClosed }, ref) {
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
    // El alto calza con el mask del box: al menos el área (minHeightCss).
    const height = `${Math.ceil(Math.max(lines.length * lineH, s.minHeightCss))}px`;
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
    // dx/w REALES por LÍNEA + alineación dentro del área (frame = minW). Medido
    // al tamaño ORIGINAL (ratio 1): el bake ya multiplica por el ratio del
    // resize. applyAlign posiciona cada línea (left = natural, center/right =
    // corrida dentro del frame) → el bake solo lee el dx.
    const runs = applyAlign(applyTextDiff(s.runs, text), s.seg, 1, s.minW / s.scale, s.align);
    // Viñeta colgante aplicada EN VIVO: consolidar el corrimiento de x.
    const nx = round1(Math.max(4, s.anchorX + s.xShiftPt));
    s.onPatch({
      text,
      runs: styledRunsEqual(runs, originalStyledRuns(s.seg)) ? null : runs,
      align: s.align === 'left' ? null : s.align,
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
        align: s.edit?.align ?? 'left',
      };
      // FIT de ancho: solo con el texto ORIGINAL intacto y de UNA línea (con
      // texto editado el ancho efectivo ya no describe el contenido; con '\n'
      // measureWidth mide TODAS las líneas juntas → un letter-spacing negativo
      // brutal que colapsaba el bloque multilínea encima de sí mismo). El delta
      // target−medido va a los espacios (los gaps reales del PDF) o por carácter.
      if (seedText === s.seg.text && !seedText.includes('\n')) {
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
        el.style.textAlign = live.align; // alineación del texto dentro del área
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
      log('[aldus:edit-open]', s.seg.id, 'layer(textarea):', JSON.stringify(value.slice(0, 30)), 'focus:', document.activeElement === ta);
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
      // El texto CAMBIÓ: fuera el estiramiento del fit (ws/ls). Ese fit imita
      // los gaps del PDF del texto ORIGINAL (que el save preserva verbatim);
      // con texto modificado el bake escribe métrica NATURAL — y lo que ves
      // tipeando tiene que ser EXACTAMENTE lo que se guarda.
      if ((s.ws !== 0 || s.ls !== 0) && ta.value !== s.seedText) {
        s.ws = 0;
        s.ls = 0;
        for (const el of [ta, backdropRef.current]) {
          if (!el) continue;
          el.style.wordSpacing = '';
          el.style.letterSpacing = '';
        }
      }
      s.runs = applyTextDiff(s.runs, ta.value);
      refresh();
    };
    const onBlur = () => {
      const s = sessionRef.current;
      if (!s) return;
      log('[aldus:blur] layer comitea y cierra', s.seg.id);
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
      const detail = (ev as CustomEvent<{ key?: 'bold' | 'italic' | 'underline' | 'color' | 'list' | 'align'; color?: string; align?: 'left' | 'center' | 'right' }>).detail;
      if (detail?.key === 'align' && detail.align) {
        // Alinear en vivo: solo el text-align (CSS); el dx se calcula al commit.
        s.align = detail.align;
        for (const el of [ta, backdropRef.current]) if (el) el.style.textAlign = detail.align;
        return;
      }
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
