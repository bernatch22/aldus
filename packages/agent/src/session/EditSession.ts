/**
 * EditSession — FACHADA fina de edición sobre un documento (audit-agent §3.2):
 * los LOOKUPS van por {@link NodeIndex} (O(1), mata los 5 scans lineales de v1),
 * las MUTACIONES por el {@link EditLedger} de core (el gemelo del `usePendingEdits`
 * del editor), y el REFLOW / PLACEMENT / charX por el motor de layout de core
 * (`paragraphOf` / `paragraphToks` / `reflowApply` / `matchPlaceholders`). La
 * sesión ya NO calcula geometría: cablea los seams (ReflowEnv/LayoutEnv + el
 * `reExtract` inyectado) + el estado que las tools acumulan (creates/fills), y
 * `bake()` orquesta (bakeSegmentEdits → creates en cola → setFieldValues).
 *
 * Dos clases de cambio, igual que el editor:
 *  - EDICIONES sobre nodos EXISTENTES (texto/imagen/campo/highlight/link) → el
 *    EditLedger, horneadas por `bake()` de core en un solo tiro.
 *  - CREACIONES de nodos NUEVOS (texto, imagen, highlight, link, watermark,
 *    encabezado/pie, campo) → una cola aplicada DESPUÉS del bake (cada una una
 *    función de create de core, bytes→bytes). El highlight/link "sobre un texto"
 *    resuelve su rect al hornear desde la geometría EFECTIVA del segmento.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  applyTextDiff, originalStyledRuns, effectiveGeometry,
  paragraphOf, paraLinesOf, paragraphToks, reflowApply, matchPlaceholders, placeFieldsInGaps,
  looksLikeLeaderRewrite, looksLikePlaceholderConversion, EditLedger,
  NeverCancelled, throwIfCancelled,
  type CancellationToken,
  type SegmentEdit, type ImageEdit, type SegmentNode, type WidgetKind, type FontBucket,
  type PageGraph, type ReflowTok, type ReflowEnv,
  type ReflowCreate, type LayoutEnv, type OccupiedRect,
} from '@aldus/core';
import {
  bake, addHighlight, addLink, addText, addWatermark, addHeaderFooter, addFormField, insertImage, setFieldValues,
  composePageBlocks, type PageBlock,
} from '@aldus/core/bake';
import type { DocGraph } from '../graph.js';
import { graphFromBytes } from '../graph.js';
import { NodeIndex } from './NodeIndex.js';

/** Una CREACIÓN pendiente: se aplica después del bake (bytes→bytes). El
 *  highlight/link "sobre un texto" guarda el segId y resuelve su rect al hornear. */
type CreateOp =
  | { kind: 'highlightSeg'; segId: string; color?: string }
  | { kind: 'linkSeg'; segId: string; url: string }
  | { kind: 'text'; page: number; x: number; y: number; text: string; size?: number; bucket?: FontBucket; bold?: boolean; italic?: boolean; color?: string }
  | { kind: 'image'; page: number; x: number; y: number; path: string; maxWidth?: number }
  | { kind: 'watermark'; text: string; opacity?: number; color?: string }
  | { kind: 'headerFooter'; header?: string; footer?: string; pageNumbers?: boolean }
  | { kind: 'field'; fieldType: WidgetKind; page: number; x: number; y: number; width?: number; height?: number; name?: string };

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/**
 * Resultado discriminado de {@link EditSession.finishTurn} — la política de
 * PRODUCTO "¿el host hornea+persiste o devuelve ediciones?" en UN lugar
 * (audit-hosts §2: en v1 vivía embebida en la ruta agent.ts del server):
 *  - `baked` → hubo creaciones/annotations/fills que el estado local del editor
 *    no sabe representar: acá van los bytes YA horneados; el host los persiste
 *    y el cliente recarga el documento limpio.
 *  - `edits` → el turno solo acumuló ediciones de texto/imagen: el host las
 *    devuelve y el editor las aplica a su estado local (preview, sin persistir).
 */
export type TurnFinish =
  | { kind: 'baked'; pdf: Uint8Array; applied: string[]; warnings: string[] }
  | { kind: 'edits'; edits: SegmentEdit[]; imageEdits: ImageEdit[] };

export class EditSession {
  private readonly index: NodeIndex;
  private readonly ledger = new EditLedger();
  /** La cola de creaciones. Tipada como `ReflowCreate[]` (lo que el motor de
   *  reflow de core mutará in-place: emite renglones extra, re-ancla campos);
   *  guarda objetos {@link CreateOp} y `applyCreate` los narrowa por `kind`. */
  private readonly creates: ReflowCreate[] = [];
  /** Los creates de la ÚLTIMA composición de cada página (replacePage):
   *  re-componer la misma página descarta los anteriores (reemplaza, no acumula). */
  private readonly composedByPage = new Map<number, ReflowCreate[]>();
  /** Valores de formulario a COMPLETAR, por nombre de campo (setFieldValues). */
  private readonly fills = new Map<string, string | boolean | string[]>();
  /** Token de cancelación del turno (threaded al loop de 6 bakes del reflow). */
  private cancellation: CancellationToken = NeverCancelled;

  constructor(private readonly doc: DocGraph) {
    this.index = new NodeIndex(doc);
  }

  /** Cablea el token de cancelación del turno: `bake()` (y por lo tanto el loop
   *  del reflow que hornea 6 veces) lo chequea y aborta con TaskCancelledError. */
  setCancellation(ct: CancellationToken): void { this.cancellation = ct; }

  private pageOf(s: SegmentNode): PageGraph {
    return this.index.pageOf(s.id) ?? this.doc.pages.find(p => p.page === s.page)!;
  }

