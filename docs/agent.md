# The agent

Aldus's agent edits PDFs **without vision**. It doesn't look at pixels and guess
coordinates — it gets the typed content graph in its prompt and calls tools by
node id (`p1-y708-x72`). A hallucinated coordinate isn't possible: there are no
coordinates to hallucinate.

## Two levels

```
prompt ──▶ READER (cheap, reads the whole doc)
              ├── answers directly ─────────────▶ you
              ├── fills form fields ────────────▶ you
              └── routes an edit ──▶ EDITOR (strong, only the affected pages)
                                       └── report ──▶ reader ──▶ you
```

- The **reader** (`readTurn`) sees the whole document and answers your question.
  It can also **fill form fields on its own** — `fill_field`/`fill_fields` are
  `level: 'both'` because filling needs only a field *name*, which the reading
  view already lists, not the graph. Everything else it delegates.
- The **editor** (`editPages`) runs with only the pages that matter, and has the
  edit tools.

This is cost tuning, not two brains: point both at the same model if you'd
rather have one.

### Routed, or addressed directly

The arrow from reader to editor is **optional**, and it's just the `editor`
callback you pass to `readTurn`:

- **Pass it** → the reader gets an `edit_document({pages, request})` tool and
  routes edits itself. One conversation, the model picks the scope.
- **Omit it** → the reader is read-only-plus-filling and says so when asked for
  anything else. You then call `editPages` yourself, with the scope *you* decide.

The bundled editor UI takes the second path: CASPER has two tabs (**Lectura** /
**Edición**), one conversation each, and the editor tab is scoped to the page
you're looking at instead of to a page list a cheap model guessed. The server
picks between them on `mode` — see [server.md](server.md#agent).

### Fan-out

When the reader routes N pages, `editPages` launches **one editor per page in
parallel**, each with its own scoped graph — latency becomes the slowest page,
not the sum. Measured: 4 pages, 31 fields, **235s → 118s**.

They share one `EditSession`, so mutations are serialized through a `Mutex`: the
parallelism is in waiting for the model, the mutation stays ordered. One editor
failing doesn't take down the others; if *all* fail, it propagates.

## Usage

The simplest path is the CLI — one verb per agent, and it wires all of this for
you ([cli.md](cli.md)):

```bash
aldus ask  doc.pdf "What does clause 4 say?"        # reader → stdout
aldus edit doc.pdf "Highlight the totals" -o out.pdf  # editor → a new PDF
```

Programmatically:

```ts
import { createAgentContainer, loadDoc, EditSession, readTurn, editPages,
         IToolRegistry, IAgentConfig } from 'aldus';

const agent = createAgentContainer();
const registry = agent.get(IToolRegistry);
const config = agent.get(IAgentConfig);

const doc = await loadDoc('contract.pdf');
const session = new EditSession(doc);

const { text } = await readTurn(
  {
    doc, session, prompt: 'Highlight the totals', history: [],
    onEvent: ev => console.log(ev),
    // OPTIONAL — this callback IS the reader→editor door. Drop it and the
    // reader answers + fills fields only, never delegating.
    editor: async route => {
      const r = await editPages(
        { doc, session, request: route.request, pages: route.pages, parallel: route.parallel },
        registry, config,
      );
      return r.text || `✓ ${r.toolCalls} edits applied.`;
    },
  },
  registry, config,
);

const fin = await session.finishTurn();   // { kind: 'baked' | 'edits', … }
```

To address the editor **directly** — no reader in front, you choose the scope:

```ts
const r = await editPages(
  { doc, session, request: 'Highlight the totals', pages: [3] },
  registry, config,
);
const fin = await session.finishTurn();
```

`apps/server/src/routes/agent.ts` is the reference wiring for both, including
cancellation and per-document history.

## Auth and models

### There is no provider knob

The transport is derived from the **model id**, and nothing else:

```
vendor/slug   (contains '/')   → OpenRouter
claude-*                       → Claude Agent SDK
```

So you pick a provider by naming a model. The two agents are configured
independently — the default deliberately puts each on a different provider.

| Variable | Default | |
|---|---|---|
| `ALDUS_READER_MODEL` | `google/gemini-3.1-flash-lite` | the reader → OpenRouter |
| `ALDUS_EDITOR_MODEL` | `claude-sonnet-5` | the editor → Claude SDK |
| `ALDUS_MAX_TURNS` | `24` | the editor's turn budget |
| `OPENROUTER_API_KEY` | — | required by any `vendor/slug` model |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | any OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | — | **unset = bill the Claude Code subscription** |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | the subscription, headless |

`aldus tools` prints the models and transports actually in effect — the fastest
way to check your config is what you think it is.

### Claude Code subscription

No per-token bill, best quality, but it can't run on a public server.

- **Interactive / your machine**: run **without** `ANTHROPIC_API_KEY`. The CLI
  launcher deletes it from the child process on purpose (`ALDUS_USE_API_KEY=1`
  keeps it).
- **Headless / servers**: set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).

