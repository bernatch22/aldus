# Auditoría art-of-code — Hosts & Packaging de Aldus

Dominio: `apps/server/src/`, `packages/npm/`, `bin/`, `examples/edit-in-browser/`,
todos los `package.json` + `pnpm-workspace.yaml`. Marco: skill `art-of-code`
(Ten Commandments, PATTERNS §2/§7/§9/§10, APPLYING steps 2/3/6, `example/src/ioc` + `errors.ts`).

---

## 1. Inventario real

### apps/server/src (≈680 LOC total — chico y sano)

| Archivo | LOC | Qué hace |
|---|---|---|
| `index.ts` | 87 | Boot/composición: `registerNodeFontProviders()` (side effect top-level), env knobs (PORT/HOST/DATA), middleware de store por request (`ALDUS_SESSION_SCOPED` → `SessionStores`, sino singleton), monta 5 routers bajo `/api/documents`, sirve SPA si `ALDUS_STATIC`, banner MAGI. |
| `store.ts` | 164 | `DocStore` (interface) + `FileDocStore` (Repository: pdf+meta+edits en disco, revisiones `<id>.rev-<ts>.pdf`, `popRevision` = undo server-side) + `SessionStores` (un FileDocStore por cookie `sid`, seed de `_samples`). |
| `validate.ts` | 28 | `ID_RE`, `getStore(req)` (cast del monkey-patch), `requireDoc()` (404 guard). |
| `uploads.ts` | 7 | multer memoria, 50 MB. |
| `routes/documents.ts` | 58 | CRUD: upload (valida magic `%PDF-`), list, GET pdf, PUT/GET edits, POST revert. |
| `routes/bake.ts` | 42 | POST /bake: desarma 7 arrays del body → `bakeSegmentEdits` + loop `addHighlight` → `writePdf`. try/catch propio → 500. |
| `routes/ops.ts` | 100 | POST /ops: **switch de 8 casos** sobre `action` → funciones de `@aldus/core/bake`; POST /fields; POST /images. try/catch propio en cada handler. |
| `routes/agent.ts` | 65 | POST /agent: NDJSON inline (`res.write(JSON+'\n')` como `onEvent`), decide `hasBakedOps ? bake+persist : devolver edits`. try/catch propio. |
| `routes/debug.ts` | 129 | Modo forense 🐞. **104 de las 129 líneas son un template string** de `repro.mts` embebido en la ruta. Resuelve `REPO` subiendo 4 niveles (no aplica en bundle, gateado por `ALDUS_DEBUG`). |

### packages/npm — la distribución `aldus-pdf` (v0.6.4)

- `build.mjs` (52): esbuild ×3 (lib `dist/index.js`, CLI `dist/cli.js` con shebang, server `dist/server.mjs`) con **alias workspace→source** (`@aldus/core` → `../core/src/index.ts`, incl. entrada explícita `bake/fonts-node` porque el alias matchea por prefijo — ya mordió) + externals (pdf-lib, fontkit, pdfjs-dist, agent-sdk, zod, express, multer). Después `pnpm --filter aldus-editor build` con `VITE_BASE=/` → `cpSync` a `dist/editor`.
- `package.json`: `bin.aldus → dist/cli.js`, `exports: { ".": "./dist/index.js" }` **sin `types` y sin subpaths**. `express` y `multer` como **dependencies incondicionales**. `prepublishOnly: node build.mjs` (solo publicable desde el monorepo — OK, es intencional).
- Basura en el dir: `aldus-pdf-0.6.4.tgz` commiteado/local, `node_modules`, `dist`.

### bin/ y examples/

- `bin/start` (20): bash trivial — `unset ANTHROPIC_API_KEY` (fuerza suscripción) + `exec pnpm dev`. Vivo, referenciado por el script `start` del root.
- `examples/edit-in-browser/serve.mjs` (85) + README (46): **vivo y bien documentado**… pero es un **duplicado ~80% de `openInEditor()` en `packages/agent/src/cli.ts:54-97`** (mismo spawn del server con ALDUS_STATIC/ALDUS_DATA tmp, mismo poll-fetch, mismo upload multipart, mismo open del browser). Dos copias que ya driftean (puertos, mensajes). El README además dice `pnpm --filter @aldus/editor build` en una línea y `aldus-editor` en el serve.mjs header — el nombre viejo quedó en el doc.

