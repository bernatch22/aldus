# Aldus Agent v2 — reescritura desde 0 (arquitectura + plan por fases)

> Respaldo: branch **`backup/agent-v1`** (el agente actual completo).
> Supersede la parte de agente de `UNIFICATION-PLAN.md`; el diagnóstico
> Signwax↔Aldus de ese doc sigue vigente.

## Principio rector

Dos agentes, cada uno con UN trabajo, y el grafo pesado nunca entra entero a un prompt:

```
prompt del usuario
   │
   ▼
READER  (modelo barato)
   system = OUTLINE del doc (páginas, títulos, conteo de campos — ~20 líneas, NO el grafo)
   tools  = lectura: doc_info · read_page · find_text · list_fields
            + tools del host nivel reader (Signwax: list_signers, list_agreements…)
            + edit_document({pages, request})  ← la ÚNICA puerta a la edición
   ▼ lee SOLO las páginas que necesita (paga por página leída, no por documento)
   │
   ├── pregunta/consulta → contesta él mismo. Fin. (turno barato)
   │
   └── edición → edit_document(...) ─────────────┐
                                                 ▼
                                     EDITOR  (modelo fuerte)
                                        system = grafo serializado de LAS páginas pedidas
                                        tools  = edición 1:1 con EditSession
                                                 + tools del host nivel editor
                                        ▼
                                     EditSession → finishTurn()
                                        → AnyEdit[] (kinds de core/model/edits.ts)
                                        → o bake in-situ
                                     ═══ MISMO contrato que consume el server ═══
```

**Diferencia clave con v1:** el chat de v1 embebía `serializeDoc(doc)` ENTERO en el
system prompt. El reader nuevo recibe solo un outline y **lee por tools** — un doc de
40 páginas ya no cuesta 40 páginas de input por turno.

**"La edición coincide con el server" por construcción:** las tools del editor no
tienen lógica — cada una delega en UN método de `EditSession`, y `EditSession`
produce `AnyEdit[]`/bake, que es exactamente lo que persisten las rutas del server
(`instantOps`, `routes/agent`, `routes/bake`). Un solo camino de escritura.

## Qué sobrevive del agente actual (no reescribir lo que ya coincide con el server)

| Pieza | Por qué queda |
|---|---|
| `session/EditSession.ts` + `NodeIndex` | ES la superficie de edición compartida con el server (`AnyEdit`, `finishTurn`, bake). Reescribirla rompería la coincidencia que queremos. |
| `transport/` (`ILlmTransport`, ClaudeSdk, OpenRouter, sink) | Plumbing probado, ya inyectable (art-of-code C2/C6). Los agentes nuevos lo consumen igual. |
| `llm/serialize.ts` | grafo→texto ya resuelto; se le agrega el modo **outline** (nuevo). |
| `graph.ts` (`loadDoc`) | carga del grafo, sin cambios. |

## Qué se reescribe de 0

`llm/tools.ts`, `llm/runTurn.ts`, `llm/prompts.ts`, `llm/verify.ts`, `config.ts`, `host/cli.ts`.

## Arquitectura (art-of-code aplicado)

