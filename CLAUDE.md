# Aldus — working in this repo

Pixel-perfect PDF editing: parse the real content-stream graph and edit it **in
situ**. Never paint a white box over old text, never redraw with an approximated
font. pnpm monorepo, published on npm as **`aldus`**.

**Read these before writing code — they are current and they don't lie:**

| Doc | When |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | packages, layering, extension points. **Start here.** |
| [docs/cli.md](docs/cli.md) · [library.md](docs/library.md) · [editor.md](docs/editor.md) · [server.md](docs/server.md) · [agent.md](docs/agent.md) | how each surface is used |
| [CHANGELOG.md](CHANGELOG.md) | the source of truth for every release note |

Discovery: `megabrain ask "<question>" --repo ~/aldus-v2` for how/where/why. If
you already know the exact string (a label, an id, an error message), grep it.

---

## Run it

```bash
pnpm install
pnpm dev      # server :4100 + editor :5190 → http://localhost:5190
pnpm test     # 387 tests · core 246 · agent 93 · editor 39 · server 9
pnpm build    # all packages
```

Agent models (**there is no provider knob** — the transport is derived from the
model id: `vendor/slug` → OpenRouter, `claude-*` → Claude SDK):

```
ALDUS_READER_MODEL    default google/gemini-3.5-flash    reads, routes, fills fields
ALDUS_EDITOR_MODEL    default google/gemini-3.5-flash    edits with the real tools
ALDUS_MAX_TURNS       default 24
OPENROUTER_API_KEY / OPENROUTER_BASE_URL
```

Debug logs: `ALDUS_DEBUG=aldus:*` (Node) or `localStorage.aldusDebug='1'`.
Namespaces worth knowing: `aldus:reflow`, `aldus:transport:openrouter` (logs the
**real USD cost** of every request), `aldus:agent:editor`.

---

## The traps (each one cost a real debugging session)

**`@aldus/agent` is consumed as `dist`, never as source.** Its `exports` maps
only to `./dist/index.js`, so `apps/server` — and therefore `pnpm dev` — runs the
*compiled* bundle. Tests and `scripts/*.mts` run against `src`. So a green test
suite says **nothing** about the running server: **`pnpm build` before testing
anything through the server or the UI.**

**Kill orphans before starting a dev server.** `tsx watch` respawns a child that
grabs `:4100`, so a fresh `pnpm dev` dies with `EADDRINUSE` while an *old build*
keeps answering. Verify in your own log that the server actually booted, not just
that the port replies:

```bash
ps aux | grep "[a]ldus-v2" | grep -E "tsx|vite" | awk '{print $2}' | xargs -r kill -9
```

**Never verify UI yourself** — no screenshots, no DOM polling. Build, start the
server, hand the URL over, and wait.

**pdf.js TRANSFERS buffers to its worker** → always `bytes.slice()` before
`getDocument`/`bake`.

---

## Laws (breaking these is a bug, not a style choice)

- **A new capability is a new file plus one registration.** Never modify a
  sibling: a new emit strategy in `bake/text.ts`, a new font provider in
  `fontProviders.ts`, a new tool as one `IAgentTool` bound in `ioc.ts`.
- **The bake locates by GEOMETRY, never by index**, and refuses what it can't
  understand. A pass that can't be done right doesn't happen: `reflowApply`
  restores its snapshot and aborts rather than shipping a broken layout.
- **Coordinates convert only in `common/coords.ts`.** Gap thresholds only in
  `graph/tokens.ts`. The `Tz` sanity clamp (65–135%) is sacred — deformed glyphs
  are worse than a small gap.
- **The LLM detects, the code computes geometry.** Never the reverse. A model
  that passes coordinates is a model about to corrupt a page.
- **Bake `applied` / `warnings` strings are a de-facto API** (UI and tests read
  them). Don't reword without checking both.
- **`✓ / ↩︎ / ⚠️` is the tool protocol**, and `classify()` in
  `tools/registry.ts` is the only place allowed to interpret those prefixes —
  callers use the structured `ToolOutcome`, never `msg.startsWith('✓')`.

---

## Working on the agent

Two agents, separately addressable (`mode: 'reader' | 'editor'` over HTTP, one
CLI verb each, two tabs in the editor):

- **reader** — cheap, has the whole document inline, answers and fills form
  fields. Only reaches the editor if the host wires the `editor:` callback.
- **editor** — strong, gets the graph **scoped** to the requested pages, edits by
  anchoring to real node ids.

Both serialize an **effective view**: the graph with the session's pending ledger
applied. The graph comes from the PDF on disk and doesn't change mid-turn, so
without it the editor reads the document *before its own edits* — quoting text it
replaced and anchoring to nodes it deleted. Every successful tool call also
returns a **diff of what changed**; keep it that way, or the model burns turns
probing for the state.

### Testing agent changes without burning money

```bash
cd packages/agent
npx tsx scripts/replay-ledger.mts <dir>          # re-runs a past run's tool calls, no LLM
npx tsx scripts/eval-placeholders.mts <pdf...>   # full E2E + before/after crops per field
npx tsx scripts/dbg-prompt.mts <pdf> <page>      # exactly what the editor sees
npx tsx scripts/dbg-rows.mts <dir> <page>        # baked geometry: runs, gaps, widgets
```

`eval-placeholders.mts` writes `output.pdf`, per-field crops, an HTML gallery and
a ledger of every tool call with its arguments and result. `--reuse` re-crops
without calling the model.

**Iterate with the replay, confirm once with the real thing.** Every model call
costs money, and a Sonnet turn that flails is measured in dollars, not cents.

---

## Placeholders → fields (the most defended path in the repo)

Two automatic modes:

- **A usable leader run** (`.....`, `____`) → the field lands directly on the
  printed rect. Text untouched, zero reflow.
- **A leaderless filler** (`XXXX`, `xxx`, `***`) → the filler is *removed*, the
  hole is re-emitted as a **blank gap** at the data's useful width, the paragraph
  reflows, and the field lands on the **measured gap between re-extracted runs**
  — bounded by neighbouring text, so overlap is impossible by construction.

Never emit dots and estimate glyph positions to place a field: run edges are
exact pdf.js geometry, `charXOf` is an estimate, and the drift puts fields on top
of text. Descriptive labels (`[company legal name]`) are **not** placeholders —
they anchor to the adjacent leader run instead of being converted.

`edit_text`, `replace_paragraph` and `replace_section` all **refuse** to "convert"
placeholders by hand — writing spaces, `DD/MM/AAAA` or `[Label]` looks like a
blank but isn't fillable. Models reach for all three when the first is blocked.

Anti-recall guards are about **idempotency, not locking**: repeating a call with
the same resulting text is a no-op, but asking for *different* text on an
already-edited paragraph is a legitimate edit and must run.

---

## Finishing a task

A task isn't done when the code works — it's done when the docs don't lie.
Before saying "listo": update [CHANGELOG.md](CHANGELOG.md) (it *is* the release
notes), and check whether anything in `docs/` or the READMEs just became false.
The 0.4.0 entry exists because five documented env vars and three documented CLI
commands did not exist — in the README that ships to npm.

Releases: bump `packages/aldus-pdf/package.json`, tag `vX.Y.Z`, publish from that
directory (`--provenance` only works from CI). `gh` account for this repo:
`bernatch22`.
