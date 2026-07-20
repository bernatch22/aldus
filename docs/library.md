# Library API

Everything below is importable from the package root:

```ts
import { loadDoc, EditSession, bake, readFormFields } from 'aldus';
```

There are two layers, and you can work at either one:

- **Bytes → bytes** (`bake`, `addText`, `readFormFields`, …) — stateless, one PDF
  in, one PDF out. Deterministic, no LLM.
- **`EditSession`** — a façade that *accumulates* changes and bakes them in one
  pass at the end. This is what the CLI, the server and the agent all drive.

---

## Loading a document

```ts
import { loadDoc, graphFromBytes, serializeDoc } from 'aldus';

const doc = await loadDoc('contract.pdf');   // from a path
const doc2 = await graphFromBytes(bytes);    // from a Uint8Array

doc.pages;        // PageGraph[] — the parsed content graph
doc.bytes;        // the original bytes
```

A `PageGraph` holds the real content-stream elements as typed nodes:

```ts
const page = doc.pages[0];
for (const seg of page.segments) {
  console.log(seg.id, seg.text, '@', seg.x, seg.baseline, `${seg.fontSize}pt`);
}
page.lines;     // visual lines (a real row, with its true width)
page.images;    // ImageNode[]
page.widgets;   // WidgetNode[] — form fields
page.shapes;    // ShapeNode[]
```

Every node has a **stable id** like `p1-y708-x72` (page, baseline, x). Every API
below addresses nodes by that id — never by coordinates you have to guess.

---

## `EditSession` — the edit façade

```ts
import { loadDoc, EditSession } from 'aldus';

const doc = await loadDoc('contract.pdf');
const session = new EditSession(doc);

session.editText('p1-y708-x72', 'FINAL');
session.highlightText('p1-y690-x72', '#ffd400');
await session.save('out.pdf');
```

Two classes of change, kept apart on purpose:

- **Edits to existing nodes** go into an internal ledger and are baked in one
  pass by `bake()`.
- **Creations of new nodes** are queued and applied *after* the bake, each one a
  bytes→bytes call.

### Text

| Method | What it does |
|---|---|
| `await editText(id, text)` | Replace a node's text. If the new text doesn't fit its line, the **paragraph is reflowed** deterministically — overflow cascades to the next line, never overlaps, never runs off the edge. |
| `await replaceParagraph(id, text, endId?)` | Replace a whole paragraph (all its lines) in one call. Re-wraps at the real paragraph width and pushes the content below down (or **pulls it up** if it shrank). `endId` spans a multi-paragraph block on the same page. |
| `await replaceSection(startId, endId, text)` | Same, but **across pages**. The span collapses: the first node becomes the new paragraph, the rest are deleted. |
| `styleText(id, { bold?, italic? })` | Bold/italic. Bake re-encodes with the matching font variant, falling back to a standard equivalent (and reporting it) if the PDF doesn't embed one. |
| `moveText(id, x?, y?)` · `colorText(id, color)` · `resizeText(id, size)` | Position, colour, size. |
| `deleteText(id)` | Remove the node. |
| `deleteTextPullUp(id, mode)` | Remove it **and pull up** what's below. `'gap'` closes the hole; `'top'` also reclaims the top margin. Never moves the footer. |
| `await replacePage(page, blocks, bucket?)` | Replace a whole page with structured blocks (title/heading/paragraph/bullet). `composePageBlocks` does all the layout — typography per block type, wrap with real font measurement, margins. |

### Creating new content

```ts
session.addTextNode({ page: 1, x: 72, y: 700, text: 'Approved', size: 12, bold: true });
session.insertImageFile(1, 400, 60, './signature.png', 120);   // PNG/JPEG
session.watermark('DRAFT', '#ff0000', 0.2);                    // all pages, idempotent
session.headerFooter({ header: 'Acme', footer: 'Confidential', pageNumbers: true });
session.highlightText('p1-y690-x72');                          // over an existing node
session.linkText('p1-y690-x72', 'https://example.com');
session.addField('signature', 1, 90, 60, 200, 40, 'signature_a');
```

`addTextNode` is **collision-aware**: if the estimated rect overlaps existing
text (or text already queued), it walks down line by line until it finds a free
slot, and tells you it moved.

`watermark` and `headerFooter` are **idempotent** — calling them twice with the
same args is a no-op, not two stacked copies.

### Forms

```ts
session.fillField('name', 'Ana');
session.fillField('subscribe', true);                          // checkbox
session.fillFields([{ name: 'plan', value: 'Pro' }, { name: 'vat', value: 'X' }]);

// Turn "……………" placeholders into real fields — the code does the layout:
await session.placeholdersToFields('p1-y620-x72', [
  { placeholder: '………', name: 'company' },
  { placeholder: '……',  name: 'date' },
]);
```

