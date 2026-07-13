# ALDUS V2 — Plan maestro art-of-code

Síntesis de 5 auditorías por dominio (en `audits/`), cada una hecha con la skill
`art-of-code` (framework destilado de vscode-js-debug) leyendo TODOS los archivos del
dominio. Fecha: 2026-07-14. Repo origen: `~/aldus` (~6.900 LOC src + ~1.700 test).

## El veredicto unificado

**Aldus v1 no está podrido — está sin nombrar.** Las 5 auditorías coinciden:

- El **grafo de dependencias ya es unidireccional y limpio** (`core ← agent ← server`,
  `core ← editor`). Nada del bake se filtró a los hosts.
- Los **patrones ya existen de facto sin nombre**: `ITextEmitStrategy` + registry (2 veces
  probado), `TOOL_DEFS` como data, DocStore Repository, merge*Edit = Command, Snap = Memento,
  los 7 NodeBoxes = Strategy embrionaria.
- El problema real es **duplicación estructural** (el mismo concepto escrito 2-5 veces) y
  **canales de estado incorrectos** (React deps/refs espejo/window events/module-let en vez
  de servicios con emitter propio).
- Y el riesgo #1 del rewrite: **~55% de la lógica más sutil (reflow, placeholders, extract,
  lift) corre SIN tests** — 16 defensas pagadas con sangre en placeholders, cero cobertura.

**Estrategia: re-arquitectura con trasplante.** El esqueleto (capas, contenedores, contratos,
golden harness) se escribe desde 0. El código pagado con sangre se TRASPLANTA verbatim, cada
pieza llegando CON su test (escrito antes de mover, contra v1, verificado igual en v2).

## Las 7 duplicaciones que v2 mata (una sola fuente de verdad c/u)

| # | Concepto duplicado | Copias hoy | Fuente única v2 |
|---|---|---|---|
| 1 | Ledger de edits (maps + revert + snapshot + promote) | `usePendingEdits` (editor) + `EditSession` (agent) | `EditLedger` en core (browser-safe, cero React) |
| 2 | Flujo two-level del agente | `agent.ts` + `openrouter.ts` | UN `runTurn` sobre `ILlmTransport` |
| 3 | charX (posición por carácter) | `session.charXOf` (buena) + `verify.charXMap` (vieja, drifteada) | `core/layout/charX.ts` |
| 4 | merge/effective rect-like | 5 pares casi idénticos en `edits.ts` (~200 LOC) | genérico `mergeRectEdit` |
| 5 | Geometría del subrayado (0.11/0.055) | 3 lugares (text.ts ×2 + fallback.ts) | `bake/underline.ts` + test de consistencia |
| 6 | Dispatch por tipo de nodo | 6 cascadas if (NodeOverlay ×4, hotkeys, Inspector) | registry `INodeKind` multi-bound |
| 7 | Registro de ops instantáneas | switch en `routes/ops.ts` + `TOOL_DEFS` | `IInstantOp` multi-bound (REST + MCP + CLI) |

Más las menores: parsers de raw fill (×2), hex→rgb (×2), `removeLink` vs annotEdits,
localizadores de geometría con tolerancias dispersas (×6), `serve.mjs` vs `openInEditor`,
`MANUAL_GEOMETRY` (×2), boot con `registerNodeFontProviders()` por convención (×3).

## Estructura del monorepo v2 — 4 paquetes + 1 app privada