```
packages/agent/src
├── tools/
│   ├── contract.ts      IAgentTool (Symbol+interface, C2): { name, description,
│   │                    schema (zod), level: 'reader'|'editor'|'both', run(ctx,args) }
│   │                    ToolContext = { session, doc, emit } — el host cierra sobre lo suyo.
│   ├── registry.ts      ÚNICO catch site (C7): valida zod → run → ToolOutcome
│   │                    {ok, code, retriable, message}. unknown_tool/bad_args/internal.
│   ├── read/            UN ARCHIVO = UNA TOOL (C4, multi-binding):
│   │   ├── docInfo.ts       doc_info
│   │   ├── readPage.ts      read_page
│   │   ├── findText.ts      find_text
│   │   └── listFields.ts    list_fields
│   └── edit/
│       ├── fillField.ts     fill_field          → session.fillField
│       ├── editText.ts      edit_text           → session.editText
│       └── …                (una tool por método de EditSession, fase a fase)
├── agents/
│   ├── reader.ts        IReaderAgent — outline prompt + tools(level reader) + edit_document
│   └── editor.ts        IEditorAgent — grafo scoped + tools(level editor)
├── session/             (v1, intacto)
├── transport/           (v1, intacto)
├── serialize.ts         (v1 + serializeOutline nuevo)
├── ioc.ts               COMPOSITION ROOT (C3): manifiesto legible —
│                        bind(IAgentTool)×N, bind(IReaderAgent), bind(IEditorAgent),
│                        bind(ILlmTransport), config. El host (Signwax) crea el
│                        container y BINDEA SUS PROPIAS IAgentTool — extensión = 
│                        un bind más, cero cambios en el agente (OCP, C4).
├── config.ts            IAgentConfig inyectable; default: MISMO modelo en ambos
│                        agentes (un solo LLM); bajar el reader a barato = 1 env var.
└── cli.ts               host de prueba: `aldus ask <pdf> "<prompt>"` + `aldus tools`
```

- **Extensión Signwax** = implementar `IAgentTool` (con `level`) y bindearla en el
  container — sin `HostToolDef` aparte, sin formato dual: un solo contrato de tool
  para las nativas y las del host. Los eventos del host viajan por `ctx.emit`
  (passthrough al sink → NDJSON).
- **Testing (C9):** transporte real virtualizado — `ScriptedTransport` (un fake de
  guion que "llama" tools en orden fijado) + **golden-text** del wire completo del
  turno (`eventos + outcomes + summary()` → `.txt` committeado, `RESET_RESULTS=1`
  regenera). Las tools puras además test unit colocado.
- **Modelos (decisión Berna 2026-07-14):** reader = **Gemini Flash vía OpenRouter**
  (`ALDUS_READER_MODEL=google/gemini-3.5-flash` — para leer no hace falta Sonnet);
  editor = **`claude-sonnet-5`** por la suscripción. El transporte se deriva del id
  (`vendor/slug` → OpenRouter); sin knob de provider.

## Protocolo de prueba (obligatorio)

- **PDF de prueba:** `~/signwax/tmp/contrato-de-distribucion-de-software.pdf` (164 KB).
  Las ediciones se prueban de la más mínima a la más complicada, SIEMPRE sobre este doc.
- **Quién prueba: BERNA, con el CLI `aldus`.** Al cerrar cada checkpoint marcado
  **📣 TE AVISO** abajo, Claude para, avisa con los comandos exactos listos para
  copiar/pegar, y NO avanza hasta el OK. Nada se da por andando sin que Berna lo
  haya visto con sus propios ojos.

## Plan por fases — minimalista, tool por tool, cada fase termina con vos mirándolo

Regla: **no se pasa a la fase siguiente hasta que corriste el CLI y lo viste.**
Cada tool nueva = 1 archivo + 1 bind + 1 golden test + 1 corrida CLI tuya.

### F0 — Esqueleto (sin LLM, sin gasto) ✅ HECHO (2026-07-14)
- Branch `backup/agent-v1` ✔ · borrados `llm/{tools,runTurn,prompts,verify}.ts` + `host/cli.ts`.
- Nuevos: `tools/contract.ts` (IAgentTool con `level`), `tools/registry.ts` (único
  catch site, 8 tests), `config.ts` (reader/editor por modelo), `ioc.ts`, `cli.ts`.
- Suite verde: 24 tests (sobreviven ledger/reflow/placeholders/serialize = el contrato server).
- 📣 **TE AVISO → probás:** `cd ~/aldus-v2/packages/agent && ./bin/aldus.mjs tools`
  (manifiesto: modelos + 0 tools). *Checkpoint liviano: mirarlo alcanza.*

### F1+F2 — El READER ✅ HECHO (2026-07-14, corregido tras feedback de Berna)
- **Lectura = contenido INLINE en el system prompt** (`serializeReading`: texto en
  orden de lectura + campos, sin ids/coordenadas). CERO tools de lectura — una
  consulta cierra en UNA pasada. El intento intermedio de "outline + tools de
  lectura" fue un error de diseño (7 round-trips y 16s para una pregunta simple):
  Berna nunca pidió eso; el split reader/editor es para la EDICIÓN (el editor no
  come el doc entero), no para leer. Tools `doc_info/read_page/find_text/list_fields`
  ELIMINADAS.
