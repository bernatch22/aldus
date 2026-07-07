# The bake, from the inside

*This is the recruitment poster for PDF nerds.* The bake applies edits to the
PDF's content stream **in place** — no paint-over, no rasterizing, no
approximated fonts.

## The three machines

1. **`tokenizer.ts`** — tokenizes the whole content stream keeping the exact
   **byte offsets** of every operator and its raw operands. Byte fidelity is
   the point: what we don't touch must survive verbatim.

2. **`textWalk.ts`** — an ISO 32000 §9.4 text state machine over those
   tokens: `Tm/Td/TD/T*/TL/Tf`, the `q/Q/cm` CTM stack, fill color, `Do`
   XObjects. For every show op (`Tj/TJ/'/"`), it yields the **absolute**
   position (`Tm × CTM`), the font, the graphics state, and the byte range.
   *Honest limitation:* after a show with no explicit repositioning, the next
   show's x is unknown (we don't ship width tables) — it's marked `stale` and
   the bake refuses to touch that segment rather than guess.
   It also finds the **backstop**: the insertion point for "send to back" —
   right before the first REAL content op, *after* the full-page white fills
   many generators paint as paper (insert at byte 0 and the opaque paper
   covers your image).

3. **`bake.ts` + friends** — the orchestrator:
   - `locate.ts` finds an edit's operators **by geometry** against the edit's
     `original` snapshot (~1.8 pt tolerance) — never by index.
   - `splice.ts` replaces byte ranges **in place** (`Splice {start,end,text}`),
     which is what keeps z-order intact: the re-emitted block paints in the
     same turn the original did.
   - Every emitted matrix is **relative to the CTM at the insertion point**
     (`M_rel = M_abs × inv(ctm)`) because in-place emission runs inside the
     original `q/cm` nesting.

## The text strategies (A/B/C)

`text.ts` — probed in order, each self-gates (`canHandle`), the catch-all
last:

- **A — `VerbatimReemit`**: move/scale/restyle only. Each op re-emitted with
  its original bytes (TJ kerning intact!), new matrix, optional `Tc`/`Tz`/
  color overrides. Pixel-perfect.
- **B/C — `StyledRunsReemit`**: new text or styles, emitted per styled run.
  Per run: find the original font resource for that bold/italic combination
  (the PDF already owns both variants), re-encode the new text through the
  font's reverse `/ToUnicode` map (`toUnicode.ts`) — that's **B**. If the
  subset can't encode it, or the family changed, queue a standard-font
  fallback draw (`fallback.ts`) that PRESERVES the original op's color —
  that's **C**, always counted and reported in `warnings`.

Underlines don't exist in PDF: they're drawn as thin rects appended at the end
of the stream (identity CTM → absolute coords). And they FOLLOW their text:
`textWalk` records every simple filled rect (`re` or the m+3×l polygon pdf-lib
emits) as a `FillRectOp` with its byte range; when a segment moves, its
underline rects are spliced out and re-emitted with the same delta — when it's
removed or rewritten, they're spliced out (fresh ones come from the runs).
Without this, editing underlined text left orphan lines at the old position.

### Clipping — moving text out of its clip

Many generators wrap the whole page in a clip: `q <rect> W n … Q`. Re-emitting a
moved segment IN PLACE (inside that `q…Q`) means the clip still applies — drag
the text past the clip edge and it's cropped to **nothing** (the ops exist, but
render blank). So `textWalk` tracks the active clip rect per `ShowOp.clip`
(pushed/popped with `q`/`Q`, intersecting each `re W n` / axis-aligned polygon
clip; a non-rect clip conservatively leaves the previous state). Both strategies
call `escapesClip(op, x, y)`: if the destination falls outside, the original op
is spliced out and the block goes to `appendBlocks` (stream end, identity CTM,
no clip) instead of an in-place splice. Annotations (`/Annots`) are never
clipped — that's why a moved highlight would survive while its black text
vanished under the page clip.

## Images and widgets

- Move/scale replaces the `Do` in place with `q cm /Name Do Q`. Only
  `Subtype /Image` XObjects are candidates — a Form XObject *wraps content*
  and splicing it would delete everything inside.
  Reordering is deliberate: pdf.js numbers objects by paint order, so moving
  a `Do` would change the image's identity on re-extraction; the editor keeps
  moved images visible with an overlay sticker instead, and promotes them to
  the front only on the final save (`promoteMovedImages`).
- Widgets live in `/Annots`, not the stream: move = rewrite `/Rect`; delete =
  remove the field; appearances refreshed best-effort (`widgets.ts`).
- **Highlights AND links are `/Annots`, never burned into `/Contents`** — a
  separate, selectable, movable layer even after saving (and the editor preview
  matches the saved file). `createNodes.addHighlight` writes the annotation
  (QuadPoints + `/C` + a Multiply appearance stream for external viewers);
  `annotEdits.ts` is the shared locate-by-`/Rect` machinery consumed by
  `applyHighlightEdits` (also rewrites QuadPoints) and `applyLinkEdits` — the
  same pattern as widgets. The editor draws both as overlay boxes; on the
  display copy only, `/Highlight` annots get the Hidden flag
  (`hideHighlightAnnotations`) so pdf.js doesn't double-paint them, while
  widgets and any pre-existing exotic annotations still render on the canvas.
  A **saved highlight that overlaps a segment is glued to it**: the editor draws
  it as a child of that segment's box (follows the text live) and shifts its
  `/Rect` by the same delta on move — see the app README/CLAUDE. Two footguns
  live here: (1) `hideHighlightAnnotations` must NOT byte-scan for `"/Highlight"`
  as a fast-path — pdf-lib saves dicts inside compressed object streams, so the
  literal isn't in the raw bytes and the scan would skip the hide (highlights
  double-paint). (2) pdf-lib's typed `lookup(name, Type)` **throws** on a missing
  key, so a page without `/Annots` crashed the bake — use `lookupMaybe`.

## Honesty as an invariant

Everything the bake did lands in `BakeReport` (`applied` / `warnings` /
`colors` — the exact stream color per touched segment, which the editor uses
for its ghosts). A segment it can't locate, a rotated image, a degenerate
matrix: warning, not guess. The tests then **re-extract the baked PDF** and
assert the graph — the parser is the oracle.