### Monorepo: package.json × 7 + workspace

```
pnpm-workspace.yaml: packages/* · apps/* · deploy/*   ← deploy/ NO EXISTE (entrada stale)
```

| Paquete | npm | Rol | Notas |
|---|---|---|---|
| root `aldus` 0.0.1 | private | scripts dev/build/test | OK |
| `@aldus/core` 0.0.1 | NO publicado | exports **`.ts` crudo** (`./src/index.ts`, `./bake`, `./bake/fonts-node`) | Sin build: solo consumible vía tsx/vite/esbuild-alias. pdfjs-dist como peer **opcional** (bien: el bake no lo necesita). |
| `@aldus/agent` 0.0.1 | NO publicado | exports `.ts` crudo; `bin/aldus.mjs` = launcher que spawnea **tsx** | **`tsx` como dependency de runtime** (dev tool en prod deps). `spike.mjs` en examples/. |
| `@aldus/server` 0.0.1 | private ✔ | host Express | también arrastra `tsx` como dependency. |
| `aldus-editor` 0.2.6 | **publicado** | lib React embebible + app ejemplo | TODO en `devDependencies` → el paquete publicado no declara deps, solo peers (react/react-dom/pdfjs-dist); pdf-lib/core/lucide van INLINE en dist-lib. Correcto pero no obvio. |
| `aldus-pdf` 0.6.4 (`packages/npm`) | **publicado** | meta-bundle lib+CLI+server+SPA | ver arriba. |
| `packages/ui` | — | **carpeta vacía** (src/ sin un solo archivo, sin package.json) | MUERTO. |

**Grafo real de imports** (conteo de specifiers en src):
```
@aldus/core            ×36   ← agent, server, editor (workspace:*), npm (alias)
@aldus/core/bake       ×14   ← server routes (bake, ops), editor useLocalPreview (import dinámico), agent
@aldus/core/bake/fonts-node ×3 ← server/index.ts, agent (cli/session vía registerNodeFontProviders)
@aldus/agent           ×1    ← server/routes/agent.ts (EditSession, loadDoc, runTurn)
@aldus/editor          ×0 real ← solo self-refs (lib.ts/types) + una mención en cli.ts (mensaje de error con el NOMBRE VIEJO del filtro pnpm)
```
Dirección de dependencias: `core ← agent ← server`, `core ← editor`. **Limpia y unidireccional** — la Ley 1 del skill ya se cumple. El desorden no es el grafo: es (a) `packages/ui` vacío, (b) `deploy/*` fantasma en el workspace, (c) `packages/npm` que es un *build script* disfrazado de paquete, (d) el ejemplo duplicando el CLI, (e) tgz/dist commiteados en dirs de trabajo, (f) tres corrientes de versión (0.0.1 / 0.2.6 / 0.6.4).

---

## 2. Veredicto por pieza

