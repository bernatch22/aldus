# Changelog — aldus

Newest first; dates `YYYY-MM-DD`. This file is the source of truth for the notes
of every GitHub Release.

## 0.6.1 — 2026-07-21 — the agent wears the host's name

### `agentBrand`: the panel stops saying CASPER inside someone else's product

The panel header hardcoded **CASPER** — right for the standalone editor, wrong
inside an embedding host: the host already has a name for its assistant
(signwax calls it *Wax AI*), and a second brand inside the same screen reads as
somebody else's software bolted on. `<AldusEditor agentBrand={…}>` names the
agent; default stays CASPER.

(Meant to ride in 0.6.0, but that version was published to npm minutes before
the prop landed — npm versions are immutable, so it ships one patch later. The
`v0.6.0` git tag was moved back to match the published artifact exactly.)

## 0.6.0 — 2026-07-21 — `aldus/editor` ships its types

### The editor subpath is no longer `any`

`aldus/editor` published a 1.8 MB bundle and **zero** `.d.ts`: in every host,
`AldusEditor`, `configureAldusApi`, `aldusApi` and `HostBox` were `any` (TS7016).
That is how the 0.4.0 `agentStream` breaking change (positional → options
object) sailed through a host's compiler unnoticed — the exact class of bug
types exist to catch.

The root cause was upstream of packaging: `tsconfig.base.json` never set `jsx`,
so the React half of the editor **had never been through `tsc` at all**. Turning
it on surfaced 30 dormant strictness errors (`noUncheckedIndexedAccess` — all
`lines[i]`-style accesses already guarded by `i < lines.length` one token
earlier, plus one real find: `agentStream` called its **optional** `onEvent`
unguarded). All fixed; none changed behaviour.

The build now emits the declaration tree next to the bundle
(`dist/editor-lib/types/**`), rewrites `@aldus/core*` specifiers to the
`dist/_core` types that already ship in the package (same trick as the main
entry), strips CSS side-effect imports, and **fails loudly** if the entry
`.d.ts` is missing, doesn't re-export `AldusEditorProps`, or any `@aldus/*`
specifier survives — a package that lies about its types should not build.

Verified with a real consumer probe: a scratch project that installs the
tarball and compiles `import { AldusEditor } from 'aldus/editor'` under
`strict` — including two `@ts-expect-error` lines proving that a bad
`agentStream` mode and the pre-0.4.0 positional call now FAIL to compile.

## 0.5.1 — 2026-07-21 — the host hears about what the agent did

### `onAgentApplied`: the embedding host gets told when the agent writes

When the agent bakes and persists, the editor reloads itself — but the **host**
never heard about it. That is fine for a host whose only state is the PDF, and
wrong for every real one: an e-sign host keeps signers and fields alongside the
document, and a single edit turn can create fields, assign them to a party, or
add a signer. The host kept showing the state from before the turn until
something else happened to refresh it.

`<AldusEditor onAgentApplied={() => …}>` fires right after the internal reload.
No behaviour changes without it — hosts that don't pass it are unaffected.

It is a callback and not a `refreshKey`-style bump because the host already owns
`refreshKey` for the opposite direction (host edited → tell the editor); reusing
one channel for both would make "who reloads whom" ambiguous.

Not unit-tested: rendering `AldusEditor` needs pdf.js, a canvas and a live API,
and standing that up to assert a one-line pass-through would test the harness,
not the code. It is covered where it actually matters — the host that consumes it.

## 0.5.0 — 2026-07-20 — a transport that can force a tool

### The transport can force a tool, and lift its output cap

Two optional fields on `PassRequest`, both aimed at hosts that use the transport
for something other than the agent loop:

- **`toolChoice`** — force one named tool instead of letting the model pick. A
  caller doing *structured extraction* doesn't want prose, it wants the object;
  without this the model is free to answer in text and the parse downstream gets
  nothing. It is sent **only on the first pass**: keep forcing it and the model
  calls the same tool until the turn runs out of budget. Never sent when there
  are no tools — the endpoint rejects a `tool_choice` it cannot satisfy.
- **`maxOutputTokens`** — raise the 8192 default for long generation (a whole
  contract). The cap exists because OpenRouter *reserves* credit against it.

