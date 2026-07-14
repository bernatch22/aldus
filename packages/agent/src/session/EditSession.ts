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
  paragraphOf, paraLinesOf, paragraphToks, reflowApply, matchPlaceholders,
  looksLikeLeaderRewrite, EditLedger,
  NeverCancelled, throwIfCancelled,
  type CancellationToken,
  type SegmentEdit, type ImageEdit, type SegmentNode, type WidgetKind, type FontBucket,
  type PageGraph, type ReflowTok, type ReflowEnv,
  type ReflowCreate, type LayoutEnv, type OccupiedRect,
} from '@aldus/core';
import {
  bake, addHighlight, addLink, addText, addWatermark, addHeaderFooter, addFormField, insertImage, setFieldValues,
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

  // ── EDICIONES de texto (nodos existentes) ──
  /** Edita el texto de un nodo. Si el texto NUEVO es más ancho de lo que entra
   *  en su renglón, el PÁRRAFO se reconstruye (reflow determinístico): lo que
   *  sobra baja al renglón siguiente en cascada — nunca se superpone ni se sale
   *  del borde. Texto igual o más corto = camino simple (verbatim + diff). */
  async editText(id: string, text: string): Promise<string> {
    const s = this.index.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    // GUARDRAIL: reescribir un placeholder de leaders (".....", "____") con
    // relleno ("XXXX", "___", o directamente borrándolo) NO es una edición de
    // texto — es una conversión a campo, y a mano rompe el layout. La tool
    // correcta lo hace determinístico.
    if (looksLikeLeaderRewrite(s.text, text)) {
      return `⚠️ ${id} contiene placeholders de puntos/guiones. NO los reescribas con edit_text: usá placeholders_to_fields(id, fields=[{placeholder,name}]) — convierte los huecos en campos reales sin romper el layout.`;
    }
    const styled = applyTextDiff(originalStyledRuns(s), text);

    // ¿Entra en el renglón? Estimo con el ancho medio REAL del segmento (incluye
    // el espaciado justificado → sobreestima → seguro). Si no crece, ni mido.
    const env = this.reflowEnv();
    const para = paragraphOf(this.pageOf(s), s, env);
    const avgCharW = s.width / Math.max(1, s.text.length);
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
    const s = this.index.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
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
    const s = this.index.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    this.ledger.patchSegment(s, { x, baseline: y });
    return `✓ Texto ${id} movido a @(${x ?? Math.round(s.x)},${y ?? Math.round(s.baseline)})`;
  }
  colorText(id: string, color: string): string {
    const s = this.index.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    this.ledger.patchSegment(s, { color });
    return `✓ Texto ${id} → color ${color}`;
  }
  resizeText(id: string, fontSize: number): string {
    const s = this.index.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    this.ledger.patchSegment(s, { fontSize });
    return `✓ Texto ${id} → ${fontSize}pt`;
  }
  deleteText(id: string): string {
    const s = this.index.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    this.ledger.patchSegment(s, { remove: true });
    return `✓ Texto ${id} eliminado`;
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
  moveField(id: string, x?: number, y?: number): string {
    const w = this.index.widget(id); if (!w) return `⚠️ No existe el campo "${id}".`;
    this.ledger.patchRect(w, { x, y });
    return `✓ Campo ${id} movido a @(${x ?? Math.round(w.x)},${y ?? Math.round(w.y)})`;
  }
  deleteField(id: string): string {
    const w = this.index.widget(id); if (!w) return `⚠️ No existe el campo "${id}".`;
    this.ledger.patchRect(w, { remove: true });
    return `✓ Campo ${id} eliminado`;
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

  // ── CREACIONES (nodos nuevos — cola aplicada post-bake) ──
  highlightText(segId: string, color?: string): string {
    if (!this.index.seg(segId)) return `⚠️ No existe el nodo de texto "${segId}".`;
    this.creates.push({ kind: 'highlightSeg', segId, color });
    return `✓ Resaltado sobre ${segId}${color ? ` (${color})` : ''}`;
  }
  linkText(segId: string, url: string): string {
    if (!this.index.seg(segId)) return `⚠️ No existe el nodo de texto "${segId}".`;
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
    this.creates.push({ kind: 'watermark', text, color, opacity });
    return `✓ Marca de agua: ${JSON.stringify(text)}`;
  }
  headerFooter(op: { header?: string; footer?: string; pageNumbers?: boolean }): string {
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
    const s = this.index.seg(id); if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    if (!text.trim()) return `⚠️ replace_paragraph necesita el texto nuevo (para borrar usá delete_text).`;
    const env = this.reflowEnv();
    let para = paragraphOf(this.pageOf(s), s, env);
    if (endId && endId !== id) {
      // BLOQUE multi-párrafo (una cláusula con varios párrafos): todas las líneas
      // de la MISMA columna entre id y end_id, cruzando los gaps entre párrafos.
      const e = this.index.seg(endId);
      if (!e) return `⚠️ No existe el nodo de texto "${endId}" (end_id).`;
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
    const avgCharW = s.width / Math.max(1, s.text.length);
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
   * DETERMINÍSTICO — el LLM DETECTA (pasa los substrings de placeholder + nombre
   * y opcionalmente el ancho útil) y el CÓDIGO (matchPlaceholders de core) hace
   * TODO el layout: localiza cada hueco (leader elástico, flex multi-línea,
   * des-hifenado Word), expande al run máximo, barre los leaders huérfanos, y
   * coloca cada campo DIRECTAMENTE sobre el rect real (charXOf), sin tocar el
   * texto (cero reflow). `id` = cualquier línea del párrafo; `fields` en orden.
   */
  async placeholdersToFields(id: string, fields: Array<{ placeholder: string; name: string; width?: number }>): Promise<string> {
    const s = this.index.seg(id);
    if (!s) return `⚠️ No existe el nodo de texto "${id}".`;
    if (!fields.length) return `⚠️ placeholders_to_fields necesita al menos un {placeholder,name}.`;
    const page = this.pageOf(s);
    const { lines } = paragraphOf(page, s, this.layoutEnv);

    // Idempotencia: rects ya ocupados por widgets del documento o campos ya
    // encolados por esta sesión (misma página).
    const existingWidgets: OccupiedRect[] = page.widgets.map(w => ({ x: w.x, y: w.y, width: w.width }));
    const queuedFields: OccupiedRect[] = this.creates
      .filter(c => c.kind === 'field' && c.page === s.page)
      .map(c => ({ x: c.x as number, y: c.y as number, width: c.width as number }));

    const res = matchPlaceholders(lines, fields, {
      page: s.page, fontSize: s.fontSize, existingWidgets, queuedFields, nodeId: id,
    });
    if (res.error) return `⚠️ ${res.error}`;
    for (const f of res.fields) {
      this.creates.push({ kind: 'field', fieldType: f.fieldType, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, name: f.name });
    }
    if (res.nothingNew) return `↩︎ Nada nuevo que convertir en ese párrafo (los placeholders ya tienen campo). No repitas la llamada.`;
    return `✓ ${res.fields.length} campo(s) creados SOBRE los placeholders (texto intacto, sin reflow): ${res.notes.join(' · ')}`;
  }

  /** COMPLETA un campo de formulario por su NOMBRE o por su id de widget
   *  ([[p1-w3]] de la vista de Lectura — se resuelve al fieldName). Valor:
   *  texto para text/select/radio, true/false para checkbox. Determinístico. */
  fillField(nameOrId: string, value: string | boolean | string[]): string {
    let fieldName = nameOrId;
    if (!this.doc.pages.some(p => p.widgets.some(w => w.fieldName === fieldName))) {
      const byId = this.index.widget(nameOrId.replace(/^\[\[|\]\]$/g, ''));
      if (!byId) return `⚠️ No existe un campo llamado "${nameOrId}" (ni como fieldName ni como id).`;
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
