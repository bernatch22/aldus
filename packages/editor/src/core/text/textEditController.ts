/**
 * text/textEditController.ts — EL editor de texto (v1:
 * `apps/editor/src/editor/overlay/TextEditLayer.tsx`, 633 LOC, el archivo más
 * sutil del editor — audit §4 riesgo 1).
 *
 * Es un SINGLETON imperativo: un ÚNICO <textarea> plano, montado UNA sola vez,
 * que los boxes abren/cierran por handle (nunca N editores, uno por box).
 * ¿Por qué singleton? Porque así el editor es INMUNE al churn de
 * grafos/previews: el overlay se re-renderiza en cada edición (nuevo
 * PageGraph, fantasmas que aparecen/desaparecen), pero el textarea y su caret
 * NO se desmontan. Patrón textarea de Excalidraw + "edit box manager" de
 * pdf.js: un textarea nativo no colapsa espacios, no crea spans fantasma y su
 * caret es indestructible; los ESTILOS por tramo viven en el MODELO
 * (StyledRun[] de la sesión, offsets planos de selectionStart/End) y se
 * sincronizan por diff en cada input — nunca en el DOM.
 *
 * REGLA DURA (plan F6): el ALGORITMO viaja VERBATIM — splitAtChar,
 * renumberLines, el fit ws/ls que se apaga al primer cambio de texto, el Lbl
 * colgante con corrimiento de ancla, Enter=lista/renumerar, Enter en ítem
 * vacío = cerrar lista. Lo ÚNICO que cambia es el TRANSPORTE:
 *  - `export let liveEditRuns` / `liveMarkerKind` (module-let) → un getter
 *    `controller.session` + un evento tipado `onStyleStateChanged`.
 *  - `window.dispatchEvent(SELECTION_STYLE_EVENT)` → `controller.applyStyle(...)`,
 *    una llamada directa y tipada (FloatingBar la invoca en vez de despachar
 *    un CustomEvent sin tipo al `window`).
 *  - El JSX de host/backdrop/lbl/textarea → el propio controller los CREA
 *    (`this.el` es el host; la vista de editor-react solo lo monta una vez:
 *    `containerRef.current.appendChild(controller.el)`).
 */
import {
  applyTextDiff,
  effectiveGeometry,
  EventEmitter,
  firstMarker,
  isBareListMarker,
  LIST_GAP,
  listMarkerLen,
  markerAt,
  markerBodyDx,
  markerIsKind,
  markerKindOf,
  nextListMarker,
  originalStyledRuns,
  pdfRectToCss,
  setStyleRange,
  stripListMarker,
  styledRunsEqual,
  styledText,
  toggleStyleRange,
  type IDisposable,
  type IEvent,
  type ListKind,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
  type StyledRun,
} from '@aldus/core';
import { applyAlign, measureWidth, round1 } from './styledDom.js';
import { containerStyle, log } from '../helpers.js';

