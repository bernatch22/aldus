# Architecture

Aldus edits the PDF's **real content graph**. The whole system is one
pipeline, crossed twice — once in the browser (preview) and once on the server
(save):

```
            extract                edit                    bake
  PDF ────────────────▶ PageGraph ──────▶ SegmentEdit[] ─────────▶ new PDF
  bytes   pdf.js text     nodes            ImageEdit[]    splices     bytes
          items + ops                      WidgetEdit[]   in place
              ▲                                                        │
              └────────────────── re-extract (the tests' oracle) ◀────┘
```

## Packages (the MAGI)

- **`packages/core` — MELCHIOR.** Everything that understands PDF.
  - `model.ts` — the graph: `TextRunNode` (stream atom: exact baseline, font
    info, sampled color) → `SegmentNode` (contiguous runs, THE edit unit,
    Acrobat's model: a column gap is a BOUNDARY, never whitespace) →
    `LineNode`; plus `ImageNode`, `WidgetNode`, `LinkNode`.
  - `extractGraph.ts` + `tokens.ts` — extraction from pdf.js text items; gap
    thresholds (pdfminer style) shared with the bake.
  - `edits.ts` — the edit semantics: `merge*Edit(node, prev, patch)`
    accumulates overrides, `null` clears them, and a result identical to the
    original merges to *nothing* (auto-revert). Command pattern, formalized.
  - `coords.ts` — the ONLY PDF↔CSS converter.
  - `bake/` — see [bake-internals.md](bake-internals.md).
- **`apps/server` — BALTHASAR.** Express, boot in `index.ts`, one module per
  route family (`routes/documents|bake|ops|agent`), persistence behind the
  `DocStore` interface (`store.ts`, Repository pattern, N revisions per
  write). Validation centralized in `validate.ts`.
- **`packages/agent` — CASPER.** Claude Agent SDK; the document graph is
  serialized INTO the system prompt (no read tools), edit tools mutate an
  `EditSession` that reuses core's merge functions — the same single source of
  truth as the UI. Env knobs in `config.ts`.
- **`apps/editor` — NERV HQ.** React; `pages/EditorPage.tsx` is composition
  only, each behavior is a hook in `pages/editor/`:
  - `usePendingEdits` — the four pending collections + unified undo/redo
    (`useHistory`, Memento) + the phantom-node cache.
  - `useLocalPreview` — pending edits baked IN THE BROWSER over the base
    bytes; what you see is the real bake's output. ⚠️ Its effect must never
    depend on `graph` (render loop) — it reads through refs.
  - `useLift` — the drag machine (pdf.js annotation-editor pattern: canvas
    untouched during the gesture, pre-baked "page without the node" blitted
    on drag start).
  - `useLocks`, `useAreaWidths`, `usePlacement`, `useEditorHotkeys`.
  - `editor/overlay/` — the node overlay decomposed: one box component per
    node type + `FloatingBar` + the singleton `TextEditLayer` + shared
    `useDragGesture`/`useGripResize` hooks.

## Design patterns, by name

| Pattern | Where |
|---|---|
| Strategy (probing, first-to-claim) | `core/src/bake/text.ts` — `textEmitStrategies` |
| Command (accumulated patches, null = revert) | `core/src/edits.ts` — `merge*Edit` |
| Memento | `editor/pages/editor/useHistory.ts` |
| Repository | `server/src/store.ts` — `DocStore` |
| Builder | `core/src/bake/report.ts` — `BakeReport` |
| Singleton (imperative, deliberate) | `editor/src/editor/overlay/TextEditLayer.tsx` |

## Invariants that keep the system honest

- Dependency direction: `core` depends on nothing internal; `agent` and
  `editor`/`server` depend on core; nobody depends on an app.
- Coordinates convert in exactly one file; gap thresholds live in exactly one
  file; the moved-image promotion rule (`promoteMovedImages`) lives in exactly
  one file.
- The bake warns instead of guessing, and the tests re-extract instead of
  trusting.