| Pieza | Veredicto | Por qué |
|---|---|---|
| `store.ts` `DocStore`/`FileDocStore` | **COPY-CON-AJUSTES** | Repository de manual: interface primero, rutas nunca tocan fs, swap = una línea en index.ts (lo dice su propio doc — alineado con Commandment 2 aunque sin Symbol). Ajustes: (1) `readEdits/writeEdits` tipan `unknown[]` — el contrato de edits vive en core/model, debería tiparse; (2) `SessionStores.cache` es un Map **sin expiración** y `sessions/<sid>` **sin GC** → el demo público llena disco/memoria indefinidamente; (3) `popRevision` conflate "historia de seguridad" con "undo": un bake seguido de un op instantáneo + revert deja al usuario en un estado que no esperaba (documentar o separar pilas); (4) todo fs sync en el request path — aceptable para tool local, no para demo público con PDFs de 50 MB. |
| `validate.ts` | **COPY** | Exactamente el "boundary guard centralizado" (PATTERNS §7, `_withThread`). Micro-ajuste: `SID_RE` en index.ts duplica en espíritu a `ID_RE` — unificar. `getStore` con doble cast `req as unknown as {store}` → en v2, tipado vía declaración de módulo Express o `res.locals`. |
| `uploads.ts` | **COPY** | 7 líneas, un solo lugar. |
| `routes/documents.ts` | **COPY** | Finas de verdad: parse → guard → store → respuesta. Cero lógica de dominio. |
| `routes/bake.ts` | **COPY-CON-AJUSTES** | Fina, pero: el desarme de 7 arrays del body es un schema a mano (zod ya es dep del agente — validar acá); el loop `addHighlight` post-bake es lógica de orquestación que se repetirá en cualquier host → mover a core (`bakeSegmentEdits` acepta `highlights` nuevas) o a un `applyAll()` de agent/session. try/catch propio (ver catch site abajo). |
| `routes/ops.ts` | **REESCRIBIR (el switch)** | El `switch(action)` de 8 casos es EL anti-patrón que APPLYING Step 3 manda a registry: cada op nueva = editar el switch (viola OCP). Peor: **duplica el registro que ya existe** — `TOOL_DEFS` en `@aldus/agent/tools.ts` ya es "ops como DATA (name/shape/run)". v2: una sola familia `IInstantOp {name, schema, run(bytes, params)}` multi-bound, consumida por REST, por MCP y por el CLI. /fields y /images quedan (multipart es genuinamente distinto). |
| `routes/agent.ts` | **COPY-CON-AJUSTES** | El seam ya existe: `runTurn({onEvent})` — la ruta solo escribe NDJSON. Ajustes: (1) formalizar `onEvent` como `IAgentEventSink`/ITransport (ver §3); (2) la política "hasBakedOps → bake+persist, sino devolver edits" es decisión de PRODUCTO embebida en la ruta — subirla a un método `session.finishTurn()` que devuelva un resultado discriminado y la ruta solo lo serialice; (3) `console.log` directos violan la ley del repo de `createLogger` (core la tiene). |
| `routes/debug.ts` | **COPY-CON-AJUSTES** | La feature es oro (forensic loop). El pecado es de forma: 104 líneas de template `repro.mts` dentro del router. Mover el template a `packages/agent` (o un `packages/devtools`) como archivo `.mts.tpl` leído de disco o módulo propio; la ruta queda en ~25 líneas (guard + mkdir + 3 writes). |
| `index.ts` (server) | **COPY-CON-AJUSTES** | Ya ES una composition root que se lee como manifiesto (Commandment 3) — solo que informal. Ajustes: el middleware de sesión (25 líneas de parseo de cookie a mano) → módulo `sessionScope.ts`; `registerNodeFontProviders()` como side effect por convención → binding explícito del container (ver §3); catch site global inexistente → error middleware. |
| `bin/start` | **COPY** | Trivial y correcto. |
| `examples/edit-in-browser` | **COPY-CON-AJUSTES — vale la pena, deduplicado** | Es el mejor doc de "cómo embeber Aldus" y demuestra el patrón swappable-config. Pero su cuerpo debe ser: `import { openInEditor } from 'aldus-pdf'` (exportar el helper que HOY está copiado en cli.ts) + 5 líneas. Arreglar el nombre de filtro stale (`@aldus/editor` → `aldus-editor`) en README y en el mensaje de error de cli.ts. |
| `packages/npm/build.mjs` | **COPY-CON-AJUSTES** | El truco alias-a-source es efectivo y el archivo es legible; sobrevive en v2 (ver §3). Ajustes obligatorios: emitir `.d.ts` (hoy `aldus-pdf` se publica **sin tipos** — para una LIBRERÍA TS es el defecto #1), agregar subpaths de exports, y resolver express/multer (§4). |
| `packages/npm/package.json` | **COPY-CON-AJUSTES** | `exports` solo `"."`: un consumidor no puede `import 'aldus-pdf/bake'` ni bootear el server programáticamente (`dist/server.mjs` existe pero no está exportado). `files: [dist]` OK. |
| `packages/ui` | **MATAR** | Vacío total. `git rm -r`. |
| `pnpm-workspace.yaml` `deploy/*` | **MATAR** (la línea) | El dir no existe; documentación que miente. |
| `packages/agent/examples/spike.mjs` + script `spike` | **MATAR o mover** | Residuo de exploración. |
| `tsx` en dependencies (agent, server) | **AJUSTAR** | server es private (venial); en agent es dep de un paquete conceptualmente publicable → devDependency + bin buildeado. |

**¿DocStore está bien?** Sí — es la pieza mejor alineada con el skill (interface + repository + doc del contrato). Los ajustes son operativos (GC de sesiones, tipos de edits), no estructurales.
**¿Las rutas son finas?** documents/bake/agent sí; **ops.ts no** (switch = registry faltante) y **debug.ts no** (payload de tooling embebido). Nada de lógica de BAKE se filtró al server — la frontera core/host está respetada.

---

## 3. Propuesta de refacto art-of-code (v2)

### 3.1 Estructura de monorepo — 4 paquetes reales + 1 de distribución

```
packages/
  core/        @aldus/core   — igual, CON build (tsup → dist + d.ts).
               Subpaths se QUEDAN: ./bake, ./bake/fonts-node (renombrado ./node).
               Un paquete con subpaths > paquetes separados: bake y extract comparten
               model/coords/tokens; separarlos crearía un @aldus/model fantasma y
               triplicaría versionado. (Es el criterio pineward: UN paquete por
               ecosistema, subpaths por superficie.)
  agent/       @aldus/agent  — igual, con build. Exporta también openInEditor/bootLocalEditor.
  editor/      aldus-editor  — apps/editor entero se muda acá (hoy "apps/editor" publica
               a npm: un app/ que publica es la contradicción que hace ruido). La app
               de ejemplo queda como examples/ o un dev-entry del mismo paquete.
  aldus-pdf/   la distribución (hoy packages/npm, renombrado como el paquete que ES).
apps/
  server/      @aldus/server — private, host Express (composition root Node).
bin/ examples/ — quedan (examples deduplicado sobre openInEditor).
packages/ui, deploy/* — muertos, fuera.
```
Respuesta directa: **hacen falta 4 paquetes** (core, agent, editor, aldus-pdf) + 1 app privada (server). No más.

### 3.2 Swappable host (PATTERNS §10) — matar el registro por convención

Hoy: `fontProviders.ts` es un registry global mutable; server/index.ts y el CLI deben
ACORDARSE de llamar `registerNodeFontProviders()` (convención frágil — un host nuevo que
lo olvide hornea con fuentes estándar en silencio). v2, con el container de ~100 líneas
del skill (`example/src/ioc/container.ts`, cero deps):

```ts
// core: const IFallbackFontProvider = Symbol(...) + interface (mismo nombre, mismo archivo)
// core/composition.ts        → createCoreContainer(): bindings puros (browser-safe)
// core/composition.node.ts   → createNodeContainer(): + bind(IFallbackFontProvider).to(SystemFontProvider)
//                                                     + bind(...).to(MetricTwinDownloadProvider)
// fallback.ts consume getAll(IFallbackFontProvider) — multi-binding probing, igual que hoy
```
Los tres hosts componen containers distintos sobre el MISMO core:
- **server Express**: `createNodeContainer()` + bind(`IDocStore`→FileDocStore | SessionScopedStore) + bind(`IAgentEventSink`→NdjsonSink).
- **CLI**: `createNodeContainer()` + bind(`IAgentEventSink`→StdoutSink) + store tmp.
- **browser (editor lib)**: `createCoreContainer()` — cero providers, cero fs; el sufijo `.node.ts` mantiene el bundle browser limpio (mismo mecanismo que `*.extensionOnly.ts` de js-debug).

El módulo-convención `fontsNode.ts` no muere: se convierte en las CLASES que el container Node binds — la diferencia es que el olvido pasa de "bug silencioso en runtime" a "binding ausente visible en el manifiesto".

### 3.3 UN catch site de errores (hoy: 5 try/catch artesanales)

Cada ruta hoy repite `catch (err) { res.status(500).json({ error: err.message }) }` — y **filtra mensajes internos de pdf-lib/tokenizer al usuario** (anti-Commandment 7). v2, calcado de `example/src/errors.ts`:

```ts
// @aldus/core/errors.ts: StructuredError {code, format, showUser} + ErrorCodes (9xxx)
//   + factories: documentNotFound(id), unknownOp(action), bakeFailed(detail), linkNotFound()
// server: const h = (fn) => async (req,res,next) => { try { await fn(req,res) } catch(e){ next(e) } }
// app.use(errorMiddleware)  ← EL catch site: ProtocolError → {code,error:format} con status
//   mapeado; cualquier otro throw → 500 genérico "No se pudo procesar", stack SOLO al logger.
```
Las rutas quedan sin try/catch: parse (zod) → guard → hacer → responder. `requireDoc` tira `documentNotFound()` en vez de responder inline. Bonus: los `warnings` del BakeReport ya son datos estructurados — encajan naturales en el mismo sobre de respuesta.

### 3.4 NDJSON como ITransport

El seam ya existe (`onEvent`). Formalizar en agent:
```ts
const IAgentEventSink = Symbol('IAgentEventSink');
interface IAgentEventSink { send(ev: AgentEvent): void; end(): void; }
// impls: NdjsonHttpSink(res) [server] · StdoutSink(spinner) [cli] · CallbackSink [tests/embeds]
```
`runTurn({sink})`. La ruta agent.ts baja a ~20 líneas: parse → `loadDoc` → `runTurn` → serializar el resultado de `session.finishTurn()`. Un host futuro (WebSocket, SSE de signwax) = una impl nueva + un bind — OCP puro. El protocolo de eventos (type: text/tool/done/error) se documenta como contrato en el interface (JSDoc con las sutilezas, Commandment 10).

### 3.5 Ops instantáneas: switch → registry compartido con TOOL_DEFS

`TOOL_DEFS` (agent/tools.ts) ya es el registro bueno. Extraer la parte pura a core o agent:
`IInstantOp {name, schema: zod, run(bytes, params) → {pdf, extra?}}`, multi-bound. `ops.ts`
hace `getAll(IInstantOp).find(o => o.name === action)` → 400 si nadie reclama. El MCP server,
el router REST y el CLI consumen la MISMA lista — hoy hay dos superficies paralelas
(switch REST + TOOL_DEFS) que ya exigen doble mantenimiento por cada capability nueva.

### 3.6 Build/publish — ¿sobrevive build.mjs?

**Sí, adelgazado.** Con core/agent buildeando su propio dist (tsup: ESM + d.ts, rápido y sin config), `aldus-pdf/build.mjs` deja de alias-ear source (el hack del prefijo `fonts-node` muere solo) y pasa a: (1) esbuild del CLI+server contra los dist ya tipados (o incluso re-export directo), (2) build del editor SPA con `VITE_BASE=/`, (3) `cpSync`. Cambios de package.json:
```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./server": "./dist/server.mjs"
},
"dependencies": { pdf-lib, fontkit, pdfjs-dist, agent-sdk, zod },
"optionalDependencies" (o peer opcional): { express, multer }   // solo el modo server los usa
```
`aldus-editor` no cambia de mecánica (vite lib build está bien) — solo de carpeta. El deploy externo (`~/aldus-app`, `ALDUS_REPO`) sigue funcionando: consume el mismo build.mjs.

---

## 4. Riesgos y sutilezas del packaging (no romper en v2)

1. **`inlineDynamicImports: true` en vite.lib.config.ts es load-bearing**: sin él, los `import('@aldus/core/bake')` lazy generan chunks hermanos cuyo namespace-access Rollup re-escribe MAL cuando el host (signwax) re-bundlea → "Cannot destructure 'bakeSegmentEdits' of undefined" en runtime. Cualquier v2 del build de la lib DEBE seguir emitiendo un solo archivo (es el fix de la 0.2.6, último commit). Costo aceptado: el host no puede lazy-load el bake por separado.
2. **`VITE_BASE` se hornea en build time**: la MISMA SPA se buildea dos veces (base `/` para el paquete npm, base `/aldus/` para el demo de bernardocastro.dev). Si v2 unifica builds, o se pasa a base relativa `./` (probar rutas del router: `main.tsx` ya stripea trailing slash del basename) o se mantienen los dos artefactos conscientemente.
3. **express/multer como `dependencies` de aldus-pdf**: todo consumidor de la LIBRERÍA (que solo quiere `EditSession`/`bake`) instala un web framework. Externals en build.mjs + dependencies incondicionales = funciona, pero engorda. Mover a optionalDependencies exige `import()` dinámico en server.mjs con mensaje claro si faltan — o aceptar el costo y documentarlo.
4. **El alias de esbuild matchea por PREFIJO**: ya mordió (`@aldus/core/bake/fonts-node` se resolvía como `bake/index.ts/fonts-node` sin la entrada explícita — comentario en build.mjs). Mientras el alias-a-source viva, TODO subpath nuevo de core necesita su línea de alias. Con core buildeado a dist (propuesta 3.6) el riesgo desaparece.
5. **`aldus-pdf` se publica SIN tipos** (`exports` sin `types`, build.mjs no emite d.ts). Para el pitch "también es una librería" es el gap más visible desde afuera.
6. **pdfjs-dist en tres regímenes**: peer OPCIONAL en core (correcto: el bake no lo usa), dependency dura en agent y en aldus-pdf, peer `>=4.10` en aldus-editor. Un host con pdfjs 5 puede terminar con dos copias/workers desalineados. Fijar una política única (peer en todo lo publicado, con rango documentado).
7. **El catch-all `app.get('*')` de ALDUS_STATIC** depende del orden de montaje (los /api matchean antes) y de la sintaxis `'*'` de Express 4; Express 5 la rompe (`path-to-regexp` nuevo). Anotarlo si se actualiza express.
8. **Demo público (`ALDUS_SESSION_SCOPED`)**: `SessionStores` sin TTL ni límite — cookie de 30 días, un dir por visitante con PDFs de hasta 50 MB, seeds de _samples incluidos. Riesgo de disco real en la caja GCP. v2: sweep por mtime o LRU con tope.
9. **Tres corrientes de versión** (workspace 0.0.1 / editor 0.2.6 / aldus-pdf 0.6.4) sin changesets: el CHANGELOG manual ya es el único hilo. Adoptar changesets o al menos una convención escrita.
10. **Artefactos sucios en el árbol**: `packages/npm/aldus-pdf-0.6.4.tgz`, `apps/editor/aldus-editor-0.2.6.tgz`, dist/ y node_modules visibles en dirs publicables — `.gitignore`/limpieza para que `files:` sea la única fuente de verdad de lo que viaja.
11. **`registerNodeFontProviders()` por convención** (server index.ts línea 23, cli, y cualquier host futuro): el fallo es silencioso — el bake "funciona" con fuentes estándar en vez de la gemela métrica. Es el argumento #1 para el container de §3.2.

---

## Cierre

El server es chico, en capas correctas y con el Repository bien hecho — v2 es mayormente
**formalizar lo que ya está** (composition root, seams existentes) más tres cirugías: registry
de ops, catch site único, y fuentes por container en vez de convención. El desorden real del
monorepo es cosmético-estructural: `packages/ui` vacío, `deploy/*` fantasma, el paquete npm
sin tipos ni subpaths, el ejemplo duplicando al CLI, y versiones sin política.