  /** Mensaje de "id inexistente" con ANCLAS REALES. El modelo INVENTA ids
   *  derivándolos de coordenadas corridas: tras un reflow ve `id p3-y137
   *  @(121,132)` en el estado actualizado y prueba "p3-y132-x121" — medido: 25
   *  tool calls de flailing en un run real de Sonnet. El id es INMUTABLE (nace
   *  de la posición ORIGINAL del nodo); acá se lo decimos y le damos los ids
   *  verdaderos más cercanos a la posición que intentó, para cortar el loop en 1. */
  private notFound(id: string, what = 'el nodo de texto'): string {
    let near = '';
    const m = /^p(\d+)-y(\d+)(?:-x(\d+))?/.exec(id);
    if (m) {
      const page = this.doc.pages.find(p => p.page === Number(m[1]));
      const y = Number(m[2]), x = m[3] ? Number(m[3]) : 0;
      if (page) {
        const ids = [...page.segments]
          .filter(s => !this.isRemoved(s.id))
          .sort((a, b) =>
            (Math.abs(this.effBaseline(a) - y) + Math.abs(a.x - x) * 0.1) -
            (Math.abs(this.effBaseline(b) - y) + Math.abs(b.x - x) * 0.1))
          .slice(0, 3)
          .map(s => s.id);
        if (ids.length) near = ` Los ids REALES más cercanos a esa posición son: ${ids.join(', ')}.`;
      }
    }
    return `⚠️ No existe ${what} "${id}". Los ids NO cambian cuando el texto se corre (nacen de la posición ORIGINAL del nodo): usá el id TAL CUAL aparece en el grafo o en el estado actualizado — nunca lo derives de coordenadas.${near}`;
  }

  // ── ReflowEnv / LayoutEnv (los seams que el motor de layout de core consume) ──
  private effBaseline(seg: SegmentNode): number {
    return this.ledger.segmentEdit(seg.id)?.baseline ?? seg.baseline;
  }
  private isRemoved(id: string): boolean {
    return this.ledger.segmentEdit(id)?.remove === true;
  }
  /** ¿El nodo tiene una edición ESTRUCTURAL (contenido/remove)? Un corrimiento de
   *  baseline (bookkeeping de reflows anteriores) NO cuenta (anti-recall). */
  private isRestyled(id: string): boolean {
    const e = this.ledger.segmentEdit(id);
    return !!e && (e.runs !== undefined || e.remove === true);
  }
  /** El env que el motor de layout necesita: geometría efectiva + mutadores de
   *  segment-edit + la cola de creates + un `bake()` de los BYTES del estado. */
  private reflowEnv(): ReflowEnv {
    return {
      effBaseline: seg => this.effBaseline(seg),
      isRemoved: id => this.isRemoved(id),
      putSeg: (seg, patch) => { this.ledger.patchSegment(seg, patch); },
      deleteSeg: id => { const n = this.index.seg(id); if (n) this.ledger.revert(n); },
      snapshotSegments: () => this.ledger.snapshot().segments,
      restoreSegments: snap => {
        const full = this.ledger.snapshot();
        this.ledger.restore({ ...full, segments: new Map(snap) });
      },
      creates: this.creates,
      bake: () => this.bakeBytes(),
    };
  }
  private get layoutEnv(): LayoutEnv { return this.reflowEnv(); }
  /** Re-extracción del preview inyectada al reflow (core no importa pdfjs). */
  private readonly reExtract = async (bytes: Uint8Array): Promise<PageGraph[]> =>
    (await graphFromBytes(bytes)).pages;

  /**
   * Ancho PROMEDIO por carácter para estimar el wrap del texto nuevo. Estimarlo
   * del nodo puntual falla: si el nodo va en MAYÚSCULAS (letras anchas) sobre-
   * estima → el wrap corta temprano → renglones cortos; si es multilínea, su
   * `width` (una fila) sobre su `text.length` (todas) sub-estima.
   *
   * Se muestrean las LÍNEAS VISUALES de PROSA del mismo tamaño (LineNode: una
   * fila real, con su ancho y su largo verdaderos), descartando las dominadas
   * por leaders/placeholders ("……", "....", "[…]") que no representan el ancho
   * de una letra. Da un promedio fiel e independiente del nodo elegido.
   */
  private columnAvgCharW(s: SegmentNode): number {
    const page = this.pageOf(s);
    const leaderRatio = (t: string): number => (t.match(/[.…_\[\]]/g)?.length ?? 0) / Math.max(1, t.length);
    const prose = page.lines.filter(l =>
      Math.abs(l.fontSize - s.fontSize) < 1 && l.text.trim().length >= 8 && leaderRatio(l.text) < 0.15);
    const totW = prose.reduce((n, l) => n + l.width, 0);
    const totC = prose.reduce((n, l) => n + l.text.length, 0);
    return totC > 20 ? totW / totC : s.width / Math.max(1, s.text.length);
  }

  // ── EDICIONES de texto (nodos existentes) ──
  /** Edita el texto de un nodo. Si el texto NUEVO es más ancho de lo que entra
   *  en su renglón, el PÁRRAFO se reconstruye (reflow determinístico): lo que
   *  sobra baja al renglón siguiente en cascada — nunca se superpone ni se sale
   *  del borde. Texto igual o más corto = camino simple (verbatim + diff). */
  async editText(id: string, text: string): Promise<string> {
    const s = this.index.seg(id); if (!s) return this.notFound(id);
    // GUARDRAIL: reescribir un placeholder de leaders (".....", "____") con
    // relleno ("XXXX", "___", o directamente borrándolo) NO es una edición de
    // texto — es una conversión a campo, y a mano rompe el layout. La tool
    // correcta lo hace determinístico.
    if (looksLikeLeaderRewrite(s.text, text)) {
      return `⚠️ ${id} contiene placeholders (puntos/guiones o rellenos XXXX/xxx/***). NO los reescribas con edit_text: escribir espacios, "DD/MM/AAAA" o "[Etiqueta]" NO crea un campo rellenable y rompe el layout. Usá placeholders_to_fields(id, fields=[{placeholder,name}]) — convierte cada hueco en un campo AcroForm real (los rellenos los elimina sola).`;
    }
    const styled = applyTextDiff(originalStyledRuns(s), text);

    // ¿Entra en el renglón? Estimo con el ancho medio REAL del segmento (incluye
    // el espaciado justificado → sobreestima → seguro). Si no crece, ni mido.
    const env = this.reflowEnv();
    const para = paragraphOf(this.pageOf(s), s, env);
    const avgCharW = this.columnAvgCharW(s);
    const fits = text.length <= s.text.length || s.x + text.length * avgCharW <= para.rightEdge + 2;
    if (fits) {
      this.ledger.patchSegment(s, { runs: styled });
      return `✓ Texto ${id}: ${JSON.stringify(s.text)} → ${JSON.stringify(text)}`;
    }

    // Más largo que el renglón → reflow del párrafo con esta línea reemplazada.
    const toks = paragraphToks(para, [], { lineId: s.id, styled, avgCharW });
    const { extraLines, scale, aborted } = await reflowApply(s, para, toks, env, this.reExtract);
    if (aborted) return `⚠️ El texto nuevo NO entra en el párrafo ni comprimiendo (la página no tiene lugar para crecer). No modifiqué nada — acortá el texto o decime cómo preferís resolverlo.`;
    const grew = extraLines ? ` (+${extraLines} renglón/es, contenido inferior corrido)` : '';
    const note = scale < 1 ? ' ⚠ el párrafo quedó justo: revisá el resultado' : '';
    return `✓ Texto ${id} → ${JSON.stringify(text)} — párrafo reconstruido${grew}${note}`;
  }

