# Auditoría art-of-code — capa PDF del bake (`packages/core/src/bake/`)

Auditor: framework art-of-code (vscode-js-debug). Alcance: los 26 archivos de
`/Users/berna/aldus/packages/core/src/bake/` + los 9 tests de
`/Users/berna/aldus/packages/core/test/`. Fecha: 2026-07-14.

---

## 1. Inventario real

### Capas implícitas detectadas (hoy, sin nombrar)

```
Layer 0 (common implícito)   splice.ts (fmt/latin1/toBytes/hexString), color.ts, mul/invert (¡viven en textWalk!)
Layer 1 (protocolo PDF tonto) tokenizer.ts, textWalk.ts, pageContent.ts, toUnicode.ts
Layer 2 (servicios de dominio) locate.ts, fonts.ts, fontProviders.ts, fontsNode.ts, fallback.ts, annotEdits.ts
Layer 3 (brain / appliers)    bake.ts, text.ts, textEmit.ts, images.ts, shapes.ts, widgets.ts, highlights.ts, links.ts
Fuera del pipeline (ops one-shot pdf-lib) createNodes.ts, forms.ts, flatten.ts, info.ts
Reporting                     report.ts
```

### Archivo por archivo

| Archivo | LOC | Qué hace | Sale hacia | Entra desde |
|---|---|---|---|---|
| `bake.ts` | 105 | Orquestador `bakeSegmentEdits`: carga pdf-lib, agrupa edits por página, walk → appliers → rebuild → fallbacks | textWalk, pageContent, splice, images, shapes, text, widgets, highlights, links, fallback, report | agent/session, server/routes/bake, editor/useLocalPreview (dyn import), tests |
| `tokenizer.ts` | 212 | Content stream → `OpRecord[]` con offsets de bytes exactos. Dos defensas anti-OOM pagadas con sangre: hex-string dentro de dict (PDF taggeado) y progreso garantizado en delimitador huérfano. Skip de `BI…EI` inline | — (cero deps, puro) | textWalk, tests |
| `textWalk.ts` | 320 | Máquina de estado ISO 32000 §9.4: shows con matriz absoluta+CTM+clip+stale, xobjects, fillRects (subrayados/shapes), backstop (papel blanco) | tokenizer, **color.isWhiteFill** | bake, locate (types), text, images, shapes, tests |
| `locate.ts` | 87 | Localización por GEOMETRÍA: `matchOps` (texto, con leftSlack de ½em y rechazo de stale), `matchImage`, `imageResourceNames` (solo Subtype /Image), `xobjectRect` | pdf-lib, model, textWalk types | text, images |
| `splice.ts` | 65 | `rebuild` byte-splicing in-place (z-order intacto) + invariante de orden inserción-antes-que-reemplazo + helpers `fmt/latin1/toBytes/hexString` | — (puro) | casi todos |
| `textEmit.ts` | 71 | `relTm` (M_rel = M_abs × inv(ctm)), `reemitBlock` (path A verbatim), `newTextBlock` (path B hex re-encodeado) | textWalk (mul/invert), splice | text |
| `text.ts` | 348 | `ITextEmitStrategy` + registry (`VerbatimReemit`, `StyledRunsReemit`) + `applySegmentEditsToPage` (locate→color→remove→probe) + `underlineRectsFor` + `escapesClip` | model, textWalk, toUnicode, color, fonts, locate, splice, textEmit, fallback, report | bake, index |
| `toUnicode.ts` | 187 | CMap /ToUnicode inverso (bfchar/bfrange) + fallback IDENTIDAD para control chars en fuentes 1-byte + tablas MacRoman/WinAnsi (`encoderFromSimpleEncoding`) | — (puro) | fonts, tests |
| `fonts.ts` | 106 | `stdFontFor` (bucket→StandardFonts), `baseFontFamilyOf` (quita prefijo subset), `encoderForFont` (memoizado; ToUnicode → simple-encoding) | pdf-lib, toUnicode, splice | text, fallback, createNodes |
| `fallback.ts` | 96 | Path C: cola `FallbackDraw[]`, provider chain → estándar; filtro de control chars (cajita X); fontkit por dyn import | fonts, fontProviders, report | bake, text (types) |
| `fontProviders.ts` | 49 | Registry `IFallbackFontProvider` (probing en orden, errores tragados, idempotente). Estado **global de módulo** (no DI) | model (types) | fallback, fontsNode, tests, agent/server (re-export) |
| `fontsNode.ts` | 109 | Providers con I/O (subpath `./bake/fonts-node`): SystemFontProvider (scan de dirs) + MetricTwinProvider (Caladea/Carlito, cache `~/.aldus/fonts`) | node:fs/os/path, fontProviders | server/index, agent/cli (boot) |
| `color.ts` | 67 | hex↔rg operator↔rgb; `rawFillToRgb` + `isWhiteFill` (dos parsers PARALELOS de la misma sintaxis) | splice (fmt) | textWalk, text, index |
| `images.ts` | 99 | ImageEdits: move/scale in-place (flips preservados, NUNCA reordena el Do — objId de pdf.js), remove, zOrder front/back (backstop con inv CTM) | textWalk, locate, splice, report | bake |
| `shapes.ts` | 61 | ShapeEdits contra fillRects: `matchRect` nearest-neighbor con tol, remove/move in-place en coords locales (inv CTM sin rotación) | model, textWalk, splice, report | bake |
| `widgets.ts` | 70 | WidgetEdits: match campo+widget por nombre+rect (tol 2.5, loop propio), setRectangle / removeField / updateFieldAppearances | pdf-lib, model, report | bake |
| `flatten.ts` | 39 | `flattenForm` todo-o-nada (tamper-evidence e-sign) | pdf-lib | agent, tests |
| `info.ts` | 47 | `readPdfInfo`, `isPdf` (magic), `defaultSignaturePlacement` ← **política e-sign en core** | pdf-lib | agent, tests |
| `highlights.ts` | 68 | HighlightEdits vía annotEdits (+QuadPoints, recolor regenera AP) + `hideHighlightAnnotations` (display-only del editor, con el gotcha del object-stream documentado) | pdf-lib, annotEdits, createNodes (highlightAppearance), report | bake, editor (dyn) |
| `links.ts` | 19 | LinkEdits vía annotEdits (delegación pura, 19 líneas — el patrón funcionando) | annotEdits | bake |
| `annotEdits.ts` | 89 | Maquinaria compartida /Annots: locate por /Rect original (lookupMaybe gotcha documentado), rewrite/remove, hook `onRect` (template method) | pdf-lib, report | highlights, links |
| `createNodes.ts` | 439 | **God-file grab-bag**: addFormField (+firma a mano), setFieldOptions, addRadioOption, addText, addWatermark, addHeaderFooter, addHighlight (+`highlightAppearance`), addLink, removeLink, insertImage | pdf-lib, model, fonts, splice | server/routes/ops, agent, tests |
| `forms.ts` | 171 | `readFormFields` (/AP /N on-state, resolución de índices /Opt, required) + `setFieldValues` (validación de opciones, warnings) | pdf-lib, model | agent, cli, tests |
| `report.ts` | 41 | `BakeReport` Builder → `{applied, warnings, colors}` — **strings castellanos = API de facto** | — | todos los appliers |
| `pageContent.ts` | 48 | Decodifica/concatena /Contents (array o stream) + `setPageContents` | pdf-lib | bake |
| `index.ts` | 26 | Barrel del subpath `@aldus/core/bake` | todos | agent, server, editor, tests |

