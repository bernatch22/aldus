/**
 * Applying SegmentEdits to a page — the text side of the bake.
 *
 * The emit paths are STRATEGIES probed in registration order; each one
 * self-gates via `canHandle` (js-debug style: the decision of "is this mine?"
 * lives inside the strategy, not in a switch):
 *
 *  A) {@link VerbatimReemit} — move/scale/re-style only → every extirpated
 *     show op is re-emitted VERBATIM (same bytes, same font, same color, TJ
 *     kerning intact) with a relocated/scaled matrix. Pixel-perfect.
 *  B/C) {@link StyledRunsReemit} — new text or new style, emitted PER STYLED
 *     RUN: (B) re-encoded with the ORIGINAL font via its reverse /ToUnicode
 *     map when the subset covers it; (C) otherwise queued as a standard-font
 *     fallback draw — an explicit, reported substitution (Acrobat's policy),
 *     preserving the original op color.
 *
 * Adding a new emit path = a new class + one entry in
 * {@link textEmitStrategies}. Never edit a sibling (ley del CLAUDE.md).
 *
 * v2: semántica VERBATIM de v1 bake/text.ts; StyledRunsReemit descompuesto en
 * helpers puros NOMBRADOS (opForStyleMap/bodyOpOf/splitIntoLineRuns) sin
 * cambiar la matemática; subrayados vía bake/underline.ts (fuente única);
 * colores vía common/{hex,rawFill}.
 */
import type { SegmentEdit } from '../model/edits.js';
import type { StyledRun } from '../model/nodes.js';
import { IDENTITY } from '../common/matrix.js';
import { hexToRg, hexToRgbObj, rgbToHex } from '../common/hex.js';
import { toRgb } from '../common/rawFill.js';
import type { ShowOp } from '../pdf/contentWalk.js';
import type { Splice } from '../pdf/splice.js';
import { fmt } from '../common/bytes.js';
import { baseFontFamilyOf } from './fonts/fontService.js';
import { TextOpLocator, TEXT_NOT_LOCATED_REASON } from './locate/textOpLocator.js';
import { isLocateConflict } from './locate/types.js';
import { newTextBlock, reemitBlock, type TextStyleOverrides } from './textEmit.js';
import { underlineRectFor, underlineRectsFor } from './underline.js';
import { fitHScale } from './widthFit.js';
import { BakeCodes } from './report.js';
import type { PageBakeContext } from './context.js';

export interface SegmentEmitContext {
  /** El unit-of-work de la página (doc, page, src, sinks, fonts, report). */
  ctx: PageBakeContext;
  edit: SegmentEdit;
  /** Geometry-matched show ops of the segment (non-empty, not stale). */
  ops: ShowOp[];
}

export interface ITextEmitStrategy {
  /** Cheap, stateless self-gate — no I/O, no guessing. */
  canHandle(edit: SegmentEdit): boolean;
  emit(c: SegmentEmitContext): void;
}

/**
 * Does re-emitting at (x, y) IN PLACE fall (partly) outside the op's active
 * CLIP rect? If so, the in-place splice would render NOTHING (the clip crops
 * it) — the emission must go at the END of the stream (identity CTM, no clip).
 * Margin of 1pt: borderline targets escape too (half-clipped text is broken).
 */
const escapesClip = (o: ShowOp, x: number, y: number): boolean => {
  if (!o.clip) return false;
  const m = 1;
  return x < o.clip.x - m || x > o.clip.x + o.clip.width + m || y < o.clip.y - m || y > o.clip.y + o.clip.height + m;
};

/** Un ShowOp "des-anidado": mismo op pero como si corriera al FINAL del stream
 *  (CTM identidad, así relTm emite la matriz ABSOLUTA). */
const atStreamEnd = (o: ShowOp): ShowOp => ({ ...o, ctm: IDENTITY });

/** Scale/position/style shared by every strategy. */
const editBasics = (edit: SegmentEdit) => ({
  ratio: (edit.fontSize ?? edit.original.fontSize) / edit.original.fontSize,
  newX: edit.x ?? edit.original.x,
  newBaseline: edit.baseline ?? edit.original.baseline,
  styleOv: {
    charSpacing: edit.charSpacing,
    hScale: edit.hScale,
    colorRaw: edit.color ? hexToRg(edit.color) : undefined,
  } satisfies TextStyleOverrides,
});