- `agents/reader.ts` + `agents/transports.ts` (transporte por id de modelo);
  rol `chat` → `reader`; guard anti-repetición de tools (queda para host/editor);
  el transporte OpenRouter nunca termina un turno MUDO (pasada final forzada) y
  loguea timing por pasada con ALDUS_DEBUG=1.
- ✅ Verificado (pregunta real sobre el contrato): 1 pasada, 0 tools, ~5s,
  respuesta correcta citando secciones. Antes: 7 tools, 16.5s.

### F3 — Nace el EDITOR con UNA tool: `edit_text` ✅ HECHO (2026-07-15)
- (`fill_field` pasó a F3b: el PDF de prueba no tiene AcroForm.)
- `agents/editor.ts`: system = `serializeDoc` SCOPED (el grafo pixel-perfect: ids
  reales `p1-y711-x154`, coordenadas, estilos — "ve la página tal cual es").
- Puerta `edit_document({pages, request})` en el reader, inyectada como callback
  (el reader no conoce al editor); un fallo del editor vuelve como ⚠️, no mata el turno.
- `tools/edit/editText.ts` = delegación pura a `EditSession.editText` (reflow,
  guardrails — el MISMO camino de escritura que el server). Guard anti-spin
  compartido (`agents/dedupe.ts`). CLI: hubo edición → `session.save()` a
  `<pdf>.edited.pdf` (el original no se toca).
- ✅ E2E verificado (editor vía OpenRouter `anthropic/claude-sonnet-5`): reader
  ruteó págs+cita exacta → editor 1 solo edit_text → bake → el grafo del PDF
  horneado tiene el título nuevo, misma posición (154,711), misma Cambria-Bold
  14pt, 15/15 bloques intactos. 8.6s total.
- 📣 **TE AVISO → probás** (suscripción, tu shell tiene la sesión de Claude viva):
  `./bin/aldus.mjs ask $PDF "cambiá el título de la primera página a <lo que quieras>"`
  → abrí el `.edited.pdf` y miralo. OJO: mi shell tenía la OAuth vencida — si te
  pasa, `claude login`, o probá con `ALDUS_EDITOR_MODEL='anthropic/claude-sonnet-5'`.

### F3.5 — Refresh MCP-style + registro de dónde ✅ HECHO (2026-07-15, pedido de Berna)
- **Toda edición ✓ devuelve DÓNDE (página, id, coordenadas) + el ESTADO ACTUALIZADO
  de la zona** (±2 vecinos con el ledger aplicado, el nodo tocado marcado `← editado`)
  — patrón MCP edit-tool: el system prompt no se re-escribe, la vista fresca viaja en
  el tool result. Centralizado en `editTurn` (toda tool futura lo hereda) sobre
  `EditSession.effectiveSegments(page)` (nuevo, lee el ledger — una sola fuente).
- **Bug de core encontrado y corregido** (destapado por la edición encadenada):
  `paragraphOf` limitaba `rightEdge` al ancho del PROPIO párrafo → una línea corta
  ("DE UNA PARTE,") no podía crecer ni un carácter y se partía en dos renglones.
  Ahora el límite es la COLUMNA. Regresión pinneada en editor.test; 237 tests de
  core siguen verdes.
- CLI: un editor que falló (0 cambios) ya NO hornea un .edited.pdf inútil.
- ✅ E2E: edición doble en p1 → 2 cambios exactos, "POR UNA PARTE," en una línea,
  párrafo inferior intacto, 9.1s.

### F3b — `placeholders_to_fields` ✅ HECHO (2026-07-15, adelantada de F6 a pedido de Berna)
- Tool = delegación pura a `EditSession.placeholdersToFields` (el LLM detecta
  {placeholder, name}; `matchPlaceholders` de core hace TODO el layout — cero reflow,
  cero coordenadas del modelo). Es la salida que el guardrail de edit_text ya señalaba.