### Código muerto / dudoso

- **`walkTextOps`** (textWalk.ts:112): wrapper trivial de `walkContent().shows`. Ningún
  consumidor interno; solo el export público (paquete npm publicado — quitar = breaking).
  Candidato a MATAR en v2 con deprecación.
- **`Token.items`** solo se consume para arrays TJ (indirectamente via `raw`) — los
  operandos de TJ se re-emiten por `raw`, nunca se caminan los items salvo en
  `reemitBlock` que usa `record.operands[N].raw`. Se queda, pero está sub-usado.
- `csRaw` en textWalk: solo alimenta sc/scn — vivo, correcto.

### Duplicación (RULE 4 violada hoy)

1. **La geometría del subrayado** (`y = baseline − size*0.11, h = size*0.055`) está en
   TRES lugares: `text.ts` `underlineRectsFor` (filtro), `text.ts` StyledRunsReemit
   (emisión, línea 245), `fallback.ts` `drawUnderline` (línea 80). Si cambia una, el
   filtro deja de encontrar lo que la emisión dibuja → subrayados huérfanos. Debe ser
   UN módulo `underline.ts` con `underlineRectFor(x, baseline, size, w)` + el predicado.
2. **Dos parsers del raw fill operator**: `color.ts` `rawFillToRgb` (regex de números)
   y `isWhiteFill` (split de tokens) parsean la misma sintaxis con dos técnicas
   distintas y semánticas de sc/scn ligeramente diferentes. Un `parseRawFill(raw) →
   {op, nums} | null` + derivados `toRgb`/`isWhite`.