/** Path A: move/scale/re-style — each op verbatim, relocated IN PLACE. */
class VerbatimReemit implements ITextEmitStrategy {
  canHandle(edit: SegmentEdit): boolean {
    return edit.text === edit.original.text && edit.font === undefined && !edit.runs;
  }

  emit({ ctx, edit, ops }: SegmentEmitContext): void {
    const { splices, appendBlocks, report } = ctx;
    const src = ctx.src;
    const fillRects = ctx.walk.fillRects;
    const { ratio, newX, newBaseline, styleOv } = editBasics(edit);
    const editSplices: Splice[] = [];
    const editAppends: string[] = [];
    for (const o of ops) {
      const nx = newX + (o.x - edit.original.x) * ratio;
      const ny = newBaseline + (o.y - edit.original.baseline) * ratio;
      // Destino FUERA del clip del op: el in-place se recortaría a nada (el
      // texto "desaparece" al renderizar aunque los ops existan). Extirpar el
      // original y re-emitir al final del stream (CTM identidad, sin clip).
      const escaped = escapesClip(o, nx, ny);
      const block = reemitBlock(escaped ? atStreamEnd(o) : o, src, ratio, nx, ny, styleOv);
      if (!block) {
        report.warning(BakeCodes.DegenerateMatrix, edit.segmentId);
        return;
      }
      if (escaped) {
        editSplices.push({ start: o.record.start, end: o.record.end, text: '' });
        editAppends.push(block);
      } else {
        editSplices.push({ start: o.record.start, end: o.record.end, text: block });
      }
    }
    splices.push(...editSplices);
    appendBlocks.push(...editAppends);
    // Sus SUBRAYADOS lo siguen: extirpar el rect viejo y re-emitirlo con el
    // mismo desplazamiento/escala (al final del stream, CTM identidad).
    for (const r of underlineRectsFor(edit, fillRects)) {
      splices.push({ start: r.start, end: r.end, text: '' });
      const nx = newX + (r.x - edit.original.x) * ratio;
      const ny = newBaseline + (r.y - edit.original.baseline) * ratio;
      const fill = r.fillColorRaw || '0 0 0 rg';
      appendBlocks.push(`q ${fill} ${fmt(nx)} ${fmt(ny)} ${fmt(r.width * ratio)} ${fmt(r.height * ratio)} re f Q`);
    }
    report.applied(BakeCodes.SegmentRelocated, edit.segmentId, { ops: ops.length });
  }
}

/**
 * Fuente POR ESTILO desde los ops originales. OJO: un run del mismo estilo
 * puede ser un super/subíndice de OTRO tamaño (el "1" de "API1", un footnote):
 * si ese ganara la key, TODO el texto se re-emitiría con su fuente CHICA
 * ("todo el grafo pequeñito"). Preferimos el op cuyo tamaño está más cerca del
 * NOMINAL del segmento (el cuerpo), no el super/subíndice. (Defensa pagada —
 * NO tocar sin el test superscript.)
 */
function opForStyleMap(edit: SegmentEdit, ops: ShowOp[]): Map<string, ShowOp> {
  const dominant = edit.original.fontSize;
  const opForStyle = new Map<string, ShowOp>();
  for (const or of edit.original.runs ?? []) {
    const op = ops.find(o => Math.abs(o.x - or.x) <= 2.5);
    if (!op) continue;
    const key = `${or.bold}|${or.italic}`;
    const cur = opForStyle.get(key);
    if (!cur || Math.abs(op.fontSize - dominant) < Math.abs(cur.fontSize - dominant)) opForStyle.set(key, op);
  }
  return opForStyle;
}

/** Fallback: el op de CUERPO (tamaño ≈ nominal), nunca el super/subíndice. */
function bodyOpOf(edit: SegmentEdit, ops: ShowOp[], firstOp: ShowOp): ShowOp {
  const dominant = edit.original.fontSize;
  return ops.reduce((a, o) => Math.abs(o.fontSize - dominant) < Math.abs(a.fontSize - dominant) ? o : a, firstOp);
}