`ClaudeSdkTransport` ignores both, and says so: it runs the agentic loop inside
the SDK and exposes neither knob per pass.

### The editor edits the pages *you* choose

The Edición tab was hard-wired to the page you happened to be viewing, so
"convert the placeholders in the whole contract" was impossible from the UI. It
now picks its scope — *esta* / *todas* / a range like `1, 3, 5-7` — and past one
page, a checkbox chooses between one editor per page in parallel (fast, small
prompts) and a single editor that sees them all, which is what an edit crossing
pages needs. On the wire: `pages[]` and `parallel` (`page` still accepted).

`AldusApi.agentStream` now takes `(id, prompt, options)`. **Breaking**: the
positional form had reached nine parameters, four of them optional, and adding
one more meant counting commas at the call site.

### A tool's outcome stops being guessed from its text

`dedupedDispatch` computed a structured `ToolOutcome` — `ok`, `code`,
`retriable` — and then threw everything but `.message` away, so callers
re-derived the result by sniffing the prefix (`msg.startsWith('✓')`). The ✓ is
presentation for the model; making control flow depend on it means a tool that
rewords its message breaks a caller across the package. Dispatch now returns the
outcome, and `classify()` is the only place that knows what the prefixes mean.

### `placeholders_to_fields_batch` stops reporting work it didn't do

Conversion works per **paragraph**, but the model sends one group per **line**,
so its sibling lines came back `↩︎ already converted` — correct, since the first
call converts the whole paragraph. The batch counted those as converted anyway:
"✓ N fields in 3 paragraphs" while two did nothing, contradicting its own
per-group lines. The model noticed and burned turns re-verifying.

Groups that resolve to the same paragraph are now **merged before running**, so
the semantic names the model chose for those lines get used instead of being
swept up as `campo_N`. Skips are counted separately from failures, and the field
count comes from the session, not a regex over the previous message.

## 0.4.0 — 2026-07-20 — two agents you can address separately, and a CLI that matches its docs

### The editor finally sees the document as it *is*

The graph is extracted from the PDF on disk, but edits live in the session's
ledger — so the editor was reading the document as it was **before its own
changes**. On a second turn it would quote text it had already replaced and
anchor to nodes it had deleted. Both agents now serialize an **effective view**:
the graph with the pending ledger applied.

Each successful tool call also returns a **diff of what actually changed**,
replacing the old "±2 neighbours of the page in the `id` argument" snippet. That
snippet failed precisely for the tools that move the document most:
`placeholders_to_fields_batch` takes `groups[]` and `replace_section` takes
`start_id`/`end_id` — neither has an `id` or `page` argument, so the model got
*nothing* back and burned calls guessing at the new state.

### Reader and editor are now two agents you address separately

They were always two models, but only reachable as one pipeline: the reader read
the document and decided whether to delegate. Now each is addressable on its own,
because the useful distinction isn't which model runs — it's **what comes out the
other end**.

- **HTTP**: `POST /:id/agent` takes `mode: 'reader' | 'editor'`. In `reader` mode
  the server doesn't wire the editor callback at all, so the reader has no
  `edit_document` tool and can't pretend it edited something.
- **The editor UI**: CASPER has two tabs (*Lectura* / *Edición*), one conversation
  each. Both threads stay mounted, so a long edit keeps running — and still
  applies its edits — while you read in the other tab. The editor tab is scoped to
  the page you're looking at, instead of to a page list a cheap model guessed.
- **The CLI**: one verb per agent — `aldus ask` writes text to stdout (so it
  pipes), `aldus edit` writes a PDF (so it takes `-o` and `--pages`).

Routing didn't go away: it's `aldus edit --auto`, and passing `editor:` to
`readTurn` still gives the reader its `edit_document` tool. It's now a choice
rather than the only path.

### The reader fills form fields on its own

`fill_field` / `fill_fields` moved to `level: 'both'`. Filling a form needs a
field *name*, not the graph — so sending it to the expensive editor with the full
page graph was wasted money. The reading view now lists each field with its
current value and the text sitting next to it, because the raw field names are
usually opaque (`id-1234`) and without that label the model can't tell which is
which.