- ✅ E2E sobre el contrato: "convertí los puntos suspensivos de la p1 en campos" →
  4 llamadas (una por párrafo), **10 campos text** con nombres semánticos
  (fecha, empresa_*, distribuidor_*, software_nombre) colocados sobre el rect real
  de cada hueco, texto intacto. 31s.
- 📣 **TE AVISO → probás** y abrís el .edited.pdf: los huecos deben ser inputs.

### F3c — Fan-out: un editor por página en PARALELO ✅ HECHO (2026-07-15, pedido de Berna)
- `editPages`: cuando el reader rutea N páginas, se lanza UN `editTurn` por página
  EN PARALELO (Promise.all), cada uno con su grafo scoped. La latencia pasa de la
  SUMA a la de la página más lenta.
- Comparten UNA `EditSession` → las mutaciones se serializan con un `Mutex`
  (`agents/mutex.ts`, art-of-code C6 "serialize racy mutations through a queue"):
  el paralelismo queda en esperar al modelo, la mutación queda ordenada. Un editor
  que falla no tumba a los otros; si TODAS fallan, propaga (infra rota).
- Eventos del wire llevan `page` → el CLI muestra `[editor p3]`.
- ✅ E2E medido: 4 páginas, 31 campos idénticos, **235s → 118s** (≈2×). 4 tests
  nuevos (concurrencia real, aislamiento de fallos, mutex serializa). 40 verdes.
### F3d — `placeholders_to_fields_batch` ✅ HECHO (2026-07-15, pedido de Berna: "imprescindible")
- Todos los párrafos de una página en UNA llamada del modelo (grupos {id, fields});
  el código itera y aplica cada uno (layout determinístico por párrafo — cero
  pérdida de precisión). Prompt del editor: "usá _batch, NUNCA de a uno en serie".
- Un grupo que falla no tumba a los demás; reporta grupo por grupo.
- ✅ E2E 4 págs: **18 tool calls → 5** (p1/p2/p3 batch, p4 uno). Mismas 31 campos.
- Verdad incómoda medida: wall-clock 118s → 109s (marginal). El piso REAL no eran
  los tool calls sino la LATENCIA POR PASADA de Sonnet sobre el grafo de una página
  (~50s/pasada × 2). El batch baja tokens y hace el turno más confiable, pero para
  bajar el wall-clock hay que atacar el modelo/pasada, no el nº de tools. 42 tests.

### F3e — Fix core: campo nunca tapa la etiqueta ✅ HECHO (2026-07-15, bug visto por Berna)
- Síntoma: en bloques Word-justificados donde la palabra queda PEGADA a los leaders
  en el mismo run ("......Direcci"), un rango sloppy del LLM ponía el campo sobre la
  palabra ("Banco: [campo]ón [campo] Cuenta" con texto tapado).
- Raíz VERIFICADA (reproducida determinística): `matchPlaceholders` usaba el rango
  crudo del match para el ancho del campo; si el LLM marcaba de más, cubría letras.
  El motor colocaba bien con placeholders limpios — el problema eran los args del LLM
  (Gemini, sobre el bloque más denso).
- Fix DETERMINÍSTICO en `core/layout/placeholderMatch.ts`: al colocar, el campo se
  recorta al run de RELLENO más largo dentro del hueco (puntos/guiones/espacios) —
  nunca cubre letras, sin importar qué marcó el LLM. No-op en casos limpios (238
  tests core verdes, +1 regresión "Banco: ....Direccion").
- ✅ E2E 4 págs con Gemini: campos del banco 161→216 (no tocan "Direcci"), etiquetas
  "; IBAN:" "; SWIFT:" visibles. **30s** (Gemini editor). 42 tests agent verdes.

### F3f — Rellenos XXXX/xxx/*** → huecos EN BLANCO + reflow ✅ HECHO (2026-07-19, bug de Berna: "en vez de quitar los XXX lo pone arriba")
- Síntoma: en PDFs con rellenos ("XX de XXXXXX de XXXX", "***", "xxxxxxx") la colocación
  directa dejaba las X VISIBLES bajo el campo y el ancho era el del relleno impreso
  ("XX" → ~15pt, inutilizable). Portado y superado del fix hecho primero en v1 (~/aldus).