```
aldus-v2/
  packages/
    core/          @aldus/core — CON build (tsup → dist + d.ts). Subpaths: ./bake, ./node
      src/
        common/    Layer 0 — puro, cero deps internas, test colocado c/u:
                   coords.ts · log.ts (trace ring) · text.ts (normalize) · matrix.ts (mul/invert,
                   HOY en textWalk) · bytes.ts (fmt/latin1/hex, HOY en splice) · rawFill.ts ·
                   once.ts · events.ts (EventEmitter+IDisposable) · mapUsingProjection.ts ·
                   cancellation.ts
        model/     Layer 0.5 — SOLO tipos: nodes.ts (7 nodos + PageGraph) ·
                   edits.ts (7 *Edit con genérico RectEdit<T> + unión AnyEdit por kind)
        graph/     Layer 1 — extracción + lectura:
                   extract/ {textRuns,annotations,images,vectorRects,blocks,fonts}.ts
                     → orquestador extractPageGraph ~40 LOC sobre IGraphExtractor multi-bound
                   pageGraphService.ts (byId · segmentsAt proyección 0.55×fs bucket±1 ·
                     byGeometry ~1.8pt · byNormalizedText · replace() único punto de mutación)
                   segmentContent.ts (runLines, originalStyledRuns) · tokens.ts · locateText.ts
        edit/      Layer 2 — mutación acumulada:
                   editLedger.ts (IEditLedger: patch/revert/effective/snapshot/restore/
                     toBakeInput con promoteMovedImages ADENTRO) · styledRuns.ts (applyTextDiff,
                     toggle/setStyleRange) · listMarkers.ts
        layout/    Layer 2 — geometría determinística (SALE de agent/session):
                   charX.ts · paragraph.ts · reflow.ts (seam reExtract inyectado + ReflowLimits) ·
                   placeholderMatch.ts (función pura)
        pdf/       Layer 1 protocolo (tonto, reporta hechos, no decide negocio):
                   tokenizer.ts (VERBATIM) · contentWalk.ts (textWalk con isContentFill
                   inyectado) · splice.ts (VERBATIM) · pageContent.ts · toUnicode.ts (VERBATIM)
        bake/      Layer 3 — EL CEREBRO:
                   bake.ts → coordinador: bake(bytes, edits: AnyEdit[]) sobre IEditApplier
                   appliers/ {segment,image,shape,widget,highlight,link}Applier.ts
                   text.ts (ITextEmitStrategy: VerbatimReemit + StyledRunsReemit descompuesto) ·
                   textEmit.ts · underline.ts (FUENTE ÚNICA) · locate/ (ILocator: tolerancias
                   nombradas en un lugar) · fonts/ (FontService dueño del encCache +
                   IFallbackFontProvider multi-bound + fallback.ts) · report.ts (BakeEvent
                   {code, params, severity} + UN formatter que emite los strings actuales
                   byte-idéntico)
        create/    Layer 3 — un archivo por capacidad + registry ICreateOp;
                   IFieldCreator por WidgetKind. forms.ts · flatten.ts · info.ts
                   (defaultSignaturePlacement SE VA al host e-sign)
        errors.ts  StructuredError {code, format, showUser} + factories nombradas
        composition.ts        createCoreContainer() — bindings browser-safe
        composition.node.ts   createNodeContainer() — + font providers con I/O (subpath ./node)
      test/        goldenText.ts harness (RESET_RESULTS=1, sanitización, unasserted-logs-fail)
                   + fixtures/*.pdf + goldens/*.txt

    agent/         @aldus/agent — CON build; tsx fuera de dependencies
      src/
        transport/ ILlmTransport + ClaudeSdkTransport + OpenRouterTransport (streamCompletion
                   verbatim adentro) — pipes tontos
        prompts.ts (texto pagado con tuning, VERBATIM, cero lógica)
        serialize.ts (VERBATIM + golden que congela el formato)
        session/   NodeIndex (byId, mata los 5 scans lineales) · EditSession = FACHADA fina
                   (ledger de core + layout de core + bake)
        runTurn.ts EL orquestador two-level, escrito UNA vez, con CancellationToken threaded
                   (extraTools funciona en AMBOS transportes)
        verify.ts  (consume charX canónico) · tools.ts (TOOL_DEFS + zod .parse en runTool +
                   ToolOutcome {ok, code} debajo del protocolo ✓/⚠️/↩︎) · config.ts (IAgentConfig)
        cli.ts     (+ exporta openInEditor — el ejemplo lo importa)

    editor/        aldus-editor — SE MUDA de apps/ (un app/ que publica a npm era la contradicción)
      src/
        core/      SIN React (candidato a testear en jsdom):
                   ledger-adapter (consume IEditLedger de core) · previewService.ts ·
                   liftService.ts (máquina EXPLÍCITA: idle→prepared→dragging→dropPending→landed) ·
                   textEditController.ts (algoritmo del TextEditLayer verbatim; muere
                   liveEditRuns/window-events → getter + evento tipado) · styledDom.ts (VERBATIM
                   + test) · fontRegistry (servicio IDisposable) · sampleColor (devuelve Map,
                   NO muta el grafo) · api/ (clase AldusApi inyectada — fix capture.ts)
        react/     boxes/ (INodeKind registry + los 7 Box verbatim) · hooks finos
                   (useSyncExternalStore sobre el ledger) · AldusEditor.tsx (composition root:
                   construye servicios, DisposableList, dispose en unmount) · Inspector ·
                   AgentPanel · FloatingBar (suscripta al controller) · ui/
      demo/        HomePage + router + main — NUNCA se publica
      vite.lib.config.ts (inlineDynamicImports: true — LOAD-BEARING, no tocar)

    aldus-pdf/     la distribución (hoy packages/npm): build.mjs adelgazado contra dists
                   tipados (muere el hack alias-por-prefijo) · CON d.ts y subpath ./server ·
                   express/multer fuera de deps incondicionales
  apps/
    server/        @aldus/server private:
                   composition root Node (bind IDocStore, IAgentEventSink→NdjsonSink) ·
                   error middleware = UN catch site (rutas sin try/catch; StructuredError →
                   status; stacks SOLO al logger) · rutas finas (ops.ts → getAll(IInstantOp)) ·
                   debug.ts con el template repro.mts como archivo aparte ·
                   DocStore + GC de sesiones (TTL/LRU — el demo público llena disco hoy)
  examples/
    edit-in-browser/  import { openInEditor } from 'aldus-pdf' + 5 líneas (muere la copia)
```