If the session expires you'll see `Failed to authenticate: OAuth session
expired` — run `claude login`, or move that agent to OpenRouter:

```bash
export ALDUS_EDITOR_MODEL='anthropic/claude-sonnet-4.5'   # same model, via OpenRouter
export OPENROUTER_API_KEY=sk-or-...
```

### OpenRouter

For hosted demos and cheaper runs — any OpenAI-compatible model:

```bash
export OPENROUTER_API_KEY=sk-or-...
export ALDUS_READER_MODEL='google/gemini-3.1-flash-lite'
export ALDUS_EDITOR_MODEL='anthropic/claude-sonnet-4.5'
```

Put the cheap model on the reader (it gets the whole document) and the good one
on the editor. The default pairing measures **~1.8¢/turn on a 9-page doc, ~3–9s
per turn**.

## What it can do

Text edit/move/color/size/delete · paragraph and cross-page section replace ·
whole-page recompose · images move/delete/insert · highlights (create/recolor/
remove) · links · watermark · header/footer · **form fields**: create any type
(text/checkbox/radio/select/list/button/signature), move/delete, read values +
positions, fill by name, and **convert placeholders into real fields**.

It's aware of the full geometry and style of every element. See
[library.md](library.md#editsession--the-edit-façade) — the tools are thin
delegations to `EditSession`, so its API *is* the agent's capability list.

## Tools speak a protocol

Every tool returns a string, and its first character is the outcome:

| Prefix | Meaning | Retriable |
|---|---|---|
| `✓` | applied | — |
| `↩︎` | skipped — already done, **don't repeat the call** | no |
| `⚠️` | problem, with the reason | yes — the model can fix the args |

The registry classifies these into a structured `ToolOutcome` and is the agent's
**single catch site**: a throwing tool becomes `⚠️ internal error`, and the stack
goes to the log — never to the model, never to the user.

## Adding your own tools

`createAgentContainer()` is a DI container. A host that wants domain tools
(signers, sends, templates) binds them — the dispatcher isn't touched:

```ts
import { IAgentTool } from 'aldus';

const myTool: IAgentTool = {
  name: 'list_signers',
  description: 'Lists the signers of this agreement.',
  level: 'reader',                  // 'reader' | 'editor' | 'both'
  shape: { docId: z.string() },     // zod → JSON Schema automatically
  run: async (ctx, args) => `…`,
};
```

`level` decides which model sees it: query/action tools belong on the cheap
`reader` level; anything that mutates the document belongs on `editor`.

Use `'both'` only for tools that need the document *and* make sense from a
reading turn — `fill_field` is the one native example. Note the consequence: a
**document-less turn** (the org-level host chat, no `doc`/`session`) is offered
`'reader'` tools *only*, since `'both'` tools would have no `EditSession` to
mutate. A host tool that must work without a document belongs on `'reader'`.

## Guardrails worth knowing

The agent is deliberately fenced where models are unreliable:

- **`edit_text` refuses to rewrite placeholders — both families** (dotted/
  underscore leaders AND `XXXX`/`xxx`/`***` fillers) and points at
  `placeholders_to_fields` instead. Models try to emulate the tool by writing
  spaces, `"DD/MM/AAAA"` or `"[Label]"` over fillers (seen in a real Gemini
  run): that *looks* like a blank but isn't fillable, and breaks the layout.
- **Fillers are rewritten as BLANK GAPS**: `placeholders_to_fields` removes the
  `XXXX` run, reflows the paragraph, and lands the field on the measured gap
  between re-extracted runs — bounded by neighbouring text, so it can never
  cover a letter. Leader placeholders keep the direct, zero-reflow placement
  (field widths clip to the filler run).
- **`watermark` / `headerFooter` are idempotent** — in a fan-out, N page editors
  applying the same watermark leave one, not N stacked.
- **`replace_paragraph` refuses a paragraph already modified this session**,
  instead of stacking a second rewrite on top.
- When a reflow **can't fit** the new text even compressed, it aborts and says so
  rather than overflowing the page.

## Related

- [cli.md](cli.md) — the agent from the terminal
- [server.md](server.md#agent) — the streaming NDJSON wire
- [library.md](library.md) — `EditSession`, which the tools delegate to