3. **hex→rgb**: `color.ts` `hexToRgbObj` vs `createNodes.ts` `hexToRgb` local (misma
   lógica, distinto tipo de retorno pdf-lib `rgb()`).
4. **Cuatro localizadores por geometría** con tolerancias y estilos distintos:
   `locate.matchOps` (texto, Y_TOL/X_TOL 1.8 + leftSlack), `locate.matchImage` (tol
   proporcional 2%), `shapes.matchRect` (nearest-neighbor, TOL*4 manhattan),
   `widgets.ts` loop inline (tol 2.5), `annotEdits` loop inline (tol 2),
   `createNodes.removeLink` loop inline (tol 2, DUPLICA annotEdits casi línea a línea).
5. **El patrón `lookupMaybe(/Annots) ?? ctx.obj([])` + push + set** repetido 3× en
   createNodes (addSignatureField, addHighlight, addLink) — un helper `appendAnnot`.

### Violaciones de capas

- **`textWalk.ts` importa `isWhiteFill` de `color.ts`**: el walker de protocolo (Layer 1)
  conoce la heurística de NEGOCIO "papel blanco" para computar el backstop. El walker
  debería reportar hechos (fills con su color raw) y el brain decidir qué es papel —
  o al menos inyectar el predicado.
- **`info.ts` `defaultSignaturePlacement`**: política de producto e-sign ("N-ésimo
  firmante apilado en la última página") dentro del core del motor PDF. Va al host.
- **`highlights.ts` `hideHighlightAnnotations`**: concern de PREVIEW del editor
  (display-only copy) en la capa de bake. Funciona, pero es Layer 4 metido en Layer 3.
- **`createNodes.highlightAppearance` importado por `highlights.ts`**: la dependencia
  va de "edits de annots" hacia "creación de nodos" — el look del highlight debería
  vivir en un módulo propio que ambos importen.
- **`bake.ts` NO conoce estrategias de texto** ✓ (delegación limpia a
  `applySegmentEditsToPage`) — pero SÍ conoce el orden y el cableado de 6 appliers
  con firmas heterogéneas de bolsas de args (`{doc, page, pageNum, pageEdits, shows,
  fillRects, src, splices, appendBlocks, fallbackDraws, report}`) — el contrato
  `IEditApplier` está pidiendo nacer.
- **`bakeSegmentEdits(pdfBytes, edits, imageEdits?, widgetEdits?, highlightEdits?,
  linkEdits?, shapeEdits?)`**: 7 parámetros posicionales, 5 opcionales. Los tests lo
  sufren: `bakeSegmentEdits(pdf, [], [], [], [], [move!])`. Agregar un octavo tipo de
  edit = tocar la firma pública (viola OCP en el punto más público del paquete).

### Tests existentes (1.410 LOC)

| Test | Cubre | Estilo |
|---|---|---|
| `bake.test.ts` (717) | Ciclo REAL crear→extraer(pdfjs)→bake→re-extraer: move/rewrite/scale/remove, runs por tramo, ilocalizable→warning, \n multi-línea, imágenes (move/z-order/remove), widgets, createNodes, watermark editable, subrayado sigue al texto, highlight CRUD+GLUE, CLIP escape, color preservado | Tier-2 real (sin golden-text: asserts geométricos a mano) |
| `tokenizer.test.ts` (44) | Las DOS defensas anti-OOM (hex-en-dict, delimitador huérfano) | unit |
| `toUnicode.test.ts` (50) | Fallback identidad 1-byte, rechazo CID, \n\t\r nunca identidad | unit |
| `styledRuns.test.ts` (197) | (core/edits, no bake) classifyGap, runLines superíndice, applyTextDiff, markers | unit |
| `imageZOrder.test.ts` (84) | Regresión "todo blanco": back = después del papel, antes del BT; round-trip de matriz relativa | real |
| `widgetAppearance.test.ts` (70) | Regresión: bake sin widget edits NO toca /AP //DA //V | real |
| `forms.test.ts` (86) | readFormFields/setFieldValues | real |
| `fontProviders.test.ts` (32) | Probing, errores tragados, idempotencia | unit |
| `engineApi.test.ts` (130) | flatten/info/insertImage/forms | real |

**Huecos**: `splice.rebuild` NO tiene unit test propio (el invariante
inserción-antes-que-reemplazo solo se ejercita indirectamente vía imageZOrder);
`shapes.ts` no tiene NINGÚN test; `color.ts` parsers sin unit; `walkContent`
(clip intersection, q/Q stack, sc/scn) sin unit directo; `fonts.encoderForFont`
simple-encoding (Word/Quartz) sin test; `fallback` filtro de control chars sin test;
`hideHighlightAnnotations` sin test; `flatten` camino de error sin test.

---

## 2. Qué copiar VERBATIM a v2 — veredicto por archivo

| Archivo | Veredicto | Por qué |
|---|---|---|
| `tokenizer.ts` | **COPY** | Puro, cero deps, dos defensas anti-OOM pagadas con un tab muerto (CLAUDE.md gotcha). Cualquier "mejora" acá es riesgo puro. Llevar su test tal cual. |
| `splice.ts` | **COPY** | El invariante de orden (inserción sorts antes que reemplazo con mismo start) resolvió el caso real "imagen al fondo cuando ya es el primer op". `fmt` (sin −0) y latin1/hex son el common de facto. Solo mover `fmt/latin1/toBytes/hexString` a `common/`. |
| `toUnicode.ts` | **COPY** | El fallback identidad para control chars (acentos LibreOffice → cajita X) y las tablas MacRoman/WinAnsi en escapes numéricos ("para que ningún normalizador la corrompa") son sangre coagulada. Test existente lo clava. |
| `textWalk.ts` | **COPY-CON-AJUSTES** | La máquina ISO 32000 (q/Q, cm, Td/TD/Tm/T*, stale, clip tracking, fillRects, comillas) es LA joya — verbatim. Ajuste único: inyectar el predicado `isContentFill` (hoy importa `isWhiteFill` = negocio en el protocolo) y extraer `mul/invert/Matrix` a `common/matrix.ts`. |
| `locate.ts` | **COPY-CON-AJUSTES** | Los números están pagados: Y_TOL/X_TOL 1.8, leftSlack ½em (op que arranca con glifo espacio), rechazo de stale, "solo Subtype /Image, nunca Form XObject". Ajuste: encajarlo como implementaciones de `ILocator` (ver §3) sin tocar UNA tolerancia. |
| `textEmit.ts` | **COPY** | `relTm` (M_rel = M_abs × inv(ctm)) es el corazón matemático del in-place; reemit/newText correctos y chicos. |
| `text.ts` | **COPY-CON-AJUSTES** | `VerbatimReemit` y el registry: verbatim. `StyledRunsReemit.emit` es un god-method de 130 líneas con 5 responsabilidades (font-por-estilo con la defensa del superíndice "dominant size", split en líneas, escape de clip, subrayados, cola de fallback) → descomponer en helpers puros SIN cambiar semántica. `underlineRectsFor` + la emisión → módulo `underline.ts` único (duplicación #1). El comentario del superíndice ("todo el grafo pequeñito") es un bug pagado — conservarlo. |
| `color.ts` | **REESCRIBIR** (chico) | Correcto pero con dos parsers paralelos de la misma gramática (rawFillToRgb vs isWhiteFill) y el hex duplicado en createNodes. Un `parseRawFill` + derivados, mismos resultados, tests golden de equivalencia primero. |
| `fonts.ts` | **COPY-CON-AJUSTES** | `encoderForFont` (ToUnicode → simple-encoding sin Differences) y `baseFontFamilyOf` son sutiles y correctos. Ajuste: el cache `Map` pasado a mano → un `FontService` que POSEE el cache (services own collections). |
| `fallback.ts` | **COPY-CON-AJUSTES** | La cadena (provider→estándar), el filtro de control chars con warning, el fontkit lazy (browser nunca lo paga), el retry con clean ≤0xff: verbatim. Ajuste: recibir el registry por DI y el subrayado desde `underline.ts`. |
| `fontProviders.ts` | **COPY-CON-AJUSTES** | El contrato (nunca tira, null = no es mío, probing en orden, idempotente) es js-debug puro y está testeado. Ajuste: de global de módulo a binding en el composition root (multi-bind a `IFallbackFontProvider`); mantener el registro imperativo como shim para el paquete npm. |
| `fontsNode.ts` | **COPY** | I/O real bien aislado en subpath (patrón `.extensionOnly` ya aplicado). Scan de dirs, twins métricas, cache en disco best-effort: no tocar. |
| `bake.ts` | **REESCRIBIR** | Es delgado (105 líneas) y su lógica (groupByPage, backstop comment, orden de appliers) se conserva — pero la firma de 7 posicionales y el cableado a mano de bolsas de args se reemplazan por el coordinador `IEditApplier` (§3). El comentario del backstop/JotForm migra al JSDoc del contrato. |
| `images.ts` | **COPY-CON-AJUSTES** | La matemática de flips (signo de a/d + corrección de ancla), el M_rel del backstop, y sobre todo el comentario "NO reordenar el Do — pdf.js numera objIds por orden de pintado" son conocimiento irrecuperable. Solo re-encajar como applier. |
| `shapes.ts` | **COPY-CON-AJUSTES** | Lógica fina (coords locales vía inv CTM sin rotación). PERO: `matchRect` nearest-neighbor difiere del estilo de los otros locators y NO TIENE TEST — escribirle el test ANTES de moverlo. |
| `widgets.ts` | **COPY-CON-AJUSTES** | Match nombre+rect correcto; el loop inline se unifica bajo `ILocator`. `updateFieldAppearances` try/catch al final: conservar (regresión widgetAppearance.test depende del no-touch). |
| `highlights.ts` | **COPY-CON-AJUSTES** | QuadPoints UL-UR-LL-LR, recolor regenera AP, y el gotcha del object-stream en `hideHighlightAnnotations` (NO fast-path por bytes) — todo documentado con sangre. Ajustes: `hideHighlightAnnotations` se muda a una capa display/preview; `highlightAppearance` a un módulo propio. |
| `links.ts` | **COPY** | 19 líneas de delegación pura — el patrón objetivo ya logrado. |
| `annotEdits.ts` | **COPY-CON-AJUSTES** | ES la maquinaria compartida correcta (template method con `onRect`), con el gotcha lookupMaybe documentado. Ajuste: que `createNodes.removeLink` la use (hoy la duplica). |
| `createNodes.ts` | **REESCRIBIR** (partir) | Grab-bag de 10 capacidades sin relación (firma a mano, watermark, headers, links…). Partir en `create/` por capacidad + registry `ICreateOp` (el switch de WidgetKind y el dispatch del server /ops se vuelven registros). Conservar VERBATIM: `addSignatureField` (dict a mano, T como PDFString "pdf.js lee el fieldName de acá"), `highlightAppearance` (Multiply α 0.55, BBox local), MODERN_WIDGET, la esquina superior-izquierda como ancla del click. |
| `forms.ts` | **COPY** | El /AP /N on-state (vs /AS), la resolución de índices /Opt, la validación de opciones que pdf-lib traga en silencio — todo es conocimiento del commit 611f719. No tocar. |
| `flatten.ts` | **COPY** | Todo-o-nada honesto, 39 líneas. |
| `info.ts` | **COPY-CON-AJUSTES** | `readPdfInfo`/`isPdf` verbatim; `defaultSignaturePlacement` SE VA al host e-sign (política de producto, no de motor). |
| `report.ts` | **REESCRIBIR** | El Builder está bien; el CONTENIDO (strings castellanos como API de facto) es la deuda estructural #1 — ver §3 errores. |
| `pageContent.ts` | **COPY** | Concatenación de /Contents array con \n correcta. |
| `index.ts` | regenerar | Barrel deliberado (facade del subpath) — se regenera con la nueva forma. |
| `walkTextOps` | **MATAR** (deprecado) | Wrapper sin consumidores internos; export público → deprecar una versión, borrar en v2. |

---

## 3. Propuesta de refacto art-of-code

### 3.1 Capas (dependencias unidireccionales)

```
common/           matrix.ts (mul/invert — HOY en textWalk), bytes.ts (fmt/latin1/toBytes/hexString — HOY en splice),
                  rawFill.ts (parseRawFill + toRgb/isWhite — fusión de color.ts), hex.ts
pdf/ (Layer 1)    tokenizer.ts, contentWalk.ts (textWalk sin isWhiteFill importado — predicado inyectado),
                  splice.ts, pageContent.ts, toUnicode.ts        ← TONTO: reporta hechos, no decide negocio
fonts/ (Layer 2)  FontService (posee encCache + resuelve encoderForFont — "services own collections"),
                  IFallbackFontProvider multi-bind, fallbackDrawer, fontsNode (subpath Node)
locate/ (Layer 2) los localizadores por geometría, unificados (ver 3.2)
apply/ (Layer 3)  EL BRAIN: IEditApplier registry + las ITextEmitStrategy + underline.ts (fuente única)
create/ (Layer 3) un archivo por capacidad (fields.ts, signature.ts, text.ts, watermark.ts, highlight.ts,
                  link.ts, image.ts) + ICreateOp registry — el /ops del server hace getAll+probe
ops one-shot      forms.ts, flatten.ts, info.ts (sin defaultSignaturePlacement)
ioc.ts            composition root: lee como manifiesto (bindings de appliers, strategies, providers, locators)
```

Regla dura v2: `pdf/` no importa NADA de `apply/`/`fonts/` (hoy textWalk→color viola esto).
El browser bundle importa `apply/` sin providers (igual que hoy — la pureza ya existe, se formaliza).

### 3.2 Contratos Symbol+interface que emergen

Ya existe **`ITextEmitStrategy`** (canHandle/emit, catch-all al final) y el proto-registry
de **`IFallbackFontProvider`** — el patrón ya demostró funcionar acá. Se completa la familia:

1. **`IEditApplier`** — el contrato estrella, mata los 7 posicionales:
   ```ts
   export const IEditApplier = Symbol('IEditApplier');
   export interface IEditApplier {
     /** Self-gate barato por discriminante del edit. NO-OP si no es mío (nunca tira). */
     canHandle(edit: AnyEdit): boolean;
     /** Fase doc (widgets/annots — sin content stream) o fase página (con PageBakeContext). */
     readonly phase: 'document' | 'page';
     apply(edit: AnyEdit, ctx: DocBakeContext | PageBakeContext): void;
   }
   ```
   `AnyEdit = SegmentEdit | ImageEdit | WidgetEdit | HighlightEdit | LinkEdit | ShapeEdit`
   (unión discriminada por `kind` — el model ya casi lo es: cada edit tiene su
   `segmentId`/`imageId`/… como discriminante natural; agregar `kind` explícito).
   La API pública pasa a `bake(bytes, edits: AnyEdit[])` con un shim
   `bakeSegmentEdits(...)` deprecado que arma la unión (el paquete npm no rompe).
   Multi-bind: `SegmentEditApplier` (internamente sigue probando `textEmitStrategies`),
   `ImageEditApplier`, `ShapeEditApplier`, `WidgetEditApplier`, `HighlightEditApplier`,
   `LinkEditApplier`. **Agregar un tipo de edit nuevo = una clase + un bind** (hoy =
   tocar la firma pública + bake.ts + un archivo nuevo).

2. **`PageBakeContext`** como unit-of-work (el "target container" de js-debug): posee
   `{walk: ContentWalk, src, splices, appendBlocks, fallbackDraws, report}` — hoy esa
   bolsa se re-declara a mano en cada `apply*ToPage` con 8-11 campos posicionales.
   El bake por página = crear el contexto hijo, iterar appliers, rebuild.

3. **`ILocator`** — unificar los 4+2 localizadores:
   ```ts
   export interface ILocator<TOriginal, TFound> {
     /** null = no encontrado; {conflict} = encontrado ambiguo (NUNCA adivinar). */
     locate(original: TOriginal, ctx: PageBakeContext): TFound | LocateConflict | null;
   }
   ```
   Implementaciones: `TextOpLocator` (matchOps con leftSlack/stale — verbatim),
   `ImageOpLocator`, `FillRectLocator` (shapes), `WidgetLocator`, `AnnotRectLocator`.
   No hace falta multi-bind acá (cada applier conoce SU locator — inyección simple);
   lo que se unifica es el CONTRATO (conflict como dato, tolerancias como constantes
   nombradas en un solo lugar por tipo).

4. **`ICreateOp`** — la familia de createNodes: `{ kind: 'addText' | …, run(bytes, spec) }`
   multi-bind; el `switch(spec.type)` de addFormField se vuelve un registro de
   `IFieldCreator` por WidgetKind (el caso `signature` a mano ya es de facto una
   implementación distinta encerrada en un switch).

5. **`IFallbackFontProvider`** — ya existe; pasa de array global de módulo a multi-bind
   en el root (`container.bind(IFallbackFontProvider).to(SystemFontProvider)` …),
   con `registerFallbackFontProvider` como shim que agrega al container global.

### 3.3 Switches/ifs que deberían ser estrategias

- `createNodes.addFormField` `switch (spec.type)` (7 casos) → `IFieldCreator` registry.
- `server/routes/ops.ts` (fuera de alcance pero consumidor directo): dispatch a mano de
  addText/watermark/… → `getAll(ICreateOp)` + probe.
- `toUnicode.encoderFromSimpleEncoding` if MacRoman/WinAnsi → está BIEN como está (dos
  tablas, no dos algoritmos — no sobre-ingenierizar).
- `bake.ts` la secuencia fija applyWidget→Highlight→Link→(por página) Image→Shape→Segment
  → orden de REGISTRO de los appliers (el orden actual se preserva como orden de bind,
  documentado: annots primero porque no tocan el stream).

### 3.4 Errores estructurados (la deuda #1)

Hoy `BakeReport` acumula strings castellanos que son API de facto: los tests hacen
`applied.some(a => a.includes('al fondo'))`, `a.includes('link reubicado')`,
`a.includes('eliminado')`; el CLAUDE.md ya lo lista como gotcha. Propuesta (errors.ts
del example, adaptado a que acá son EVENTOS, no solo errores):

```ts
export const BakeCodes = {
  SegmentRelocated: 1001, SegmentRewritten: 1002, SegmentRemoved: 1003,
  ImageRelocated: 1101, ImageRemoved: 1102, ImageZOrdered: 1103,
  // warnings
  SegmentNotLocated: 9001, StaleChainedShows: 9002, DegenerateMatrix: 9003,
  RotatedImageUnsupported: 9004, PageOutOfRange: 9005, SubsetInsufficient: 9006,
  GlyphArtifactDropped: 9007, UnreadableStream: 9008, AnnotNotFound: 9009, …
} as const;
interface BakeEvent { code: number; nodeId?: string; params: Record<string, string|number>; severity: 'applied'|'warning'; }
```
`BakeReport.finish()` devuelve `events: BakeEvent[]` **Y** los strings actuales
renderizados desde un formatter castellano (UN solo sitio de render, como el catch
site único de js-debug) — la UI y los tests viejos no rompen, los tests nuevos
asertan `code`, y el día que haya i18n es un formatter más.

### 3.5 Tests golden-text a crear (gotcha del CLAUDE.md → fixture)

Adoptar el harness del example (`goldenText.ts`, `RESET_RESULTS=1`, unasserted-logs-fail).
El log observado por test: el `BakeReport` (codes+params sanitizados) + un dump de filas
re-extraídas (`text @ x,baseline size` por segmento) — exactamente lo que el modo
FORENSE 🐞 ya imprime en `repro.mts`: ese formato ES el golden natural del proyecto.

| Gotcha (CLAUDE.md) | Fixture golden | Estado hoy |
|---|---|---|
| Tagged PDF `/Span<</ActualText<hex>>>` cuelga tokenizer | `tagged-libreoffice.pdf` real + golden del walk | unit sintético existe (tokenizer.test) — falta el PDF real |
| Delimitador huérfano → loop infinito | mismo fixture | unit existe |
| Glifos sin /ToUnicode (U+0012) → identidad / filtro cajita-X | `libreoffice-accents.pdf` → editar texto con acento suelto → golden del report (GlyphArtifactDropped) + fila | unit toUnicode existe; falta end-to-end con el filtro de fallback.ts (SIN test hoy) |
| CLIP: texto movido fuera → append al final | existe en bake.test (asserts a mano) → migrar a golden | cubierto |
| Subrayados siguen al texto (move/remove/rewrite) | existe → golden; agregar caso REWRITE con underline (hoy solo move/remove/create) | parcial |
| Superíndice/list-marker ≠ línea | `superscript-api1.pdf`: rewrite de un segmento con superíndice → golden verifica que el cuerpo NO sale con la fuente chica (la defensa `dominant` de text.ts NO TIENE TEST) | **descubierto: sin test** |
| Imagen al fondo vs papel blanco JotForm | existe (imageZOrder) → golden con fixture JotForm real | cubierto sintético |
| pdf-lib lookup tira si falta la key | cubierto implícitamente (annots en página sin /Annots) → golden explícito `no-annots-page.pdf` | implícito |
| Object streams: hideHighlight sin fast-path | `hidden-highlights.pdf`: hide → golden verifica flag /F y NO duplicación | **sin test** |
| Espacios comprimidos por justificado / gap tokens | styledRuns.test (unit) — mantener | cubierto |
| Word/Quartz sin ToUnicode (WinAnsi/MacRoman) | `word-winansi.pdf`: rewrite → golden verifica que NO cae a fuente estándar (encoderForFont simple-encoding SIN test) | **sin test** |
| Multi-stream /Contents array | página con /Contents array → cualquier edit → golden | implícito |
| Flips de imagen (a/d negativos) | fixture con imagen espejada → move → golden de matriz | **sin test** |
| splice: inserción-antes-que-reemplazo | unit colocado `splice.test.ts` (Tier 1) | **sin test directo** |
| shapes matchRect nearest+tol | unit + golden banner move/remove | **sin NINGÚN test** |

Tier 1 colocados nuevos: `splice.test.ts`, `rawFill.test.ts` (equivalencia con los dos
parsers viejos ANTES de fusionar), `matrix.test.ts` (mul/invert round-trip),
`underline.test.ts` (emisión↔filtro consistentes — la invariante de la duplicación #1).

---

## 4. Riesgos del trasplante — qué NO tocar sin su test primero

1. **`tokenizer.ts`**: cualquier cambio DEBE mantener las dos defensas (hex-en-dict,
   progreso en delimitador huérfano) — tokenizer.test.ts las clava, correrlo SIEMPRE.
   El síntoma de regresión es un tab de Chrome muerto SIN consola (el peor tipo).
2. **`splice.rebuild`**: el invariante de orden NO tiene unit test — escribirlo ANTES de
   mover el archivo. La regresión (imagen "al fondo" siendo primer op) solo la agarra
   imageZOrder.test de rebote.
3. **La tríada de constantes del subrayado** (0.11/0.055/0.12/0.2 en text.ts y
   fallback.ts): están acopladas emisión↔filtro sin nada que lo haga cumplir. Fusionar
   en `underline.ts` con el test de consistencia ANTES de cualquier otro cambio en text.ts.
4. **`text.ts` `opForStyle`/`dominant`** (defensa del superíndice): SIN test. Un refactor
   "inofensivo" del god-method puede re-introducir "todo el grafo pequeñito". Escribir
   el fixture superscript primero.
5. **Los strings del report**: consumidos por UI (AgentPanel, warnings del editor) y
   tests con `.includes(...)`. NO traducir/re-frasear al introducir códigos — el
   formatter castellano debe emitir byte-idéntico hasta que TODOS los consumidores
   migren a codes (grep de cada string en apps/ y packages/ antes).
6. **`locate.matchOps` leftSlack ½em + Y_TOL 1.8**: números pagados con PDFs reales;
   moverlos de archivo sí, cambiarles el VALOR jamás sin un corpus de regresión.
7. **`fonts.encoderForFont` camino simple-encoding** (Word/Quartz) y el rechazo de
   `Differences`: sin test. Fixture word-winansi primero.
8. **`fallback.ts` filtro de control chars + retry ≤0xff**: sin test directo; es lo
   único entre un acento LibreOffice y una cajita con X en producción.
9. **`hideHighlightAnnotations`**: el comentario prohíbe re-introducir el fast-path por
   scan de bytes (object streams). Sin test — escribirlo antes de moverla de capa.
10. **Pureza del bundle browser**: core NO registra providers; fontkit solo se importa
    si un provider resuelve; `fonts-node` solo via subpath. El composition root v2 no
    puede romper esto — un `import` estático mal puesto mete node:fs en el editor.
    (El editor consume `@aldus/core/bake` por dynamic import en useLocalPreview.)
11. **API pública npm** (`aldus-pdf` publicado): `bakeSegmentEdits`, `walkTextOps`,
    los tipos del barrel — deprecar con shims, no borrar en caliente.
12. **`bake.ts` orden annots→stream**: widgets/highlights/links ANTES del loop de
    páginas (no tocan /Contents). El orden de bind de los appliers debe preservarlo
    y documentarlo en el JSDoc del token.
