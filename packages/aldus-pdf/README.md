# aldus

**A framework for building PDF apps on a PDF's real content graph.**

Aldus parses the actual content-stream operators into a typed, editable model,
lets you mutate them — from code, a CLI, a React editor, or an LLM agent — and
splices the result back into the file byte-for-byte. It never rasterizes, never
paints a white box over old text, and never redraws with an approximated font.

**One package, four entry points:**

```bash
npm i aldus
```

| | |
|---|---|
| `aldus` | the engine + the agent — [Library API](https://github.com/bernatch22/aldus/blob/main/docs/library.md) |
| `aldus/editor` | the embeddable React editor — [Editor](https://github.com/bernatch22/aldus/blob/main/docs/editor.md) |
| `aldus/server` | a ready-to-run backend — [Server](https://github.com/bernatch22/aldus/blob/main/docs/server.md) |
| `aldus` (bin) | the CLI — [CLI](https://github.com/bernatch22/aldus/blob/main/docs/cli.md) |

> **Migrating?** `aldus` replaces **`aldus-pdf`** (now `aldus`) and
> **`aldus-editor`** (now the `aldus/editor` subpath). Both are deprecated — the
> APIs are the same, just swap the import.

## Quick start

```bash
aldus doc.pdf                                         # visual editor + AI in your browser
aldus doc.pdf --chat                                  # conversation in the terminal
aldus ask  doc.pdf "What are the payment terms?"      # reader → answer on stdout
aldus edit doc.pdf "Highlight the totals" -o out.pdf  # editor → a new PDF
aldus form.pdf --fields                               # dump fields + positions (no LLM)
aldus form.pdf --fill '{"name":"Ana"}' -o filled.pdf  # fill by name (no LLM)
```

```ts
import { loadDoc, EditSession } from 'aldus';

const doc = await loadDoc('contract.pdf');
const session = new EditSession(doc);

session.editText('p1-y708-x72', 'FINAL');       // reflows the paragraph if it grows
session.addField('signature', 1, 90, 60, 200, 40, 'signature_a');
session.fillField('name', 'Ana');

await session.save('out.pdf');
```

```tsx
import { AldusEditor, configureAldusApi } from 'aldus/editor';
import 'aldus/editor/styles.css';

configureAldusApi({ apiBase: '/api' });
<AldusEditor docId={id} />;
```

## Why edit the graph, not the pixels

Every web PDF "editor" cheats: it rasterizes, or paints a white rectangle over
the old text and draws new text on top with whatever font it has. Aldus does what
Acrobat does — and is honest when it can't:

- **Move / scale / restyle text** → the original show operators are re-emitted
  **verbatim** (same bytes, same font, same kerning) with a relocated matrix.
- **New text, same font** → re-encoded through the embedded font's reverse
  `/ToUnicode` map. A glyph missing from the subset → an explicit, *reported*
  fallback.
- **Font/style change** → an embedded standard font, width-fit into the original
  slot. Explicit substitution, never a silent guess.
- **Can't locate a segment unambiguously?** It refuses to touch it and says why.

Every node has a stable id (`p1-y708-x72`). Every API addresses nodes by id —
so the agent has no coordinates to hallucinate, and needs no vision model.

## Documentation

| Doc | What's in it |
|---|---|
| **[CLI](https://github.com/bernatch22/aldus/blob/main/docs/cli.md)** | The four modes, every flag, and the deterministic (no-LLM) operations. |
| **[Library API](https://github.com/bernatch22/aldus/blob/main/docs/library.md)** | `EditSession` method by method, the bytes→bytes layer, forms, and exactly what the package root re-exports. |
| **[React editor](https://github.com/bernatch22/aldus/blob/main/docs/editor.md)** | `<AldusEditor>` props, the host-integration seams (your tabs, your boxes, your tools), the API client, forensic mode. |
| **[Server](https://github.com/bernatch22/aldus/blob/main/docs/server.md)** | Every HTTP route with body and response, the env knobs, the agent's NDJSON wire, embedding it in your own app. |
| **[Agent](https://github.com/bernatch22/aldus/blob/main/docs/agent.md)** | The two-level architecture, per-page fan-out, auth and models, cost, adding your own tools, the guardrails. |

## The agent, briefly

A cheap reader model reads the whole document and either answers or delegates the
edit to a stronger editor model running on just the affected pages — in parallel,
one editor per page. It edits **without vision**: the typed graph is in the
prompt and the tools take node ids.

Runs on your **Claude Code subscription** (no per-token bill) or **OpenRouter**
(~1.8¢/turn on a 9-page doc). Full matrix in
[docs/agent.md](https://github.com/bernatch22/aldus/blob/main/docs/agent.md#auth-and-models).

## What it can do

Text edit/move/color/size/delete · paragraph and cross-page section replace ·
whole-page recompose · images move/delete/insert · highlights · links ·
watermark · header/footer · **form fields**: create any type
(text/checkbox/radio/select/list/button/signature), move/delete, read values +
positions, fill by name, and convert `……` placeholders into real fields.

MIT · [source](https://github.com/bernatch22/aldus)
