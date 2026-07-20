# Server — `aldus/server`

The backend the editor talks to: stores documents, bakes edits, runs the agent.
It's the same server `aldus file.pdf` boots.

> **Security posture: localhost-only by design.** Documents are baked to disk
> with no auth. `ALDUS_ALLOW_REMOTE=1` binds `0.0.0.0` — only do that behind
> your own auth / reverse proxy.

## Run it

```ts
import 'aldus/server';   // boots on ALDUS_PORT (default 4100)
```

Or from the CLI: `aldus file.pdf` (starts it and opens the browser).

## Environment

| Var | Default | Meaning |
|---|---|---|
| `ALDUS_PORT` | `4100` | Listen port. |
| `ALDUS_ALLOW_REMOTE` | — | Set to bind `0.0.0.0` instead of `127.0.0.1`. |
| `ALDUS_DATA` | `<pkg>/data` | Where documents and revisions live. |
| `ALDUS_STATIC` | — | Serve a built editor SPA from this dir (same-origin as `/api`, no CORS). |
| `ALDUS_SESSION_SCOPED` | — | **Public demo mode**: one store per visitor (cookie `aldus_sid`); uploads and edits never cross. |
| `ALDUS_SESSION_TTL_HOURS` | `168` | GC for idle sessions (scoped mode). |
| `ALDUS_DEBUG` | — | Enables the forensic route (see [editor.md](editor.md)). |

Agent auth is separate — see [agent.md](agent.md).

## HTTP API

Everything is mounted under `/api/documents`.

### Documents

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/` | multipart `pdf` | `201` + `{ id, name, size, uploadedAt }` |
| `GET` | `/` | — | the list, newest first |
| `GET` | `/:id/pdf` | — | the bytes (`application/pdf`) |
| `PUT` | `/:id/edits` | `{ edits: [...] }` | `{ ok, count }` |
| `GET` | `/:id/edits` | — | the saved edits |
| `POST` | `/:id/revert` | — | `{ ok }` — undo the last server write |

Upload rejects anything that doesn't start with `%PDF-`.

`revert` restores the newest revision and pops it — that's what makes the
editor's instant ops undoable with Ctrl+Z.

### Bake

```
POST /:id/bake
```

Applies pending edits to the content stream and persists. The previous PDF is
kept as a revision.

```jsonc
{
  "edits":          [],  // SegmentEdit[]  — text
  "imageEdits":     [],  // ImageEdit[]
  "widgetEdits":    [],  // WidgetEdit[]   — form fields
  "highlights":     [],  // NEW highlights to create
  "highlightEdits": [],  // move/delete existing ones
  "linkEdits":      [],
  "shapeEdits":     []
}
```

→ `{ ok, applied, warnings }`. At least one edit is required (400 otherwise).
Every array is tolerant: a non-array falls back to `[]`.

### Instant ops

```
POST /:id/ops     { action, ...params }
```

Each one bakes and persists immediately. `action` is one of:

| `action` | Params |
|---|---|
| `addText` | `page, x, y, text` |
| `watermark` | `text` |
| `headerFooter` | `header?, footer?, pageNumbers?` |
| `highlight` | `page, x, y, width, height` |
| `addLink` | `page, x, y, width, height, url` |
| `removeLink` | `page, x, y, width, height` — `404` if there's no link there |
| `setFieldOptions` | `fieldName, options[]` |
| `addRadioOption` | `fieldName, page, x, y` |

An unknown `action` is a `400`. These names are the **wire** — note `watermark`
and `headerFooter` deliberately differ from core's kinds (`addWatermark`…).

Two ops are their own routes because they're genuinely different:

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/:id/fields` | `{ type, page, x, y, width?, height?, name? }` | `{ ok, name }` |
| `POST` | `/:id/images` | multipart `image` + `page`/`x`/`y` | `{ ok, rect }` |

Images must be PNG or JPEG.

### Agent

```
POST /:id/agent   { prompt, mode?, pages?, parallel?, edits?, imageEdits? }
```

`mode` picks **which agent** runs the turn — the two are addressed separately,
and the bundled UI exposes them as two chat tabs:

| `mode` | Agent | Scope | Can |
|---|---|---|---|
| `reader` (default) | cheap, `readTurn` | the whole document | answer questions, **fill form fields** |
| `editor` | strong, `editPages` | `pages` (all of them if omitted) | every edit tool |

In `reader` mode the server does **not** wire the `editor` callback, so the
reader never delegates and never offers `edit_document` — asked for an edit it
says so. In `editor` mode there is no reader in front: `prompt` goes to the
editor verbatim and the scope is whatever `pages` you send, not a page list a
model guessed.

`pages` is an array of 1-based page numbers; anything that isn't a positive
integer is dropped, and duplicates collapse. (`page`, singular, is still
accepted for compatibility and is merged in.) With more than one page,
`parallel` picks the shape of the run:

- **`true`** — one editor **per page, in parallel**. Latency becomes the slowest
  page instead of the sum, and each editor gets a small prompt.
- **`false`** (default) — **one** editor with every selected page in view.
  Required when the edit *crosses* pages, e.g. replacing a section that starts
  on one and ends on another; a fan-out would cut it in half.

Streams **NDJSON**, one event per line:

```jsonc
{ "type": "text",  "delta": "…", "agent": "chat" | "editor" }
{ "type": "tool",  "name": "edit_text", "agent": "editor" }
{ "type": "host",  "name": "…", "data": {} }
{ "type": "done",  "toolCalls": 3, "edits": [], "imageEdits": [], "reloaded": true }
{ "type": "error", "error": "…" }
```

Two ways a turn ends, and the client must handle both:

- **`reloaded: true`** — the agent made changes the editor's local state can't
  represent (creations, annotations, form fills), so the server **baked and
  persisted**. Reload the document.
- **`edits` / `imageEdits`** — the turn only accumulated text/image edits. Apply
  them to local state; nothing was written.

The **reader** keeps **conversational memory per document** (last 20 messages).
Since document ids are per-visitor in scoped mode, that's naturally isolated. An
`editor` turn is a self-contained order and carries no history.

Closing the stream **cancels the turn** (the server watches `res.on('close')`).

### Forensics

```
POST /:id/debug          # only responds with ALDUS_DEBUG=1
```

See [editor.md](editor.md#forensic-mode-).

## Embedding it in your own app

`createAldusApp` returns the Express app, so you can mount it, wrap it in your
auth, or run it on an ephemeral port in tests:

```ts
import { createAldusApp } from 'aldus/server';

const { app, container, sessions } = createAldusApp({
  dataDir: './data',
  scoped: false,
  staticDir: undefined,
});
app.listen(4100, '127.0.0.1');
```

Swapping the storage (S3, Postgres) is implementing the `IDocStore` interface
and one bind in the composition root — the routes don't change.

> The server is on **Express 4** on purpose: `app.get('*')` (the SPA fallback) is
> Express 4 syntax and Express 5's new path-to-regexp breaks it.

## Related

- [editor.md](editor.md) — the client for this API
- [agent.md](agent.md) — what `/agent` runs
- [library.md](library.md) — the same operations in-process, no HTTP
