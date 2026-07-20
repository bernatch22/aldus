# CLI

The `aldus` binary ships with the package.

```bash
npm i aldus        # installs the `aldus` bin
```

## One verb per agent

Aldus runs two agents ([agent.md](agent.md)), and the CLI gives each its own
verb. The split isn't "which model runs" — it's **what comes out the other end**:

```bash
aldus doc.pdf                                                # → the visual editor
aldus doc.pdf --chat                                         # → a terminal conversation
aldus ask  doc.pdf "What does the termination clause say?"   # → text on stdout
aldus edit doc.pdf "Uppercase the title" --pages 1           # → a new PDF
aldus form.pdf --fields                                      # → JSON, no LLM
aldus form.pdf --fill '{"name":"Ana"}'                       # → a filled PDF, no LLM
aldus tools                                                  # → the manifest
```

`ask` writes to stdout, so it pipes. `edit` writes a file, which is why `-o` and
`--pages` are its whole reason for existing.

### `aldus ask` — the reader

```bash
aldus ask contract.pdf "Summarise the payment terms"
aldus ask contract.pdf "What is the total?" | tee total.txt
```

Cheap model, whole document inline, answers in one pass. It has **no edit
tools** — asked for a change, it says so and points you at `aldus edit`.

One exception, and it's deliberate: the reader **can fill form fields**
(`fill_field` is `level: 'both'` — filling needs a field *name*, not the graph).
So `ask` can end up with changes:

```bash
aldus ask form.pdf "Fill it in with: Ana Pérez, ana@x.com, 12/03/2026"
# campos completados → PDF → form.edited.pdf
```

When that happens it bakes to a new file and says so. When it doesn't, `ask`
writes nothing at all.

### `aldus edit` — the editor

```bash
aldus edit doc.pdf "Turn the dotted placeholders into fillable fields" --pages 2
aldus edit doc.pdf "Highlight every total" -o highlighted.pdf
aldus edit doc.pdf "Fix the typos in the preamble" --auto
```

Strong model, every edit tool, scoped graph. The original is never touched — the
result goes to `<name>.edited.pdf` unless you pass `-o`.

| Flag | Meaning |
|---|---|
| `--pages 1,3` | the pages to edit (default: all of them) |
| `--auto` | put the **reader** in front to pick the pages for you |
| `-o <path>` | where to write the result |

**`--pages` vs `--auto`** is the real choice. Without a reader in front, someone
has to decide the scope, and by default that someone is you — same as the editor
tab in the visual editor, which is scoped to the page you're looking at. Reach
for `--auto` when you don't know where the thing lives: the reader reads the
whole document, picks the pages and delegates (fanning out one editor per page
when the work is independent).

If a turn changes nothing, `edit` says so in red and writes no file — a silent
`.edited.pdf` identical to the input is worse than a visible failure.

### `aldus tools`

Prints every bound tool by level, plus the models and transports in effect. The
fastest way to check your auth and config are what you think they are.

## `--chat` — the conversation

```bash
aldus contract.pdf --chat
```

A terminal conversation that **mirrors the two tabs** of the visual editor: it
starts in reading mode and you switch when you want to change something.

```
lectura ›  what does clause 4 say?
lectura ›  /edit
edición ›  uppercase the title
```

| Command | |
|---|---|
| `/ask` | reading mode — questions + filling fields (default) |
| `/edit` | editing mode |
| `/pages auto\|all\|1,3` | the editor's scope. Default `auto` |
| `/save [path]` | bake what's accumulated |
| `/status` | mode, scope, pending changes |
| `/help` `/exit` | Ctrl+C aborts the turn, Ctrl+D exits |

The editing scope defaults to **`auto`** — the reader picks the pages, same as
`aldus edit --auto`. In a conversation you rarely know page numbers. Reading mode
still can't delegate, ever; `auto` is an explicit choice you make in edit mode.

Edits **accumulate across turns** in one session and every save re-bakes from the
original, so turn 3's output contains turns 1-3. Reading keeps the last 10 turns
as memory, so "and now make it bold" works; editing turns are self-contained
orders and carry no history. **Leaving with unsaved changes saves them** — losing
edits you already paid a model for is the worst possible ending.

## Deterministic — no LLM, no API key

These never load a model or read your API key, and they resolve before any agent
config is built. They're the ones to script.

### `--fields`

```bash
aldus form.pdf --fields
aldus form.pdf --fields | jq '.[] | select(.type == "signature")'
```

Dumps every field as **JSON on stdout** — name, type, current value, options,
read-only, and the page + rect of each widget (a radio group has one per option).
Enough to know exactly where a signature will land. Warnings go to stderr, so the
pipe stays clean.

### `--fill`

```bash
aldus form.pdf --fill '{"name":"Ana","agrees":"true","plan":"Pro"}'
aldus form.pdf --fill '{"name":"Ana"}' -o signed.pdf --flatten
```

Fills **by field name** → `<name>.filled.pdf` unless you pass `-o`. Values can be
text, numbers, booleans or lists.

| Flag | Meaning |
|---|---|
| `-o <path>` | where to write the result |
| `--flatten` | flatten after filling — burns the values in, drops the AcroForm, no longer editable |

Problems come back as warnings rather than exceptions — a name that doesn't
exist, a read-only field, an invalid select option — and they're all printed. If
**nothing** applied, it fails and writes no file: a PDF named "filled" that's
identical to the input is worse than an error.

## Auth

The launcher (`bin/aldus.mjs`) **deletes `ANTHROPIC_API_KEY`** from the child
process on purpose: the agent is meant to run on your Claude Code subscription,
not a per-token bill. Set `ALDUS_USE_API_KEY=1` to keep it.

See [agent.md](agent.md) for the full auth and model matrix.

## `aldus <pdf>` — the visual editor

```bash
aldus contract.pdf
```

No verb, no prompt: boots a local server, serves the editor SPA, uploads the
file and opens your browser on that document — the full visual editor with the
CASPER panel. It runs until Ctrl+C. No database, no accounts; the document lives
in a temp dir (`ALDUS_DATA` overrides it, `ALDUS_PORT` the port).

The same thing is available programmatically as `openInEditor(file)`.

## Related

- [agent.md](agent.md) — the two agents, providers, models, cost
- [library.md](library.md) — the same operations as a programmatic API
- [server.md](server.md) — the HTTP wire, including `mode` on `/agent`