`placeholdersToFields` is the deterministic one to reach for: you say *which*
placeholder becomes *which* field, and `matchPlaceholders` locates each gap
(elastic leaders, multi-line flex, Word de-hyphenation, overlapping context
phrases), narrows every match to its filler/leader run (the context words the
model quoted survive), and picks one of TWO automatic modes:

- **Usable leader runs (`.....`/`____`)** → the field lands directly over the
  printed rect, **without touching the text** (zero reflow). Field widths clip
  to the filler run, so a field can never cover a letter.
- **Leaderless fillers (`XXXX`, `xxx`, `***`)** → the filler is REMOVED: the
  hole is re-emitted as a BLANK GAP at the data's useful width, the paragraph
  reflows (extra line + content below shifted if needed), and each field lands
  on the MEASURED gap between re-extracted runs — bounded by the neighbouring
  text, so overlap is impossible by construction. A sweep converts every other
  filler/leader run of the paragraph in the same call (a second call returns ↩︎).

### Inspecting and finishing

```ts
session.count;                       // pending changes
session.summary();                   // human-readable list
session.effectiveSegments(1);        // the page with the ledger applied
session.getEdits();                  // { edits, imageEdits } — what a UI can apply locally
session.hasBakedOps;                 // are there changes a UI can't represent?

const { pdf, applied, warnings } = await session.bake();   // → bytes + honest report
await session.save('out.pdf');                             // bake + write
const fin = await session.finishTurn();                    // { kind: 'baked' | 'edits', … }
```

`bake()` runs everything in order: ledger edits → queued creations → form fills
(last, so a field created and filled in the same turn works).

---

## Bytes → bytes (stateless)

Use these when you don't need a session.

```ts
import { bake, addText, addFormField, readFormFields, setFieldValues } from 'aldus';
```

**Bake** — applies a discriminated union of every edit kind in one pass:

```ts
const { pdf, applied, warnings } = await bake(bytes, edits);
```

**Create**: `addText` · `addHighlight` · `addLink` · `removeLink` · `addWatermark`
· `addHeaderFooter` · `addFormField` · `addRadioOption` · `setFieldOptions` ·
`insertImage` · `composePageBlocks`

**Forms**: `readFormFields` · `setFieldValues` · `flattenForm`

These take **bytes**, not a path — they're the stateless layer:

```ts
const bytes = new Uint8Array(await readFile('form.pdf'));

const fields = await readFormFields(bytes);
// → [{ name, type, value, options, readOnly, rects: [{ page, x, y, width, height }] }, …]

const { pdf } = await setFieldValues(bytes, { name: 'Jane Doe', agrees: true });
```

Field types: `text · checkbox · radio · select · list · button · signature`.

**Info**: `readPdfInfo` · `isPdf` · `locateText` · `bakeSegmentEdits`

---

## What the root re-exports

Verified against `packages/agent/src/index.ts`, which *is* the published root:

**Nodes & graph** — `PageGraph`, `SegmentNode`, `TextRunNode`, `LineNode`,
`ImageNode`, `ShapeNode`, `LinkNode`, `HighlightNode`, `WidgetNode`,
`WidgetKind`, `TextAnchor`, `locateText`

**Bake & create** — `bake`, `bakeSegmentEdits`, `addText`, `addHighlight`,
`addLink`, `removeLink`, `addWatermark`, `addHeaderFooter`, `addFormField`,
`addRadioOption`, `setFieldOptions`, `insertImage`, `composePageBlocks`,
`readFormFields`, `setFieldValues`, `flattenForm`, `readPdfInfo`, `isPdf`,
`FIELD_DEFAULT_SIZE`, `FormField`, `NewFieldSpec`, `NewTextSpec`,
`NewImageSpec`, `PageBlock`, `PdfInfo`, `BakeResult`, `ComposeResult`,
`FlattenResult`

**Session & agent** — `EditSession`, `loadDoc`, `serializeDoc`, `graphFromBytes`,
`NodeIndex`, `createAgentContainer`, `editPages`, `editTurn`, `readTurn`,
`ToolRegistry`, `IToolRegistry`, `IAgentTool`, `IAgentConfig`, `IAgentEventSink`,
`ILlmTransport`, `ClaudeSdkTransport`, `OpenRouterTransport`, `CallbackSink`,
`loadAgentConfig`, `transportFor`, `isOpenRouterModel`, `createMutex`,
`openFile`, `openInEditor`, `registerNodeFontProviders`

> **Not re-exported from the root:** `extractPageGraph` and `mergeSegmentEdit`
> live in `@aldus/core`, which is internal and not published. Use `loadDoc` /
> `graphFromBytes` to get a graph, and `EditSession` to build edits.

---

## Related

- [agent.md](agent.md) — driving `EditSession` with an LLM
- [editor.md](editor.md) — the React component over the same model
- [cli.md](cli.md) — the same operations from the terminal
