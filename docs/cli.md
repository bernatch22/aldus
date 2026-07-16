# CLI

The `aldus` binary ships with the package. Everything the editor and the agent
can do is reachable from it.

```bash
npm i aldus        # installs the `aldus` bin
```

## The four modes

```bash
aldus doc.pdf                                         # 1. visual editor + AI in your browser
aldus doc.pdf "Describe the content"                  # 2. one-shot agent (LLM)
aldus doc.pdf --chat                                  # 3. interactive chat in the terminal
aldus form.pdf --fields                               # 4. deterministic ops (no LLM)
```

### 1. Visual editor

`aldus file.pdf` with **no prompt** boots the local server (editor + the CASPER
agent panel) and opens your browser. No database, no accounts — the document
lives on disk under the server's data dir.

### 2. One-shot agent

```bash
aldus doc.pdf "Highlight the totals" -o out.pdf --open
```

| Flag | Meaning |
|---|---|
| `-o <path>` | write the result here (default: `<name>.edited.pdf`) |
| `--open` | open the result when it's done |

### 3. Interactive chat

```bash
aldus doc.pdf --chat
```

A terminal conversation with the same two-level agent the editor panel uses. It
keeps history across turns, so "and now make it bold" works.

### 4. Deterministic — no LLM, no API key

These never call a model. They're the ones to script.

```bash
aldus form.pdf --fields                               # dump every field + value + position
aldus form.pdf --fill '{"name":"Ana"}' -o filled.pdf  # fill by field name
```

`--fields` prints each field's name, type, current value, options and the page +
rect of every widget — enough to know exactly where a signature will land.

## Auth

The launcher (`bin/aldus.mjs`) **deletes `ANTHROPIC_API_KEY`** from the child
process on purpose: the agent is meant to run on your Claude Code subscription,
not a per-token bill. Set `ALDUS_USE_API_KEY=1` to keep it.

See [agent.md](agent.md) for the full auth and model matrix.

## Related

- [agent.md](agent.md) — what the agent can do, providers, models, cost
- [library.md](library.md) — the same operations as a programmatic API
- [server.md](server.md) — the server the editor mode boots
