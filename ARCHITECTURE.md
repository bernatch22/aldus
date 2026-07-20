# Architecture

How Aldus is put together, and why. For *what it does*, start at the
[README](README.md); for *how to use it*, the [docs/](docs/) folder.

## The one rule

**Dependencies point one way, and only one layer is allowed to be smart.**
Protocol layers (tokenizer, splicer, the typed model) stay dumb — they know the
format, not the intent. The intelligence — where does this edit land, which font
can render it, what do we do when we can't be sure — is concentrated in `bake/`
and `create/`. Everything else is a pipe.

The practical test: a new capability should be a **new file plus one
registration**, never a modification to a sibling.

## The packages

```
packages/core      @aldus/core     the engine: model, extraction, bake. Zero LLM.
packages/agent     @aldus/agent    EditSession + the two agents + the `aldus` CLI
packages/editor    aldus-editor    the React editor            → npm
packages/aldus-pdf aldus           the distribution            → npm
apps/server        @aldus/server   reference Express host + DocStore
```

**Only two go to npm.** `@aldus/core` and `@aldus/agent` are internal (`0.0.1`,
consumed via `workspace:*`): they exist to keep engine and agent separated
*inside* the repo. `aldus` bundles both into one install.

`packages/aldus-pdf` is almost not a code package — its `src/index.ts` is a
single `export * from '@aldus/agent'`, because `@aldus/agent`'s index is already
the curated public surface (it hand-re-exports core's API, grouped READ / EDIT /
FINALIZE). The real work is in `build.mjs`, which assembles five artifacts from
four directories:

```
dist/index.js + index.d.ts   the library   ← core + agent inlined, types hand-assembled
dist/cli.js                  the `aldus` bin ← packages/agent/dist/cli.js
dist/server.mjs (+impl)      the server    ← apps/server
dist/editor/                 the SPA       ← packages/editor (build:demo)
dist/editor-lib/             React lib     ← packages/editor (subpath aldus/editor)
```

> The folder is named `aldus-pdf` for historical reasons; the published package
> is `aldus`.

## `@aldus/core` — the engine

```
common/    pure utilities — coords, matrix, events, cancellation, disposables (zero deps)
pdf/       the ISO 32000 protocol: tokenizer → contentWalk → splice (dumb pipes)
model/     the typed vocabulary: nodes.ts (the graph) + edits.ts (the ledger)
graph/     extraction (pdf.js → PageGraph) + PageGraphService (the read model)
layout/    deterministic geometry: paragraph, reflow, charX
edit/      accumulated edit merging
bake/      THE BRAIN — locate-by-geometry, emit strategies
create/    forms, annotations, images, watermarks, flatten
```

### The graph

A page parses into typed nodes. **One coordinate convention everywhere**: PDF
points, origin bottom-left, y grows up; `y` on a text node is the *baseline*.
Conversion to screen space lives in `common/coords.ts` and nowhere else.

```
TextRunNode    one show operator — exact baseline, fontSize, embedded FontInfo, color
   ↓ contiguous runs
SegmentNode    THE UNIT OF EDITING, anchored to its x like an Acrobat text box
   ↓ same baseline
LineNode       the segments sharing a baseline
```

A column gap or tab is **not stored** — it's the boundary between two segments,
derivable from their `x`. And segment `x` is an *anchor*: editing the segment
next to it never moves it. That's the independent-text-box model Acrobat uses.