- `matchPlaceholders` ahora clasifica: leader usable → colocación directa de siempre
  (el corpus con "....." NO cambia); relleno sin leader → `needsReflow` + holes `rewrite`.
- `reflowApply` emite el hueco como **GAP GEOMÉTRICO PURO** (cero glifos: el run se
  cierra, el siguiente ancla con dx pasado el gap). `placeFieldsInGaps` (nueva, pura)
  coloca cada campo sobre el GAP MEDIDO entre runs re-extraídos — acotado por el texto
  vecino, **imposible pisar texto por construcción**. (v1 probó puntos + charXOf sobre
  runs mixtos: la deriva corría campos sobre el texto — descartado.)
- Defensas nuevas, todas pagadas con runs reales del harness:
  · RECORTE al run: "el señor ***" (frase-contexto que la tool misma pide) → hueco SOLO
    sobre el `***`; las palabras sobreviven. Sin esto el hueco se tragaba contenido y el
    ancho inflado hacía abortar el reflow (4/7 párrafos del NDA).
  · SPLIT: "XX de XXXXXX de XXXX" como UN field = 3 huecos (name, name_2, name_3).
  · Frases-contexto SOLAPADAS ("XXXXXX de XXXX" + "de XXXX hasta"): retry desde 0 +
    salto de huecos ya cubiertos; un placeholder no encontrado es NOTA, no error de grupo.
  · BARRIDO extendido: al reflowear, TODOS los runs x/X/* del párrafo se convierten
    (el LLM manda de a uno; la 2ª llamada da ↩︎ — sin barrido quedaban X inalcanzables).
  · Guardrail edit_text AMPLIADO a rellenos: el editor Gemini emulaba la tool escribiendo
    espacios/"DD de MM"/"[Día de Inicio]" — texto que PARECE hueco pero no se completa.
  · Prompt del reader anti-narración: flash-lite "anunciaba" la edición sin llamar
    edit_document (149s, 0 ediciones) — ahora rutea.
- Modelos por default: reader `google/gemini-3.1-flash-lite` (solo rutea) + editor
  `claude-sonnet-5` (Gemini editor se sale del carril con placeholders — medido).
- Harness E2E nuevo: `packages/agent/scripts/eval-placeholders.mts` (original → reader→
  editor real → output.pdf + crops before/after por campo con rect rojo + galería +
  ledger args/resultados en summary.json; `--reuse` re-recorta sin LLM) y
  `scripts/replay-ledger.mts` (re-ejecuta el ledger SIN LLM — iterar gratis).
- Fixes de GEOMETRÍA (Berna vio "regirá desde elde" pegado + campos corridos en p2):
  · `spaceW` MEDIDO del propio párrafo (mediana de espacios reales vía charX): una línea
    justificada Word estira los espacios con Tw y la re-emisión LO HEREDA — el 0.28em
    fijo subestimaba el ancho rendido y el run siguiente se anclaba ADENTRO del anterior.
  · Detección de ANCLAS PISADAS: cuando un run rinde más ancho que lo estimado, pdf.js
    FUSIONA los items solapados y el chequeo de gaps no ve nada — ahora se detecta por
    ancla esperada vs item que la atraviesa, y el fix va al run EXACTO (dxFix por
    (fila,índice), no por texto — "de" se repite y el fix le pegaba a los inocentes).
  · Colisión = SOLAPE REAL (gap<-0.5), no tangencia: pdf.js parte los items re-emitidos
    EXACTAMENTE en el cambio de estilo (bold→regular, gap 0 SIEMPRE) — el umbral viejo
    `<MIN_GAP` disparaba eterno, acumulaba fixes fantasma y abortaba por overflow espurio.
  · Nombres ÚNICOS por sesión (los campo_N del barrido colisionaban entre párrafos y
    addFormField los renombraba a "texto_N") · flex generalizado a rellenos (matchea
    "XXX de XXXXX del XXXX" cruzando el salto de renglón). Log gateado `aldus:reflow`
    (iteraciones + fixes) para el forense.
- ✅ Verificado: NDA Securitas 15-16 campos en TODOS los párrafos con placeholders, X
  eliminadas, huecos en blanco, nombres semánticos (fecha_fin_acuerdo_2, no texto_N),
  cero solapes campo↔texto y cero "elde"; replay determinístico del ledger real de
  Sonnet + suite 361 verdes (+12 tests).

### F3g — Costo y robustez multi-modelo ✅ HECHO (2026-07-19, "¿POR QUÉ gasta tanto?")
Medido con `usage: {include: true}` (OpenRouter devuelve el COSTO real por request — ahora
se loguea gateado en el transporte): una corrida Sonnet del contrato costaba **$1.08 / 308s**.
Tres causas, tres fixes, todos de contrato:
- **Reasoning apagado** (`reasoning: {enabled: false}` en el transporte): OpenRouter le
  encendía extended thinking a Sonnet — 5-8k tokens de salida POR tool call a $15/M era el
  66% del costo. En este agente el LLM solo detecta/nombra; el layout es del código.
- **Tramos FUSIONADOS en serialize** (solo display, el grafo no se toca): un PDF con
  /ToUnicode roto parte cada acento en su run ("identificaci|ó|n") y ese confeti era el
  55-60% del prompt — la página más ruidosa (p2 del contrato) hacía que Sonnet dijera
  "no puedo llamar tools" y quedara SIN convertir. Fusionada, p2 convierte (6 campos).
- **Anti-invención de ids** (`notFound()` con anclas): tras un corrimiento el modelo veía
  `id p3-y137 @(121,132)` e inventaba "p3-y132-x121" — 25 tool calls de flailing. El error
  ahora enseña que el id es INMUTABLE y lista los ids reales más cercanos (25→2 ⚠️).
- Además: **etiqueta ≠ placeholder** ("[denominación social…]" sin leaders/rellenos adentro
  ANCLA al run de leaders adyacente en vez de convertirse — MiniMax la reescribía y borraba
  contenido + re-emitía el mojibake) y **prompt caching** anthropic (cache_control en el
  system; pega en turnos largos, no en ráfagas de 19s).
- Bench de baratos (mismo harness): deepseek-v4-flash emite el tool call como TEXTO (inútil),
  glm-5.2 narra sin ejecutar, minimax-m2.5 ejecuta rápido (44s) pero sobre-convierte — con
  los guardrails nuevos ya no destruye. Ninguno reemplaza a Sonnet como editor todavía.
- ✅ Verificado (1 corrida): **$0.405 / 19s**, 4/4 páginas (p2 incluida), flailing 25→2,
  output 47k→4.7k tokens. Suite 363 verdes.

### F4b — Fix core: los renglones extra del reflow pertenecen AL PÁRRAFO ✅ (2026-07-15)
- Bug (visto por Berna): al crecer un párrafo, la línea extra salía en OTRA fuente.
  Raíz: el reflow la creaba como un `create` de texto suelto → bake con fuente
  ESTÁNDAR siempre. Fix conceptual (de Berna: "un párrafo es un conjunto de nodos"):
  los renglones extra van como filas '\n' del ÚLTIMO segmento del párrafo →
  camino segment-edit → fuente embebida + fallback por glifo, igual que el editor.
- Segundo fix: el agente nunca registraba los font providers reales (el server sí,
  en su composition root). `createAgentContainer()` ahora llama
  `registerNodeFontProviders()` → la sustituta es la GEMELA MÉTRICA (Caladea por
  Cambria), no Times. Verificado: 6/6 líneas uniformes en Caladea.
- Tercero: `avgCharW` ahora se muestrea de las LÍNEAS DE PROSA de la página (no del
  nodo puntual, que en MAYÚSCULAS sobreestimaba y dejaba renglones cortos).
- Prompt del editor: bloques multi-párrafo = UNA replace_paragraph con end_id.
- Tests de reflow ajustados: fila visual = baseline del RUN (el último segmento
  ahora es multilínea legítimamente). 238 core + 47 agent verdes.

### F4 — Familia TEXTO (donde estuvieron los mil problemas — de a UNA)
`edit_text`(F3) → **`delete_text` ✅** → `replace_paragraph` → `set_text_style/color/size`.
- 📣 **TE AVISO POR CADA TOOL**: entra una, corrés tu edición sobre el contrato, abrís
  el PDF, das el OK — recién ahí entra la siguiente. Acá NO se agrupa nada.
- **`delete_text` ✅ HECHO (2026-07-15)** — borra por id; `pull_up: 'gap'|'top'` sube
  el contenido de abajo (gap = cierra el hueco 52pt · top = al tope de la página,
  reclama el margen 116pt). Reusa el patrón `below`+`dy` del reflow, sin duplicar.
  Verificado por render (Berna): gap subía poco/imperceptible, top pega el contenido
  arriba. 45 tests. Gemini editor por default desde acá.

### F5 — Familia GEOMETRÍA ✅ HECHO (2026-07-15)
`move_text` · `move_field` · `move_image` · `delete_element` (una puerta que detecta
el tipo por id — nuevo `EditSession.deleteElement`, en vez de 4 deletes). Verificado
por render: mover título 40pt + borrar línea, exacto. 51 tests.

### F6 — Familia CREACIÓN ✅ HECHO (2026-07-15)
`add_text` · `add_form_field` · `highlight_text` · `add_link` · `watermark` ·
`header_footer` · `insert_image` (necesita ruta local). Todas delegación pura.
- **Fix idempotencia global**: watermark/header_footer son de TODA la página; en el
  fan-out los N editores las aplicaban N veces (8 copias encimadas). Ahora son
  idempotentes por params → 1 sola. Verificado: 8 cambios → 2.
- Render OK: BORRADOR diagonal + "Página 1 de 4" + línea resaltada amarilla. 54 tests.

**Editor completo: 19 tools bindeadas.** Falta `fill_field`/`fill_fields` (F3b diferida:
necesitan un PDF con AcroForm — el contrato de prueba no tiene, pero el editado sí).

### Extra — `replace_page`: página entera con ESTILOS ✅ (2026-07-15, pedido de Berna)
- El LLM describe BLOQUES estructurados (title/heading/subheading/paragraph/bullet/
  spacer); `composePageBlocks` (core/create) hace TODO el layout: tipografía por
  tipo (18 bold título → 11 cuerpo), wrap por medición REAL de fuente (pdf-lib
  widthOfTextAtSize), márgenes 1", espaciados, centrado, viñetas indentadas.
  Overflow honesto: reporta bloques que no entraron, no encoge.
- Fix de acumulación: re-componer la misma página DESCARTA la composición previa
  de la sesión (Sonnet llama 2 veces refinando → antes quedaba todo doble encimado).
- ✅ E2E: "reemplazá la página 4 por un anexo de confidencialidad bien diseñado" →
  página impecable (verificada por render). 61 tests agent + 238 core.

### F7 — Extensión host (el motivo de todo esto)
- `level` respetado en ambos agentes; `ctx.emit` → evento `{type:'host',…}` en el wire.
- Demo en el CLI: una tool fake `list_signers` bindeada "desde afuera" → el reader la usa.
- 📣 **TE AVISO → probás:** un turno que mezcla tools nativas + host en una conversación.

### F8 — Server + build
- `apps/server/routes/agent.ts` pasa a componer reader+editor desde el `ioc` (mismo container).
- `npm pack` → tgz nuevos para Signwax. La integración Signwax es OTRO plan (UNIFICATION-PLAN.md).

## Anti-metas (para mantenerlo minimalista)
- Sin verificador geométrico post-hoc en F0–F6: si una tool necesita verificación, la tool está mal definida — se arregla el contrato, no se parchea después.
- Sin visión/LLM multimodal: el grafo tipado ES la vista del documento.
- Sin caché de prompts, sin retry sofisticado, sin métricas: después de que las tools sean confiables.
