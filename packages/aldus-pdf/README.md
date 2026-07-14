# aldus-pdf

A **framework for building PDF apps** on a PDF's real content graph: parse the
content-stream operators into an editable model, mutate them from code, the
`aldus` CLI, or an **LLM agent**, and splice the result back byte-for-byte — no
rasterizing, no white boxes, no approximated fonts. Read/edit/move text,
highlight, link, place images, and **read/fill/build forms & signature fields**.

> Bundled build of the [`aldus`](https://github.com/bernatch22/aldus) monorepo
> (`@aldus/core` + `@aldus/agent`) → one self-contained package.

## Install

```bash
npm i aldus-pdf      # library + the `aldus` CLI
```

## CLI

```bash
aldus doc.pdf                                         # opens the VISUAL EDITOR + AI in your browser
aldus doc.pdf "Describe the content"                 # one-shot agent (LLM)
aldus doc.pdf "Highlight the totals" -o out.pdf --open
aldus doc.pdf --chat                                  # interactive chat in the terminal
aldus form.pdf --fields                               # dump fields + values + positions (no LLM)
aldus form.pdf --fill '{"name":"Ana"}' -o filled.pdf  # fill by field name (no LLM)
```

`aldus file.pdf` with no prompt boots a local server (editor + CASPER agent) and
opens the browser — no database, no accounts. `--fields` / `--fill` are
**deterministic** (no LLM). Agentic prompts run on the auth below.

## Auth (agent)

Two-level agent (cheap chat/router → strong editor). Two providers:

**Claude Code subscription** (default) — no per-token bill:
- Interactive / your machine: just run **without** `ANTHROPIC_API_KEY`.
- Headless / servers: set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).
- Models: `ALDUS_MODEL` (editor, `claude-sonnet-5`), `ALDUS_CHAT_MODEL` (router, `claude-haiku-4-5`).

**OpenRouter** (`ALDUS_PROVIDER=openrouter`, `OPENROUTER_API_KEY`) — for hosted
demos / cheaper runs. **Recommended: Gemini.** Put the cheap model on the chat
(it reads every page) and the good one on the editor:
- `ALDUS_OPENROUTER_CHAT_MODEL=google/gemini-3.1-flash-lite` (router)
- `ALDUS_OPENROUTER_MODEL=google/gemini-3.5-flash` (editor)

That combo (the default) is ~1.8¢/turn on a 9-page doc and ~3–9s per turn.

## Library

```ts
import { loadDoc, EditSession, runTurn, serializeDoc } from 'aldus-pdf';
import { readFormFields, setFieldValues } from 'aldus-pdf'; // deterministic form I/O

const doc = await loadDoc('form.pdf');
const session = new EditSession(doc);
await runTurn({ doc, session, prompt: 'Fill the form: name Ana, plan Pro' });
await session.save('filled.pdf');
```

## What the agent can do

Text edit/move/color/size/delete · images move/delete/insert · highlight (create/
recolor/remove) · links · watermark · header/footer · **form fields**: create any
type (text/checkbox/radio/select/list/button/signature), move/delete, **read
values + positions**, and **fill** (by field name or by the `[[id]]` of the
reading view). It's aware of the full geometry & style of every element.

MIT · [source](https://github.com/bernatch22/aldus)
