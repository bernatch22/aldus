/**
 * layout/reflow.ts — el MOTOR de reflow de párrafo (Layer 2, geometría
 * determinística). Trasplante VERBATIM en semántica de v1 session.reflowApply:
 * re-envuelve, re-emite cada renglón con runs anclados a posiciones CALCULADAS
 * (dx propio, nunca heredado), hornea un preview, MIDE y corrige EN LOOP hasta
 * que ningún renglón se pasa del borde ni dos tramos chocan. Si el párrafo
 * crece corre lo de abajo; si se achica lo sube y cierra el hueco.
 *
 * Dos seams inyectados (core no importa pdfjs ni sabe cómo hornea el host):
 *  - `ReflowEnv`: el estado mutable (ledger de segment-edits + cola de creates)
 *    y el `bake()` (bytes del estado actual). F5 (EditSession) lo implementa.
 *  - `reExtract(bytes) => PageGraph[]`: re-extracción del preview (el caller pasa
 *    graphFromBytes en Node, el suyo en el browser; el TEST usa la cadena
 *    bake→extract de core).
 *
 * Las constantes (regla dura #2: NO cambian de valor, se NOMBRAN) viven en
 * {@link ReflowLimits} — parametrizable SIN tocar el algoritmo (OCP por parámetro).
 *
 * Las defensas pagadas con sangre (audit-agent §4) están INTACTAS: abort+restore
 * si no entra ni comprimiendo (#9), capShrink ≤ 40% (#10), dxFix acotado a 4
 * espacios (#11), des-hifenado (#12, en paragraph.paragraphToks), MARGIN_FLOOR
 * que no corre el folio/pie (#13), holes elásticos (#14).
 */

import { createLogger } from '../common/log.js';
import type { PageGraph, SegmentNode, StyledRun } from '../model/nodes.js';
import type { SegmentEdit } from '../model/edits.js';
import type { SegmentPatch } from '../edit/mergeEdits.js';
import type { LayoutEnv, Paragraph, ReflowTok } from './paragraph.js';

const log = createLogger('aldus:reflow');

/** Una CREACIÓN pendiente que el reflow toca (emite texto extra; re-ancla campos
 *  de llamadas anteriores). Permisiva a propósito — F5 usa su CreateOp union. */
export interface ReflowCreate {
  kind: string;
  page?: number;
  x?: number;
  y?: number;
  text?: string;
  size?: number;
  [key: string]: unknown;
}

/** El estado mutable + el bake que el reflow necesita. F5 lo implementa sobre el
 *  EditLedger; el TEST con un Map + core bake. */
export interface ReflowEnv extends LayoutEnv {
  putSeg(seg: SegmentNode, patch: SegmentPatch): void;
  deleteSeg(id: string): void;
  /** Snapshot SOLO de los segment-edits (abort+restore del párrafo). */
  snapshotSegments(): ReadonlyMap<string, SegmentEdit>;
  restoreSegments(snap: ReadonlyMap<string, SegmentEdit>): void;
  /** La cola de creaciones (se emiten renglones extra; se re-anclan campos). */
  creates: ReflowCreate[];
  /** Hornea el ESTADO ACTUAL (edits + creates) → bytes del PDF. */
  bake(): Promise<Uint8Array>;
}

/** Re-extracción del preview: bytes → páginas. Inyectado (core no importa pdfjs). */
export type ReExtract = (bytes: Uint8Array) => Promise<PageGraph[]>;

/** Constantes del reflow (regla dura #2: se NOMBRAN, jamás cambian de valor). */
export interface ReflowLimits {
  /** El mobiliario de margen (folio/pie: baseline < esto) no cuenta como slack
   *  ni se corre jamás. */
  MARGIN_FLOOR: number;
  /** Máximo de renglones que el párrafo puede crecer. */
  maxExtraLines: number;
  /** capShrink ACOTADO a esta fracción de la capacidad (anti una-palabra-por-renglón). */
  capShrinkFrac: number;
  /** dxFix acotado a este número de espacios por pasada (anti empuje fuera de página). */
  dxFixMaxSpaces: number;
  /** Un hueco solo baja de renglón si NO queda al menos esto de espacio decente
   *  (si queda, se ENCOGE — un hueco solo en renglón nuevo no se puede medir). */
  holeMinElasticPt: number;
}

export const DEFAULT_REFLOW_LIMITS: ReflowLimits = {
  MARGIN_FLOOR: 58,
  maxExtraLines: 3,
  capShrinkFrac: 0.4,
  dxFixMaxSpaces: 4,
  holeMinElasticPt: 40,
};

