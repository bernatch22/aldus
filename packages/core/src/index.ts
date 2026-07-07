export type {
  FontBucket,
  FontInfo,
  TextRunNode,
  SegmentNode,
  LineNode,
  PdfNode,
  PageGraph,
  SegmentEdit,
  StyledRun,
  ImageNode,
  ImageEdit,
  WidgetNode,
  WidgetEdit,
  WidgetKind,
  LinkNode,
  LinkEdit,
  HighlightNode,
  HighlightEdit,
} from './model.js';
export { FIELD_DEFAULT_SIZE } from './model.js';
export { extractPageGraph, groupIntoLines } from './extractGraph.js';
export type { PdfJsPage, PdfJsTextItem } from './extractGraph.js';
export { classifyGap, avgCharWidth, splitSegments, segmentText } from './tokens.js';
export type { GapClass } from './tokens.js';
export { mergeSegmentEdit, segmentOriginal, effectiveGeometry, originalStyledRuns, styledRunsEqual, styledText, toggleStyleRange, setStyleRange, mergeImageEdit, effectiveImageRect, mergeWidgetEdit, effectiveWidgetRect, mergeHighlightEdit, effectiveHighlightRect, mergeLinkEdit, effectiveLinkRect, nextListMarker, hasListMarker, isBareListMarker, toggleListMarker, applyTextDiff, promoteMovedImages, LIST_GAP } from './edits.js';
export type { SegmentPatch, ImagePatch, WidgetPatch, HighlightPatch, LinkPatch } from './edits.js';
export { pdfRectToCss, cssPointToPdf } from './coords.js';
export type { PdfRect, CssRect } from './coords.js';
export { createLogger } from './log.js';
export type { Logger } from './log.js';