/**
 * A graph node CAN contain line breaks: the text splits into LINES on '\n'
 * and each one drops `leading` (1.2×size, typographically standard). Each
 * run's dx is RELATIVE to its line (the editor computes it so).
 */
function splitIntoLineRuns(runsToEmit: StyledRun[]): StyledRun[][] {
  const lineRuns: StyledRun[][] = [[]];
  for (const sr of runsToEmit) {
    const parts = sr.text.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lineRuns.push([]);
      if (p) lineRuns[lineRuns.length - 1]!.push({ ...sr, text: p });
    });
  }
  return lineRuns;
}

/**
 * Paths B/C: new content or new style — ALWAYS emitted per styled run. Each
 * run's style picks the FONT: the style→resource map comes from the original
 * runs (x + bold/italic) matched against the stream ops — the PDF already
 * owns both the bold variant and the regular as its own resources.
 *
 * Catch-all: registered LAST; `canHandle` always claims.
 */
class StyledRunsReemit implements ITextEmitStrategy {
  canHandle(): boolean {
    return true;
  }

  emit({ ctx, edit, ops }: SegmentEmitContext): void {
    const { doc, page, pageNum, splices, appendBlocks, fallbackDraws, report } = ctx;
    const { ratio, newX, newBaseline, styleOv } = editBasics(edit);
    const familyChanged = edit.font !== undefined;

    // The segment's ops are emptied; the new content goes IN PLACE of the
    // first one (z-order intact).
    for (const o of ops.slice(1)) splices.push({ start: o.record.start, end: o.record.end, text: '' });
    // Old UNDERLINES out too — the runs below re-emit fresh ones (sr.underline).
    for (const r of underlineRectsFor(edit, ctx.walk.fillRects)) splices.push({ start: r.start, end: r.end, text: '' });
    const firstOp = ops[0]!;
    const inlineBlocks: string[] = [];

    const runsToEmit: StyledRun[] = edit.runs ?? [{
      text: edit.text,
      bold: edit.original.bold ?? false,
      italic: edit.original.italic ?? false,
      dx: 0,
    }];
    const opForStyle = opForStyleMap(edit, ops);
    const bodyOp = bodyOpOf(edit, ops, firstOp);

    const lineRuns = splitIntoLineRuns(runsToEmit);
    const leading = (edit.fontSize ?? edit.original.fontSize) * 1.2;
    // ¿Alguna línea cae fuera del clip del punto de inserción? → TODO el
    // bloque nuevo va al final del stream (extirpando el op original) en vez
    // de in-place, o el clip lo recortaría a nada.
    const escaped = lineRuns.some((_, li) => escapesClip(firstOp, newX, newBaseline - li * leading));

    // WIDTH FITTING solo sin overrides de Tc/Tz del usuario (su intención manda
    // sobre el encaje geométrico) — ver bake/widthFit.ts.
    const wantFit = styleOv.hScale === undefined && styleOv.charSpacing === undefined;
    let substituted = 0;
    for (let li = 0; li < lineRuns.length; li++) {
      const lineBase = newBaseline - li * leading;
      const runsInLine = lineRuns[li]!;
      for (let ri = 0; ri < runsInLine.length; ri++) {
        const sr = runsInLine[ri]!;
        if (!sr.text) continue;
        const x = newX + sr.dx * ratio;
        // SLOT geométrico del run: ancla del run SIGUIENTE de la línea − la
        // propia (dx reales del PDF cuando el edit trae runs anclados —
        // restyleFromGraph). Sin run siguiente (fin de línea) no hay slot:
        // comportamiento intacto.
        const nextInLine = runsInLine[ri + 1];
        const rawSlot = edit.runs && nextInLine ? (nextInLine.dx - sr.dx) * ratio : undefined;
        const slotWidth = wantFit && rawSlot !== undefined && Number.isFinite(rawSlot) && rawSlot > 0 ? rawSlot : undefined;
        const fontName = familyChanged ? undefined : opForStyle.get(`${sr.bold}|${sr.italic}`)?.fontName;
        const bytes = fontName ? ctx.fonts.encoderForFont(doc, page, fontName)?.encode(sr.text) ?? null : null;
        // Per-run color (selection) > segment override > the original op's.
        const runOv: TextStyleOverrides = {
          ...styleOv,
          colorRaw: sr.color ? hexToRg(sr.color) : styleOv.colorRaw,
        };
        const srcForBlock = opForStyle.get(`${sr.bold}|${sr.italic}`) ?? bodyOp;
        // WIDTH FITTING (path B): el re-encode pierde el kerning TJ original —
        // con slot conocido y una fuente que expone anchos CONFIABLES
        // (/Widths o /W Identity: FontService.widthOfBytes; si no, null y NO
        // se ajusta), Tz encaja el run en su hueco. Ancho natural en pts de
        // página: unidades/1000 × Tf × escala X de la matriz × ratio (a Tz=100,
        // Tc=0 — exactamente lo que emite newTextBlock sin overrides).
        let fittedTz: number | undefined;
        if (slotWidth !== undefined && fontName && bytes) {
          const units = ctx.fonts.widthOfBytes(doc, page, fontName, bytes);
          if (units !== null) {
            const scaleX = Math.hypot(srcForBlock.matrix[0], srcForBlock.matrix[1]) * ratio;
            fittedTz = fitHScale((units / 1000) * srcForBlock.fontSize * scaleX, slotWidth);
            if (fittedTz !== undefined) runOv.hScale = fittedTz;
          }
        }
        const inlineBlock = fontName && bytes
          ? newTextBlock(escaped ? atStreamEnd(srcForBlock) : srcForBlock, ratio, x, lineBase, bytes, runOv)
          : null;
        if (inlineBlock) {
          inlineBlocks.push(inlineBlock);
          // UNDERLINE: PDFs have no underline attribute — draw the line (a
          // thin rect) under the run, at the end of the stream (identity CTM
          // → absolute coords). Width measured by the editor (sr.w).
          // Geometría desde underline.ts (fuente única de la tríada).
          if (sr.underline && sr.w) {
            const size = edit.fontSize ?? edit.original.fontSize;
            const c = sr.color
              ? hexToRgbObj(sr.color)
              : edit.color
                ? hexToRgbObj(edit.color)
                : toRgb((ops.find(o => o.fontName === fontName) ?? firstOp)?.fillColorRaw) ?? { r: 0, g: 0, b: 0 };
            // Con fit, el ancho DIBUJADO es el slot — el subrayado mide lo que se ve.
            const u = underlineRectFor(x, lineBase, size, fittedTz !== undefined ? slotWidth! : sr.w * ratio);
            appendBlocks.push(
              `q ${fmt(c.r)} ${fmt(c.g)} ${fmt(c.b)} rg ${fmt(u.x)} ${fmt(u.y)} ${fmt(u.width)} ${fmt(u.height)} re f Q`,
            );
          }
        } else {
          if (!/^\s+$/.test(sr.text)) {
            // Preserve the ORIGINAL op color unless explicitly overridden —
            // without this, font substitution used to paint everything black.
            const srcOp = ops.find(o => o.fontName === fontName) ?? firstOp;
            const color = sr.color
              ? hexToRgbObj(sr.color)
              : edit.color
                ? hexToRgbObj(edit.color)
                : toRgb(srcOp?.fillColorRaw) ?? undefined;
            fallbackDraws.push({
              page: pageNum,
              text: sr.text,
              x,
              y: lineBase,
              size: edit.fontSize ?? edit.original.fontSize,
              bucket: edit.font ?? edit.original.bucket ?? 'sans',
              bold: sr.bold,
              italic: sr.italic,
              // FAMILIA original del op ("Cambria") — cambio EXPLÍCITO de
              // familia (edit.font) no la lleva: el usuario pidió otra.
              family: familyChanged ? undefined : baseFontFamilyOf(page, (srcOp ?? firstOp).fontName) ?? undefined,
              color: color ?? undefined,
              underline: sr.underline,
              // SLOT geométrico → el fallback encaja el dibujo con Tz (la cara
              // sustituta es más ancha/angosta que el hueco entre anclas).
              ...(slotWidth !== undefined ? { targetWidth: slotWidth } : {}),
            });
          }
          substituted++;
        }
      }
    }
    if (escaped) {
      splices.push({ start: firstOp.record.start, end: firstOp.record.end, text: '' });
      if (inlineBlocks.length) appendBlocks.push(inlineBlocks.join('\n'));
    } else {
      splices.push({ start: firstOp.record.start, end: firstOp.record.end, text: inlineBlocks.join('\n') });
    }
    if (substituted && !familyChanged) {
      report.warning(BakeCodes.SubsetInsufficient, edit.segmentId, { substituted });
    }
    if (familyChanged) report.applied(BakeCodes.SegmentFamilyChanged, edit.segmentId);
    else report.applied(BakeCodes.SegmentRewritten, edit.segmentId, { runs: runsToEmit.length });
  }
}