export interface EditSession {
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
  /** Los tramos estilados EN VIVO (se re-mapean por diff en cada input).
   *  Con etiqueta Lbl: SOLO el cuerpo (el marcador vive fuera del textarea). */
  runs: StyledRun[];
  seedText: string;
  seedRuns: StyledRun[];
  /** Lbl/LBody (ISO 32000): el MARCADOR de lista como etiqueta COLGANTE fija,
   *  fuera del textarea — el gap es geometría (bodyDx), no espacios. null = sin
   *  marcador (modo plano). */
  lblRuns: StyledRun[] | null;
  /** El prefijo textual del marcador ("14. ") — para reconstruir text al commit
   *  y para que Enter continúe la lista. */
  lblText: string;
  /** Indent REAL del cuerpo (pt desde el ancla) — la geometría del gap. */
  bodyDx: number;
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

/** Snapshot del ESTILO en vivo de la sesión abierta — reemplaza
 *  `liveEditRuns`/`liveMarkerKind` (module-let de v1). null = sin editor
 *  abierto. FloatingBar lo lee vía `controller.session` y se suscribe a
 *  `onStyleStateChanged` para refrescar sus toggles B/I/U en vivo. */
export interface StyleState {
  runs: StyledRun[];
  markerKind: ListKind | null;
}

/** La acción que el panel/atajo le pide a la sesión abierta — reemplaza el
 *  `CustomEvent` sin tipo `SELECTION_STYLE_EVENT` de v1. */
export type StyleAction =
  | { key: 'bold' | 'italic' | 'underline' }
  | { key: 'color'; color: string }
  | { key: 'list'; listKind?: ListKind }
  | { key: 'align'; align: 'left' | 'center' | 'right' };

/** Corta los runs estilados en el offset `n` del texto plano → [head, tail]. */
function splitAtChar(runs: StyledRun[], n: number): [StyledRun[], StyledRun[]] {
  const head: StyledRun[] = [];
  const tail: StyledRun[] = [];
  let pos = 0;
  for (const r of runs) {
    const start = pos;
    pos += r.text.length;
    if (pos <= n) head.push(r);
    else if (start >= n) tail.push(r);
    else {
      head.push({ ...r, text: r.text.slice(0, n - start) });
      tail.push({ ...r, text: r.text.slice(n - start) });
    }
  }
  return [head, tail];
}

/** Fusiona tramos adyacentes del MISMO estilo (para comparar contra el original,
 *  que puede venir fusionado — p. ej. "I. Custodiar" en un solo run). */
function mergeSameStyle(runs: StyledRun[]): StyledRun[] {
  const out: StyledRun[] = [];
  for (const r of runs) {
    const l = out[out.length - 1];
    if (l && l.bold === r.bold && l.italic === r.italic && l.color === r.color && !!l.underline === !!r.underline) l.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

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
    n = n == null ? parseInt(m[2]!, 10) : n + 1;
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

/** Escape mínimo para el backdrop (white-space:pre conserva los espacios). */
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface TextEditControllerOptions {
  /** Llamado cuando la sesión se cierra (blur/Escape) — el composition root
   *  lo usa para des-seleccionar el nodo en el overlay. */
  onClosed?: () => void;
}

/**
 * Singleton imperativo, sin React. `el` es el HOST (display:none hasta
 * `open()`) — el composition root lo monta UNA vez en el overlay:
 * `overlayRoot.appendChild(controller.el)`.
 */
export class TextEditController implements IDisposable {
  readonly el: HTMLDivElement;
  private readonly lblEl: HTMLDivElement;
  private readonly backdropEl: HTMLDivElement;
  private readonly ta: HTMLTextAreaElement;

  private session: LiveSession | null = null;

  private readonly _onStyleStateChanged = new EventEmitter<StyleState | null>();
  readonly onStyleStateChanged: IEvent<StyleState | null> = this._onStyleStateChanged.event;

  private readonly onClosed: () => void;
  private readonly unlisten: () => void;

  constructor(opts: TextEditControllerOptions = {}) {
    this.onClosed = opts.onClosed ?? (() => undefined);

    this.el = document.createElement('div');
    this.el.className = 'seg-box editing masked';
    Object.assign(this.el.style, { display: 'none', position: 'absolute', zIndex: '40' });
    // stopPropagation: un click DENTRO del editor no puede burbujear al
    // overlay (su click de fondo deselecciona y hasta forzaba el blur).
    for (const evt of ['click', 'pointerdown', 'dblclick'] as const) {
      this.el.addEventListener(evt, e => e.stopPropagation());
    }

    this.lblEl = document.createElement('div');
    this.lblEl.className = 'seg-text seg-lbl';
    this.lblEl.setAttribute('aria-hidden', 'true');
    this.lblEl.style.display = 'none';

    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'seg-text seg-backdrop';
    this.backdropEl.setAttribute('aria-hidden', 'true');

    this.ta = document.createElement('textarea');
    this.ta.className = 'seg-text seg-textarea';
    this.ta.rows = 1;
    this.ta.wrap = 'off';
    this.ta.spellcheck = false;
    this.ta.autocapitalize = 'off';
    this.ta.setAttribute('autocorrect', 'off');

    this.el.append(this.lblEl, this.backdropEl, this.ta);

    // Listeners nativos, atados UNA sola vez (nunca se re-atan) — el
    // singleton los conserva mientras viva el controller.
    const syncRuns = () => this.syncRuns();
    const onBlur = () => this.handleBlur();
    const onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
    this.ta.addEventListener('blur', onBlur);
    this.ta.addEventListener('keydown', onKeyDown);
    this.ta.addEventListener('input', syncRuns);
    this.unlisten = () => {
      this.ta.removeEventListener('blur', onBlur);
      this.ta.removeEventListener('keydown', onKeyDown);
      this.ta.removeEventListener('input', syncRuns);
    };
  }

  isOpen(): boolean {
    return this.session != null;
  }

  /** Commit + close EXPLÍCITOS — el NodeOverlay lo llama al seleccionar OTRO
   *  nodo. Reemplaza el force-blur de v1 (`activeEditingBox()?.blur()`): el
   *  `preventDefault` de los pointerdown impide el blur natural, y acá la
   *  coordinación deja de viajar por el focus del DOM. No-op sin sesión. */
  commitAndClose(): void {
    if (!this.session) return;
    this.commit();
    this.close();
  }

  /** Estilo uniforme BAJO LA SELECCIÓN del textarea abierto (o null sin
   *  sesión) — FloatingBar lo lee para pintar sus toggles B/I/U en vivo
   *  (v1 leía `liveEditRuns` + los offsets del textarea a mano). */
  get selectionStyle(): { bold: boolean; italic: boolean; underline: boolean } | null {
    if (!this.session) return null;
    return styleAtRange(this.session.runs, this.ta.selectionStart, this.ta.selectionEnd);
  }

  /** Snapshot del estilo EN VIVO de la sesión abierta (o null). */
  get styleState(): StyleState | null {
    return this.session ? { runs: this.session.runs, markerKind: this.liveMarkerKind } : null;
  }

  private liveMarkerKind: ListKind | null = null;

  private fireStyleState(): void {
    this._onStyleStateChanged.fire(this.styleState);
  }

  open(s: EditSession): void {
    const host = this.el;
    const ta = this.ta;
    const fullRuns = s.edit?.runs ?? originalStyledRuns(s.seg);
    const fullText = styledText(fullRuns);
    // ── Lbl/LBody: si el nodo arranca con un marcador de lista CON cuerpo,
    // el marcador sale del textarea (etiqueta colgante) y el cuerpo arranca
    // en su indent REAL (bodyDx) — el gap es geometría, no espacios. ──
    const mlen = listMarkerLen(fullText);
    let bodyDx = 0;
    if (mlen > 0 && !isBareListMarker(fullText)) {
      if (s.edit?.runs) {
        // Runs editados: llevan dx — el del primer run del cuerpo.
        let pos = 0;
        for (const r of s.edit.runs) { if (pos >= mlen) { bodyDx = r.dx ?? 0; break; } pos += r.text.length; }
      } else {
        bodyDx = markerBodyDx(s.seg);
      }
    }
    const useLbl = mlen > 0 && bodyDx > 0.5;
    const [lblRuns, seedRuns] = useLbl ? splitAtChar(fullRuns, mlen) : [null, fullRuns] as const;
    const lblText = useLbl ? fullText.slice(0, mlen) : '';
    const seedText = styledText(seedRuns);
    // Ítem de lista PELADO (solo el marcador, sin cuerpo): sembrar el GAP para
    // poder tipear detrás (solo aplica en modo plano, sin etiqueta).
    const value = !useLbl && isBareListMarker(seedText) ? `${seedText.replace(/\s+$/, '')}${LIST_GAP}` : seedText;
    const eff = effectiveGeometry(s.seg, s.edit);
    const rect = pdfRectToCss({ x: eff.x, y: eff.y, width: eff.width, height: eff.height }, s.pageHeight, s.scale);
    const style = containerStyle(s.seg, s.edit, s.scale);
    const live: LiveSession = {
      ...s,
      seedText,
      seedRuns,
      runs: seedRuns,
      lblRuns: lblRuns ? lblRuns.map(r => ({ ...r })) : null,
      lblText,
      bodyDx,
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
    if (fullText === s.seg.text && !seedText.includes('\n')) {
      const bodyPx0 = useLbl ? bodyDx * s.scale : 0;
      const measured = measureWidth(value, live.fontCss);
      const spaces = (value.match(/ /g) ?? []).length;
      const delta = rect.width - bodyPx0 - measured;
      if (measured > 0 && Math.abs(delta) > 0.5 && value.length > 1) {
        if (delta > 0 && spaces > 0) live.ws = delta / spaces;
        else {
          const ls = delta / value.length;
          const sizePx = parseFloat(String(style.fontSize)) || 12;
          if (Math.abs(ls) <= sizePx * 0.4) live.ls = ls;
        }
      }
    }
    this.session = live;
    host.style.display = 'block';
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.height = `${rect.height}px`;
    const bd = this.backdropEl;
    // Mismas métricas en textarea Y backdrop (font/size/spacing/altura).
    for (const el of [ta, bd]) {
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
    ta.style.caretColor = style.color ?? '#000';
    // Lbl colgante: la etiqueta hereda las MISMAS métricas; el cuerpo
    // (backdrop+textarea) arranca en el indent REAL (left = bodyDx px).
    Object.assign(this.lblEl.style, style);
    this.lblEl.style.height = `${rect.height}px`;
    this.lblEl.style.lineHeight = `${rect.height}px`;
    const bodyPx = useLbl ? bodyDx * s.scale : 0;
    for (const el of [ta, bd]) el.style.left = `${bodyPx}px`;
    this.liveMarkerKind = useLbl ? markerKindOf(`${lblText.trim()} x`) : null;
    this.renderLbl();
    ta.value = value;
    live.runs = applyTextDiff(seedRuns, value);
    this.renderBackdrop();
    this.fit();
    ta.focus();
    ta.setSelectionRange(value.length, value.length);
    log('[aldus:edit-open]', s.seg.id, 'layer(textarea):', JSON.stringify(value.slice(0, 30)), 'focus:', document.activeElement === ta);
  }

  /** Aplica una acción de estilo a la sesión abierta — reemplaza el
   *  `window.dispatchEvent(SELECTION_STYLE_EVENT)` de v1 (llamada directa y
   *  tipada desde FloatingBar). No-op si no hay sesión abierta. */
  applyStyle(action: StyleAction): void {
    const s = this.session;
    const ta = this.ta;
    if (!s) return;
    if (action.key === 'align') {
      // Alinear en vivo: solo el text-align (CSS); el dx se calcula al commit.
      s.align = action.align;
      for (const el of [ta, this.backdropEl]) el.style.textAlign = action.align;
      return;
    }
    const selectionStart = ta.selectionStart;
    const selectionEnd = ta.selectionEnd;
    // Caret colapsado: aplicar a la PALABRA bajo el caret (consistente con
    // el estado que muestra el botón); sin palabra → segmento entero.
    const [from, to] = selectionStart === selectionEnd
      ? wordRangeAt(ta.value, selectionStart)
      : [selectionStart, selectionEnd];
    if (action.key === 'bold' || action.key === 'italic' || action.key === 'underline') {
      // Lbl/LBody: el marcador de lista y su gap NO reciben el estilo del
      // cuerpo — subrayar "todo" no dibuja la línea bajo el "•"/"A." ni el hueco.
      const mlen = listMarkerLen(ta.value.split('\n')[0] ?? '');
      const from2 = Math.max(from, mlen);
      if (to > from2) s.runs = toggleStyleRange(s.runs, from2, to, action.key);
      this.refresh();
    } else if (action.key === 'color') {
      s.runs = setStyleRange(s.runs, from, to, { color: action.color });
      this.refresh();
    } else if (action.key === 'list') {
      this.applyListStyle(s, action.listKind ?? 'bullet', from, to, selectionStart, selectionEnd);
    }
  }

  private applyListStyle(s: LiveSession, kind: ListKind, from: number, to: number, selA: number, selB: number): void {
    // Toggle de viñeta POR LÍNEA (patrón de los editores markdown): si TODAS
    // las líneas con contenido ya tienen marcador → se quita de todas; si no
    // → se agrega a las que falte. La viñeta es COLGANTE: el marcador de la
    // 1.ª línea corre el ancla x del grafo (el contenido no se mueve; se
    // consolida en x al commit).
    const ta = this.ta;
    const host = this.el;
    void from; void to;
    const blockStart = ta.value.lastIndexOf('\n', selA - 1) + 1;
    const touchesFirst = blockStart === 0;
    const setBodyLeft = (px: number) => { for (const el of [ta, this.backdropEl]) el.style.left = `${px}px`; };
    const moveHost = (px: number) => { host.style.left = `${parseFloat(host.style.left) + px}px`; };
    if (touchesFirst) {
      if (s.lblRuns && markerIsKind(`${s.lblText.trim()} x`, kind)) {
        // MISMO tipo → OFF: fuera la etiqueta; el ancla absorbe el indent.
        s.lblRuns = null;
        this.liveMarkerKind = null;
        s.xShiftPt += s.bodyDx;
        moveHost(s.bodyDx * s.scale);
        s.bodyDx = 0;
        setBodyLeft(0);
      } else if (s.lblRuns) {
        // OTRO tipo → CONVERTIR la etiqueta; el delta de ancho va al ancla.
        const trail = /\s*$/.exec(s.lblText)?.[0] || ' ';
        const oldW = measureWidth(s.lblText, s.fontCss) / s.scale;
        s.lblText = `${firstMarker(kind)}${trail}`;
        s.lblRuns = [{ ...s.lblRuns[0]!, text: s.lblText }];
        this.liveMarkerKind = kind;
        const delta = measureWidth(s.lblText, s.fontCss) / s.scale - oldW;
        s.xShiftPt -= delta;
        s.bodyDx += delta;
        moveHost(-delta * s.scale);
        setBodyLeft(s.bodyDx * s.scale);
      } else {
        // SIN marcador → CREAR la etiqueta colgante (hereda estilo del
        // cuerpo, jamás underline); el ancla se corre su ancho a la izquierda.
        s.lblText = `${firstMarker(kind)}${LIST_GAP}`;
        const first = s.runs[0];
        s.lblRuns = [{ text: s.lblText, bold: first?.bold ?? false, italic: first?.italic ?? false, color: first?.color, dx: 0 }];
        this.liveMarkerKind = kind;
        const mw = measureWidth(s.lblText, s.fontCss) / s.scale;
        s.xShiftPt -= mw;
        s.bodyDx = mw;
        moveHost(-mw * s.scale);
        setBodyLeft(mw * s.scale);
      }
      this.renderLbl();
    }
    // Líneas 2+ (selección multi-línea): marcadores INLINE por línea, con la
    // numeración siguiendo a la etiqueta (el Lbl es el ítem 1).
    let blockEnd = ta.value.indexOf('\n', selB);
    if (blockEnd < 0) blockEnd = ta.value.length;
    const lines = ta.value.split('\n');
    if (lines.length > 1) {
      const i0 = Math.max(1, ta.value.slice(0, blockStart).split('\n').length - 1);
      const i1 = ta.value.slice(0, blockEnd).split('\n').length - 1;
      const affected = lines.slice(i0, i1 + 1).filter(l => l.trim() !== '');
      if (affected.length) {
        const removing = affected.every(l => markerIsKind(l, kind));
        let seq = s.lblRuns || markerIsKind(lines[0] ?? '', kind) ? 1 : 0;
        const out = lines.map((l, i) => {
          if (i < i0 || i > i1 || l.trim() === '') return l;
          if (removing) return stripListMarker(l);
          seq++;
          return `${markerAt(kind, seq)}${LIST_GAP}${stripListMarker(l)}`;
        });
        ta.value = out.join('\n');
      }
    }
    this.syncRuns();
  }

  private renderLbl(): void {
    const s = this.session;
    const lbl = this.lblEl;
    if (!s || !s.lblRuns) { lbl.style.display = 'none'; lbl.innerHTML = ''; return; }
    lbl.style.display = 'block';
    lbl.innerHTML = s.lblRuns.map(r => {
      const st: string[] = [];
      if (r.bold) st.push('text-shadow:0.02em 0 0 currentColor,-0.02em 0 0 currentColor');
      if (r.italic) st.push('font-style:italic');
      if (r.color) st.push(`color:${r.color}`);
      return `<span${st.length ? ` style="${st.join(';')}"` : ''}>${escHtml(r.text)}</span>`;
    }).join('');
  }

  private renderBackdrop(): void {
    const s = this.session;
    const bd = this.backdropEl;
    if (!s) return;
    bd.innerHTML = s.runs.map(r => {
      const st: string[] = [];
      if (r.bold) st.push('text-shadow:0.02em 0 0 currentColor,-0.02em 0 0 currentColor');
      if (r.italic) st.push('font-style:italic');
      if (r.underline) st.push('text-decoration:underline');
      if (r.color) st.push(`color:${r.color}`);
      return `<span${st.length ? ` style="${st.join(';')}"` : ''}>${escHtml(r.text)}</span>`;
    }).join('') || '&#8203;';
    this.fireStyleState();
  }

  private close(): void {
    this.el.style.display = 'none';
    this.session = null;
    this.liveMarkerKind = null;
    this._onStyleStateChanged.fire(null);
    this.onClosed();
  }

  // Ancho al contenido (medido con la fuente real + el fit) — textarea y
  // backdrop comparten el mismo ancho para que el caret alinee con lo dibujado.
  private fit(): void {
    const s = this.session;
    const ta = this.ta;
    if (!s) return;
    // MULTILÍNEA: ancho = la línea más larga; alto = n líneas × line-height
    // (1 línea usa el alto real del segmento; 2+ usan el leading del bake).
    const lines = ta.value.split('\n');
    let maxW = 0;
    for (const line of lines) {
      const spaces = (line.match(/ /g) ?? []).length;
      maxW = Math.max(maxW, measureWidth(line, s.fontCss) + spaces * s.ws + line.length * s.ls);
    }
    // Ancho = el del box (minW) si el texto entra; si el usuario tipeó de más,
    // crece con el contenido. Con Lbl colgante el cuerpo arranca en bodyDx px:
    // su ancho disponible es minW − bodyPx, y el HOST cubre etiqueta + cuerpo.
    const bodyPx = s.lblRuns ? s.bodyDx * s.scale : 0;
    const bodyW = Math.max(s.minW - bodyPx, Math.ceil(maxW) + 1);
    const lineH = lines.length > 1 ? s.lineHN : s.lineH1;
    // El alto calza con el mask del box: al menos el área (minHeightCss).
    const height = `${Math.ceil(Math.max(lines.length * lineH, s.minHeightCss))}px`;
    for (const el of [ta, this.backdropEl]) {
      el.style.width = `${bodyW}px`;
      el.style.height = height;
      el.style.lineHeight = `${lineH}px`;
    }
    const host = this.el;
    // El HOST también: sus hijos son absolute (sin esto su fondo blanco no
    // cubre nada — "el grafo impreso muchas veces").
    host.style.width = `${bodyPx + bodyW}px`;
    host.style.height = height;
  }

  // Un cambio de contenido o estilo: re-dibujar el backdrop + re-ajustar ancho.
  private refresh(): void {
    this.renderBackdrop();
    this.fit();
  }

  private commit(): void {
    const s = this.session;
    const ta = this.ta;
    if (!s) return;
    const bodyText = ta.value.replace(/\s+$/, '');
    // dx/w REALES por LÍNEA + alineación dentro del área (frame = ancho del
    // CUERPO). applyAlign da dx desde el arranque del cuerpo; con Lbl colgante
    // se les suma el indent REAL (bodyDx, geometría) y el marcador se antepone
    // VERBATIM — el gap no depende de espacios ni de mediciones.
    const bodyPx = s.lblRuns ? s.bodyDx * s.scale : 0;
    let bodyRuns = applyAlign(applyTextDiff(s.runs, bodyText), s.seg, 1, (s.minW - bodyPx) / s.scale, s.align);
    if (s.lblRuns) bodyRuns = bodyRuns.map(r => ({ ...r, dx: round1((r.dx ?? 0) + s.bodyDx) }));
    const runs = s.lblRuns ? [...s.lblRuns, ...bodyRuns] : bodyRuns;
    const text = (s.lblRuns ? s.lblText : '') + bodyText;
    // Viñeta colgante aplicada EN VIVO: consolidar el corrimiento de x.
    const nx = round1(Math.max(4, s.anchorX + s.xShiftPt));
    // noop: comparado con estilos FUSIONADOS (el original puede traer
    // marcador+cuerpo en un solo run — "I. Custodiar").
    const noop = styledRunsEqual(mergeSameStyle(runs), mergeSameStyle(originalStyledRuns(s.seg)));
    s.onPatch({
      text,
      runs: noop ? null : runs,
      align: s.align === 'left' ? null : s.align,
      ...(s.xShiftPt !== 0 ? { x: nx === round1(s.seg.x) ? null : nx } : {}),
    });
  }

  private syncRuns(): void {
    const s = this.session;
    const ta = this.ta;
    if (!s) return;
    // El texto CAMBIÓ: fuera el estiramiento del fit (ws/ls). Ese fit imita
    // los gaps del PDF del texto ORIGINAL (que el save preserva verbatim);
    // con texto modificado el bake escribe métrica NATURAL — y lo que ves
    // tipeando tiene que ser EXACTAMENTE lo que se guarda.
    if ((s.ws !== 0 || s.ls !== 0) && ta.value !== s.seedText) {
      s.ws = 0;
      s.ls = 0;
      for (const el of [ta, this.backdropEl]) {
        el.style.wordSpacing = '';
        el.style.letterSpacing = '';
      }
    }
    s.runs = applyTextDiff(s.runs, ta.value);
    this.refresh();
  }

  private handleBlur(): void {
    const s = this.session;
    if (!s) return;
    log('[aldus:blur] layer comitea y cierra', s.seg.id);
    this.commit();
    this.close();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const s = this.session;
    const ta = this.ta;
    if (!s) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // ENTER = BREAKLINE dentro del MISMO grafo (el PDF soporta bloques
      // multilínea; el bake emite cada línea con su leading). En una lista,
      // el marcador continúa incrementado en la línea nueva. Enter en un
      // ítem vacío (solo el marcador) = terminar la lista, como Word.
      const pos = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
      // Con Lbl colgante, el marcador de la 1.ª línea vive FUERA del textarea:
      // anteponerlo para que nextListMarker continúe la serie ("14." → "15.").
      const curLine = (lineStart === 0 && s.lblRuns ? s.lblText : '') + ta.value.slice(lineStart, pos);
      if (isBareListMarker(curLine) && curLine.trim() !== '') {
        // ítem vacío: quitar el marcador huérfano y cerrar (commit + close).
        ta.setRangeText('', lineStart, pos, 'start');
        this.syncRuns();
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
      this.syncRuns();
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
      this.applyStyle({ key: e.key === 'b' ? 'bold' : e.key === 'i' ? 'italic' : 'underline' });
    }
  }

  dispose(): void {
    this.unlisten();
    this._onStyleStateChanged.dispose();
    this.el.remove();
  }
}
