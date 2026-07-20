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
npm i aldus        # library + editor + server + the `aldus` CLI
aldus contract.pdf # opens the visual editor in your browser
```

## Documentation

| Doc | What's in it |
|---|---|
| **[CLI](docs/cli.md)** | Every command and flag — the visual editor, the chat, the two agent verbs, and the deterministic form operations. |
| **[Library API](docs/library.md)** | `EditSession` method by method, the bytes→bytes layer, forms, and exactly what the package root re-exports. |
| **[React editor](docs/editor.md)** | `<AldusEditor>` props, the host-integration seams (your tabs, your boxes, your tools), the API client, forensic mode. |
| **[Server](docs/server.md)** | Every HTTP route with body and response, the env knobs, the agent's NDJSON wire, embedding it in your own app. |
| **[Agent](docs/agent.md)** | The two agents, per-page fan-out, auth and models, cost, adding your own tools, the guardrails. |
| **[Architecture](ARCHITECTURE.md)** | How the packages fit, the layering, and every extension point. |

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
  What it can't understand, it never modifies.

That honesty is the point: a signing, automation, or grading pipeline needs a PDF
that is *the same document* afterward, not a re-rendered approximation.

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

## The CLI

```bash
aldus contract.pdf                                       # the visual editor in your browser
aldus contract.pdf --chat                                # conversation in the terminal

aldus ask  contract.pdf "What are the payment terms?"    # reader → answer on stdout
aldus edit contract.pdf "Uppercase the title" --pages 1  # editor → a new PDF

aldus form.pdf --fields                                  # every field as JSON   (no LLM)
aldus form.pdf --fill '{"name":"Jane","agrees":"true"}'  # fill by name          (no LLM)

aldus tools                                              # bound tools + models in effect
```

There's **one verb per agent**, and the split is about what comes out the other
end: `ask` answers on stdout (so it pipes), `edit` writes a PDF (so it takes `-o`
and `--pages`). `--fields` / `--fill` are **deterministic** — they never load a
model and never read your API key.

Full reference in [docs/cli.md](docs/cli.md).

## The web app

The editor is a full WYSIWYG React app. The same bake that saves the file runs
**in the browser** for the live preview, so what you see is what gets written.

```bash
git clone git@github.com:bernatch22/aldus.git && cd aldus
pnpm install
pnpm dev        # server :4100 + editor with hot-reload :5190
```

Upload a PDF, edit text in place (drag, restyle, resize), add form fields,
highlights, links and images, then **Apply** to bake. The **CASPER** panel is the
LLM agent, with a tab per agent: *Lectura* for questions and filling fields,
*Edición* for changes to the page you're on.

---

## The library

`aldus` is the only package you install; it bundles the engine (`@aldus/core`)
and the agent (`@aldus/agent`), which are internal. Everything below imports from
the package root.

### Read a document

```ts
import { loadDoc, readFormFields, readPdfInfo } from 'aldus';
import { readFile } from 'node:fs/promises';

const doc = await loadDoc('contract.pdf');
for (const seg of doc.pages[0].segments) {
  console.log(seg.id, JSON.stringify(seg.text), '@', seg.x, seg.baseline, `${seg.fontSize}pt`);
}
// p1-y708-x72 "CONTRATO DE DISTRIBUCIÓN" @ 100 720 18pt

const bytes = new Uint8Array(await readFile('form.pdf'));
const fields = await readFormFields(bytes);
// → [{ name, type, value, options, readOnly, rects: [{ page, x, y, width, height }] }, …]
```

### Edit and bake

`EditSession` accumulates edits and bakes them. It's the same surface the agent's
tools call — they're thin delegations to these methods.

```ts
import { loadDoc, EditSession } from 'aldus';

const doc = await loadDoc('contract.pdf');
const session = new EditSession(doc);

await session.editText('p1-y708-x72', 'FINAL');   // async: it may reflow the paragraph
session.fillFields([{ name: 'signer', value: 'Jane Doe' }]);

const { applied, warnings } = await session.save('out.pdf');
```

`bake()` always works from the **original bytes plus the full ledger**, so it's
cumulative and repeatable — and `warnings` is the honest report of anything it
had to substitute or refuse.

### Bytes in, bytes out

For stateless pipelines, the creation and form primitives take and return bytes:

```ts
import { addFormField, setFieldValues, flattenForm } from 'aldus';

let out = (await addFormField(bytes, {
  type: 'signature', page: 1, x: 90, y: 60, width: 200, height: 40, name: 'signature_a',
})).pdf;

