# Example: edit a PDF in the browser

The smallest possible Aldus app: open a local PDF and get the **full editor +
the CASPER AI agent**, ready in the browser. **No database, no accounts, no
sessions** — one user, one file, edit and save.

The agent panel works out of the box on the **Claude Code subscription** (no API
key). To use OpenRouter instead (e.g. Gemini): `ALDUS_PROVIDER=openrouter
OPENROUTER_API_KEY=… node serve.mjs contract.pdf`.

```bash
pnpm --filter @aldus/agent build        # once: the agent lib the example imports
pnpm --filter aldus-editor build:demo   # once: build the editor UI
node examples/edit-in-browser/serve.mjs contract.pdf
# → opens http://localhost:4180/doc/<id> in your browser
```

Or, from the CLI (same thing):

```bash
aldus contract.pdf                      # no prompt → opens the editor UI
```

## How it works (and why there's so little code here)

This example is **one import**: `openInEditor` from `@aldus/agent` (the same
helper the `aldus` CLI uses, also shipped in the `aldus-pdf` npm package). It

- runs **`@aldus/server`** in *local mode*: a single in-temp-dir store, serving
  the built editor SPA (`ALDUS_STATIC`) on the same origin as its `/api`;
- uploads your PDF and opens the browser at that document.

In v1 this example duplicated those ~85 lines by hand; the copies drifted. Now
there is exactly ONE implementation, exported by the real package.

A public/hosted deployment is *this same app* plus one flag —
`ALDUS_SESSION_SCOPED=1` isolates documents per visitor (cookie, with a TTL
garbage-collector) — and a bundle step for the remote box. Same UI, same
server, different config: nothing is duplicated.

## The edit loop

1. The editor parses the PDF's content-stream graph (`@aldus/core`) client-side.
2. You move/edit/highlight/fill — accumulated as non-destructive *edits*.
3. **Apply** posts the edits to `/api/documents/:id/bake`, which splices them
   into the real content stream (never rasterizes, never white-boxes).
4. Save/download the resulting PDF.