  /** Cambia el ESTILO (negrita/itálica) de un nodo de texto entero. El bake
   *  re-encoda con la variante de fuente correspondiente (si el PDF no la trae
   *  embebida, cae a la estándar equivalente y lo reporta). */
  styleText(id: string, opts: { bold?: boolean; italic?: boolean }): string {
    const s = this.index.seg(id); if (!s) return this.notFound(id);
    if (opts.bold === undefined && opts.italic === undefined) return `⚠️ pasá bold y/o italic.`;
    const runs = originalStyledRuns(s).map(r => ({
      ...r,
      bold: opts.bold ?? r.bold,
      italic: opts.italic ?? r.italic,
    }));
    this.ledger.patchSegment(s, { runs });
    const parts = [opts.bold !== undefined ? `bold=${opts.bold}` : '', opts.italic !== undefined ? `italic=${opts.italic}` : ''].filter(Boolean);
    return `✓ Texto ${id} → ${parts.join(', ')}`;
  }
  moveText(id: string, x?: number, y?: number): string {
    const s = this.index.seg(id); if (!s) return this.notFound(id);
    this.ledger.patchSegment(s, { x, baseline: y });
    return `✓ Texto ${id} movido a @(${x ?? Math.round(s.x)},${y ?? Math.round(s.baseline)})`;
  }
  colorText(id: string, color: string): string {
    const s = this.index.seg(id); if (!s) return this.notFound(id);
    this.ledger.patchSegment(s, { color });
    return `✓ Texto ${id} → color ${color}`;
  }
  resizeText(id: string, fontSize: number): string {
    const s = this.index.seg(id); if (!s) return this.notFound(id);
    this.ledger.patchSegment(s, { fontSize });
    return `✓ Texto ${id} → ${fontSize}pt`;
  }
  deleteText(id: string): string {
    const s = this.index.seg(id); if (!s) return this.notFound(id);
    this.ledger.patchSegment(s, { remove: true });
    return `✓ Texto ${id} eliminado`;
  }

  /**
   * Elimina un nodo Y SUBE lo que queda debajo. Reusa el patrón del reflow
   * (`below` corridos por un `dy`), sin reconstruir párrafo. Dos modos:
   *
   *  - 'gap' (cerrar hueco): `dy` = el salto del nodo al primer contenido de
   *    abajo → ese sube a donde estaba el nodo, el resto conserva su separación.
   *  - 'top' (subir al tope): además reclama el MARGEN SUPERIOR — el primer
   *    contenido de abajo se lleva cerca del borde de la página (margen mínimo),
   *    así todo el bloque se pega arriba. Útil cuando el nodo borrado era lo más
   *    alto y "cerrar el hueco" no alcanza a mover nada a la vista.
   *
   * El pie/folio (baseline < 58) nunca se corre.
   */
  deleteTextPullUp(id: string, mode: 'gap' | 'top' = 'gap'): string {
    const s = this.index.seg(id); if (!s) return this.notFound(id);
    const page = this.pageOf(s);
    const myBase = this.effBaseline(s);
    const below = page.segments
      .filter(o => o.id !== id && !this.isRemoved(o.id) && this.effBaseline(o) < myBase - 1 && this.effBaseline(o) >= 58)
      .sort((a, b) => this.effBaseline(b) - this.effBaseline(a)); // el más alto primero
    this.ledger.patchSegment(s, { remove: true });
    if (!below.length) return `✓ Texto ${id} eliminado (nada debajo que subir).`;

    const firstBelow = below[0]!;
    let dy = myBase - this.effBaseline(firstBelow); // cerrar hueco
    if (mode === 'top') {
      // Reclamar el margen: el primer contenido sube hasta un margen superior
      // mínimo (~56pt del borde, menos el ascenso de su fuente). Nunca lo baja.
      const TOP_MARGIN = 56;
      const target = page.height - TOP_MARGIN - firstBelow.fontSize;
      dy = Math.max(dy, target - this.effBaseline(firstBelow));
    }
    if (dy <= 0.5) return `✓ Texto ${id} eliminado.`;
    for (const o of below) this.ledger.patchSegment(o, { baseline: this.effBaseline(o) + dy });
    const what = mode === 'top' ? 'subidos al tope de la página' : 'subidos para cerrar el hueco';
    return `✓ Texto ${id} eliminado y ${below.length} bloque(s) de abajo ${what} (${Math.round(dy)}pt).`;
  }

  // ── EDICIONES de imagen (nodos existentes) ──
  moveImage(id: string, patch: { x?: number; y?: number; width?: number; height?: number }): string {
    const im = this.index.img(id); if (!im) return `⚠️ No existe la imagen "${id}".`;
    this.ledger.patchRect(im, patch);
    return `✓ Imagen ${id} → @(${patch.x ?? Math.round(im.x)},${patch.y ?? Math.round(im.y)}) ${patch.width ?? Math.round(im.width)}×${patch.height ?? Math.round(im.height)}`;
  }
  deleteImage(id: string): string {
    const im = this.index.img(id); if (!im) return `⚠️ No existe la imagen "${id}".`;
    this.ledger.patchRect(im, { remove: true });
    return `✓ Imagen ${id} eliminada`;
  }

