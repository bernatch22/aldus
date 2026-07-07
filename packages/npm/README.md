# @bernatch22/aldus

Pixel-perfect **PDF editing** over a PDF's real content graph, plus an **LLM
agent** that reads, edits, highlights, links, and **fills/builds forms** — from
code or the `aldus` CLI. The agent runs on your **Claude Code subscription** or
on **OpenRouter** (for headless/public use).

> Bundled build of the [`aldus`](https://github.com/bernatch22/aldus) monorepo
> (`@aldus/core` + `@aldus/agent`) → one self-contained package. Powers the demo
> at [bernardocastro.dev/aldus](https://bernardocastro.dev/aldus).

## Install

```bash
npm i @bernatch22/aldus      # library + the `aldus` CLI
```

## CLI

```bash
aldus doc.pdf "Describe the content"                 # ask (LLM)
aldus doc.pdf "Highlight the totals" -o out.pdf --open
aldus form.pdf --fields                               # dump fields + values + positions (no LLM)
aldus form.pdf --fill '{"name":"Ana"}' -o filled.pdf  # fill by field name (no LLM)
aldus doc.pdf                                          # interactive chat
```

`--fields` / `--fill` are **deterministic** (no LLM). The agentic prompts need a
provider (below).

## Provider

- **Subscription** (default): run **without** `ANTHROPIC_API_KEY` — bills your
  Claude Code subscription.
- **OpenRouter** (headless / servers): `ALDUS_PROVIDER=openrouter` +
  `OPENROUTER_API_KEY` (or an `OPENROUTER_BASE_URL` pointing at an
  OpenAI-compatible proxy). Model via `ALDUS_OPENROUTER_MODEL`.

## Library

```ts
import { loadDoc, EditSession, runTurn, serializeDoc } from '@bernatch22/aldus';
import { readFormFields, setFieldValues } from '@bernatch22/aldus'; // deterministic form I/O

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
