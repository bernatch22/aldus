# Aldus // MAGI SYSTEM

> *God's in his heaven. All's right with the PDF.*

**Aldus is a pixel-perfect PDF editor that edits the document's real content
graph — it never paints white boxes over your text and never redraws it with
approximated fonts.** It parses the actual content-stream operators, lets you
edit them in place (UI or LLM agent), and splices the result back byte-by-byte.

> Aldus Manutius invented italics; Aldus Corp. created PageMaker, the father
> of desktop publishing. This Aldus edits PDFs with that same typographic
> obsession.

[Léeme en español](README.es.md) · [Architecture](docs/architecture.md) ·
[Bake internals](docs/bake-internals.md) · [Coordinates](docs/coordinate-system.md) ·
[Roadmap](docs/roadmap.md)

## Why this exists

Every web PDF "editor" cheats: it rasterizes, or it paints a white rectangle
over the old text and draws new text on top with whatever font it has. Aldus
does what Acrobat does — and is honest when it can't:

- **Move / scale / restyle text** → the original show operators are re-emitted
  **verbatim** (same bytes, same font, same TJ kerning) with a relocated
  matrix. Pixel-perfect.
- **New text, same font** → re-encoded through the embedded font's reverse
  `/ToUnicode` map. If a character is missing from the subset → explicit,
  *reported* fallback.
- **Font/style change** → embedded standard font, preserving the original
  color. Explicit substitution, the Acrobat policy — never a silent guess.
- **Can't locate a segment unambiguously?** It refuses to touch it and tells
  you why. What isn't understood is never modified.

## The MAGI

| Unit | Package | Role |
|---|---|---|
| **MELCHIOR·1** | `packages/core` (`@aldus/core`) | The scientist — model, extraction, and the content-stream **bake** |
| **BALTHASAR·2** | `apps/server` (`@aldus/server`) | The mother — Express API, document store with revisions |
| **CASPER·3** | `packages/agent` (`@aldus/agent`) | The woman — LLM agent (Claude Agent SDK) with the PDF graph embedded in its prompt |
| **NERV HQ** | `apps/editor` (`@aldus/editor`) | The UI — Vite + React, WYSIWYG local preview (the same bake, run in the browser) |

## Quickstart

```bash
pnpm install
pnpm dev          # server :4100 + editor :5190
```

Open http://localhost:5190, drop a PDF, double-click any text.

**The AI panel (CASPER)** talks to the document through the Claude Code
subscription — run the server *without* `ANTHROPIC_API_KEY`. Every knob is
documented in [`packages/agent/src/config.ts`](packages/agent/src/config.ts).

## Testing philosophy

```bash
pnpm -r test
```

Core tests run the **real cycle**: create a PDF → extract its graph → bake
edits into the content stream → re-extract → assert the world matches. No
mocked PDFs, no golden pixels — the parser itself is the oracle. The editor's
DOM bridge (`styledDom`) is tested headless in jsdom.

## Project layout

```
packages/core     model + extraction + bake (./bake subpath isolates pdf-lib)
  src/bake/       tokenizer → textWalk (ISO 32000 §9.4 machine) → splice
                  text.ts holds the emit STRATEGIES (A/B/C above)
packages/agent    the LLM agent + CLI (bin/aldus)
apps/server       routes/ + DocStore (repository with N revisions)
apps/editor       React editor; behaviors live in hooks (pages/editor/*)
```

The server is **localhost-only by design** (`ALDUS_ALLOW_REMOTE=1` to opt
out — put your own auth in front). Debug logging is gated: `ALDUS_DEBUG=1`
(Node) or `localStorage.aldusDebug = '1'` (browser).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: dependency
direction is law, coordinates convert only in `coords.ts`, gap thresholds live
only in `tokens.ts`, and the bake never guesses.

## License

[MIT](LICENSE) — Bernardo Castro.
