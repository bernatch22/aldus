# Unificación Signwax ↔ Aldus v2 — diagnóstico y plan

> **2026-07-16 — SUPERSEDIDO.** Este plan se re-escribió y ejecutó desde
> `~/signwax/docs/plans/cli-and-unification.md`: G1/G2/G3 cerrados por la
> reescritura del agente (aldus 0.1.0/0.2.0-dev), Opción A ejecutada (signwax
> corre 100% sobre el motor v2), y el turno org-level de Wax ya corre en el
> reader de aldus detrás de `WAX_ENGINE=aldus`. Queda: port de los seams
> doc/template/upload y las borraduras (waxTurn + lib/pdf LLM). Ver ese doc.

> Objetivo: que Signwax **no tenga motor de edición propio**. El agente de edición
> pasa a ser `@aldus/agent`; Signwax le **inyecta sus tools de dominio** (firmantes,
> envíos, plantillas, equipo) vía el seam OCP que aldus-v2 ya expone. Un solo LLM.

---

## 1. Diagnóstico — hoy hay dos agentes que no se conocen

| | **Wax (Signwax)** | **@aldus/agent (v2)** |
|---|---|---|
| Orquestador | `waxTurn` (`services/wax.ts`, **2 717 LOC**) | `runTurn` (two-level: chat → editor) |
| Tools | **52** (10 de edición + 42 de dominio) | **22** de edición sobre grafo tipado |
| Capa LLM | `lib/pdf/llm.ts` propia (`resolveModel`, `makeAnthropic`) | `ILlmTransport` inyectable (Claude SDK ⟋ OpenRouter) |
| Motor de PDF | `lib/pdf/*` — **3 637 LOC**, de las cuales **966 son pasadas LLM** | `@aldus/core` — grafo tipado (10 403 LOC con agent) |
| Persistencia | Postgres (`documents` / `document_versions`) | `IDocStore` (Repository) → `FileDocStore` |
| Streaming | NDJSON ad-hoc (`delta`/`card`/`mutation`/`proposal_update`) | `IAgentEventSink` → `NdjsonHttpSink` |

**Lo que Signwax usa hoy de Aldus es solo el músculo, no el cerebro:** `aldus-pdf@0.7.0`
(core de PDF, cero LLM) y `aldus-editor@0.3.0` (UI). El paquete `agent` **nunca entró**.

### 1.1 La edición de Wax es peor *por construcción*

Wax edita **a ciegas**: no tiene un grafo del documento, así que para tocar un PDF hace
tres pasadas de LLM con **visión** (`scan` → `locate` → `verify`) y encima un verificador
geométrico para atajar los errores del modelo. Por eso existe `visionModel()` forzando
Sonnet: sin visión, no ve.

Aldus v2 tiene un **grafo tipado** (`page → segment → line → run / widget`) y sus tools
operan **por id** (`p1-w3`) de forma determinística — no necesita visión, no necesita
verificar geometría a posteriori, y no puede "alucinar" una coordenada.

> **Corolario:** las "sub-tareas de PDF" de Signwax no son una feature, son una **muleta**
> por no tener grafo. Con Aldus **desaparecen** (≈966 LOC de LLM + buena parte de las 3 637).

### 1.2 Lo que aldus-v2 YA tiene listo (no hay que inventar nada)

- **`TurnOpts.extraTools: HostToolDef[]`** — el seam OCP, ya documentado en el `index.ts`
  como *"tools de su dominio: firmantes, envíos…"*. JSON Schema plano (no impone zod al
  host) + `run(args)` que cierra sobre el estado del host (DB, docId). **Funciona en los
  dos transportes.**
- **`IDocStore`** — Repository. El propio `store.ts` dice: *"swapping in an S3/sqlite store
  is implementing this interface + one bind in the composition root"*.
- **`IAgentEventSink`** — el seam de streaming (HTTP NDJSON / callback / test).
- **`IAgentConfig`** y **`ILlmTransport`** inyectables.
- **`@aldus/server`** ya es un package con `exports` — solo está `private: true`.

---

## 2. Los 3 gaps reales (= lo que hay que tocar en Aldus y sacar build)

### G1 — El modelo CHAT no ve las tools del host ⛔ *bloqueante*
`runTurn` fase 1 arma `tools: [routerTool]` — **solo `edit_document`**. Las 42 tools de
dominio de Signwax (`list_agreements`, `list_team`, `send_signing_invite`, …) son de
**consulta/acción**, no de edición: tienen que poder correr en el **chat barato**, sin
forzar un pase de editor. Hoy `extraTools` solo llega a la fase EDITOR
(`editorPassTools(opts.extraTools)`).

**Sin esto la unificación es imposible.**

### G2 — El wire no transporta eventos del host
Signwax emite `card`, `mutation`, `navigate`, `proposal_update` para su panel.
`AgentWireEvent = AgentEvent | TurnDoneEvent | TurnErrorEvent` no tiene un canal para
eventos de una host-tool.

### G3 — `@aldus/server` es `private` y su store es disco
Signwax persiste en Postgres. Hay que publicarlo como lib y que Signwax bindee su propio
`IDocStore`.