Beside text: `ImageNode` (XObject × CTM bbox), `WidgetNode` (AcroForm field),
`HighlightNode` and `LinkNode` (annotations), `ShapeNode` (filled vector rects —
banners and boxes, informative only; the bake doesn't touch them).

> ⚠️ `TextRunNode.text` travels **intact**. A glyph with no `/ToUnicode` entry
> arrives as a raw control char (LibreOffice's stray accent is `U+0012`) and the
> bake re-encodes it by identity. Any normalization or trim there destroys it —
> which is why normalization exists only inside the *matching index*, never on
> the graph.

### `PageGraphService` — the read model

Every consumer used to do its own `segments.find` and sort. Now the indexes are
built once per `replace()` and queried in O(1)/O(bucket): `byId` across every
node kind, `segmentsAt` (baseline buckets), `byGeometry` (rect match within
`GEOMETRY_TOL_PT` = 1.8pt — the same tolerance the bake uses to locate ops), and
`byNormalizedText`.

`replace()` is the **only** mutation point: a page's graph is swapped whole
after a re-extract, never mutated in place. That's what lets nodes memoize and
indexes stay immutable between replaces; `onDidReplace` notifies consumers.

### Edits and the bake

You never mutate the graph. You express **edits** — accumulated, non-destructive
overrides — and the bake splices them into the real content stream. `bake(bytes,
edits)` takes a discriminated union of every kind (segment, image, widget,
highlight, link, shape) and routes each to its `IEditApplier` by `kind`, in one
pass.

Ops are located **by position, never by index**, so z-order survives.

The honesty rules that make this usable in a signing pipeline:

- **Move / restyle text** → the original show operators are re-emitted
  *verbatim* (same bytes, same font, same TJ kerning) with a relocated matrix.
- **New text, same font** → re-encoded through the embedded font's reverse
  `/ToUnicode` map (or its simple encoding when there is none). A glyph missing
  from the subset produces an explicit, **reported** fallback.
- **Can't locate a segment unambiguously?** It refuses and says why.

`layout/reflow.ts` handles the case where new text doesn't fit: it re-wraps the
paragraph, re-bakes, and re-extracts to measure for real. When it can't fit even
compressed, it **aborts** rather than overflowing the page.

## `@aldus/agent` — two agents

The split exists for one reason: **the editor must never eat the whole
document**.

| | Reader | Editor |
|---|---|---|
| Sees | the whole document as text, inline in the system prompt | the pixel-perfect graph of *scoped pages* — ids, coordinates, styles |
| Serializer | `serializeReading` (no ids, no coordinates) | `serializeDoc` (real ids like `p1-y711-x154`) |
| Model | cheap (`google/gemini-3.1-flash-lite`) | strong (`claude-sonnet-5`) |
| Can | answer, fill form fields | every edit tool |

The reader answers in **one pass** — a whole contract fits in a cheap model for
cents, with no tool round-trips just to read. The editor anchors every edit to a
real graph id, which is why it needs no vision and no geometric verification
afterward: there are no coordinates to hallucinate.

### The gate between them is optional

The reader **does not know the editor exists**. The host injects the door as a
callback (`ReadTurnOpts.editor`):

- **Pass it** → the reader gets an `edit_document({pages, request})` tool and
  routes edits itself.
- **Omit it** → the reader is read-only-plus-filling and says so when asked for
  more.

Both paths ship. The CLI exposes them as `aldus ask` / `aldus edit` (+
`--auto` for routing), and the editor UI as two chat tabs.

**Fan-out**: when routing marks work as independent per page, `editPages`
launches one editor per page in parallel — latency becomes the slowest page, not
the sum (measured: 4 pages, 31 fields, 235s → 118s). They share one
`EditSession`, so mutations serialize through a `Mutex`.

### Tools: one contract, multi-bound

A tool is one `IAgentTool` bound in the container. Native Aldus tools and a
host's domain tools use the **same** format — there is no separate "host tool"
shape.

```ts
level: 'reader' | 'editor' | 'both'
```

`'both'` is for tools that need the document *and* make sense from a reading
turn — `fill_field` is the one native example, because filling needs a field
*name*, not the graph. Consequence: a **document-less turn** (a host's org-level
chat, no `doc`/`session`) is offered `'reader'` tools only, since `'both'` tools
would have no `EditSession` to mutate.

Every tool returns a string whose first character is the outcome — `✓` applied,
`↩︎` skipped, `⚠️` problem (retriable). The registry classifies these into a
structured `ToolOutcome` and is the agent's **single catch site**: a throwing
tool becomes `⚠️ internal error` and the stack goes to the log, never to the
model or the user.

### `EditSession` — the ledger

Accumulates edits, creates and field fills, then bakes. `bake()` always works
from the **original bytes plus the full ledger**, so it's cumulative and
idempotent; `finishTurn()` decides the product policy (baked-and-persisted vs.
return-the-edits) outside of any route.

Two properties that matter to callers: a session is **reusable across turns**
(nothing ends its life), and `count` is **monotonic** — there's no reset. Code
that asks "did *this* turn change anything?" must compare a delta, not the
absolute (`cli/chat.ts` does; `cli/turns.ts` uses the absolute because its
sessions are always fresh).

### Transports

`ILlmTransport` is one dumb pipe per provider, injected. The orchestration runs
once over that contract — no provider switch inside.

**The transport is derived from the model id — there is no provider knob:**

```
vendor/slug   (contains '/')   → OpenRouter
claude-*                       → Claude Agent SDK
```

## `aldus-editor` — the React editor

`AldusEditor` is a real **composition root**: it constructs the per-document
services in dependency order and disposes them on unmount.

```
EditLedgerAdapter → PreviewService → LiftService → TextEditController
                                   + FontRegistryService, ColorSampler, ImagePixelCache
```

The same bake that writes the file runs **in the browser** for the live preview,
so what you see is what gets written. Editing works in layers: `PdfCanvas`
renders the page, `NodeOverlay` puts editable boxes over the nodes, and edited
segments are *extirpated from the preview* and drawn as transparent "phantoms"
by the overlay.

Host integration is by props, not forks: `panelTabs` (your own right-panel
tabs), `hostBoxes` / `hostTools` (your draggable boxes and rail tools),
`panelFooter`, `headerActions`, `brand`, `onExit`.

## `@aldus/server` — the reference host

Routes: upload/list, `pdf`, `bake`, `ops` (instant server ops), `fields`,
`images`, `revert`, `agent`.

**`DocStore` is the persistence boundary** (Repository pattern) — routes talk to
the interface, never the filesystem. Swapping in S3 or sqlite is implementing
the interface plus one bind. `writePdf` snapshots the previous bytes as
`<id>.rev-<timestamp>.pdf` and keeps the newest `ALDUS_REVISIONS` (default 10) —
coarse multi-level undo. `popRevision` undoes the last **write**, whatever it
was; it is not a semantic per-change undo, and the editor wires it to its
history knowing that.

**Session-scoped mode** (`ALDUS_SESSION_SCOPED`) is for the public demo: each
visitor (a `sid` cookie) gets an isolated store seeded with copies of the
samples, so uploads never leak between visitors. A GC sweep by mtime runs at
boot and hourly, deleting sessions idle past the TTL.

**The agent route streams NDJSON**, one JSON line per event, so the panel shows
the answer typing and tools running instead of a mute 20-40s wait. Since it's
streaming, once headers are sent an error can't come back as an HTTP status —
the error channel is a `{type:'error'}` event. And closing the response
**cancels the turn**: `CancellationTokenSource` → transport `AbortSignal` → the
reflow's bake loop. A client that hangs up is an LLM that stops billing.

## Extension points

Every capability is one interface with N implementations, probed at runtime:

| To add | Implement | Registered |
|---|---|---|
| an edit kind | `IEditApplier` | bake's applier list |
| a text-emit behavior | `ITextEmitStrategy` (`canHandle`/`emit`) | strategy list |
| an agent tool | `IAgentTool` | `bind(IAgentTool)` in the container |
| an extractor | `IGraphExtractor` | `bindGraphExtractors` |
| an instant server op | `IInstantOp` | server composition root |
| an LLM transport | `ILlmTransport` | by model id |
| a document store | `DocStore` | server composition root |
| a font provider | font provider | `registerNodeFontProviders` |

## Testing

Tests run the **real** cycle: build a PDF with pdf-lib → extract its graph →
bake edits → re-extract → assert the world matches. No mocked PDFs, no golden
pixels — **the parser is the oracle**. The agent's tests drive real turns
through a scripted fake transport, so orchestration is tested without spending a
token.

```bash
pnpm build && pnpm test
```

Debug logging is gated: `ALDUS_DEBUG=1` in Node, `localStorage.aldusDebug='1'`
in the browser. With `ALDUS_DEBUG=1` the editor's 🐞 button writes a runnable
repro bundle to `/tmp/aldus-debug/`.
