# Changelog — aldus

Newest first; dates `YYYY-MM-DD`. This file is the source of truth for the notes
of every GitHub Release.

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