export interface ReflowResult {
  layout: ReflowTok[][];
  rePage: PageGraph | undefined;
  scale: number;
  extraLines: number;
  /** Renglones LIBERADOS (el párrafo se achicó): lo de abajo subió a cerrarlos. */
  freedLines: number;
  /** true = NO entró ni comprimiendo: no se aplicó NADA (estado restaurado). */
  aborted?: boolean;
}

/** Re-envuelve, aplica y MIDE EN LOOP. Ver el header del archivo. */
export async function reflowApply(
  s: SegmentNode,
  para: Paragraph,
  toks: ReflowTok[],
  env: ReflowEnv,
  reExtract: ReExtract,
  limits: ReflowLimits = DEFAULT_REFLOW_LIMITS,
): Promise<ReflowResult> {
  const { page, lines, leading, rightEdge, capacity, spaceW, paraBottom } = para;
  // Slack REAL para crecer: el fondo EFECTIVO del CONTENIDO de la página (con
  // los corrimientos de llamadas anteriores). El mobiliario de margen (folio,
  // pie: baseline < MARGIN_FLOOR) NO cuenta — ni limita el slack ni se corre.
  const MARGIN_FLOOR = limits.MARGIN_FLOOR;
  const pageBottomEff = Math.min(paraBottom, ...page.segments
    .filter(o => !env.isRemoved(o.id) && env.effBaseline(o) >= MARGIN_FLOOR)
    .map(o => env.effBaseline(o)));
  const slackBelow = Math.max(0, pageBottomEff - MARGIN_FLOOR);
  const maxExtraLines = Math.min(limits.maxExtraLines, Math.floor(slackBelow / leading));

  const holeW = (t: ReflowTok, scale: number) => Math.max(25, t.hole!.target * scale);
  // `capShrink` recorta la capacidad del renglón: cuando el preview muestra que
  // una palabra se pasó del borde, subimos capShrink por el excedente MEDIDO y
  // el próximo wrap corta ANTES (la palabra baja de renglón) — el texto nunca
  // termina en el margen ni clippeado.
  const wrap = (scale: number, capShrink: number): ReflowTok[][] => {
    const cap = capacity - capShrink;
    const rows: ReflowTok[][] = [[]];
    let curW = 0;
    for (const t of toks) {
      const w = t.kind === 'hole' ? holeW(t, scale) : t.w;
      const sep = rows[rows.length - 1]!.length ? spaceW : 0;
      if (curW + sep + w > cap && rows[rows.length - 1]!.length) {
        // Un HUECO es elástico: si queda espacio decente en el renglón, se
        // ENCOGE a ese espacio en vez de bajar (un hueco solo en un renglón
        // nuevo no tiene glifos vecinos → el campo no se podría medir).
        const avail = cap - curW - sep;
        if (t.kind === 'hole' && avail >= limits.holeMinElasticPt) {
          const shrunk: ReflowTok = { ...t, hole: { ...t.hole!, target: avail / scale } };
          rows[rows.length - 1]!.push(shrunk);
          curW += sep + avail;
          continue;
        }
        rows.push([]); curW = 0;
      }
      rows[rows.length - 1]!.push(t);
      curW += (rows[rows.length - 1]!.length > 1 ? spaceW : 0) + w;
    }
    return rows;
  };

  const BOUNDARY_PAD = 2; // aire al cambiar de estilo (deriva de estimación)
  // Corrección de anclas MEDIDA, por (fila, índice de run emitido). La clave
  // vieja era el TEXTO del run: en un párrafo español "de" aparece 4 veces —
  // el fix del que colisionaba se aplicaba a TODOS los inocentes y el culpable
  // podía quedar igual. La clave posicional pega el fix al run exacto.
  const dxFix = new Map<string, number>();
  // Los runs emitidos de la ÚLTIMA aplicación, por fila global: el measure loop
  // los necesita para (a) matchear cada colisión medida con SU run emitido y
  // (b) detectar anclas PISADAS aunque pdf.js fusione los items solapados.
  let emittedRows: StyledRun[][] = [];
  // Un HUECO se emite como GAP GEOMÉTRICO PURO: NINGÚN glifo — el run anterior
  // se cierra, el cursor avanza el ancho del hueco, y el run siguiente se ancla
  // con dx PASADO el gap. El campo se ubica después midiendo los gaps grandes
  // entre runs re-extraídos ({@link placeFieldsInGaps}): los bordes de run son
  // geometría EXACTA de la extracción → el campo no puede pisar texto jamás.
  // (La versión anterior emitía espacios/puntos y estimaba posiciones con charX
  // sobre runs mixtos: la deriva corría los campos ENCIMA del texto.)
  const rowRuns = (row: ReflowTok[], scale: number, rowIdx: number): StyledRun[] => {
    const runs: StyledRun[] = [];
    let cursor = 0;
    let afterHole = false;
    for (const t of row) {
      const isFirst = runs.length === 0 && !afterHole;
      const sep = isFirst ? 0 : spaceW;
      if (t.kind === 'hole') { cursor += sep + holeW(t, scale); afterHole = true; continue; }
      const bold = !!t.bold, italic = !!t.italic;
      const last = runs[runs.length - 1];
      if (last && !afterHole && last.bold === bold && last.italic === italic) {
        last.text += ' ' + t.text!; // mismo estilo y sin gap en el medio: fluye en el run
      } else {
        runs.push({ text: t.text!, bold, italic, dx: cursor + sep + (runs.length ? BOUNDARY_PAD : 0) });
      }
      afterHole = false;
      cursor += sep + t.w;
    }
    runs.forEach((r, j) => {
      const fix = dxFix.get(`${rowIdx}:${j}`);
      if (fix) r.dx += fix;
    });
    emittedRows[rowIdx] = runs;
    return runs;
  };

  const createStart = env.creates.length;
  // COMPOSICIÓN entre llamadas: TODO en geometría EFECTIVA pre-llamada. Las
  // líneas del párrafo son VISUALES (un bloque multilínea aporta varias del
  // mismo segmento); sus baselines efectivas ya vienen en ParaLine. Los
  // SEGMENTOS del párrafo (para emisión y exclusión) en orden de lectura.
  const lineBl = lines.map(l => l.baseline);
  const paraSegs = [...new Set(lines.map(l => l.seg))];
  const segBl = new Map(paraSegs.map(g => [g.id, env.effBaseline(g)] as const));
  const below = page.segments.filter(o =>
    !env.isRemoved(o.id) && env.effBaseline(o) < paraBottom - 1 &&
    env.effBaseline(o) >= 58 /* el folio/pie no se corre */ && !paraSegs.some(g => g.id === o.id));
  const belowBase = new Map(below.map(o => [o.id, env.effBaseline(o)] as const));
  // Widgets creados por llamadas ANTERIORES: su y pre-llamada (el ajuste es
  // absoluto por iteración — antes se acumulaba 6 veces dentro del loop).
  const priorFieldY = new Map<number, number>();
  for (let ci = 0; ci < createStart; ci++) {
    const c = env.creates[ci]!;
    if (c.kind === 'field' && c.page === s.page) priorFieldY.set(ci, c.y!);
  }
  const touched = new Set<string>();
  // Snapshot pre-llamada: si el layout NO entra ni comprimiendo, se ABORTA y se
  // restaura todo — el motor jamás aplica un resultado que destruye la página
  // (ley de Aldus: lo que no puede hacer bien, no lo toca).
  const preEdits = env.snapshotSegments();
  let scale = 1;
  let capShrink = 0;
  let layout: ReflowTok[][] = [];
  let extraLines = 0;
  let rePage: PageGraph | undefined;

  // Cada iteración hornea el DOC ENTERO (caro). 6 alcanza para resolver overflow
  // (recorte de capacidad) Y colisiones (re-ancla); más era lento.
  for (let iter = 0; iter < 6; iter++) {
    layout = wrap(scale, capShrink);
    while (layout.length > lines.length + maxExtraLines && scale > 0.3) { scale *= 0.9; layout = wrap(scale, capShrink); }
    if (layout.length > lines.length + maxExtraLines + 2) {
      // Ni al mínimo entra (p. ej. la página no tiene lugar para crecer):
      // restaurar y rehusar en vez de degenerar en una-palabra-por-renglón.
      env.restoreSegments(preEdits);
      env.creates.length = createStart;
      return { layout, rePage, scale, extraLines: 0, freedLines: 0, aborted: true };
    }
    extraLines = Math.max(0, layout.length - lines.length);

    // (re)aplicar desde cero: ediciones frescas + creates truncados. La emisión
    // es POR SEGMENTO: cada bloque recibe SUS filas unidas con '\n' (el bake
    // emite cada línea con su leading) — un segmento-por-renglón recibe
    // exactamente una fila, como siempre.
    emittedRows = [];
    env.creates.length = createStart;
    for (const g of paraSegs) env.deleteSeg(g.id);
    {
      let k = 0;
      for (const g of paraSegs) {
        const count = lines.filter(l => l.seg === g).length;
        const rows: StyledRun[][] = [];
        for (let i = 0; i < count; i++, k++) rows.push(k < layout.length ? rowRuns(layout[k]!, scale, k) : []);
        // Los renglones EXTRA del overflow pertenecen al PÁRRAFO (un párrafo es
        // un conjunto de nodos): van al ÚLTIMO segmento como filas '\n' extra,
        // horneadas por el camino de segment-edit — fuente EMBEBIDA del bloque
        // con fallback por glifo, igual que el editor. Antes eran un create de
        // texto suelto, que dibuja SIEMPRE con fuente estándar → la última
        // línea de un párrafo que crecía salía en otra tipografía.
        if (g === paraSegs[paraSegs.length - 1]) {
          for (; k < layout.length; k++) rows.push(rowRuns(layout[k]!, scale, k));
        }
        while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop();
        const flat: StyledRun[] = [];
        rows.forEach((rr, i) => {
          if (i > 0) {
            if (flat.length) flat[flat.length - 1] = { ...flat[flat.length - 1]!, text: flat[flat.length - 1]!.text + '\n' };
            else flat.push({ text: '\n', bold: false, italic: false, dx: 0 });
          }
          flat.push(...rr);
        });
        // baseline EFECTIVA congelada: si el segmento venía corrido por un
        // reflow anterior, el corrimiento se re-aplica (el delete lo borró).
        const blPatch = Math.abs(segBl.get(g.id)! - g.baseline) > 0.01 ? { baseline: segBl.get(g.id)! } : {};
        if (flat.length) env.putSeg(g, { runs: flat, ...blPatch });
        else env.putSeg(g, { remove: true, ...blPatch });
      }
    }
    // (Los renglones extra ya viajan dentro del último segmento — ver arriba.)
    // Corrimiento del contenido INFERIOR, en AMBOS sentidos y por SPAN REAL: el
    // nuevo fondo del bloque es la baseline de la última línea USADA (si se
    // achicó) o paraBottom − extra·leading (si creció). Así, un bloque multi-
    // párrafo (end_id) que se compacta también TRAGA los gaps entre párrafos —
    // sin esto quedaba un agujero blanco del alto liberado.
    const newBottom = layout.length <= lines.length
      ? lines[Math.max(0, layout.length - 1)]!.baseline
      : paraBottom - (layout.length - lines.length) * leading;
    const dy = paraBottom - newBottom; // >0: creció (bajar lo de abajo) · <0: se achicó (subirlo)
    if (Math.abs(dy) > 0.5) {
      for (const other of below) {
        env.putSeg(other, { baseline: belowBase.get(other.id)! - dy });
        touched.add(other.id);
      }
      for (const [ci, y0] of priorFieldY) {
        const c = env.creates[ci]!;
        if (c.kind === 'field' && y0 < paraBottom - 1) c.y = y0 - dy;
      }
    } else if (touched.size) {
      // una iteración previa corrió y esta ya no: restaurar el estado pre-llamada.
      for (const other of below) if (touched.has(other.id)) env.putSeg(other, { baseline: belowBase.get(other.id)! });
      for (const [ci, y0] of priorFieldY) { const c = env.creates[ci]!; if (c.kind === 'field') c.y = y0; }
      touched.clear();
    }

    // MEDIR: (a) ningún renglón puede pasarse del borde de texto original (los
    // generadores tipo Word CLIPPEAN ahí), (b) gap mínimo entre tramos — si
    // chocan o quedan pegados, corrijo el ancla con el corrimiento medido.
    const pdf = await env.bake();
    const rePages = await reExtract(pdf.slice());
    rePage = rePages.find(p => p.page === s.page);
    let maxOver = 0; // cuánto se pasó del borde el renglón más ancho
    let collided = false;
    const MIN_GAP = spaceW * 0.7;
    // Incremento ACOTADO por pasada: la deriva real de estimación converge en
    // 2-3 pasadas; una "colisión" de cientos de pt contra contenido ajeno en
    // pleno corrimiento NO es deriva y sin tope empujaba tramos fuera de página.
    const bump = (rowIdx: number, runIdx: number, delta: number, why: string): void => {
      const key = `${rowIdx}:${runIdx}`;
      dxFix.set(key, (dxFix.get(key) ?? 0) + Math.min(delta, spaceW * limits.dxFixMaxSpaces));
      log(`  fix ${key} +${Math.round(Math.min(delta, spaceW * limits.dxFixMaxSpaces) * 10) / 10} (${why}) → ${Math.round(dxFix.get(key)! * 10) / 10}`);
    };
    for (let k = 0; k < layout.length; k++) {
      const bl = k < lines.length ? lineBl[k]! : paraBottom - leading * (k - lines.length + 1);
      const rowX0 = k < lines.length ? lines[k]!.x : s.x;
      const rowSegs = (rePage?.segments ?? [])
        .filter(x => Math.abs(x.baseline - bl) < 6 && x.x >= s.x - 3)
        .sort((a, b) => a.x - b.x);
      const flat = rowSegs.flatMap(seg => seg.runs).sort((a, b) => a.x - b.x);
      const emitted = emittedRows[k] ?? [];
      // El run emitido cuyo ANCLA está más cerca de una x medida (el fix va al
      // run EXACTO, no a todos los que comparten texto).
      const nearestEmitted = (x: number): number => {
        let bj = -1, bd = Infinity;
        emitted.forEach((r, j) => { const d = Math.abs(rowX0 + r.dx - x); if (d < bd) { bd = d; bj = j; } });
        return bj;
      };
      for (let i = 0; i < flat.length; i++) {
        maxOver = Math.max(maxOver, flat[i]!.x + flat[i]!.width - rightEdge);
        if (i > 0) {
          const gap = flat[i]!.x - (flat[i - 1]!.x + flat[i - 1]!.width);
          // Colisión = SOLAPE REAL (gap negativo). Un gap ≈0 NO es colisión:
          // pdf.js parte los items de un tramo re-emitido EXACTAMENTE en el
          // cambio de estilo (bold→regular) y reporta tangencia SIEMPRE — el
          // viejo umbral `< MIN_GAP` disparaba eterno ahí, acumulaba fixes y
          // el texto terminaba desbordando el margen (abort espurio).
          if (gap < -0.5) {
            collided = true;
            const bj = nearestEmitted(flat[i]!.x);
            if (bj > 0) bump(k, bj, MIN_GAP - gap, `solape ${Math.round(gap * 10) / 10} en "${flat[i]!.text.slice(0, 12)}"`);
          }
        }
      }
      // ANCLAS PISADAS: cuando el run anterior rinde MÁS ancho que lo estimado
      // (línea justificada: la re-emisión hereda el Tw estirado), el run se
      // dibuja ADENTRO del anterior y pdf.js FUSIONA ambos items — el chequeo
      // de gaps no ve nada ("regirá desde elde"). Se detecta por ancla: si a la
      // x esperada de un run emitido no ARRANCA ningún item medido y un item la
      // ATRAVIESA, el anterior lo pisó → se corre el ancla.
      for (let j = 1; j < emitted.length; j++) {
        const anchorX = rowX0 + emitted[j]!.dx;
        const startsHere = flat.some(r => Math.abs(r.x - anchorX) < 2.5);
        if (startsHere) continue;
        const spanning = flat.find(r => r.x < anchorX - 2 && r.x + r.width > anchorX + 1);
        if (!spanning) continue;
        collided = true;
        bump(k, j, spanning.x + spanning.width - anchorX + MIN_GAP, `ancla pisada @${Math.round(anchorX)} por "${spanning.text.slice(0, 12)}" (end ${Math.round(spanning.x + spanning.width)})`);
      }
    }
    log(`iter ${iter}: filas=${layout.length}/${lines.length} scale=${Math.round(scale * 100) / 100} capShrink=${Math.round(capShrink)} maxOver=${Math.round(maxOver * 10) / 10} collided=${collided} fixes=${dxFix.size}`);
    const overflow = maxOver > 3;
    if (!overflow && !collided) break;
    // Última pasada y sigue desbordado: NO se entrega un layout roto — se
    // restaura todo y se rehúsa (ley: lo que no puede hacer bien, no lo toca).
    if (iter === 5 && overflow) {
      env.restoreSegments(preEdits);
      env.creates.length = createStart;
      return { layout, rePage, scale, extraLines: 0, freedLines: 0, aborted: true };
    }
    // Overflow del borde → recortá la capacidad por el excedente medido (+aire)
    // para que la palabra que sobra baje de renglón la próxima pasada; además
    // achicá los huecos (el excedente suele venir del ancho REAL de los espacios
    // del hueco ≠ estimado). capShrink está ACOTADO al 40% de la capacidad: sin
    // el tope, el ratchet iterativo la comía entera y el wrap degeneraba en
    // una-palabra-por-renglón (documento destruido).
    if (overflow) {
      capShrink = Math.min(capShrink + maxOver + spaceW, capacity * limits.capShrinkFrac);
      scale *= toks.some(t => t.kind === 'hole') ? 0.9 : 0.96;
    }
  }
  return { layout, rePage, scale, extraLines, freedLines: Math.max(0, lines.length - layout.length) };
}