/** The registry, probed in order; first `canHandle` wins. Catch-all last. */
export const textEmitStrategies: readonly ITextEmitStrategy[] = [
  new VerbatimReemit(),
  new StyledRunsReemit(),
];

const textLocator = new TextOpLocator();

/**
 * ESCUDO NaN: ¿algún número que el emit escribiría al stream NO es finito?
 * Un run sin `dx` (o con NaN) hace `newX + sr.dx * ratio` = NaN → `fmt(NaN)`
 * escribe "NaN" en el Tm → PDF corrupto ("Unknown command NaN" / "Tm expected
 * 6 args, got 4"). Ley del proyecto: lo que no puede hacer bien, NO lo toca —
 * el edit entero se salta con warning {@link BakeCodes.InvalidGeometry}.
 */
function hasNonFiniteGeometry(edit: SegmentEdit): boolean {
  const bad = (v: number | undefined) => v !== undefined && !Number.isFinite(v);
  if (bad(edit.fontSize) || bad(edit.x) || bad(edit.baseline) || bad(edit.charSpacing) || bad(edit.hScale)) return true;
  // ratio = (fontSize ?? original.fontSize) / original.fontSize: un original
  // degenerado (0/NaN) también propaga NaN/Infinity a toda la emisión.
  if (!Number.isFinite(edit.original.fontSize) || edit.original.fontSize === 0) return true;
  if (!Number.isFinite(edit.original.x) || !Number.isFinite(edit.original.baseline)) return true;
  for (const r of edit.runs ?? []) {
    if (!Number.isFinite(r.dx)) return true; // dx es REQUERIDO: undefined → NaN
    if (r.w !== undefined && !Number.isFinite(r.w)) return true;
  }
  return false;
}