Fixed alongside: a **document-less turn** (a host's org-level chat, no
`doc`/`session`) was being offered those `'both'` tools, which would have failed
against a session that doesn't exist. The registry now filters them out.

### The CLI does what the READMEs said it did

Three commands were documented — in the README that **ships to npm** — and did not
exist. Anyone who installed `aldus` and followed it got an error. They exist now:

- `aldus <pdf>` — the visual editor. The whole pipeline was already there
  (`openInEditor`, the bundled server, the SPA in `dist/editor`); only the CLI
  branch was missing.
- `aldus <pdf> --fields` — every field as JSON on stdout, pipeable.
- `aldus <pdf> --fill '{…}'` — fill by name, plus `--flatten`. Both are
  deterministic: no model, no API key, and they resolve before the agent
  container is even built.
- `aldus <pdf> --chat` — a terminal conversation mirroring the two tabs, with
  `/ask`, `/edit`, `/pages`, `/save`, `/status`.

Also fixed: an **unknown flag is now an error**. It used to fall through as a
positional argument, so `aldus doc.pdf --chat` didn't say "I don't know `--chat`",
it said "`aldus <pdf>` takes no prompt" — an error that points nowhere.

And a failing turn now explains itself. An expired session or an empty balance
used to print a raw SDK stack trace; it now names the agent, the model, and the
provider that model actually goes through, with the command to fix it.

### Documentation that stopped lying

- **`ARCHITECTURE.md`** (new) — the packages and which two are published, the
  layering, the graph model, the bake, the two agents, and every extension point.
- **The agent's environment variables were entirely fictional.** `ALDUS_PROVIDER`,
  `ALDUS_MODEL`, `ALDUS_CHAT_MODEL`, `ALDUS_OPENROUTER_MODEL` and
  `ALDUS_OPENROUTER_CHAT_MODEL` do not exist and never did. The real ones are
  `ALDUS_READER_MODEL` and `ALDUS_EDITOR_MODEL` — and there is **no provider
  knob**: the transport is derived from the model id (`vendor/slug` → OpenRouter,
  `claude-*` → Claude SDK).
- The README's first two code samples didn't compile — they imported
  `extractPageGraph` and `mergeSegmentEdit`, neither of which `aldus` re-exports.
  Every symbol in the README is now verified against the package's actual exports.

## 0.3.1 — 2026-07-19 — hotfix: never let the reasoning opt-out cost a turn

`0.3.0` sent `reasoning: {enabled: false}` on every OpenRouter request. Endpoints
that *mandate* reasoning reject it with `400 "Reasoning is mandatory for this
endpoint and cannot be disabled"` — which killed the whole turn instead of just
losing an optimisation. It hit production immediately: the public demo's reader
(`google/gemini-3.5-flash`) 400'd on every request while local runs (flash-lite
reader + Sonnet editor) never touched a mandatory-reasoning endpoint.

The flag is now self-healing: on that specific 400 the model is recorded and the
request retried without it, and the flag is never sent for that model again. No
allowlist to maintain, works for any present or future endpoint, and the cost
optimisation still applies everywhere it is accepted.

## 0.3.0 — 2026-07-19 — filler placeholders become real fields, and the agent turn gets 2.7× cheaper

### Placeholders: `XXXX` / `xxx` / `***` are now converted (not painted over)

`placeholders_to_fields` used to have a single strategy — drop the field directly
on the printed rect and never touch the text. That is right for dotted/underscore
**leaders** (`.....`, `____`): the field covers them, like a paper form. It was
wrong for **fillers**: the `XXXX` stayed visible under the widget, and the field
inherited the filler's printed width (a `XX` day placeholder became a ~15pt box —
unusable). Now the tool picks one of two modes automatically:

- **Usable leader run** → unchanged behaviour: field on the real rect, text intact,
  zero reflow. The whole leader-based corpus is byte-identical to 0.2.0.
- **Leaderless filler** → the filler is **removed**: the hole is re-emitted as a
  blank geometric gap sized to the data's useful width, the paragraph reflows
  (extra line + content below shifted when needed), and each field lands on the
  **measured gap between re-extracted runs** — bounded by the neighbouring text,
  so a field cannot overlap a glyph by construction.

