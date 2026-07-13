# Auditoría art-of-code — `packages/agent` (@aldus/agent)

Auditor: framework **art-of-code** (destilado de vscode-js-debug: layering, Symbol+interface DI,
multi-binding/probing, services vs entities, errores estructurados, cancellation, golden-text).
Archivos leídos ENTEROS: los 10 de `src/` + `test/pipeline.test.ts` + los 3 docs de la skill +
`example/src` completo (container, errors, ioc, export registry, domain, goldenText).

Total del paquete: **2.512 LOC src + 124 LOC test**.

---

## 1. Inventario real

### `src/graph.ts` — 36 LOC
**Qué hace**: `graphFromBytes` / `loadDoc` → `DocGraph` (pdf.js legacy headless + `extractPageGraph`
de core, todas las páginas). Deps: `@aldus/core`, `pdfjs-dist` (import perezoso), `node:fs`.
**Dolor**: ninguno. Pequeño, puro, una responsabilidad, respeta el gotcha del transfer
(`bytes.slice()`). Es la única "capa I/O de lectura" del agente y es tonta, como debe ser.

### `src/session.ts` — 1.010 LOC ← **EL GOD-FILE**
**Qué hace**: `EditSession` = TODO a la vez. Deps: `@aldus/core`, `@aldus/core/bake`, `graph.ts`, `node:fs`.
Responsabilidades reales contadas (≥6, el umbral de APPLYING.md es 3):

1. **Ledger de ediciones** (~180 LOC): 5 Maps (`edits/imageEdits/widgetEdits/highlightEdits/linkEdits`)
   + cola `creates` + `fills`, con `merge*Edit` de core (bien: una sola fuente de merge compartida
   con el editor UI). `seed()/getEdits()/count/hasBakedOps/summary()` = el contrato con server/editor.
2. **Lookups de nodos** (líneas 106–125): `seg()/img()/widget()/hlNode()/linkNode()` — **cinco scans
   lineales casi idénticos** página por página en cada tool call. Anti-patrón directo del mandamiento 5
   ("services own collections — one map per query shape"): no hay NINGÚN índice by-id; un doc de 9
   páginas con cientos de segmentos re-escanea todo por cada `edit_text`.
3. **Mutadores de tool** (~160 LOC): `editText/styleText/moveText/colorText/resizeText/deleteText/
   moveImage/.../fillFields` — finos, delegan al ledger. OK.
4. **MOTOR DE GEOMETRÍA / REFLOW (~370 LOC)**: `charXOf` (pesos por clase de glifo — incluye el fix
   de la elipsis U+2026 del commit 35c9222), `paraLinesOf`, `paragraphOf` (detección de párrafo por
   x-ancla + paso de leading), `paragraphToks` (tokenización con estilo por carácter + des-hifenado
   Word), `reflowApply` (wrap elástico, holes que se encogen, capShrink acotado al 40%, dxFix acotado
   a 4 espacios, loop de 6 bakes ENTEROS con medición real, abort+restore). **Nada de esto es "agente":
   es layout determinístico de PDF. Es lógica de CORE viviendo en el paquete equivocado.** Prueba:
   `verify.ts` tiene su PROPIO `charXMap` (ver abajo) — la duplicación ya empezó a driftar.
5. **`placeholdersToFields` (~135 LOC)**: matching literal → LEADER_RUN elástico → regex `flex` para
   placeholders mixtos ("..... [label]" cruzando renglones con guion de corte Word), expansión de
   bordes al run máximo de leaders, barrido de leaders huérfanos, colocación directa sobre el rect
   (charXOf) sin reflow, idempotencia por overlap. Lógica pagada con sangre (ver §4).
6. **Orquestación del bake** (~80 LOC): `applyCreate` (un `switch` de 7 casos sobre `CreateOp`) +
   `bake()` (bakeSegmentEdits → creates en cola → setFieldValues al final) + `save()`.
7. **Heurísticas de producto**: `targetWidthFor` con regex `WIDE_FIELD/NARROW_FIELD` **solo en
   español** (nombre/domicilio/ruc/cuit) — un contrato en inglés ("address", "phone") cae siempre
   al default de 80pt. Hardcodes sueltos: `MARGIN_FLOOR = 58` aparece DOS veces (líneas 466 y 542,
   una como constante y otra como literal mágico), `maxExtraLines ≤ 3`, `40pt` de hole mínimo.