out = (await setFieldValues(out, { name: 'Jane Doe', agrees: true, plan: 'Premium' })).pdf;
out = (await flattenForm(out)).pdf;   // burn the values in, drop the AcroForm
```

Field types: `text · checkbox · radio · select · list · button · signature`.
`rects` gives you every widget's page and position — enough to overlay your own
UI or know exactly where a signature will land.

Full surface in [docs/library.md](docs/library.md).

### The agent

Two agents, and the door between them is a callback you choose to wire.

```ts
import { createAgentContainer, loadDoc, EditSession, readTurn, editPages,
         IToolRegistry, IAgentConfig } from 'aldus';

const c = createAgentContainer();
const [registry, config] = [c.get(IToolRegistry), c.get(IAgentConfig)];

const doc = await loadDoc('contract.pdf');
const session = new EditSession(doc);

// READER — answers from the whole document; can fill form fields.
const { text } = await readTurn({ doc, session, prompt: 'What are the terms?' }, registry, config);

// EDITOR — the real edit tools, scoped to the pages you choose.
await editPages({ doc, session, request: 'Uppercase the title', pages: [1] }, registry, config);

const { warnings } = await session.save('out.pdf');
```

Pass `editor:` to `readTurn` and the reader gets an `edit_document` tool to
delegate with; omit it and the reader never edits beyond filling fields. A host
adds its own domain tools by binding `IAgentTool` in the container — the same
contract the native tools use.

**Models and transport.** There is no provider knob: the transport is derived
from the model id — `vendor/slug` goes to OpenRouter, `claude-*` to the Claude
Agent SDK.

| Variable | Default | |
|---|---|---|
| `ALDUS_READER_MODEL` | `google/gemini-3.1-flash-lite` | the reader |
| `ALDUS_EDITOR_MODEL` | `claude-sonnet-5` | the editor |
| `ALDUS_MAX_TURNS` | `24` | the editor's turn budget |
| `OPENROUTER_API_KEY` | — | needed by any `vendor/slug` model |
| `ANTHROPIC_API_KEY` | — | **unset = bill the Claude Code subscription** |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | the subscription, headless |

The default pairing puts the cheap model where the whole document goes and the
strong one where the edits happen. See [docs/agent.md](docs/agent.md) for cost,
guardrails, and the fan-out.

---

## Embed the editor in your own app

The editor ships inside `aldus` under the **`aldus/editor`** subpath — a single
`<AldusEditor>` component you drop into your host and point at your backend. This
is how a real host (e.g. an e-signature product) puts a document editor behind its
own auth and routes.

```tsx
import { AldusEditor, configureAldusApi } from 'aldus/editor';
import 'aldus/editor/styles.css';
import { GlobalWorkerOptions } from 'pdfjs-dist';

// pdf.js worker (peer dep) — set once at startup:
GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

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
| `panelTabs` / `panelFooter` | inject your own tabs and footer into the right panel |
| `hostBoxes` / `hostTools` | overlay your own draggable boxes and rail tools |

**The wire protocol.** The editor talks to a small REST surface — mount an
`@aldus/server` instance under your `apiBase`, or proxy these to one:

```
POST   /:id/bake        apply pending edits → new PDF revision
POST   /:id/ops         instant server op (add text, watermark, header/footer, link…)
POST   /:id/agent       run an agent turn (streams NDJSON; `mode` picks the agent)
POST   /:id/fields      form field ops     ·   POST /:id/images   insert an image
GET    /:id/pdf         the current bytes  ·   GET/PUT /:id/edits  the pending edits
POST   /:id/revert      roll back one revision
POST   /   ·   GET /    upload  ·  list
```

Your host owns the store, auth, and lifecycle; Aldus owns the editing.
`@aldus/server` ships a reference file-backed `DocStore` (keeps N revisions) you
can swap for your own by binding a different implementation in its composition
root.

---

## How it's built

A pnpm monorepo layered so dependencies only ever point one way — protocol layers
stay dumb, one layer holds the intelligence.

```
packages/core      @aldus/core     the engine: model, extraction, bake. Zero LLM.
packages/agent     @aldus/agent    EditSession + the two agents + the `aldus` CLI
packages/editor    aldus-editor    the React editor            → npm
packages/aldus-pdf aldus           the distribution            → npm
apps/server        @aldus/server   reference Express host + DocStore
```

`@aldus/core` and `@aldus/agent` are **internal** — `aldus` bundles them, plus
the server and the editor, into the one package you install.

Extensibility is by **contract, not modification**: a new edit kind is an
`IEditApplier`, a new agent tool an `IAgentTool`, a new transport an
`ILlmTransport` — each one a new file plus one registration, never an edit to a
sibling. The full map is in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

### Develop & test

```bash
pnpm install
pnpm dev          # reference app: server :4100 + editor :5190
pnpm build && pnpm test
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