Defences added along the way, each one paid for by a real failure:

- **Phrase split**: `"XX de XXXXXX de XXXX"` passed as one field becomes three
  holes; the words between them survive (one big hole ate contract text).
- **Label anchoring**: a match with no leaders/fillers inside (`[denominación
  social de la empresa]`) is **not** a placeholder. It anchors to the adjacent
  leader run instead of being converted — previously a model passing labels
  deleted contract text and re-emitted broken glyphs visibly.
- **Filler sweep**: with a reflow underway, every `x`/`X`/`*` run in the paragraph
  is converted, not just the ones the model listed (models send them one at a
  time and the second call hits the anti-recall guard, orphaning the rest).
- **Guardrails on the escape hatches**: `edit_text`, `replace_paragraph` and
  `replace_section` now refuse to "convert" placeholders by hand. Writing spaces,
  `DD/MM/AAAA` or `[Label]` looks like a blank but is not fillable — models
  reached for all three when the first was blocked.
- **Session-unique field names**, and pending (not-yet-baked) fields are operable
  by name via `fill_field` / `move_field` / `delete_field`.

### Layout engine

- `spaceW` is measured from the paragraph's own justified spacing instead of a
  fixed `0.28em`. Word stretches spaces via `Tw` and re-emission inherits it; the
  fixed value undershot and runs anchored **inside** their neighbour (`"desde
  elde"` glyph overlap).
- **Anchor-pierced detection**: pdf.js merges overlapping items into one, so a
  gap-based collision check saw nothing. Overlap is now detected by comparing an
  emitted run's expected anchor against the item that spans it, and the fix is
  applied to that exact run (`dxFix` keyed by row+index — keying by text hit every
  identical word in the paragraph instead of the guilty one).
- Collision now requires **real overlap** (`gap < -0.5`), not tangency: style
  boundaries always report `gap ≈ 0`, so the old threshold looped forever
  accumulating phantom corrections until the paragraph spuriously aborted.

### Cost and robustness of the agent turn

Measured end to end with per-request cost accounting (`usage: {include: true}`,
logged behind `aldus:transport:openrouter`). A Sonnet run over a 4-page contract
went from **$1.08 / 308s** to **$0.405 / 19s**, converting 4/4 pages instead of 3/4:

- **`reasoning: {enabled: false}`** on the OpenRouter transport. Extended thinking
  is on by default for models that support it — 5–8k output tokens *per tool call*
  at $15/M was 66% of the bill. This agent's model only detects and names; the
  layout is deterministic code.
- **Fused `tramos` in the prompt** (display only — the graph is untouched). PDFs
  with broken `/ToUnicode` split every accent into its own run
  (`"identificaci|ó|n"`); that confetti was 55–60% of the prompt. The noisiest
  page made the editor claim it "could not call tools" and skip the page
  entirely. Fused, it converts.
- **Id anchors on "not found"**: models derive ids from shifted coordinates after
  a reflow (`p3-y137 @(121,132)` → invented `p3-y132-x121`, 25 wasted tool calls
  in one run). The error now states that ids are immutable and lists the three
  real ids nearest the attempted position.
- Anthropic **prompt caching** (`cache_control` on the system block) for long
  tool-calling loops.

### Notes

- The `aldus` graph, bake and editor APIs are unchanged; this is a behaviour
  release for the agent and the placeholder engine.
- Suite: 363 tests green.

## 0.2.0 — the unified `aldus` package + the two-level agent

Single package replacing `aldus-pdf` and `aldus-editor` (both deprecated; the
editor is now the `aldus/editor` subpath). Ships the two-level agent rewrite:
reader (cheap, routes) → editor (strong, edits), per-page fan-out over a shared
`EditSession`, one file per tool behind an IoC container.

> **Provenance note.** `0.2.0` was published from a working tree that still had
> the agent rewrite uncommitted, so its `gitHead` (`979b3c5`) points at the commit
> *before* the code it actually contains. No `v0.2.0` tag exists, because no
> commit reproduces that tarball exactly. Tagging starts at `v0.3.0`, which does
> correspond byte-for-byte to its commit.

## 0.1.0 — first release of the unified package