  // ── EDICIONES de campo / highlight / link existentes ──
  /** Un campo PENDIENTE de esta sesión (create encolado) por su nombre. */
  private pendingField(name: string): number {
    return this.creates.findIndex(c => c.kind === 'field' && c.name === name);
  }
  moveField(id: string, x?: number, y?: number): string {
    const w = this.index.widget(id);
    if (w) {
      this.ledger.patchRect(w, { x, y });
      return `✓ Campo ${id} movido a @(${x ?? Math.round(w.x)},${y ?? Math.round(w.y)})`;
    }
    // Campo PENDIENTE (recién convertido/creado en esta sesión): se muta el create.
    const qi = this.pendingField(id);
    if (qi >= 0) {
      const c = this.creates[qi]!;
      if (x !== undefined) c.x = x;
      if (y !== undefined) c.y = y;
      return `✓ Campo pendiente "${id}" movido a @(${Math.round(c.x as number)},${Math.round(c.y as number)})`;
    }
    return `⚠️ No existe el campo "${id}". Campos disponibles: ${this.fieldNames().join(', ') || '(ninguno)'}.`;
  }
  deleteField(id: string): string {
    const w = this.index.widget(id);
    if (w) {
      this.ledger.patchRect(w, { remove: true });
      return `✓ Campo ${id} eliminado`;
    }
    // Campo PENDIENTE: descartar el create (y su fill, si lo tenía).
    const qi = this.pendingField(id);
    if (qi >= 0) {
      this.creates.splice(qi, 1);
      this.fills.delete(id);
      return `✓ Campo pendiente "${id}" descartado (aún no estaba horneado).`;
    }
    return `⚠️ No existe el campo "${id}". Campos disponibles: ${this.fieldNames().join(', ') || '(ninguno)'}.`;
  }
  recolorHighlight(id: string, color: string): string {
    const h = this.index.highlight(id); if (!h) return `⚠️ No existe el resaltado "${id}".`;
    this.ledger.patchRect(h, { color });
    return `✓ Resaltado ${id} → color ${color}`;
  }
  deleteHighlight(id: string): string {
    const h = this.index.highlight(id); if (!h) return `⚠️ No existe el resaltado "${id}".`;
    this.ledger.patchRect(h, { remove: true });
    return `✓ Resaltado ${id} eliminado`;
  }
  deleteLink(id: string): string {
    const l = this.index.link(id); if (!l) return `⚠️ No existe el link "${id}".`;
    this.ledger.patchRect(l, { remove: true });
    return `✓ Link ${id} eliminado`;
  }

  /**
   * REEMPLAZA una PÁGINA ENTERA por contenido estructurado con estilos. La
   * división del trabajo de siempre: el LLM describe los BLOQUES (título,
   * encabezados, párrafos, viñetas); composePageBlocks (core) hace TODO el
   * layout — tipografía por tipo, wrap con medición real de fuente, márgenes,
   * espaciados. Borra el texto existente de la página y encola los bloques
   * como creates. Los campos/imágenes de la página quedan (borralos aparte).
   */
  async replacePage(pageNum: number, blocks: PageBlock[], bucket: FontBucket = 'serif'): Promise<string> {
    const page = this.doc.pages.find(p => p.page === pageNum);
    if (!page) return `⚠️ No existe la página ${pageNum} (el documento tiene ${this.doc.pages.length}).`;
    if (!blocks.length) return `⚠️ replace_page necesita al menos un bloque.`;

    const { specs, truncated, lines } = await composePageBlocks(blocks, page.width, page.height, bucket);
    if (!specs.length) return `⚠️ ningún bloque entró en la página (¿demasiado contenido?).`;

    // RE-COMPONER reemplaza, no acumula: si esta página ya fue compuesta en
    // esta sesión, descartar aquellos creates (el modelo a veces llama dos
    // veces — refinando el contenido — y sin esto ambas versiones se horneaban
    // ENCIMADAS: la página salía con todo el texto doble).
    const prev = this.composedByPage.get(pageNum);
    if (prev) for (const c of prev) { const i = this.creates.indexOf(c); if (i >= 0) this.creates.splice(i, 1); }

    let removed = 0;
    for (const seg of page.segments) {
      if (!this.isRemoved(seg.id)) { this.ledger.patchSegment(seg, { remove: true }); removed++; }
    }
    const mine: ReflowCreate[] = specs.map(spec => ({ kind: 'text' as const, ...spec, page: pageNum }));
    this.creates.push(...mine);
    this.composedByPage.set(pageNum, mine);

    const again = prev ? ' (recompuesta: la versión anterior de esta sesión fue descartada)' : '';
    const trunc = truncated.length ? ` ⚠️ ${truncated.length} bloque/s NO entraron (página llena): ${truncated.join(' · ')}` : '';
    return `✓ Página ${pageNum} recompuesta: ${removed} bloques viejos eliminados → ${specs.length} bloques nuevos (${lines} líneas, tipografía por tipo).${again}${trunc}`;
  }

  /**
   * Elimina CUALQUIER elemento por id, detectando su tipo (texto, imagen, campo,
   * resaltado, link). Una sola puerta para el agente en vez de una tool por tipo:
   * despacha al delete específico según qué nodo resuelve el índice. El texto
   * usa deleteText (sin subir nada); para subir lo de abajo está deleteTextPullUp.
   */
  deleteElement(id: string): string {
    if (this.index.seg(id)) return this.deleteText(id);
    if (this.index.img(id)) return this.deleteImage(id);
    if (this.index.widget(id)) return this.deleteField(id);
    if (this.index.highlight(id)) return this.deleteHighlight(id);
    if (this.index.link(id)) return this.deleteLink(id);
    if (this.pendingField(id) >= 0) return this.deleteField(id); // campo pendiente por nombre
    return this.notFound(id, "ningún elemento con id");
  }