### G4 *(menor)* — Config de modelo a nivel módulo
`config.ts` lee env al importar. Signwax elige modelo por request. `loadAgentConfig` ya es
inyectable — basta pasarlo por `TurnOpts`.

---

## 3. Sobre "un solo LLM"

Aldus es two-level **por diseño** (chat barato rutea → editor fuerte aplica). Eso **no
rompe** la coherencia si ambos niveles son el mismo modelo: es tuning de costo, no de
cerebro.

**Recomendación:** arrancar con `ALDUS_MODEL=claude-sonnet-5` **y**
`ALDUS_CHAT_MODEL=claude-sonnet-5` (un solo modelo, coherencia total). Si el costo pica,
bajar solo el chat a Haiku — decisión reversible de una env var.

Se **borran** de Signwax: DeepSeek del selector y del default, `visionModel()`,
`resolveModel`, `makeAnthropic`, `lib/pdf/llm.ts` y las 966 LOC de pasadas LLM.

---

## 4. Plan

### FASE 0 — Aldus v2: abrir los seams (→ nuevo build)
| # | Cambio | Archivo |
|---|---|---|
| A | `HostToolDef.level?: 'chat' \| 'editor' \| 'both'` (default `'editor'` = compat). Fase 1 arma `tools: [routerTool, ...chatTools]` y despacha por `runTool`. **Aditivo, no rompe nada.** | `llm/runTurn.ts`, `llm/tools.ts` |
| B | `AgentWireEvent` += `HostEvent {type:'host', name, data}`; `HostToolDef.run(args, emit)`. | `transport/sink.ts`, `llm/tools.ts` |
| C | Sacar `private`, versionar, exportar `createServerContainer` + routers + `IDocStore`. Revisar que las rutas no asuman `FileDocStore` (`validate.ts`/`getStore`). | `apps/server/*` |
| D | Build + `npm pack` → `aldus-agent-*.tgz` / `aldus-server-*.tgz` a `apps/api/vendor/` (mismo patrón que `aldus-pdf-0.7.0.tgz` hoy). | — |

### FASE 1 — Signwax: `PgDocStore` + montar el motor
- Implementar `IDocStore` sobre Postgres (`documents`/`document_versions`) — **un archivo**.
- Composition root en `apps/api`: bindear `PgDocStore` en el container de aldus.
- **Borrar** `lib/pdf/{scan,scanByPage,locateSignatures,detectParties,verify,aiEdit,edit,convertFields,placeholderLocate,llm}.ts`.

### FASE 2 — Las 52 tools de Wax → `HostToolDef[]`
- **~10 de edición se BORRAN** (`edit_line`, `add_line`, `remove_line`, `move_line`,
  `edit_pdf`, `convert_pdf_to_fields`, `replace_placeholders`, `verify_document`,
  `propose_rescan`, `propose_{add,set,remove}_field`) → las cubre `TOOL_DEFS` de aldus
  (`edit_text`, `replace_paragraph`, `add_text`, `placeholders_to_fields`,
  `add_form_field`, `move_field`, `fill_fields`, …).
- **~42 de dominio → `HostToolDef[]`**, la mayoría `level:'chat'`. Cierran sobre DB/orgId
  igual que hoy.
- `waxTurn` (2 717 LOC) queda en: armar el `HostToolDef[]`, llamar `runTurn`, y **adaptar
  el sink** al wire que ya consume `AgentPanel` (así la UI no se toca).

### FASE 3 — Un solo LLM + limpieza
- `ALDUS_MODEL` / `ALDUS_CHAT_MODEL` = `claude-sonnet-5`. Fuera DeepSeek de `admin.ts` y
  del selector de `wax.tsx`.
- `signerAssist.ts` y `nda.ts` → mismo config (o directamente `runTurn` + host-tools).
- Briefing qwen3: **queda como está** (no es "el LLM del producto", es una frase de resumen
  gratis con fallback determinístico).
- CHANGELOG + `docs/architecture/wax-ai.md` + skill `esign-wax-ai`.

---

## 5. Decisión abierta (necesita tu call)

`aldus-pdf@0.7.0` y `aldus-editor@0.3.0` que Signwax usa hoy vienen de **`~/aldus` (v1)**,
no de v2. El agente que queremos está en **v2**, sobre un **motor de grafo distinto**.

- **Opción A — migrar todo a v2** (core + editor + agent). Coherente, pero es un salto de
  motor: el editor visual y las rutas de PDF pasan al grafo nuevo.
- **Opción B — v2 solo por el agente**, conviviendo con el core v1 un tiempo. Menos riesgo,
  pero dos motores de PDF en el mismo proceso (y el agente de v2 asume el grafo de v2 →
  probablemente **no es viable** sin arrastrar `@aldus/core` v2 igual).

Sospecha fuerte: **B no existe en la práctica** — el agente de v2 no funciona sin el core
de v2. Confirmar antes de comprometerse.

## 6. Fuera de alcance (sigue siendo de Signwax)
Sellado PAdES/CMS, timestamping/anchoring, audit hash-chain, auth/orgs/billing. El propio
`index.ts` de aldus lo dice: *"El sellado criptográfico es del host, no del motor."*
