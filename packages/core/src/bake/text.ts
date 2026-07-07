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
 * {@link textEmitStrategies}. Never edit a sibling.
 */
import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { SegmentEdit, StyledRun } from '../model.js';
import type { ShowOp } from './textWalk.js';
import type { ReverseEncoder } from './toUnicode.js';
import { hexToRg, hexToRgbObj, rawFillToRgb, rgbToHex } from './color.js';
import { encoderForFont } from './fonts.js';
import { matchOps } from './locate.js';
import { fmt, type Splice } from './splice.js';
import { newTextBlock, reemitBlock, type TextStyleOverrides } from './textEmit.js';
import type { FallbackDraw } from './fallback.js';
import type { BakeReport } from './report.js';

export interface SegmentEmitContext {
  doc: PDFDocument;
  page: PDFPage;
  pageNum: number;
  edit: SegmentEdit;
  /** Geometry-matched show ops of the segment (non-empty, not stale). */
  ops: ShowOp[];
  src: Uint8Array;
  encCache: Map<string, ReverseEncoder | null>;
  /** Sink: in-place stream replacements. */
  splices: Splice[];
  /** Sink: blocks appended at the end of the stream (identity CTM). */
  appendBlocks: string[];
  /** Sink: queued standard-font draws (path C). */
  fallbackDraws: FallbackDraw[];
  report: BakeReport;
}

export interface ITextEmitStrategy {
  /** Cheap, stateless self-gate — no I/O, no guessing. */
  canHandle(edit: SegmentEdit): boolean;
  emit(ctx: SegmentEmitContext): void;
}

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

  emit({ edit, ops, src, splices, report }: SegmentEmitContext): void {
    const { ratio, newX, newBaseline, styleOv } = editBasics(edit);
    const editSplices: Splice[] = [];
    for (const o of ops) {
      const block = reemitBlock(o, src, ratio,
        newX + (o.x - edit.original.x) * ratio,
        newBaseline + (o.y - edit.original.baseline) * ratio,
        styleOv);
      if (!block) {
        report.warn(`${edit.segmentId}: matriz degenerada — sin cambios`);
        return;
      }
      editSplices.push({ start: o.record.start, end: o.record.end, text: block });
    }
    splices.push(...editSplices);
    report.apply(`${edit.segmentId}: reubicado/escalado (${ops.length} op${ops.length > 1 ? 's' : ''})`);
  }
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

  emit(ctx: SegmentEmitContext): void {
    const { edit, ops, doc, page, pageNum, encCache, splices, appendBlocks, fallbackDraws, report } = ctx;
    const { ratio, newX, newBaseline, styleOv } = editBasics(edit);
    const familyChanged = edit.font !== undefined;

    // The segment's ops are emptied; the new content goes IN PLACE of the
    // first one (z-order intact).
    for (const o of ops.slice(1)) splices.push({ start: o.record.start, end: o.record.end, text: '' });
    const firstOp = ops[0];
    const inlineBlocks: string[] = [];

    const runsToEmit: StyledRun[] = edit.runs ?? [{
      text: edit.text,
      bold: edit.original.bold ?? false,
      italic: edit.original.italic ?? false,
      dx: 0,
    }];
    const fontForStyle = new Map<string, string>();
    for (const or of edit.original.runs ?? []) {
      const op = ops.find(o => Math.abs(o.x - or.x) <= 2.5);
      const key = `${or.bold}|${or.italic}`;
      if (op && !fontForStyle.has(key)) fontForStyle.set(key, op.fontName);
    }

    // A graph node CAN contain line breaks: the text splits into LINES on
    // '\n' and each one drops `leading` (1.2×size, typographically standard).
    // Each run's dx is RELATIVE to its line (the editor computes it so).
    const lineRuns: StyledRun[][] = [[]];
    for (const sr of runsToEmit) {
      const parts = sr.text.split('\n');
      parts.forEach((p, i) => {
        if (i > 0) lineRuns.push([]);
        if (p) lineRuns[lineRuns.length - 1].push({ ...sr, text: p });
      });
    }
    const leading = (edit.fontSize ?? edit.original.fontSize) * 1.2;

    let substituted = 0;
    for (let li = 0; li < lineRuns.length; li++) {
      const lineBase = newBaseline - li * leading;
      for (const sr of lineRuns[li]) {
        if (!sr.text) continue;
        const x = newX + sr.dx * ratio;
        const fontName = familyChanged ? undefined : fontForStyle.get(`${sr.bold}|${sr.italic}`);
        const bytes = fontName ? encoderForFont(doc, page, fontName, encCache)?.encode(sr.text) ?? null : null;
        // Per-run color (selection) > segment override > the original op's.
        const runOv: TextStyleOverrides = {
          ...styleOv,
          colorRaw: sr.color ? hexToRg(sr.color) : styleOv.colorRaw,
        };
        const inlineBlock = fontName && bytes
          ? newTextBlock(ops.find(o => o.fontName === fontName) ?? firstOp, ratio, x, lineBase, bytes, runOv)
          : null;
        if (inlineBlock) {
          inlineBlocks.push(inlineBlock);
          // UNDERLINE: PDFs have no underline attribute — draw the line (a
          // thin rect) under the run, at the end of the stream (identity CTM
          // → absolute coords). Width measured by the editor (sr.w).
          if (sr.underline && sr.w) {
            const size = edit.fontSize ?? edit.original.fontSize;
            const c = sr.color
              ? hexToRgbObj(sr.color)
              : edit.color
                ? hexToRgbObj(edit.color)
                : rawFillToRgb((ops.find(o => o.fontName === fontName) ?? firstOp)?.fillColorRaw) ?? { r: 0, g: 0, b: 0 };
            appendBlocks.push(
              `q ${fmt(c.r)} ${fmt(c.g)} ${fmt(c.b)} rg ${fmt(x)} ${fmt(lineBase - size * 0.11)} ${fmt(sr.w * ratio)} ${fmt(size * 0.055)} re f Q`,
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
                : rawFillToRgb(srcOp?.fillColorRaw) ?? undefined;
            fallbackDraws.push({
              page: pageNum,
              text: sr.text,
              x,
              y: lineBase,
              size: edit.fontSize ?? edit.original.fontSize,
              bucket: edit.font ?? edit.original.bucket ?? 'sans',
              bold: sr.bold,
              italic: sr.italic,
              color: color ?? undefined,
              underline: sr.underline,
            });
          }
          substituted++;
        }
      }
    }
    splices.push({ start: firstOp.record.start, end: firstOp.record.end, text: inlineBlocks.join('\n') });
    if (substituted && !familyChanged) {
      report.warn(`${edit.segmentId}: ${substituted} tramo${substituted > 1 ? 's' : ''} sin fuente original disponible (estilo nuevo o subset insuficiente) — sustituido por estándar`);
    }
    report.apply(familyChanged
      ? `${edit.segmentId}: redibujado con fuente estándar (cambio de familia)`
      : `${edit.segmentId}: reescrito por tramos (${runsToEmit.length})`);
  }
}

