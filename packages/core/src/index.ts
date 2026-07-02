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
} from './model.js';
export { FIELD_DEFAULT_SIZE } from './model.js';
export { extractPageGraph, groupIntoLines } from './extractGraph.js';
export type { PdfJsPage, PdfJsTextItem } from './extractGraph.js';
export { classifyGap, avgCharWidth, splitSegments, segmentText } from './tokens.js';
export type { GapClass } from './tokens.js';
export { mergeSegmentEdit, segmentOriginal, effectiveGeometry, originalStyledRuns, styledRunsEqual, styledText, toggleStyleRange, setStyleRange, mergeImageEdit, effectiveImageRect, mergeWidgetEdit, effectiveWidgetRect, nextListMarker, hasListMarker, isBareListMarker, toggleListMarker } from './edits.js';
export type { SegmentPatch, ImagePatch, WidgetPatch } from './edits.js';
export { pdfRectToCss, cssPointToPdf } from './coords.js';
export type { PdfRect, CssRect } from './coords.js';