/**
 * Apply ONE SegmentEdit on its page: locate by geometry, record the exact
 * segment color, handle removal, then probe the emit strategies. (El cuerpo
 * del loop de v1 applySegmentEditsToPage — el loop vive en SegmentEditApplier.)
 */
export function applySegmentEdit(edit: SegmentEdit, ctx: PageBakeContext): void {
  const { splices, report } = ctx;
  // Escudo NaN ANTES de tocar nada: un edit con geometría no finita jamás
  // llega a los sinks (splices/appendBlocks) — el segmento queda intacto.
  if (hasNonFiniteGeometry(edit)) {
    report.warning(BakeCodes.InvalidGeometry, edit.segmentId);
    return;
  }
  const located = textLocator.locate(edit.original, ctx.walk.shows);
  if (located === null || isLocateConflict(located)) {
    const reason = located === null ? TEXT_NOT_LOCATED_REASON : located.conflict;
    report.warning(BakeCodes.SegmentNotLocated, edit.segmentId, { reason });
    return;
  }
  const ops = located;
  // EXACT segment color (first op that painted ink) — for the editor's
  // ghost, more faithful than sampling pixels.
  const colorOp = ops.find(o => toRgb(o.fillColorRaw));
  if (colorOp) {
    const c = toRgb(colorOp.fillColorRaw);
    if (c) report.color(edit.segmentId, rgbToHex(c));
  }
  // REMOVE: extirpate every op of the segment — and its underlines with it.
  if (edit.remove) {
    for (const o of ops) splices.push({ start: o.record.start, end: o.record.end, text: '' });
    for (const r of underlineRectsFor(edit, ctx.walk.fillRects)) splices.push({ start: r.start, end: r.end, text: '' });
    report.applied(BakeCodes.SegmentRemoved, edit.segmentId);
    return;
  }

  const emitCtx: SegmentEmitContext = { ctx, edit, ops };
  for (const strategy of textEmitStrategies) {
    if (strategy.canHandle(edit)) {
      strategy.emit(emitCtx);
      break;
    }
  }
}