**Muertos confirmados (no cruzan a v2)**: `packages/ui` (vacío, ni trackeado), `deploy/*` del
workspace, `spike.mjs`, los .tgz commiteados, `walkTextOps`, `groupIntoLines`/`splitSegments`/
`avgCharWidth`/`hasBulletMarker` (exports sin consumidores), `api.saveEdits/loadEdits` (verificar
signwax antes), la segunda copia del orquestador, el `charXMap` de verify, el shim NodeOverlay.

## Los contratos (Symbol + interface homónima, JSDoc con las sutilezas)

| Contrato | Multi-bind | Reemplaza |
|---|---|---|
| `IEditApplier` {canHandle, phase: 'document'\|'page', apply} | ✔ 6 appliers | los 7 posicionales de bakeSegmentEdits; edit nuevo = clase + bind |
| `ITextEmitStrategy` | ✔ (ya existe) | — se conserva |
| `IFallbackFontProvider` | ✔ (ya existe) | global de módulo → binding; el olvido pasa de bug silencioso a binding ausente visible |
| `IGraphExtractor` | ✔ 4-6 extractores | el monolito extractGraph; "extraer tablas" = clase + bind |
| `ICreateOp` / `IFieldCreator` | ✔ | el god-file createNodes + el switch de WidgetKind |
| `IInstantOp` | ✔ | el switch de routes/ops.ts (REST + MCP + CLI consumen la misma lista) |
| `INodeKind` {find, effectiveRect, move, remove, Box, inspector?} | ✔ 7 kinds | las 6 cascadas if del editor; tipo de nodo nuevo = clase + registro (antes ~7 archivos) |
| `ILlmTransport` {chat(req, ct)} | 2 impls | el switch de provider + la doble copia del flujo |
| `IAgentEventSink` {send, end} | Ndjson/Stdout/Callback | el onEvent informal; host nuevo (WebSocket) = impl + bind |
| `IPageGraphService` / `IEditLedger` / `ILocator` / `IDocStore` / `IAgentConfig` | inyección simple | scans lineales dispersos / doble ledger / tolerancias dispersas / — |

Contenedores jerárquicos (container hand-rolled del example, ~100 LOC, cero deps):
**global** (log, font providers) → **documento** (PageGraphService, EditLedger, DocStore entry)
→ **página/bake** (`PageBakeContext` = unit-of-work con walk/splices/appendBlocks/report).
`disposeContainer` teardown; browser compone `createCoreContainer()` sin bindings Node.

## Errores y eventos estructurados (la deuda transversal #1)

- `BakeEvent {code, nodeId?, params, severity}` + `BakeCodes` (SegmentRelocated 1001 …
  SegmentNotLocated 9001 …). UN formatter castellano emite los strings actuales
  **byte-idéntico** (UI y tests viejos no rompen; tests nuevos asean por code).
- `ToolOutcome {ok, code, retriable}` DEBAJO del protocolo `✓/⚠️/↩︎` (contrato con el LLM,
  no se rompe). `runTool` = único catch site del agente; `Internal` loguea el stack (hoy se pierde).
- Server: error middleware único; `requireDoc` tira `documentNotFound()`; los mensajes internos
  de pdf-lib dejan de filtrarse al usuario.
- `CancellationToken` threaded: runTurn → transporte (AbortSignal) → reflow (check por
  iteración de bake). El server cablea el close del stream NDJSON al CancellationTokenSource.

## Testing: la red ANTES del trasplante (regla de oro del plan)

Harness golden-text (copiado del example): `RESET_RESULTS=1` regenera, sanitización
(offsets → `<n>`), **falla si loggeó output no aseado**. El formato del modo forense 🐞
(BakeReport + filas re-extraídas x/width/gaps por run) ES el formato golden del proyecto.

**Tests que se escriben contra v1 ANTES de mover el código** (los huecos descubiertos):