  // ── CREACIONES (nodos nuevos — cola aplicada post-bake) ──
  highlightText(segId: string, color?: string): string {
    if (!this.index.seg(segId)) return this.notFound(segId);
    this.creates.push({ kind: 'highlightSeg', segId, color });
    return `✓ Resaltado sobre ${segId}${color ? ` (${color})` : ''}`;
  }
  linkText(segId: string, url: string): string {
    if (!this.index.seg(segId)) return this.notFound(segId);
    this.creates.push({ kind: 'linkSeg', segId, url });
    return `✓ Link sobre ${segId} → ${url}`;
  }
  /** Agrega texto nuevo. ANTI-COLISIÓN determinística: si el rect estimado pisa
   *  texto existente (u otro texto ya encolado), baja renglón a renglón hasta un
   *  hueco libre — el LLM no tiene que acertar la y exacta. */
  addTextNode(op: Omit<Extract<CreateOp, { kind: 'text' }>, 'kind'>): string {
    const page = this.doc.pages.find(p => p.page === op.page);
    const size = op.size ?? 11;
    let y = op.y; // esquina SUPERIOR-izquierda (baseline ≈ y - size)
    if (page) {
      const estW = Math.min(op.text.length * size * 0.55, page.width - op.x - 20);
      const collides = (yt: number): boolean =>
        page.segments.some(sg =>
          sg.baseline > yt - size * 1.5 && sg.baseline < yt + 2 &&
          sg.x < op.x + estW && sg.x + sg.width > op.x) ||
        this.creates.some(c =>
          c.kind === 'text' && c.page === op.page &&
          Math.abs((c.y as number) - yt) < size * 1.3 && (c.x as number) < op.x + estW);
      let guard = 0;
      while (collides(y) && y - size * 1.3 > 40 && guard++ < 60) y -= size * 1.3;
      if (collides(y)) y = op.y; // no hay lugar libre debajo: respetar lo pedido
    }
    const moved = Math.abs(y - op.y) > 1;
    this.creates.push({ kind: 'text', ...op, y });
    return `✓ Texto nuevo en p${op.page} @(${op.x},${Math.round(y)})${moved ? ` — BAJADO desde y=${Math.round(op.y)} (pisaba texto existente)` : ''}: ${JSON.stringify(op.text.slice(0, 40))}`;
  }
  insertImageFile(page: number, x: number, y: number, path: string, maxWidth?: number): string {
    this.creates.push({ kind: 'image', page, x, y, path, maxWidth });
    return `✓ Imagen "${path}" en p${page} @(${x},${y})`;
  }
  watermark(text: string, color?: string, opacity?: number): string {
    // GLOBAL (todas las páginas): idempotente. En el fan-out, los N editores de
    // página aplican la misma marca; sin esto quedaban N copias encimadas.
    if (this.creates.some(c => c.kind === 'watermark' && c.text === text)) {
      return `↩︎ ya hay una marca de agua ${JSON.stringify(text)} — no la repito.`;
    }
    this.creates.push({ kind: 'watermark', text, color, opacity });
    return `✓ Marca de agua: ${JSON.stringify(text)}`;
  }
  headerFooter(op: { header?: string; footer?: string; pageNumbers?: boolean }): string {
    // GLOBAL: idempotente por (header, footer, pageNumbers) — ver watermark.
    if (this.creates.some(c => c.kind === 'headerFooter' && c.header === op.header && c.footer === op.footer && c.pageNumbers === op.pageNumbers)) {
      return `↩︎ ese encabezado/pie ya está aplicado — no lo repito.`;
    }
    this.creates.push({ kind: 'headerFooter', ...op });
    return `✓ Encabezado/pie aplicado`;
  }
  addField(fieldType: WidgetKind, page: number, x: number, y: number, width?: number, height?: number, name?: string): string {
    this.creates.push({ kind: 'field', fieldType, page, x, y, width, height, name });
    return `✓ Campo ${fieldType} en p${page} @(${x},${y})`;
  }

  /**
   * DETERMINÍSTICO — reemplaza un PÁRRAFO ENTERO (todas sus líneas) por texto
   * nuevo, en UNA llamada: el código re-envuelve al ancho real del párrafo,
   * re-emite cada renglón, y corre el contenido inferior (baja si creció, SUBE
   * y cierra el hueco si se achicó). `id` = cualquier línea del párrafo.
   * Es LA herramienta para "reemplazá la cláusula/el punto N": jamás edit_text
   * + delete_text renglón por renglón (eso deja agujeros y piezas sueltas).
   */
  async replaceParagraph(id: string, text: string, endId?: string): Promise<string> {
    const s = this.index.seg(id); if (!s) return this.notFound(id);
    if (!text.trim()) return `⚠️ replace_paragraph necesita el texto nuevo (para borrar usá delete_text).`;
    const env = this.reflowEnv();
    let para = paragraphOf(this.pageOf(s), s, env);
    if (endId && endId !== id) {
      // BLOQUE multi-párrafo (una cláusula con varios párrafos): todas las líneas
      // de la MISMA columna entre id y end_id, cruzando los gaps entre párrafos.
      const e = this.index.seg(endId);
      if (!e) return this.notFound(endId, "el nodo de texto (end_id)");
      if (e.page !== s.page) return `⚠️ id y end_id deben estar en la misma página.`;
      const page = this.pageOf(s);
      // Rango en LÍNEAS VISUALES: de la primera línea de `id` a la última de
      // `end_id` (cada uno puede ser un bloque multilínea).
      const sTop = Math.max(...paraLinesOf(s, env).map(l => l.baseline));
      const eBot = Math.min(...paraLinesOf(e, env).map(l => l.baseline));
      const top = Math.max(sTop, eBot) + 1;
      const bottom = Math.min(sTop, eBot) - 1;
      const lines = page.segments
        .filter(x => !this.isRemoved(x.id) && Math.abs(x.x - s.x) < 6 && Math.abs(x.fontSize - s.fontSize) < 2)
        .flatMap(x => paraLinesOf(x, env))
        .filter(l => l.baseline <= top && l.baseline >= bottom)
        .sort((a, b) => b.baseline - a.baseline);
      if (lines.length < 2) return `⚠️ end_id no delimita un bloque (¿misma columna que id?).`;
      // leading = el paso de RENGLÓN real (el mínimo entre líneas consecutivas —
      // los gaps entre párrafos son más grandes y no cuentan como renglón).
      const steps: number[] = [];
      for (let i = 1; i < lines.length; i++) steps.push(lines[i - 1]!.baseline - lines[i]!.baseline);
      const leading = steps.length ? Math.min(...steps) : s.fontSize * 1.15;
      const rightEdge = Math.max(...lines.map(l => l.x + l.width));
      para = {
        page, lines, leading, rightEdge,
        capacity: rightEdge - Math.min(...lines.map(l => l.x)),
        spaceW: s.fontSize * 0.28,
        paraBottom: lines[lines.length - 1]!.baseline,
      };
    }
    if (para.lines.some(l => this.isRestyled(l.seg.id))) {
      return `↩︎ Ese párrafo/bloque ya fue modificado en esta sesión — no repitas la llamada (una sola llamada cubre toda la cláusula con end_id).`;
    }
    // GUARDRAIL a nivel BLOQUE (criterio de INTENCIÓN, no de pérdida — una
    // reescritura legítima de cláusula puede rozar leaders vecinos): párrafo con
    // placeholders + texto nuevo con PSEUDO-placeholders ("[Día inicio]",
    // espacios, "DD/MM") = conversión a mano — Sonnet usó esta tool como escape
    // cuando edit_text se lo rechazó (visto en un run real).
    if (looksLikePlaceholderConversion(para.lines.map(l => l.text).join('\n'), text)) {
      return `⚠️ Ese párrafo contiene placeholders (leaders o rellenos XXXX/xxx/***). NO los reescribas con replace_paragraph: escribir "[Etiqueta]", espacios o "DD/MM" NO crea un campo rellenable. Usá placeholders_to_fields(id, fields=[{placeholder,name}]) — convierte cada hueco en un campo AcroForm real (los rellenos los elimina sola).`;
    }
    const avgCharW = this.columnAvgCharW(s);
    const toks: ReflowTok[] = [...text.matchAll(/\S+/g)].map(m => ({
      kind: 'word' as const, text: m[0], w: m[0].length * avgCharW, bold: false, italic: false,
    }));
    if (!toks.length) return `⚠️ el texto nuevo quedó vacío.`;
    const { extraLines, freedLines, scale, aborted } = await reflowApply(s, para, toks, env, this.reExtract);
    if (aborted) return `⚠️ El texto nuevo NO entra en el bloque ni comprimiendo (la página no tiene lugar para crecer). No modifiqué nada — acortá el texto o decime cómo preferís resolverlo.`;
    const moved = extraLines
      ? ` (+${extraLines} renglón/es, contenido inferior corrido hacia abajo)`
      : freedLines
        ? ` (−${freedLines} renglón/es, contenido inferior SUBIDO — hueco cerrado)`
        : '';
    const note = scale < 1 ? ' ⚠ quedó justo: revisá el resultado' : '';
    return `✓ Párrafo de ${para.lines.length} línea(s) reemplazado por ${JSON.stringify(text.slice(0, 60))}…${moved}${note}`;
  }

