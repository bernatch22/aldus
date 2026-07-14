# Aldus

> *God's in his heaven. All's right with the PDF.*

**Aldus is a TypeScript framework for editing a PDF's real content graph.** It
parses the actual content-stream operators into a typed, editable model, lets you
mutate them — from code, a CLI, or an LLM agent — and splices the result back into
the file byte-for-byte. It never rasterizes, never paints a white box over old
text, and never redraws with an approximated font.

If you're building document automation on PDFs — filling and generating forms,
placing signatures and fields, annotating, correcting, or letting an agent edit a
contract in natural language — Aldus gives you the primitives without fighting a
black-box "PDF editor".

```bash
npm i aldus-pdf     # library + `aldus` CLI  ·  `aldus file.pdf` opens the editor
```

---

## Why edit the graph, not the pixels

Every web PDF "editor" cheats: it rasterizes, or paints a white rectangle over the
old text and draws new text on top with whatever font it has. Aldus does what
Acrobat does — and is honest when it can't:

- **Move / scale / restyle text** → the original show operators are re-emitted
  **verbatim** (same bytes, same font, same TJ kerning) with a relocated matrix.
  Pixel-perfect.
- **New text, same font** → re-encoded through the embedded font's reverse
  `/ToUnicode` map (or its simple encoding when there's no `/ToUnicode`). A glyph
  missing from the subset → an explicit, *reported* fallback.
- **Font/style change** → an embedded standard font, preserving the original
  color, width-fit into the original glyph's slot so nothing overlaps. Explicit
  substitution — never a silent guess.
- **Can't locate a segment unambiguously?** It refuses to touch it and says why.
  What it can't understand, it never modifies — and it never writes an invalid
  number into the stream.

That honesty is the point: a signing, automation, or grading pipeline needs a PDF
that is *the same document* afterward, not a re-rendered approximation.

---

## The mental model

A page parses into a **graph** of typed nodes, in PDF coordinates (origin
bottom-left, points):

```
PageGraph
 ├─ SegmentNode   contiguous text runs — THE unit of editing, anchored to its x
 │   └─ TextRunNode   one show op: exact baseline, fontSize, embedded FontInfo, color
 ├─ ImageNode     an XObject × CTM bounding box
 ├─ WidgetNode    an AcroForm field (type / name / rect / options / value)
 ├─ ShapeNode     a filled vector rectangle (banner / box)
 ├─ HighlightNode /Highlight annotation
 └─ LinkNode      /Link annotation → URL
```

You express changes as **edits** — accumulated overrides, never destructive — and
the **bake** splices them into the real content stream. Geometry is located by
*position*, never by index, so z-order stays intact.

---

## Run it

### The CLI

```bash
aldus contract.pdf                                             # opens the editor in your browser
aldus contract.pdf "Uppercase the title and highlight amounts" # one-shot agent, then saves
aldus form.pdf --fields                                        # dump fields + values as JSON
aldus form.pdf --fill '{"name":"Jane","agrees":"true"}'        # deterministic fill (no LLM)
aldus contract.pdf --chat                                      # interactive agent in the terminal
```

`aldus file.pdf` boots a local server, serves the editor, uploads the file, and
opens your browser at that document. `--fields` / `--fill` are **deterministic** —
they never call the LLM.

### The web app

The editor is a full WYSIWYG React app. The same bake that saves the file runs
**in the browser** for the live preview, so what you see is what gets written.

```bash
git clone git@github.com:bernatch22/aldus.git && cd aldus
pnpm install
pnpm dev        # server on :4100 + editor with hot-reload on :5190 → open http://localhost:5190
```

Upload a PDF, edit text in place (drag, restyle, resize), add form fields,
highlights, links and images, then **Apply** to bake. The **CASPER** panel is the
LLM agent — ask it to describe the document or make changes in natural language.

---

## The API

Two packages make up the framework. `@aldus/core` is the engine — model,
extraction, and bake, with zero LLM. `@aldus/agent` adds an edit session, a CLI,
and the optional agent. (`aldus-pdf` bundles both plus the server and editor into
one install; import from it or from the scoped packages directly.)

### Parse a page into the graph

```ts
import { getDocument } from 'pdfjs-dist';
import { extractPageGraph } from '@aldus/core';

const pdf = await getDocument({ data: bytes.slice() }).promise; // pdf.js transfers buffers → slice!
const page = await pdf.getPage(1);
const graph = await extractPageGraph(page);

for (const seg of graph.segments) {
  console.log(seg.id, seg.text, '@', seg.x, seg.baseline, `${seg.fontSize}pt`);
}
```

### Edit + bake — the core round-trip

```ts
import { mergeSegmentEdit } from '@aldus/core';
import { bake } from '@aldus/core/bake';

const seg = graph.segments.find(s => s.text.includes('DRAFT'))!;
const edit = mergeSegmentEdit(seg, null, { text: 'FINAL', baseline: seg.baseline });

const { pdf, applied, warnings } = await bake(bytes, [edit]);
// `pdf` is a new Uint8Array; `applied` / `warnings` are the honest report.
```

`bake(bytes, edits)` takes a discriminated union of every edit kind (segment,
image, widget, highlight, link, shape) and applies them all in one pass — each
routed to its applier by `kind`.

### Create content and fill forms

```ts
import {
  addFormField, addText, addHighlight, insertImage,
  readFormFields, setFieldValues,
} from '@aldus/core/bake';

let out = (await addFormField(bytes, {
  type: 'signature', page: 1, x: 90, y: 60, width: 200, height: 40, name: 'signature_a',
})).pdf;

const fields = await readFormFields(out);
// → [{ name, type, value, options, readOnly, rects: [{ page, x, y, width, height }] }, …]

out = (await setFieldValues(out, { name: 'Jane Doe', agrees: 'true', plan: 'Premium' })).pdf;
```

Field types: `text · checkbox · radio · select · list · button · signature`.
`rects` gives you every widget's page + position — enough to overlay your own UI
or know exactly where a signature will land.

### The agent (optional)

An `EditSession` accumulates edits and creates and bakes them; `runTurn` drives it
with an LLM that has the page graph in its prompt and the same tools a human has.

```ts
import { loadDoc, EditSession, runTurn } from '@aldus/agent';

const doc = await loadDoc('contract.pdf');
const session = new EditSession(doc);

session.editText('p1-y708-x72', 'FINAL');                       // programmatic (no LLM)
await runTurn({ doc, session, prompt: 'Add a signature field at the bottom' }); // or natural language

const { pdf, warnings } = await session.bake();
```

The agent is **two-level**: a cheap chat/router model reads the whole document and
either answers or delegates the edit to a stronger editor model, which runs with
only the affected pages. Two transports back it, chosen in
[`packages/agent/src/config.ts`](packages/agent/src/config.ts):

- **Claude Code subscription** (default) — no `ANTHROPIC_API_KEY`; set
  `CLAUDE_CODE_OAUTH_TOKEN` for headless/server use. Best quality; can't run on a
  public server.
- **OpenRouter** (`ALDUS_PROVIDER=openrouter`, `OPENROUTER_API_KEY`) — any
  OpenAI-compatible model, for hosted/public deployments. The default pairing is
  `gemini-3.1-flash-lite` (chat) + `gemini-3.5-flash` (editor) — ~1.8¢/turn.
  Override either with `ALDUS_OPENROUTER_CHAT_MODEL` / `ALDUS_OPENROUTER_MODEL`;
  no code change needed.

---

## Embed the editor in your own app

The editor ships as a React library (`aldus-editor`) — a single `<AldusEditor>`
component you drop into your host and point at your backend. This is how a real
host (e.g. an e-signature product) puts a document editor behind its own auth and
routes.

```tsx
import { AldusEditor, configureAldusApi } from 'aldus-editor';
import 'aldus-editor/styles.css';
import { GlobalWorkerOptions } from 'pdfjs-dist';

// pdf.js worker (peer dep) — set once at startup:
GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

// Point the editor at YOUR API base (it proxies to an Aldus server, see below):
configureAldusApi({ apiBase: '/api/aldus' });

function EditDocument({ id }: { id: string }) {
  return <AldusEditor docId={id} onExit={() => history.back()} brand={<MyLogo />} />;
}
```

**`<AldusEditor>` props** — all optional except `docId`:

| Prop | Purpose |
|---|---|
| `docId` | the document to edit (its id in your store) |
| `onExit` | header "back" button handler — you decide where it goes |
| `brand` | a node shown in the header when there's no `onExit` |
| `agent` | show the CASPER agent panel (default `true`) |
| `formTools` | show the form-field tools in the rail (default `true`) |
| `inspectorTab` | show the properties inspector (default `true`) |
| `panelTabs` | inject your own tabs into the right panel |
| `hostBoxes` / `hostTools` | overlay your own draggable boxes and rail tools |

**The wire protocol.** The editor talks to a small REST surface — mount an
`@aldus/server` instance under your `apiBase`, or proxy these to one:

```
POST   /:id/bake        apply pending edits → new PDF revision
POST   /:id/ops         instant server op (add text, watermark, header/footer, link…)
POST   /:id/agent       run an agent turn (streams NDJSON)
POST   /:id/fields      form field ops     ·   POST /:id/images   insert an image
GET    /:id/pdf         the current bytes  ·   GET/PUT /:id/edits  the pending edits
POST   /:id/revert      roll back one revision
POST   /   ·   GET /    upload  ·  list
```

Your host owns the store, auth, and lifecycle; Aldus owns the editing. `@aldus/server`
ships a reference `DocStore` (file-backed, keeps N revisions) you can swap for your
own by binding a different implementation in its composition root.

---

## How it's built

Aldus is a pnpm monorepo layered so dependencies only ever point one way —
protocol layers stay dumb, one layer holds the intelligence:

```
packages/core     @aldus/core   the engine, layered:
  common/         pure utilities — coords, matrix, events, cancellation (zero deps)
  pdf/            the ISO 32000 protocol: tokenizer → contentWalk → splice (dumb pipes)
  model/          the typed vocabulary — nodes + edits
  graph/          extraction (pdf.js → PageGraph) + the read model
  edit/ layout/   accumulated edits (the ledger) + deterministic geometry (reflow, charX)
  bake/ create/   THE BRAIN — locate-by-geometry, emit strategies, form/annotation creation
packages/agent    @aldus/agent  EditSession + CLI (bin/aldus) + the two-level agent
packages/editor   aldus-editor  the React editor library + a reference demo app
packages/aldus-pdf aldus-pdf    the one-install distribution (lib + CLI + server + editor)
apps/server       @aldus/server reference Express host + DocStore
```

Extensibility is by **contract, not modification** — each capability is one
interface with N implementations, probed at runtime:

- a new **edit kind** → an `IEditApplier` (bake applies it, located by geometry)
- a new **text-emit behavior** → an `ITextEmitStrategy` (`{ canHandle, emit }`)
- a new **agent tool** → a `ToolDef` in `TOOL_DEFS` (a pure method on `EditSession`)
- a new **extractor**, **node box**, **instant op**, **LLM transport**, or
  **font provider** → its own interface, one `bind` line.

Adding a capability is a new class plus one registration — never an edit to a
sibling.

### Develop & test

```bash
pnpm install
pnpm dev          # reference app: server :4100 + editor :5190
pnpm -r test      # the real round-trip
```

Tests run the *real* cycle: build a PDF → extract its graph → bake edits →
re-extract → assert the world matches. No mocked PDFs, no golden pixels — the
parser is the oracle. Debug logging is gated (`ALDUS_DEBUG=1` in Node,
`localStorage.aldusDebug='1'` in the browser); with `ALDUS_DEBUG=1` the editor's
🐞 button writes a runnable repro bundle to `/tmp/aldus-debug/`.

---

## License

[MIT](LICENSE) — Bernardo Castro.

> Aldus Manutius invented italics; Aldus Corp. created PageMaker, the father of
> desktop publishing. This Aldus edits PDFs with that same typographic obsession.