1. `splice.test.ts` — invariante inserción-antes-que-reemplazo (hoy solo indirecto).
2. `extract.test.ts` — ids estables por geometría tras remover un nodo (hueco #1 de model);
   `mergeBlockSegments` (firma exacta del leading 1.2×fs del bake).
3. Superíndice: rewrite de segmento con superíndice → el cuerpo NO sale con la fuente chica
   (la defensa `dominant` de text.ts, SIN test hoy).
4. `word-winansi.pdf` — encoderForFont simple-encoding (Word/Quartz, SIN test).
5. Filtro de control chars del fallback (acento LibreOffice → cajita X, SIN test).
6. `shapes.ts` entero (SIN NINGÚN test) + flips de imagen (a/d negativos).
7. `underline.test.ts` — emisión↔filtro consistentes (la tríada 0.11/0.055 en 3 lugares).
8. Golden de `serializeDoc` (EL contrato con el LLM, hoy 2 `toContain`).
9. **Los 10 tests de placeholders/reflow** (audit-agent §4: guardrail XXXX, leader elástico,
   flex multi-línea, barrido, idempotencia, abort+restore, capShrink, elipsis 35c9222…) —
   16 defensas, cero tests hoy.
10. Ledger: patch→revert→snapshot vacío; goldens de `ledger.apply()×N → snapshot`.
11. Orquestador con `ILlmTransport` fake de guion (two-level + gating verify sin red).
12. runLines casos borde 0.549/0.551×fs (la proyección a buckets DEBE chequear bucket±1).
13. `hideHighlightAnnotations` (prohibido re-introducir el fast-path por bytes) y
    `rawFill.test.ts` (equivalencia con los DOS parsers viejos antes de fusionar).

## Fases de ejecución (verde al final de cada una)

**F0 — Esqueleto** · scaffold del monorepo, `common/` completo (con tests colocados),
container, errors.ts, harness golden. Sin dominio todavía.

**F1 — Red de seguridad en v1** · los tests de la lista de arriba se escriben CONTRA `~/aldus`
(fixtures pdf-lib + PDFs reales de los gotchas). Son la definición ejecutable de "v2 no rompió
nada": correrán idénticos contra v2.

**F2 — pdf/ + model/ + graph/** · trasplante de tokenizer/splice/toUnicode (verbatim) y
contentWalk (predicado inyectado); model partido en nodes/edits; extract descompuesto en
IGraphExtractor; PageGraphService + entidades memoizadas con once(). Los tests de F1 pasan.

**F3 — bake/ + create/** · IEditApplier + PageBakeContext + ILocator + underline.ts +
FontService + BakeEvent con formatter byte-idéntico. bake.test.ts de v1 (717 LOC) migrado y
verde. createNodes partido en ICreateOp.

**F4 — edit/ + layout/** · EditLedger (genérico rect-edit adentro) + el motor
charX/paragraph/reflow/placeholderMatch trasplantado a core con seam reExtract. Los 10 tests
de placeholders verdes.

**F5 — agent/** · ILlmTransport ×2 + runTurn único + NodeIndex + EditSession fachada +
ToolOutcome + zod.parse + cancellation. Golden de serialize verde; pipeline.test ampliado.

**F6 — editor/** · editor-core sin React (ledger-adapter, PreviewService, LiftService máquina
explícita, TextEditController, styledDom verbatim) + editor-react (INodeKind registry,
composition root con dispose). Los gotchas de UI (blur/TDZ/re-render loop/refs espejo/Snap
incompleto) mueren estructuralmente.

**F7 — hosts + distribución** · server con composition root + error middleware + IInstantOp +
IAgentEventSink + GC de sesiones; aldus-pdf con d.ts y subpaths; ejemplo deduplicado; CI.

**F8 — paridad final** · corpus de PDFs reales (los de los gotchas + contratos usados en
forense) bakeado por v1 y v2 → diff de goldens = el certificado de trasplante. Docs (README,
CLAUDE.md v2, migración v1→v2 con los shims deprecados: bakeSegmentEdits(...) → bake(edits)).

## Reglas duras durante la construcción (de las auditorías, innegociables)

1. **Ningún trasplante sin su test primero** (F1 gates F2-F6).
2. **Tolerancias y constantes NO se cambian de valor** (Y_TOL 1.8, leftSlack ½em, 0.55×fs,
   0.11/0.055, MARGIN_FLOOR 58, capShrink 40%…): se mueven y se NOMBRAN, jamás se "mejoran".
3. **Los strings del report se emiten byte-idéntico** desde el formatter hasta que el último
   consumidor migre a codes.
4. La ÚNICA normalización de texto del grafo es la copia local de locateText — U+0012 viaja
   intacto o los acentos LibreOffice mueren.
5. `pdf/` no importa NADA de `bake/`/`fonts/`. Un import estático mal puesto mete node:fs en
   el bundle browser — la CI lo verifica (grep de imports por capa).
6. `inlineDynamicImports: true` y el orden annots-antes-que-stream del bake se preservan y se
   documentan en el JSDoc del token correspondiente.
7. API pública npm: shims deprecados (`bakeSegmentEdits`, `registerFallbackFontProvider`),
   no borrados en caliente.
