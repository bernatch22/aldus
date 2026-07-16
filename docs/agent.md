# The agent

Aldus's agent edits PDFs **without vision**. It doesn't look at pixels and guess
coordinates — it gets the typed content graph in its prompt and calls tools by
node id (`p1-y708-x72`). A hallucinated coordinate isn't possible: there are no
coordinates to hallucinate.

## Two levels

```
prompt ──▶ READER (cheap, reads the whole doc)
              ├── answers directly ─────────────▶ you
              └── routes an edit ──▶ EDITOR (strong, only the affected pages)
                                       └── report ──▶ reader ──▶ you
```

- The **reader** (`readTurn`) sees the whole document and either answers your
  question or decides this is an edit and delegates.
- The **editor** (`editPages`) runs with only the pages that matter, and has the
  edit tools.

This is cost tuning, not two brains: point both at the same model if you'd
rather have one.

### Fan-out

When the reader routes N pages, `editPages` launches **one editor per page in
parallel**, each with its own scoped graph — latency becomes the slowest page,
not the sum. Measured: 4 pages, 31 fields, **235s → 118s**.

They share one `EditSession`, so mutations are serialized through a `Mutex`: the
parallelism is in waiting for the model, the mutation stays ordered. One editor
failing doesn't take down the others; if *all* fail, it propagates.

## Usage

The simplest path is the CLI — it wires all of this for you:

```bash
aldus doc.pdf "Highlight the totals" -o out.pdf
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

`apps/server/src/routes/agent.ts` is the reference wiring, including
cancellation and per-document history.

## Auth and models

### Claude Code subscription (default)

No per-token bill.

- **Interactive / your machine**: just run **without** `ANTHROPIC_API_KEY`. The
  CLI launcher deletes it from the child process on purpose (`ALDUS_USE_API_KEY=1`
  keeps it).
- **Headless / servers**: set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).

| Var | Default |
|---|---|
| `ALDUS_MODEL` | `claude-sonnet-5` (editor) |
| `ALDUS_CHAT_MODEL` | `claude-haiku-4-5` (reader) |

Best quality — but it can't run on a public server.

### OpenRouter

For hosted demos and cheaper runs. Any OpenAI-compatible model.

```bash
ALDUS_PROVIDER=openrouter
OPENROUTER_API_KEY=...
ALDUS_OPENROUTER_CHAT_MODEL=google/gemini-3.1-flash-lite   # reader
ALDUS_OPENROUTER_MODEL=google/gemini-3.5-flash             # editor
```

Put the cheap model on the reader (it reads every page) and the good one on the
editor. That pairing — the default — measures **~1.8¢/turn on a 9-page doc,
~3–9s per turn**.

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
  level: 'chat',                    // 'chat' | 'editor' | 'both'
  shape: { docId: z.string() },     // zod → JSON Schema automatically
  run: async (ctx, args) => `…`,
};
```

`level` decides which model sees it: query/action tools belong on the cheap
`chat` level; anything that mutates the document belongs on `editor`.

## Guardrails worth knowing

The agent is deliberately fenced where models are unreliable:

- **`edit_text` refuses to rewrite dotted/underscore placeholders** and points at
  `placeholders_to_fields` instead — filling `"....."` with `"XXXX"` by hand
  breaks the layout; the deterministic tool doesn't.
- **Field widths clip to the filler run**, so a sloppy range from the model can
  never cover a letter.
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
