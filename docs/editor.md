# React editor — `aldus/editor`

The visual editor as an embeddable component. It's router-free and unbranded by
default: you mount it inside your app, point it at your backend, and it renders
the page, the node overlay, the toolbar, the inspector and the AI panel.

```bash
npm i aldus react react-dom     # react/react-dom >= 18 are peer deps
```

## Minimal setup

```tsx
import { AldusEditor, configureAldusApi } from 'aldus/editor';
import 'aldus/editor/styles.css';

configureAldusApi({ apiBase: '/api' });   // ← your aldus/server mount, no trailing slash

export default function Page({ docId }: { docId: string }) {
  return <AldusEditor docId={docId} />;
}
```

Two things that bite:

- **`docId` is required.** The editor doesn't upload — it edits a document that
  already exists on the server. Upload first (`POST /api/documents`), then pass
  the returned id.
- **`apiBase`, not `baseUrl`** — and no trailing slash. `/api` or
  `/my-app/api` both work.

The component needs a **height**: it renders `h-full`, so its parent must have
one.

## Props

### Core

| Prop | Type | Notes |
|---|---|---|
| `docId` | `string` | **Required.** The document's id in your host. |
| `api` | `AldusApi` | A specific client instance. Defaults to the shared `aldusApi`. |
| `onExit` | `() => void` | Renders a "back" button in the header. Absent → the Aldus brand shows instead. |
| `brand` | `ReactNode` | Replace the header brand with your own. |
| `agent` | `boolean` | The AI panel (default `true`). |
| `formTools` | `boolean` | The Forms group in the left rail (default `true`). |
| `refreshKey` | `number` | Bump it to reload the document from the server — use it when your host edited the doc out of band. |

### Host integration

The editor is built to sit inside a product (an e-signature app, a CRM) that has
its own concepts. These are the seams:

| Prop | Type | What it's for |
|---|---|---|
| `panelTabs` | `Array<{ id, label, content }>` | Your own tabs in the right panel (Signers, Wax…). They sit next to the built-in "Campos" (Inspector) tab. |
| `inspectorTab` | `boolean` | `false` drops the built-in Inspector tab entirely — your tabs are the panel. |
| `panelTab` / `onPanelTabChange` | `string \| null` | Pass both to control the active tab from the host. |
| `panelFooter` | `ReactNode` | Pinned to the bottom of the right panel (e.g. your agent's input). |
| `headerActions` | `ReactNode` | Your controls in the top bar, just left of "Aplicar". |

### Host boxes and tools

Draw **your own** overlays on the page (per-signer signature boxes, for example)
and let users place them:

| Prop | Type |
|---|---|
| `hostBoxes` | `HostBox[]` — `{ id, page, x, y, width, height, … }` |
| `selectedHostBoxId` / `onHostBoxSelect` | `string \| null` |
| `onHostBoxChange` | `(box) => void` — fires on move/resize |
| `onHostBoxContextMenu` | `(id, at) => void` — right-click → your menu |
| `hostTools` | `Array<{ id, label, icon }>` — extra tools in the rail's "Campos" group (lucide icons) |
| `onHostToolPlace` | `(toolId, { page, x, y }) => void` — a click on the page, **in PDF points** |

That's the whole contract for putting a document editor behind your own auth,
routes and domain semantics — without forking it.

## The API client

```ts
import { aldusApi, configureAldusApi, AldusApi } from 'aldus/editor';
```

`aldusApi` is a shared instance; `configureAldusApi({ apiBase })` reconfigures
it. If you need more than one (multi-tenant, two backends), construct your own
`new AldusApi({ apiBase })` and pass it as the `api` prop.

Without configuration, the base is read from `VITE_API_BASE`, falling back to
`${BASE_URL}/api`.

## How editing works

Worth knowing, because it explains the UI:

- **Pending vs applied.** Text/image edits accumulate **locally** (with undo/redo)
  and are written only when you hit **Aplicar** — which calls `POST /:id/bake`.
  The counter on the button is the pending count.
- **Instant ops** are different: creating text/images/fields, watermarks,
  headers and links are written to the server **immediately** (`POST /:id/ops`).
  They're still undoable — Ctrl+Z calls `POST /:id/revert`, which restores the
  previous server revision.
- **Highlights** accumulate as a preview layer and are baked with Aplicar.
- The AI panel streams NDJSON from `POST /:id/agent` and either applies the
  returned edits to local state or reloads the document if the agent baked
  something the UI can't represent locally.

## Forensic mode 🐞

With `ALDUS_DEBUG=1` on the server and `?debug=1` in the URL, a capture button
appears (also **Ctrl+Alt+D**). It writes a reproducible bundle to
`/tmp/aldus-debug/<ts>-<doc>/`: the document's current bytes, the full captured
state (clicked node, page graph at click time, pending edits, log trace), and a
**pre-built `repro.mts`** that replays the edits through the real bake and diffs
the node's row before/after.

```bash
npx tsx /tmp/aldus-debug/<dir>/repro.mts
```

## Related

- [server.md](server.md) — the backend the editor talks to, and every route
- [library.md](library.md) — the same model, programmatically
- [agent.md](agent.md) — what the AI panel is driving