  /**
   * Reemplaza una SECCIÓN entera por un párrafo — CRUZANDO PÁGINAS. Es lo que
   * replace_paragraph no puede (id/end_id deben ser de la misma página): acá
   * start_id y end_id pueden estar en páginas distintas. El span (todos los
   * nodos de texto en orden de lectura entre ambos, en TODAS las páginas que
   * toca) se colapsa: el PRIMER nodo pasa a ser el párrafo nuevo (con reflow en
   * su página), el resto se elimina. Mismo-página → delega en replaceParagraph.
   */
  async replaceSection(startId: string, endId: string, text: string): Promise<string> {
    const a = this.index.seg(startId); if (!a) return `⚠️ No existe el nodo "${startId}".`;
    const b = this.index.seg(endId); if (!b) return `⚠️ No existe el nodo "${endId}".`;
    if (!text.trim()) return `⚠️ replace_section necesita el texto nuevo.`;
    // Ordenar por lectura (página asc; dentro, baseline desc) → s primero.
    const readBefore = (x: SegmentNode, y: SegmentNode): number =>
      x.page !== y.page ? x.page - y.page : this.effBaseline(y) - this.effBaseline(x);
    const [s, e] = readBefore(a, b) <= 0 ? [a, b] : [b, a];
    if (s.page === e.page) return this.replaceParagraph(s.id, text, e.id);

    const sBase = this.effBaseline(s), eBase = this.effBaseline(e);
    const inSpan = (seg: SegmentNode): boolean => {
      const y = this.effBaseline(seg);
      const afterStart = seg.page > s.page || (seg.page === s.page && y <= sBase + 0.5);
      const beforeEnd = seg.page < e.page || (seg.page === e.page && y >= eBase - 0.5);
      return afterStart && beforeEnd;
    };
    const span = this.doc.pages.flatMap(p => p.segments).filter(seg => !this.isRemoved(seg.id) && inSpan(seg));
    // GUARDRAIL: mismo que replace_paragraph — una sección con placeholders no
    // se "convierte" reescribiéndola con etiquetas/espacios (eso no crea campos).
    if (looksLikePlaceholderConversion(span.map(seg => seg.text).join('\n'), text)) {
      return `⚠️ Esa sección contiene placeholders (leaders o rellenos XXXX/xxx/***). NO los reescribas con replace_section: usá placeholders_to_fields por párrafo — convierte cada hueco en un campo AcroForm real.`;
    }
    let removed = 0;
    for (const seg of span) if (seg.id !== s.id) { this.ledger.patchSegment(seg, { remove: true }); removed++; }
    const r = await this.replaceParagraph(s.id, text);
    if (r.startsWith('⚠️')) return r;
    return `✓ Sección ${s.id}→${e.id} reemplazada (${removed + 1} nodos en ${e.page - s.page + 1} páginas): el primero pasó a ser el párrafo nuevo, el resto se eliminó.`;
  }