/** The registry, probed in order; first `canHandle` wins. Catch-all last. */
export const textEmitStrategies: readonly ITextEmitStrategy[] = [
  new VerbatimReemit(),
  new StyledRunsReemit(),
];

/**
 * Apply every SegmentEdit of one page: locate by geometry, record the exact
 * segment color, handle removal, then probe the emit strategies.
 */
export function applySegmentEditsToPage(args: {
  doc: PDFDocument;
  page: PDFPage;
  pageNum: number;
  pageEdits: SegmentEdit[];
  shows: ShowOp[];
  src: Uint8Array;
  splices: Splice[];
  appendBlocks: string[];
  fallbackDraws: FallbackDraw[];
  report: BakeReport;
}): void {
  const { doc, page, pageNum, pageEdits, shows, src, splices, appendBlocks, fallbackDraws, report } = args;
  const encCache = new Map<string, ReverseEncoder | null>();

  for (const edit of pageEdits) {
    const { ops, conflict } = matchOps(shows, edit.original);
    if (conflict) {
      report.warn(`${edit.segmentId}: ${conflict} — sin cambios`);
      continue;
    }
    // EXACT segment color (first op that painted ink) — for the editor's
    // ghost, more faithful than sampling pixels.
    const colorOp = ops.find(o => rawFillToRgb(o.fillColorRaw));
    if (colorOp) {
      const c = rawFillToRgb(colorOp.fillColorRaw);
      if (c) report.color(edit.segmentId, rgbToHex(c));
    }
    // REMOVE: extirpate every op of the segment and move on.
    if (edit.remove) {
      for (const o of ops) splices.push({ start: o.record.start, end: o.record.end, text: '' });
      report.apply(`${edit.segmentId}: eliminado`);
      continue;
    }

    const ctx: SegmentEmitContext = { doc, page, pageNum, edit, ops, src, encCache, splices, appendBlocks, fallbackDraws, report };
    for (const strategy of textEmitStrategies) {
      if (strategy.canHandle(edit)) {
        strategy.emit(ctx);
        break;
      }
    }
  }
}