**Dolor adicional**: `reflowApply` muta `this.edits`/`this.creates` como estado compartido y los
restaura a mano (`preEdits`, `createStart`) — un memento artesanal sin abstracción; el loop de 6
iteraciones hornea el **documento entero** cada vez sin token de cancelación (un doc grande = turnos
de decenas de segundos imposibles de abortar desde el server).

### `src/tools.ts` — 301 LOC
**Qué hace**: `TOOL_DEFS` (21 tools como DATA: name/description/zod shape/run) + `buildToolServer`
(MCP para el SDK), `buildRouterServer` (edit_document), `openaiTools/openaiRouterTool` (serialización
al formato OpenAI), `runTool` (dispatch por nombre), `HostToolDef` (extensión OCP del host).
**Dolor**:
- **El patrón base es CORRECTO** (mandamiento 4: extensibilidad = registro, no switch; "new agent
  capability = a NEW ToolDef" ya es Ley en CLAUDE.md). Doble binding a dos transportes desde UNA
  fuente ✓. `HostToolDef` con JSON-Schema plano para no imponer zod al host ✓.
- Pero cada `run` recibe `Record<string, unknown>` y hace **casting a mano** (`id as string`) — el
  shape zod existe y NO se usa para parsear: en el path OpenRouter los args vienen de un
  `JSON.parse` de texto del LLM y entran SIN validar (`runTool` → `d.run(session, args)` directo).
  Un `{"page": "1"}` string del LLM llega hasta `addTextNode` como string. El path MCP sí valida
  (el SDK aplica el shape) → **los dos transportes tienen contratos de validación distintos**.
- `runTool` traga errores a string `⚠️ ...` — razonable como frontera LLM, pero es la ÚNICA captura
  y no distingue error de programación (bug) de error de dominio (id inexistente): mandamiento 7
  (errores estructurados + un catch site que no filtra stacks pero sí los LOGUEA) a medias — acá
  el stack se pierde del todo (ni `log()`).
- `const a = (o) => o` como "alias legible" es un cast disfrazado.

### `src/agent.ts` — 322 LOC
**Qué hace**: `systemPrompt` (EDITOR, ~85 líneas de prompt) + `chatSystemPrompt` (CHAT/router, ~45) +
tipos `TurnResult/AgentEvent/TurnOpts` + `runTurn` (flujo two-level sobre el Claude Agent SDK +
pasada verify). Deps: SDK, tools, serialize, verify, config.
**Dolor**:
- Línea 195: `if (config.provider === 'openrouter') return runTurnOpenRouter(opts)` — un **switch de
  provider escondido** dentro del propio `runTurn`. Es la marca exacta que APPLYING.md Step 3 manda
  convertir en registro/estrategia.
- El flujo two-level está **escrito dos veces** (ver openrouter.ts): fase chat → captura de route →
  fallback `pages = route.pages.length ? ... : opts.page` → fase editor → `MANUAL_GEOMETRY` +
  `overlapReport` + una pasada correctiva → return. Los DOS archivos repiten: la constante
  `MANUAL_GEOMETRY` (definida 2 veces, líneas agent:310 y openrouter:101), la lógica de verify-gating,
  el conteo de toolCalls/usedTools, la emisión de `AgentEvent`. **Violación DRY estructural**: hoy un
  fix al gating de verify (como el que ya está comentado: "flaggeaba falsos positivos… 25s tirados")
  hay que acordarse de aplicarlo en dos lugares. El de suscripción encadena la pasada verify con
  `resume` (misma conversación); el de OR la mete como user message en el mismo array — mismo intent,
  dos mecánicas, cero contrato común.
- Los prompts (130 líneas de texto acumulado a base de tuning) conviven con la orquestación: cambiar
  el prompt = tocar el archivo del flujo.
- Parsing de `stream_event` con casts inline duplicado ENTRE las dos fases del mismo archivo
  (chat loop líneas 224–236 ≈ editor loop 277–298).
- **Sin cancelación**: un turno de 40s+ (chat + editor + verify + re-bake) no se puede abortar
  (el server route /:id/agent no puede cortar si el cliente cierra el stream NDJSON).

### `src/openrouter.ts` — 181 LOC
**Qué hace**: `streamCompletion` (SSE hand-rolled sobre fetch: acumulación de tool_calls por índice,
error-in-stream, provider sort) + `runTurnOpenRouter` = **el MISMO flujo two-level reescrito** sobre
transporte OpenAI-compatible, + loop de function-calling manual.
**Dolor**: la mitad del archivo (streamCompletion, ~65 LOC) es transporte puro y está bien aislada;
la otra mitad es la segunda copia del orquestador (ver arriba). El header comment lo admite: "solo
cambia el TRANSPORTE" — exactamente la definición de un `ITransport` que no se extrajo.
Bonus: acá SÍ soporta `extraTools` (HostToolDef); el path suscripción NO los pasa a `buildToolServer`
→ **feature asimétrica entre providers** documentada solo en un comment de TurnOpts.

### `src/serialize.ts` — 214 LOC
**Qué hace**: `serializeDoc(doc, pages?)` → el grafo como texto compacto de prompt: `styleOf`,
`nearestLabel` (ancla semántica de widgets: izquierda > arriba > abajo con scores 0/300/600),
`readingView` (texto en orden de lectura con `[[id]]` intercalados — el corazón del fill de forms),
secciones por tipo de nodo con tramos intra-nodo. **Función pura, cero estado, deps solo de tipos.**
**Dolor**: es EL contrato entre el documento y el LLM (cambiar un carácter del formato puede
degradar el fill de forms) y **no tiene ni un test propio** más allá de dos `toContain` en
pipeline.test. Es el candidato #1 a golden-text del paquete. Heurísticas con números mágicos
(±35pt, tolerancia 8pt, scores 300/600) sin fixture que las fije.

### `src/verify.ts` — 89 LOC
**Qué hace**: `overlapReport` (bake en memoria → re-extract → widgets que pisan texto/otros widgets,
con excepción de placeholders "____") + `verifyMessage`. Determinístico, solo geometría. Bien scopeado.
**Dolor**: `charXMap` (líneas 16–31) es **la versión vieja/naïve de `session.charXOf`**: reparte el
ancho del run UNIFORME por carácter — exactamente el bug que charXOf arregló con pesos por glifo
("un run que mezcla palabras y leaders corría el inicio de los puntos ~50pt"). **Duplicación ya
drifteada**: verify puede marcar falsos positivos/negativos que la colocación (con la versión buena)
no produce. RULE 4.2 del usuario en acción: dos copias, una quedó atrás.

### `src/config.ts` — 44 LOC
**Qué hace**: knobs de entorno en UN objeto `config` const, con tabla en el header (excelente doc).
**Dolor**: menor — es un singleton global leído en import-time; para tests de orquestador habría que
inyectarlo (token `IAgentConfig`), pero como data plana está bien curada.

### `src/cli.ts` — 267 LOC
**Qué hace**: el binario `aldus`: `openInEditor` (boot del server real + upload + browser),
one-shot, `--chat` REPL, `--fields/--fill` determinísticos, spinner TTY.
**Dolor**: 4 modos + boot de server + spinner en un archivo, pero es la capa app/UI (Layer 4) y cada
pieza es corta y lineal. `openInEditor` conoce los dos layouts (publicado/repo) — inevitable ahí.
El polling `for (let i = 0; i < 120…) fetch` para readiness es aceptable en CLI.

### `src/index.ts` — 48 LOC
Fachada pública organizada por momentos (LEER/EDITAR/FINALIZAR/HOST) — deliberada y documentada.
Bien (PATTERNS §11: "no barrel files except deliberate facades").

### `test/pipeline.test.ts` — 124 LOC
Integración REAL sin mocks (PDF con pdf-lib → grafo → sesión → bake → re-extract) + turno LLM opt-in.
**Es exactamente el espíritu del mandamiento 9** (testear contra la realidad)… pero cubre solo:
extract, serialize (2 contains), editText camino corto, moveImage, id inexistente, seed/getEdits.
**Cero cobertura de**: reflowApply, replaceParagraph, placeholdersToFields, fillField(s), verify,
readingView, creates (highlight/link/watermark/field), openrouter, runTool con args rotos.
~55% del LOC del paquete (todo el motor de reflow + placeholders) corre SIN red de tests.

---

## 2. Veredicto por archivo

| Archivo | Veredicto | Por qué |
|---|---|---|
| `graph.ts` | **COPY** | Pequeño, puro, correcto. |
| `index.ts` | **COPY** | Fachada deliberada, bien organizada. |
| `config.ts` | **COPY-CON-AJUSTES** | Envolver en token `IAgentConfig` para inyectar en tests; la data queda igual. |
| `serialize.ts` | **COPY-CON-AJUSTES** | El código queda; le FALTA el golden-text que congele el formato (es un contrato). |
| `tools.ts` | **COPY-CON-AJUSTES** | El patrón registry ya es el correcto. Ajustes: `z.object(shape).parse(args)` dentro de `runTool` (mismo contrato en ambos transportes), tipar `run` por inferencia del shape (`z.infer`) matando los `as`, log del stack en el catch. |
| `verify.ts` | **COPY-CON-AJUSTES** | Lógica correcta; **matar su `charXMap` y consumir el charX canónico de core** (ver §3). |
| `cli.ts` | **COPY-CON-AJUSTES** | Partir en `cli/` (editor-launch, one-shot, chat, forms) solo si crece; hoy tolerable. |
| `agent.ts` | **REESCRIBIR (parcial)** | Los prompts se COPIAN tal cual a `prompts.ts` (texto pagado con tuning). El `runTurn` se reescribe como orquestador ÚNICO sobre `ILlmTransport`. |
| `openrouter.ts` | **REESCRIBIR** | `streamCompletion` se COPIA casi intacto adentro de `OpenRouterTransport`; el resto (la segunda copia del flujo) **se MATA** — lo absorbe el orquestador único. |
| `session.ts` | **REESCRIBIR (partir)** | El código interno se preserva línea a línea (es sangre), pero el archivo se descompone: ledger / índice / motor de reflow (→ core) / placeholders / bake. |
| `pipeline.test.ts` | **COPY + AMPLIAR** | Base sólida; falta el 55% del paquete (ver §4). |

**Nada se MATA salvo la segunda copia del orquestador en openrouter.ts** (y el `charXMap` de verify).

---

## 3. Propuesta de refacto art-of-code

### 3.1 Capas (Step 1 de APPLYING)

```
@aldus/core                          Layer 0–2 (ya existe)
  + src/layout/charX.ts              ← charXOf ÚNICO (sale de session, mata charXMap de verify)
  + src/layout/paragraph.ts          ← paraLinesOf/paragraphOf/paragraphToks (sobre runLines, que YA es de core)
  + src/layout/reflow.ts             ← el motor reflowApply, parametrizado (ver 3.3)
  + src/layout/placeholderMatch.ts   ← matching de leaders/flex/expansión/barrido como FUNCIÓN PURA
@aldus/agent
  transport/   Layer 1 — pipes tontos: ILlmTransport + 2 impls
  prompts.ts   Layer 1.5 — systemPrompt/chatSystemPrompt (texto, cero lógica)
  serialize.ts Layer 1.5 — igual que hoy
  session/     Layer 2 — dominio: ledger + índice + fachada EditSession
  runTurn.ts   Layer 3 — EL cerebro: two-level flow escrito UNA vez
  cli.ts       Layer 4
```

Regla del quick-map de APPLYING ya vigente ("Placeholders→fields: el LLM DETECTA, el CÓDIGO computa
geometría") llevada a su consecuencia: **si el código computa geometría, la geometría es de core** —
el editor UI podría ofrecer "reemplazar párrafo" con el MISMO motor (hoy no puede: vive en agent).
Cuidado práctico: el reflow re-extrae con pdf.js → en core la función recibe un
`reExtract: (bytes) => Promise<PageGraph[]>` inyectado (core no importa pdfjs-dist Node; el agente
le pasa `graphFromBytes`, el browser el suyo). Eso además abre el seam de test.

### 3.2 Contratos Symbol+interface (Step 2)

```ts
// transport/transport.ts
export const ILlmTransport = Symbol('ILlmTransport');
export interface ILlmTransport {
  /** Una pasada de completions streameada. `resume` es opaco al orquestador:
   *  el transporte SDK lo mapea a session resume; el OR lo mapea a su array
   *  de mensajes acumulado. Tools como TOOL_DEFS — cada impl las serializa. */
  chat(req: PassRequest, ct: CancellationToken): Promise<PassResult>;
}
// impls: ClaudeSdkTransport (query() + stream_event parsing, canUseTool gate)
//        OpenRouterTransport (streamCompletion actual, casi verbatim)
```

- **UN `runTurn`** (Layer 3): fase chat → route → fase editor (loop de tools con `runTool` — que el
  transporte SDK resuelve vía MCP server y el OR vía dispatch; la diferencia queda ADENTRO de cada
  impl) → gating `MANUAL_GEOMETRY` (constante definida UNA vez) → pasada verify → `TurnResult`.
  El provider se elige en la composición root (`ioc.ts` de ~30 líneas con el container del example,
  o incluso una factory simple — con 2 impls y 1 consumidor, el container es opcional; lo
  innegociable es que `runTurn` reciba el transporte, no lo elija).
- **`IToolDef` multi-binding**: `TOOL_DEFS` ya ES el registro — formalizar: `HostToolDef` y `ToolDef`
  convergen en una interfaz (`name/description/schema/run`), el server las apendea (ya lo hace
  `openaiTools(extra)`); el path suscripción gana `extraTools` gratis al pasar por el mismo camino.
  Self-gating no aplica (dispatch por nombre exacto, no probing) — y está bien: es un registry
  keyed, no una chain of responsibility. No forzar el patrón donde no toca.
- **EditSession se parte** (Step 4, services vs entities):
  - `NodeIndex` — service que posee las colecciones: `byId: Map<string, Node>` construido UNA vez
    del DocGraph (mata los 5 scans lineales). Un map por query shape si aparecen más.
  - `EditLedger` — service: los 5 Maps + creates + fills + seed/getEdits/count/summary. **Es el
    gemelo semántico de `usePendingEdits` del editor** — mismo contrato (`merge*Edit`, null=revert);
    no se comparten (React hook vs clase Node) pero el ledger documenta la paridad y los tests de
    uno sirven de espejo del otro.
  - `EditSession` queda como FACHADA fina (lo que las tools llaman): lookups vía NodeIndex,
    mutaciones vía Ledger, reflow/placeholders vía core, `bake()` orquestando.
- **Reflow/placement como estrategia de core**: `reflowApply` ya es UN algoritmo con dos entradas
  (`paragraphToks` con replace para edit_text; toks planos para replace_paragraph) — NO necesita
  Strategy hoy (una sola implementación); necesita ser función/clase de core con el seam
  `reExtract` inyectado y sus constantes (`MARGIN_FLOOR`, `maxExtraLines`, caps) en un objeto
  `ReflowLimits` con defaults — parametrizable sin tocar el algoritmo (OCP por parámetro, no por
  herencia). Si algún día hay "reflow que NO corre lo de abajo" (modo e-sign), AHÍ nace la interfaz.
- **`targetWidthFor`**: las regex español-only pasan a una tabla inyectable
  (`fieldWidthHints: Array<{pattern: RegExp; width: (fs:number)=>number}>`) con EN+ES por default —
  extensión = agregar entrada, no editar función.

### 3.3 Errores estructurados (Step 6)

El protocolo `✓/⚠️/↩︎` de los strings de tool ES un contrato de-facto (el prompt instruye sobre él:
"Si la tool devuelve ⚠️/↩︎, reportalo") — **no romperlo**. Estructurarlo POR DEBAJO:

```ts
type ToolOutcome =
  | { ok: true;  message: string }                    // "✓ …"
  | { ok: false; code: ToolErrorCode; message: string; retriable: boolean }; // "⚠️/↩︎ …"
enum ToolErrorCode { NodeNotFound, ReflowWontFit, AlreadyConverted, LeaderRewriteRejected, BadArgs, Internal }
```

`runTool` = el ÚNICO catch site: `ToolOutcome` → string para el LLM; `Internal` loguea el stack con
`createLogger('aldus:tools')` (hoy se pierde) y devuelve mensaje genérico. Los códigos habilitan
además métricas (¿cuántas veces el LLM pisa `AlreadyConverted`?) y asserts de test que no dependan
del texto en español.

### 3.4 Cancellation (mandamiento 13)

`CancellationToken` (copiar `common/cancellation` del patrón js-debug) threaded por:
`runTurn(opts, ct)` → cada pasada del transporte (el fetch de OR acepta `AbortSignal` directo; el
SDK ya soporta abort) → `reflowApply(…, ct)` — chequear `ct.isCancellationRequested` al tope de cada
una de las 6 iteraciones de bake (son EL costo dominante). El server route `/:id/agent` cablea el
`close` del response NDJSON al `CancellationTokenSource`. Hoy un usuario que cierra el tab deja
40s de bakes corriendo.

### 3.5 Tests (Step 7)

- **Golden-text de `serializeDoc`** (el más urgente y el más barato): fixtures reales
  (`test/fixtures/*.pdf` — un contrato con leaders, un form AcroForm, uno con tramos/bold) →
  `serializeDoc` → `.txt` commiteado, sanitizando solo lo no-determinístico si lo hubiera.
  Congela: readingView, nearestLabel, tramos, el formato entero del prompt. Cualquier cambio de
  formato se vuelve un diff revisable (hoy es invisible hasta que el LLM empeora).
- **Goldens del reflow**: PDF fixture → `replaceParagraph`/`editText` largo → bake → re-extract →
  log de la fila (x/width/gaps por run, EXACTAMENTE lo que dumpa el `repro.mts` del modo forense —
  reusar ese dump como formato de golden) → assert contra `.txt`. `RESET_RESULTS=1` regenera.
- **Unit tests de `placeholderMatch` puro** (posible recién tras extraerlo): tabla de casos de §4.
- **Paridad charX**: un test que corre el charX canónico sobre un run mixto palabras+leaders y
  asserta que el borde del leader cae donde el PDF real lo dibuja (el bug de los ~50pt, commit
  35c9222, como caso regresión).
- **`runTool` con args rotos**: `{"page":"1"}`, args no-JSON, tool desconocida → `ToolOutcome` correcto.
- **Orquestador con transporte fake**: `ILlmTransport` de test que devuelve un guion (chat delega →
  editor llama 2 tools → fin) — verifica el flujo two-level, el gating de verify y los eventos SIN
  red. Es "virtualizar solo el seam de I/O": el PDF y la sesión son reales, solo el LLM es guion.

### 3.6 Orden de ejecución (cada paso deja verde)

1. Extraer `prompts.ts` + `MANUAL_GEOMETRY` a un solo lugar (mecánico, 0 riesgo).
2. Golden de `serializeDoc` (red de seguridad ANTES de mover nada).
3. `ILlmTransport` + 2 impls + `runTurn` único (muere la copia de openrouter.ts). El path
   suscripción gana `extraTools`.
4. `NodeIndex` + `EditLedger` (session se parte; fachada intacta → tools no cambian).
5. charX/paragraph/reflow/placeholderMatch → core con seam `reExtract`; verify consume el charX
   canónico. Goldens de reflow ANTES de mover (paso 2 bis).
6. `ToolOutcome` + validación zod en `runTool` + cancellation.

---

## 4. Riesgos — la defensividad de `placeholdersToFields` (y el reflow)

Inventario de las defensas pagadas con sangre (cada una tiene un comment que narra el incidente):

| # | Defensa | Dónde | Test hoy |
|---|---|---|---|
| 1 | `edit_text` RECHAZA reescribir leaders con relleno (guardrail XXXX) | session.ts:159 | **NINGUNO** |
| 2 | Matching de leader elástico (el LLM nunca copia el conteo de puntos; `.`+`…` mezclados) | :794 | **NINGUNO** |
| 3 | Regex `flex` para placeholders mixtos cruzando renglones + guion de corte Word | :786 | **NINGUNO** |
| 4 | Expansión de bordes al run máximo de leaders (67 puntos vs 5 pasados) | :808 | **NINGUNO** |
| 5 | Barrido de leaders huérfanos (anti segunda-llamada vs anti-recall) | :844 | **NINGUNO** |
| 6 | Hueco NOMBRADO en la línea del run más largo; el resto `drop` | :817 | **NINGUNO** |
| 7 | Colocación DIRECTA sobre el rect (cero reflow) + idempotencia por overlap | :858 | **NINGUNO** |
| 8 | charXOf con pesos por glifo (elipsis ancha, leaders angostos, espacios justificados) | :322 | **NINGUNO** |
| 9 | Reflow: abort+restore si no entra ni comprimiendo ("lo que no puede hacer bien, no lo toca") | :567,:669 | **NINGUNO** |
| 10 | capShrink ≤ 40% capacidad (anti una-palabra-por-renglón) | :681 | **NINGUNO** |
| 11 | dxFix acotado a 4 espacios por pasada (anti empuje fuera de página) | :660 | **NINGUNO** |
| 12 | Des-hifenado de cortes Word al re-envolver | :445 | **NINGUNO** |
| 13 | MARGIN_FLOOR: el folio/pie no se corre ni limita slack | :466 | **NINGUNO** |
| 14 | Holes elásticos: se encogen al espacio del renglón en vez de bajar solos | :489 | **NINGUNO** |
| 15 | Anti-recall: párrafo ya restyled → `↩︎ no repitas` | :732 | **NINGUNO** |
| 16 | verify ignora campo sobre "____" (intencional, PDF fillable) | verify.ts:51 | **NINGUNO** |

**Dieciséis defensas, cero tests.** La única protección actual es (a) el modo FORENSE 🐞 (excelente
para reproducir, pero es una herramienta, no una red: no corre en CI) y (b) los `applied/warnings`
del bake de core (que tienen sus tests… en core). Cualquier refactor de session.ts —incluido el que
propone este informe— puede romper silenciosamente cualquiera de las 16. **Por eso el orden del
§3.6 pone los goldens ANTES de mover el motor.**

Tests faltantes concretos (todos posibles hoy, sin extraer nada, contra PDFs fixture hechos con
pdf-lib como ya hace pipeline.test):

1. `editText` sobre nodo con "......." pidiendo texto sin leaders → contiene `⚠️` y `count===0`. (def #1)
2. PDF con `"NOMBRE: ..........."` (30 puntos) + `placeholdersToFields(id, [{placeholder:'.....', name:'nombre'}])`
   → 1 create `field` cuyo x0/x1 ≈ el rect real del run de puntos (±2pt). (defs #2, #4, #7, #8)
3. Mismo PDF, segunda llamada idéntica → `↩︎ … salteado` y creates no crece. (def #7)
4. Párrafo con DOS runs de leaders, `fields` pasa solo uno → se crean DOS campos (barrido). (def #5)
5. Placeholder mixto multi-línea `"..... [company legal name]"` con "[ad-"/"dress" partido →
   match único, label dropped, campo en la línea del run largo. (defs #3, #6)
6. `replaceParagraph` con texto que NO entra ni comprimiendo (página llena) → `⚠️ … No modifiqué nada`
   y el grafo re-extraído es idéntico al original byte-a-byte del texto. (defs #9, #10)
7. `replaceParagraph` que ACHICA → golden con `freedLines>0` y baselines de abajo SUBIDAS. (spans)
8. Golden del reflow largo: `editText` que agrega 2 renglones → dump de filas (formato repro.mts)
   contra `.txt`; asserta que ningún run pasa `rightEdge+3` y ningún gap < MIN_GAP. (defs #11–#14)
9. `overlapReport` fixture: campo sobre texto real → 1 issue; campo sobre "____" → 0 issues. (def #16)
10. Regresión elipsis: línea `"Mr./Ms. ………………"` → el campo no queda enano ni descentrado (commit 35c9222).

Riesgos adicionales no-placeholder:

- **verify.ts drifteado de charXOf** (§1): riesgo activo de falsos positivos que disparan la pasada
  correctiva (25s + un editor "acomodando" lo que estaba bien). Unificar YA.
- **`route` con args sin validar en el path OR** y **casts en todos los `run`**: un LLM sucio puede
  meter tipos rotos hasta lo profundo de session.
- **Feature asimétrica `extraTools`** (solo OR): un host que desarrolla contra OR y deploya con
  suscripción pierde sus tools sin error.
- **Prompts como strings vivos**: 130 líneas de instrucciones tuneadas sin ningún harness que
  detecte regresión de comportamiento (el test LLM opt-in cubre UN caso feliz).
- **Sin cancelación** en el loop de 6 bakes: costo real en el demo público session-scoped.