  /**
   * DETERMINÍSTICO — el LLM DETECTA (pasa los substrings de placeholder + nombre
   * y opcionalmente el ancho útil) y el CÓDIGO (matchPlaceholders de core) hace
   * TODO el layout. DOS modos automáticos:
   *  - LEADERS usables (...../____) → campo DIRECTAMENTE sobre el rect real
   *    (charXOf), sin tocar el texto (cero reflow).
   *  - RELLENOS sin leader (XXXX, xxx, ***) → el placeholder se REESCRIBE como
   *    GAP EN BLANCO al ancho útil del dato y el párrafo se reacomoda
   *    (reflowApply); los campos se colocan al final sobre los GAPS MEDIDOS del
   *    preview horneado (placeFieldsInGaps) — acotados por los runs vecinos,
   *    imposible pisar texto.
   * `id` = cualquier línea del párrafo; `fields` en orden.
   */
  async placeholdersToFields(id: string, fields: Array<{ placeholder: string; name: string; width?: number }>): Promise<string> {
    const s = this.index.seg(id);
    if (!s) return this.notFound(id);
    if (!fields.length) return `⚠️ placeholders_to_fields necesita al menos un {placeholder,name}.`;
    const page = this.pageOf(s);
    const env = this.reflowEnv();
    const para = paragraphOf(page, s, env);
    const { lines } = para;

    // Idempotencia: rects ya ocupados por widgets del documento o campos ya
    // encolados por esta sesión (misma página).
    const existingWidgets: OccupiedRect[] = page.widgets.map(w => ({ x: w.x, y: w.y, width: w.width }));
    const queuedFields: OccupiedRect[] = this.creates
      .filter(c => c.kind === 'field' && c.page === s.page)
      .map(c => ({ x: c.x as number, y: c.y as number, width: c.width as number }));
    const ctx = { page: s.page, fontSize: s.fontSize, existingWidgets, queuedFields, nodeId: id };

    // Nombre ÚNICO en la sesión: los auto-nombres del barrido (campo_N) arrancan
    // de 0 en CADA llamada → colisionaban entre párrafos y addFormField los
    // renombraba a "texto_N" (nombres basura en el PDF final).
    const used = new Set(this.fieldNames());
    const uniq = (n: string): string => {
      let out = n; let i = 2;
      while (used.has(out)) out = `${n}_${i++}`;
      used.add(out);
      return out;
    };

    const res = matchPlaceholders(lines, fields, ctx);
    if (res.error) return `⚠️ ${res.error}`;
    if (!res.needsReflow) {
      for (const f of res.fields) {
        this.creates.push({ kind: 'field', fieldType: f.fieldType, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, name: uniq(f.name) });
      }
      if (res.nothingNew) return `↩︎ Nada nuevo que convertir en ese párrafo (los placeholders ya tienen campo). No repitas la llamada.`;
      return `✓ ${res.fields.length} campo(s) creados SOBRE los placeholders (texto intacto, sin reflow): ${res.notes.join(' · ')}`;
    }

    // ── REESCRITURA + REFLOW (hay rellenos XXXX/xxx/***) ────────────────────
    // Acá el texto SÍ se reescribe: cada hueco se emite como GAP EN BLANCO al
    // ancho ÚTIL del dato — el relleno DESAPARECE del documento — y reflowApply
    // reacomoda el párrafo (renglón extra + contenido inferior corrido si
    // crece; huecos elásticos si la página no da). La colocación final es por
    // GAPS MEDIDOS (placeFieldsInGaps) sobre el rePage que el reflow ya midió.
    if (para.lines.some(l => this.isRestyled(l.seg.id))) {
      return `↩︎ Ese párrafo ya fue convertido en esta sesión — no repitas la llamada (UNA llamada con todos los fields[] cubre el párrafo).`;
    }
    const toks = paragraphToks(para, res.holes!);
    const { layout, rePage, aborted, extraLines, scale } = await reflowApply(s, para, toks, env, this.reExtract);
    if (aborted) return `⚠️ Los campos no entran en el párrafo ni comprimiendo (la página no tiene lugar para crecer). No modifiqué nada.`;
    const placed = placeFieldsInGaps(para, s.x, layout, rePage, scale, ctx);
    for (const f of placed.fields) {
      this.creates.push({ kind: 'field', fieldType: f.fieldType, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, name: uniq(f.name) });
    }
    if (!placed.fields.length) return `↩︎ Nada nuevo que convertir en ese párrafo. No repitas la llamada.`;
    const grew = extraLines ? ` (+${extraLines} renglón/es, contenido inferior corrido)` : '';
    return `✓ ${placed.fields.length} campo(s): placeholders reescritos como huecos EN BLANCO (el relleno XXXX/*** se ELIMINÓ del texto) y campo sobre cada hueco${grew}: ${[...res.notes, ...placed.notes].join(' · ')}`;
  }

  /** Los nombres de campo ALCANZABLES: widgets del documento + campos PENDIENTES
   *  encolados por esta sesión (placeholders_to_fields / add_form_field). */
  private fieldNames(): string[] {
    const doc = this.doc.pages.flatMap(p => p.widgets.map(w => w.fieldName));
    const queued = this.creates.filter(c => c.kind === 'field' && typeof c.name === 'string').map(c => c.name as string);
    return [...new Set([...doc, ...queued])];
  }

  /** COMPLETA un campo de formulario por su NOMBRE o por su id de widget
   *  ([[p1-w3]] de la vista de Lectura — se resuelve al fieldName). Vale también
   *  para un campo PENDIENTE de esta sesión (recién convertido/creado): el bake
   *  completa los formularios AL FINAL, sobre el PDF ya con los campos creados.
   *  Valor: texto para text/select/radio, true/false para checkbox. */
  fillField(nameOrId: string, value: string | boolean | string[]): string {
    let fieldName = nameOrId;
    const known = this.fieldNames();
    if (!known.includes(fieldName)) {
      const byId = this.index.widget(nameOrId.replace(/^\[\[|\]\]$/g, ''));
      if (!byId) return `⚠️ No existe un campo llamado "${nameOrId}" (ni como fieldName ni como id). Campos disponibles: ${known.join(', ') || '(ninguno)'}.`;
      fieldName = byId.fieldName;
    }
    this.fills.set(fieldName, value);
    return `✓ Campo "${fieldName}" ← ${JSON.stringify(value)}`;
  }

  /** COMPLETA VARIOS campos de una (por fieldName o id de widget) — UNA sola tool
   *  call en vez de N idas y vueltas con el modelo (clave para forms grandes). */
  fillFields(entries: Array<{ name: string; value: string | boolean | string[] }>): string {
    const lines = entries.map(e => this.fillField(e.name, e.value));
    return lines.join('\n');
  }

  /** Precarga ediciones ya existentes (p. ej. las pendientes del editor UI). */
  seed(edits: SegmentEdit[] = [], imageEdits: ImageEdit[] = []): void {
    const snap = this.ledger.snapshot();
    const segments = new Map(snap.segments);
    const images = new Map(snap.images);
    for (const e of edits) segments.set(e.segmentId, e);
    for (const e of imageEdits) images.set(e.imageId, e);
    this.ledger.restore({ ...snap, segments, images });
  }

  /** La vista EFECTIVA de una página: los segmentos del grafo con el ledger
   *  aplicado (texto/posición actuales, eliminados marcados). Es lo que las
   *  tools devuelven como "estado actualizado" tras cada edición (patrón MCP:
   *  el system prompt no se re-escribe — la vista fresca viaja en el resultado). */
  effectiveSegments(page: number): Array<{ id: string; text: string; x: number; baseline: number; removed: boolean; edited: boolean }> {
    const p = this.doc.pages.find(pg => pg.page === page);
    if (!p) return [];
    return p.segments.map(s => {
      const e = this.ledger.segmentEdit(s.id);
      return {
        id: s.id,
        text: e?.text ?? s.text,
        x: e?.x ?? s.x,
        baseline: e?.baseline ?? s.baseline,
        removed: e?.remove === true,
        edited: !!e && e.remove !== true,
      };
    });
  }

  /** Ediciones de texto/imagen acumuladas (lo que el editor sabe aplicar a su
   *  estado local; las creaciones/annotations se hornean en el server/CLI). */
  getEdits(): { edits: SegmentEdit[]; imageEdits: ImageEdit[] } {
    const snap = this.ledger.snapshot();
    return { edits: [...snap.segments.values()], imageEdits: [...snap.images.values()] };
  }

  /** Cantidad total de cambios pendientes. */
  get count(): number {
    return this.ledger.size + this.creates.length + this.fills.size;
  }

  /** ¿Hay cambios que el editor NO puede reflejar con getEdits() (creaciones,
   *  ediciones de annotations, o llenado de formularios)? El server los hornea +
   *  persiste en vez de devolverlos como seg/img edits. */
  get hasBakedOps(): boolean {
    const snap = this.ledger.snapshot();
    return this.creates.length + snap.widgets.size + snap.highlights.size + snap.links.size + this.fills.size > 0;
  }

  summary(): string {
    const snap = this.ledger.snapshot();
    const parts: string[] = [];
    for (const e of snap.segments.values()) parts.push(e.remove ? `${e.segmentId}: eliminar` : `${e.segmentId}: editar`);
    for (const e of snap.images.values()) parts.push(e.remove ? `${e.imageId}: eliminar` : `${e.imageId}: mover/escalar`);
    for (const e of snap.widgets.values()) parts.push(`${e.widgetId}: campo`);
    for (const e of snap.highlights.values()) parts.push(`${e.highlightId}: resaltado`);
    for (const e of snap.links.values()) parts.push(`${e.linkId}: link`);
    for (const c of this.creates) parts.push(`+${c.kind}`);
    for (const [name] of this.fills) parts.push(`${name}: completar`);
    return parts.join(' · ') || '(sin cambios)';
  }

  /** Aplica una CREACIÓN sobre los bytes ya horneados (bytes→bytes). */
  private async applyCreate(pdf: Uint8Array, op: CreateOp): Promise<Uint8Array> {
    switch (op.kind) {
      case 'highlightSeg': {
        const s = this.index.seg(op.segId)!;
        const g = effectiveGeometry(s, this.ledger.segmentEdit(op.segId) ?? null);
        return (await addHighlight(pdf, { page: s.page, x: g.x, y: g.y, width: g.width, height: g.height, color: op.color })).pdf;
      }
      case 'linkSeg': {
        const s = this.index.seg(op.segId)!;
        const g = effectiveGeometry(s, this.ledger.segmentEdit(op.segId) ?? null);
        return (await addLink(pdf, { page: s.page, x: g.x, y: g.y, width: g.width, height: g.height, url: op.url })).pdf;
      }
      case 'text':
        return (await addText(pdf, op)).pdf;
      case 'image': {
        const bytes = new Uint8Array(await readFile(op.path));
        const ext = op.path.split('.').pop()?.toLowerCase() ?? '';
        const mime = MIME[ext];
        if (!mime) throw new Error(`imagen no soportada (${op.path}): solo PNG/JPEG`);
        return (await insertImage(pdf, { page: op.page, x: op.x, y: op.y, bytes, mime, maxWidth: op.maxWidth })).pdf;
      }
      case 'watermark':
        return (await addWatermark(pdf, { text: op.text, opacity: op.opacity, color: op.color })).pdf;
      case 'headerFooter':
        return (await addHeaderFooter(pdf, { header: op.header, footer: op.footer, pageNumbers: op.pageNumbers })).pdf;
      case 'field':
        return (await addFormField(pdf, { type: op.fieldType, page: op.page, x: op.x, y: op.y, width: op.width, height: op.height, name: op.name })).pdf;
    }
  }

  /** Hornea TODO (ediciones + annotations + creaciones + fills) → resultado. */
  async bake(): Promise<{ pdf: Uint8Array; applied: string[]; warnings: string[] }> {
    throwIfCancelled(this.cancellation);
    const r = await bake(this.doc.bytes.slice(), this.ledger.toBakeInput());
    let pdf = r.pdf;
    const applied = [...r.applied];
    const warnings = [...r.warnings];
    for (const raw of this.creates) { pdf = await this.applyCreate(pdf, raw as unknown as CreateOp); applied.push(`+${raw.kind}`); }
    // Completar formularios AL FINAL (sobre el PDF ya con los campos creados, por
    // si el agente creó un campo y lo completó en el mismo turno).
    if (this.fills.size) {
      const res = await setFieldValues(pdf, Object.fromEntries(this.fills));
      pdf = res.pdf;
      applied.push(...res.applied.map(a => `campo ${a}`));
      warnings.push(...res.warnings);
    }
    return { pdf, applied, warnings };
  }

  /** Solo los BYTES del estado actual (el seam `bake()` del ReflowEnv). */
  private async bakeBytes(): Promise<Uint8Array> {
    return (await this.bake()).pdf;
  }

  /** Hornea y escribe el PDF a `outPath`. */
  async save(outPath: string): Promise<{ applied: string[]; warnings: string[] }> {
    const { pdf, applied, warnings } = await this.bake();
    await writeFile(outPath, pdf);
    return { applied, warnings };
  }

  /** Cierra el turno con la política de producto (ver {@link TurnFinish}):
   *  hornea si hay cambios que el editor no representa localmente; si no,
   *  devuelve las ediciones acumuladas. */
  async finishTurn(): Promise<TurnFinish> {
    if (this.hasBakedOps) {
      const { pdf, applied, warnings } = await this.bake();
      return { kind: 'baked', pdf, applied, warnings };
    }
    const { edits, imageEdits } = this.getEdits();
    return { kind: 'edits', edits, imageEdits };
  }
}
