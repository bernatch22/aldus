# Auditoría art-of-code — dominio MODELO + EXTRACCIÓN de `@aldus/core`

Alcance: `/Users/berna/aldus/packages/core/src/{model,extractGraph,tokens,coords,locateText,edits,log,index}.ts`,
tests en `/Users/berna/aldus/packages/core/test/`, `package.json`. Marco: skill `art-of-code`
(Ten Commandments, PATTERNS.md §5 services-vs-entities, APPLYING.md pasos 0–8, `example/src`).

---

## 1. Inventario real

| Archivo | LOC | Qué hace | Consumidores externos (archivos) |
|---|---|---|---|
| `model.ts` | 354 | TODOS los tipos: FontInfo, TextRunNode, SegmentNode, LineNode, ImageNode, WidgetNode, LinkNode, HighlightNode, ShapeNode, PageGraph, StyledRun + los 7 tipos `*Edit` + `FIELD_DEFAULT_SIZE` | bake (10 archivos, importan SOLO `../model`), agent (serialize, session, graph…), editor (overlay/*, hooks) |
| `extractGraph.ts` | 507 | pdf.js → PageGraph: runs desde textContent, líneas por baseline, segmentos por gap, `mergeBlockSegments`, imágenes por CTM-walk del operator list, widgets/links/highlights desde /Annots, rects vectoriales → `run.underline` + shapes | `extractPageGraph`: editor `PdfCanvas.tsx` + agent `graph.ts`. `groupIntoLines` exportado, **0 consumidores externos** |
| `tokens.ts` | 89 | umbrales de gap (`classifyGap`: column >2×max(charW); space >0.5×avg ∨ >0.12×fs) + `splitSegments` + `segmentText` | `classifyGap`: `edits.ts` (interno) + editor `styledDom.ts`. `segmentText`: agent `session.ts`. `splitSegments`/`avgCharWidth`: **solo interno** |
| `coords.ts` | 32 | `pdfRectToCss` / `cssPointToPdf` — LA conversión PDF↔CSS | editor: 8 archivos (`pdfRectToCss`), 1 (`cssPointToPdf`). agent/server/bake: 0 (correcto — viven en puntos PDF) |
| `locateText.ts` | 71 | ancla por texto citado, normalizado NFD, prefer shortest/first, sub-rect por interpolación | agent (tools/session). Editor: 0 |
| `edits.ts` | 668 | `runLines` (0.55×fs), `originalStyledRuns`, `applyTextDiff` (LCS por carácter), TODO el motor de list-markers (regex Lbl, toggle, next, roman), `toggleStyleRange`/`setStyleRange`, `segmentOriginal`, y **6 pares mergeXEdit/effectiveXRect** casi idénticos (segment/image/shape/widget/highlight/link) + `promoteMovedImages` | El más consumido: editor 10+ archivos (TextEditLayer, FloatingBar, Inspector, usePendingEdits, styledDom, overlay/*), agent session.ts |
| `log.ts` | 49 | `createLogger` gateado + ring buffer de trace (800) para el modo forense | editor (4), agent (2), bake (varios) |
| `index.ts` | 35 | barrel: re-exporta todo | — |

### ¿`model.ts` es un god-file?
**No por LOC (354) pero sí por responsabilidad doble.** Contiene:
- **19 entidades/tipos** (7 nodos + 7 edits + StyledRun + FontInfo + PageGraph + LineNode + aliases).
- **1 pieza de lógica/config que no es tipo**: `FIELD_DEFAULT_SIZE` (dato de UI/creación, no de modelo).
- El resto es puro `interface`/`type` — aceptable como "protocol layer" (dumb). El problema no es
  model.ts en sí sino que **edits.ts es el god-file real**: 668 LOC con CUATRO dominios distintos
  (agrupado visual de runs, diff de texto estilado, list-markers, y el ledger merge/effective ×6 tipos).

### Duplicación y código muerto
1. **Duplicación estructural masiva en `edits.ts`**: `mergeImageEdit`/`mergeShapeEdit`/`mergeWidgetEdit`/
   `mergeHighlightEdit`/`mergeLinkEdit` son la MISMA función (clonar-o-crear con `original` snapshot,
   loop sobre KEYS, `null`→delete, noop→null) copiada 5 veces con distinta lista de keys, y
   `effectiveXRect` ×5 ídem (x/y/width/height/removed/moved). ~200 LOC que son un genérico
   `mergeRectEdit<K extends readonly string[]>(node, prev, patch, keys, originalOf)` + un
   `effectiveRect`. Solo `mergeSegmentEdit` tiene semántica propia (runs manda, revert por
   `styledRunsEqual`). Viola RULE 4.2 del usuario dentro del propio core.
2. **Acumulación de edits duplicada entre capas** (la señalada en el encargo): el patrón
   "Map<string, XEdit> + set/delete por revert + snapshot para undo + promote al bake" vive DOS veces:
   `apps/editor/src/pages/editor/usePendingEdits.ts` (7 maps + refs + Memento) y
   `packages/agent/src/session.ts` (`EditSession`: 5 maps privados + creates + fills). Las funciones
   merge* son compartidas (bien) pero el LEDGER (colecciones, revert, "qué está pendiente") no.
3. **Exports muertos o casi**: `groupIntoLines` (0 consumidores externos, interno a extractGraph),
   `splitSegments`, `avgCharWidth` (solo internos), `hasBulletMarker` (grep: solo editor 0/1 usos
   marginales). El barrel `index.ts` exporta 35+ símbolos sin curaduría.
4. **Doc-claim stale**: CLAUDE.md dice que `tokens.ts` es "SINGLE source of truth (extract + **bake**)"
   — el bake NO importa tokens.ts (grep: los 14 archivos de `src/bake/` solo importan `../model`).
   Los umbrales los comparten extracción + edits.ts + styledDom (editor) + segmentText (agent). El
   espíritu (una sola fuente) se cumple; la afirmación literal sobre el bake, no.
5. **`extractGraph.ts` sin tests directos**: ninguno de los 9 test files ejercita `extractPageGraph`,
   `mergeBlockSegments`, `extractVectorRects`, `applyVectorRects` ni `extractImages`. La cobertura de
   la EXTRACCIÓN es indirecta (bake.test.ts re-extrae) o inexistente (underline detection, shapes,
   IDs estables por objId, merge de bloques). Es el hueco de testing más grande del dominio.
6. **Comentario huérfano** en edits.ts:97-99: el docstring "Si el texto arranca con un marcador de
   LISTA…" está pegado ENCIMA de `applyTextDiff` pero describe `nextListMarker` (línea 303) — doc
   que miente por posición.

---

## 2. Veredicto por archivo: VERBATIM / AJUSTES / REESCRIBIR / MATAR

| Archivo | Veredicto | Detalle |
|---|---|---|
| `coords.ts` | **VERBATIM** | 32 LOC, puro, ley respetada (grep: nadie más hace `pageHeight - y`). Solo falta el test colocado `coords.test.ts` (Commandment 10) — hoy NO tiene ninguno. |
| `tokens.ts` | **VERBATIM** (+ mover) | Los umbrales y su justificación (pdfminer/PDFBox, el fix del "i)", el espacio comprimido 0.12×fs) son oro destilado de bugs reales. Va a `common/` o `graph/` con su test colocado (hoy protegido en styledRuns.test.ts — mover esos 3 describes al lado). Corregir el claim del header sobre el bake. |
| `log.ts` | **VERBATIM** | Ya es el patrón correcto (gateado + trace ring). En v2 va a `common/log.ts`. Único ajuste: exponer `clearTrace()` si el forense lo necesita por sesión. |
| `locateText.ts` | **COPY-CON-AJUSTES** | Lógica correcta y testeada (engineApi.test.ts). Ajustes: (a) hoy escanea `g.segments.filter(...)` lineal — en v2 consulta al PageGraphService (índice por texto normalizado, memoizado); (b) `normalize` es un helper puro → `common/text.ts` con test. |
| `model.ts` | **COPY-CON-AJUSTES** | Los tipos son el contrato público y están bien pensados (coords documentadas, overrides opcionales, `original` snapshot). Ajustes: (a) sacar `FIELD_DEFAULT_SIZE` a `create/`-side config; (b) partir en `model/nodes.ts` + `model/edits.ts` (los 7 `*Edit` son el vocabulario del ledger, no del grafo); (c) derivar los `*Edit` rect-like de un genérico `RectEdit<TOriginal>` para que el par merge/effective genérico tipee solo. |
| `extractGraph.ts` | **COPY-CON-AJUSTES** (split, no rewrite) | Las mates (CTM walk, hypot(c,d), sub-path decomposition) están verificadas contra PDFs reales — NO reescribir. Ajustes: partir en `extract/` por concern: `textRuns.ts`, `annotations.ts` (links/highlights/widgets comparten el mismo loop rect→node: hoy 3 funciones casi iguales), `images.ts`, `vectorRects.ts`, `blocks.ts` (mergeBlockSegments), `fonts.ts` (fontInfoFor+styleFromName). El orquestador `extractPageGraph` queda ~40 LOC. Y DARLE TESTS (hoy cero directos). |
| `edits.ts` | **REESCRIBIR (reorganizar)** | El contenido sobrevive casi entero pero repartido: `runLines`+`originalStyledRuns`+`styledRunsEqual`+`styledText` → `graph/segmentContent.ts` (es semántica de LECTURA del grafo, no de edición); `applyTextDiff`+`toggleStyleRange`+`setStyleRange`+`splitAt`+`mergeAdjacent`+`sameStyle` → `edit/styledRuns.ts`; TODO el bloque list-markers (regex, ListKind, toggle, next, markerBodyDx…) → `edit/listMarkers.ts` (dominio autocontenido, ~150 LOC, ya con test suite propia); los 6 merge* + effective* + promoteMovedImages → el **EditLedger** (§3), con los 5 rect-like colapsados al genérico. |
| `index.ts` | **REESCRIBIR** | Barrel curado por área (`graph`, `edit`, `common`), matando los exports sin consumidor (`groupIntoLines`, `splitSegments`, `avgCharWidth`, `hasBulletMarker`) o marcándolos `/** @internal */`. |
| `package.json` | **COPY-CON-AJUSTES** | Exports `.`/`./bake`/`./bake/fonts-node` correctos (bake subpath mantiene pdf-lib fuera del bundle browser; fonts-node mantiene el I/O fuera de core — Commandment 16 ya cumplido). Ajuste: apuntar a `dist/` cuando core se publique compilado; hoy `./src/index.ts` funciona solo dentro del monorepo. |
| Nada para **MATAR** entero | — | El código muerto es a nivel export, no archivo. |

**¿Se sostienen las leyes "single source of truth"?**
- `coords.ts`: SÍ, verificado (0 conversiones fuera; agent/server nunca lo importan porque viven en pts).
- `tokens.ts`: SÍ en la práctica (extract + edits + styledDom + segmentText pasan todos por `classifyGap`),
  pero el enunciado "extract + bake" de CLAUDE.md es literalmente falso — el bake localiza por
  geometría (`locate.ts`, ~1.8pt) y no clasifica gaps. Corregir el doc, no el código.

---

## 3. Propuesta de refacto art-of-code

### Layout v2 (Commandments 1, 5, 10)

```
packages/core/src/
  common/            Layer 0 — puro, cero deps hacia arriba, test colocado
    coords.ts (+test)         log.ts (+test)        text.ts (normalize, +test)
    events.ts  disposable.ts  objUtils.ts (once)    mapUsingProjection.ts
  model/             Layer 0.5 — solo tipos (protocol layer, dumb)
    nodes.ts (los 7 nodos + PageGraph + FontInfo + StyledRun)
    edits.ts (los 7 *Edit, con RectEdit<T> genérico)
  graph/             Layer 1 — extracción + lectura del grafo
    extract/ {textRuns,annotations,images,vectorRects,blocks,fonts}.ts
    pageGraphService.ts       segmentContent.ts (runLines, originalStyledRuns)
    tokens.ts                 locateText.ts
  edit/              Layer 2 — mutación acumulada
    editLedger.ts             styledRuns.ts (applyTextDiff, toggle/setStyleRange)
    listMarkers.ts
  bake/              Layer 3 — sin cambios en esta auditoría
```

### PageGraphService — el service dueño de las colecciones

Hoy `PageGraph` es un POJO y CADA consumidor hace su propio `pages.find` / `segments.find` /
`sort by baseline` (EditSession.seg/img/widget/hlNode son 4 loops O(n·pages) idénticos;
usePendingEdits.findSeg otro; locateText otro). El service (patrón SourceContainer):

```ts
export interface IPageGraphService {
  readonly onDidReplace: IEvent<PageGraph>;          // re-extract tras preview/bake
  page(n: number): PageGraph | undefined;
  byId(id: string): PdfNode | undefined;             // UN map global id→node (todos los kinds)
  segmentsAt(page: number, baseline: number, fontSize: number): SegmentNode[];
     // proyección: bucket = round(baseline / (0.55×fontSize)) — la MISMA tolerancia de runLines,
     // vía MapUsingProjection; chequea bucket±1 (la proyección discretiza un umbral continuo)
  byGeometry(page: number, rect: PdfRect, tolPt?: number): PdfNode[];
     // el índice que hoy el bake reconstruye ad-hoc en locate.ts (~1.8pt) y el editor en hit-testing
  byNormalizedText(needle: string): SegmentNode[];   // locateText consulta acá
  replace(page: PageGraph): void;                    // ÚNICO punto de mutación; reconstruye índices y fire
}
export const IPageGraphService = Symbol('IPageGraphService');
```
- **Factory de nodos**: la creación de ids (`p${n}-y${baseline}-x${x}`, objId de imágenes con
  contador `seen`) sale de extractGraph y entra al service/factory — el invariante "id estable por
  geometría, no por índice" (comentario de lineFromRuns) queda en UN lugar con su test.
- Los mapas se construyen UNA vez por `replace()`; `byId` mata los 6 loops lineales dispersos.

### Entidades con identidad readonly + `once()`

`SegmentNode` pasa de interface a clase creada SOLO por la factory:

```ts
export class Segment {
  constructor(readonly id: string, readonly page: number, readonly runs: readonly TextRun[],
              readonly x: number, readonly baseline: number, /*…*/) {}
  readonly lines = once(() => runLines(this));                 // hoy se recalcula en CADA render
  readonly styledRuns = once(() => originalStyledRuns(this));  // ídem (FloatingBar, Inspector,
                                                               // TextEditLayer, session lo llaman N veces)
  readonly text = once(() => this.lines().map(segmentText).join('\n'));
  readonly original = once(() => segmentOriginal(this));       // el snapshot del bake, congelado
}
```
Los nodos son inmutables (el grafo se REEMPLAZA en re-extract, nunca se muta) → memoizar es seguro.
Compat: la clase implementa la interface `SegmentNode` actual; los consumidores tipados no cambian.

### EditLedger — el service que mata la duplicación editor/agent

```ts
export interface IEditLedger {
  readonly onDidChange: IEvent<void>;
  patchSegment(id: string, patch: SegmentPatch): void;   // merge + null→revert adentro
  patchRect(kind: 'image'|'widget'|'highlight'|'link'|'shape', id: string, patch: RectPatch): void;
  revert(kind: NodeKind, id: string): void;
  effective(node: PdfNode): EffectiveGeometry;           // los 6 effectiveXRect, uno
  snapshot(): LedgerSnapshot;                            // Memento — useHistory lo consume
  restore(s: LedgerSnapshot): void;
  toBakeInput(): BakeInput;                              // aplica promoteMovedImages acá, único sitio
  clear(): void;
}
export const IEditLedger = Symbol('IEditLedger');
```
- Los merge* actuales se vuelven privados del ledger; los 5 rect-like colapsan al genérico
  `mergeRectEdit(node, prev, patch, keys, originalOf)`.
- **Editor**: `usePendingEdits` queda un shim de ~40 LOC — suscribe `onDidChange` →
  `useSyncExternalStore`; `useHistory` empuja `ledger.snapshot()`. Las 7 parejas useState+useRef
  desaparecen. `segCache` (fantasmas) también entra al ledger (`originalOf(id)`).
- **Agent**: `EditSession` inyecta el MISMO ledger + `IPageGraphService`; conserva solo lo suyo
  (reflow, creates queue, fills). La acumulación deja de existir dos veces.
- `promoteMovedImages` deja de ser una función que dos callers deben ACORDARSE de llamar
  (hoy la ley vive en un comentario "no la dupliques") y pasa a ser un paso interno de `toBakeInput()`.

### `common/` (Commandment 10)
`coords.ts`, `log.ts`, `normalize` (de locateText), `once`, `EventEmitter`+`IDisposable` (copiar de
`example/src/common/`), `MapUsingProjection` (para baseline/case-insensitive) — cada uno con
`*.test.ts` colocado. `tokens.ts` puede vivir en `graph/` (depende de TextRunNode) pero
`avgCharWidth`/los umbrales numéricos son candidatos a constantes documentadas en un solo objeto
`GAP_THRESHOLDS` exportado para los tests.

### Contratos Symbol+interface que emergen
- `IPageGraphService`, `IEditLedger` (arriba).
- `IGraphExtractor` — `{ canHandle(source): boolean; extract(page): Promise<Partial<PageGraph>> }`
  multi-bound: `TextRunExtractor`, `AnnotationExtractor`, `ImageExtractor`, `VectorRectExtractor`
  — el orquestador `extractPageGraph` hace `getAll()` y fusiona. Agregar "extraer tablas" = una
  clase + un bind (OCP), sin tocar el walker que ya anda.
- Composición: un `ioc.ts` de core es opcional (core es una lib); alcanza el container hand-rolled
  del example (~100 LOC) instanciado por doc-session en agent/server, y por editor-mount en el UI.
  Jerarquía: global (fontProviders, log) → por-documento (PageGraphService, EditLedger).

### Eventos y lifecycle (Commandment 6)
- `EventEmitter` propio (copiar `example/src/common/events.ts`): `onDidReplace` (PageGraphService)
  y `onDidChange` (EditLedger) reemplazan el patrón actual del editor de refs + "effect que NO debe
  depender de graph" (gotcha del re-render loop documentado en CLAUDE.md — con eventos + refs
  internas del service, ese gotcha muere de raíz).
- `IDisposable`: el editor-mount y la EditSession disponen su container → listeners fuera. El trace
  ring de log.ts se registra como disposable de sesión (hoy es global compartido entre docs).

---

## 4. Riesgos — invariantes sutiles que un rewrite ingenuo rompe

| # | Invariante | Dónde vive | Qué pasa si se rompe | Test que lo protege |
|---|---|---|---|---|
| 1 | **runLines 0.55×maxFontSize**: super/subíndice y marcador "a)" NO abren línea; solo caída ≥0.55×fs. maxFs sobre TODOS los runs del segmento (no por par). | `edits.ts:23-34` (comparten seg.text, originalStyledRuns, styledDom, session.ts) | El bake baja el texto una línea ("1 Una API" partido); bloques Word explotan | `test/styledRuns.test.ts` "runLines — super/subíndice NO abre línea" (2 casos, valores reales baseline 94.6/97.6). **Si el service proyecta baselines a buckets, DEBE chequear bucket±1 — este test lo atraparía solo si se agregan casos borde exactamente en el umbral: AGREGAR uno a 0.549 y 0.551×fs.** |
| 2 | **classifyGap con MAX (no avg) para columna**: un marcador corto ("i)", charW diminuto) no puede bajar el umbral. Y el escape 0.12×fontSize para espacios comprimidos por justificado. | `tokens.ts:27-48` | "i)" queda nodo suelto; "Siel número deRUC" (espacios comidos) | `styledRuns.test.ts` describe `classifyGap` (3 its con los valores reales del doc capturado: gap 7.9pt, w 6.4). Mover el test JUNTO a tokens.ts en v2. |
| 3 | **NBSP = `String.fromCharCode(0xa0)`**, jamás el carácter literal: los editores de archivos lo corrompen silenciosamente. Multi-espacios se siembran como NBSP en contentEditable (colapsa espacios normales) y se DES-siembran al serializar (`NBSP_RE → ' '`). | `apps/editor/src/editor/styledDom.ts:28-36,265` (frontera del dominio, pero cualquier v2 de originalStyledRuns/serialización lo hereda) | Espacios múltiples colapsan al editar; o NBSPs reales se hornean al PDF como 0xa0 | `apps/editor/src/editor/styledDom.test.ts` (jsdom roundtrip; línea 66 verifica `styledRunsEqual(runs, originalStyledRuns(seg))` — el contrato editor↔core). Un rewrite de `originalStyledRuns` DEBE correr también este test del editor, no solo los de core. |
| 4 | **Glyphs sin /ToUnicode → control chars U+0000–U+001F (U+0012)**: path B re-encodea IDENTIDAD (char 0x12 → byte 0x12, solo fuentes 1-byte); el fallback los FILTRA (custom → .notdef cajita X). El MODELO los transporta tal cual: cualquier "sanitización de texto" en extract/segmentContent los destruiría. | `bake/toUnicode.ts:100-106`, `bake/fallback.ts:72`; el dato viaja por TextRunNode.text | Acentos LibreOffice → cajitas X o throw en std fonts | `test/toUnicode.test.ts`. Riesgo v2: un `normalize()`/trim "inocente" en la factory de Segment. Regla: la ÚNICA normalización permitida en el grafo es la de locateText (copia local), nunca in-place. |
| 5 | **IDs por geometría, no por índice** (`p{n}-y{baseline}-x{x}`; imágenes por objId con contador `seen`). | `extractGraph.ts:222,241-248,487-491` | El preview local extirpa ops → con ids posicionales todos los ids corren y el mapa de ediciones apunta a nodos ajenos; mover imagen al frente cambia su índice | **NINGUNO hoy.** El hueco #1: escribir `test/extract.test.ts` (grafo sintético o PDF fixture) que asserte estabilidad de ids tras remover un nodo, ANTES de tocar la factory. |
| 6 | **mergeBlockSegments**: re-fusiona bloques del propio bake (1 seg/línea, misma x ±0.5, mismo fs ±0.1, leading 1.2×fs ±0.06×fs). Los números son la firma EXACTA de lo que emite el bake. | `extractGraph.ts:23-65` | Guardar un bloque multilínea lo desintegra en N segmentos | **NINGUNO directo.** Cambiar el leading del bake sin tocar esta firma (o viceversa) rompe el roundtrip — otra razón para extraer la constante compartida y testear el ciclo bake→extract (golden). |
| 7 | **merge*Edit null = revert / noop → null**: el caller BORRA la entrada. `runs` manda sobre `text`; `styledRunsEqual` contra `originalStyledRuns(seg)` decide el revert. | `edits.ts:403-439` | Edits fantasma que el bake intenta localizar; o reverts que no limpian | Indirecto vía `styledDom.test.ts:66` y `bake.test.ts`. El EditLedger v2 necesita test propio: patch→revert→snapshot vacío. |
| 8 | **promoteMovedImages en el bake-input, siempre**: imagen movida sin zOrder explícito → 'front' (si no, "se mueve y desaparece" tapada). | `edits.ts:477-482` + comentario-ley | Regresión visual silenciosa | `test/imageZOrder.test.ts`. En v2, dentro de `toBakeInput()` el test pasa a ser del ledger. |
| 9 | **`bytes.slice()` antes de getDocument/bake** (pdf.js TRANSFIERE el buffer al worker) y `embedded = !missingFile` (nunca `font.data`, pdf.js lo libera post-render). | gotchas CLAUDE.md; `extractGraph.ts:360-371` | Buffer detached crash; fuentes embebidas marcadas "no embebidas" → fallback erróneo | Ninguno unit-testeable fácil; documentar en el JSDoc del contrato (Commandment 10: la sutileza vive EN el doc de `IGraphExtractor`). |
| 10 | **Strings de applied/warnings del bake son API de facto** (UI + tests los consumen). No es de este dominio pero el ledger v2 los re-expone: no traducir/reformular. | `bake/report.ts` + CLAUDE.md | Tests y UI rompen en silencio | `bake.test.ts` (53 asserts). |

### Orden de refacto sugerido (APPLYING paso a paso, repo verde entre pasos)
1. Tests faltantes PRIMERO (extract ids estables, mergeBlockSegments, coords) — red de seguridad.
2. Colapsar los 5 merge/effective rect-like al genérico (cambio puro, tests existentes cubren).
3. Split de edits.ts en graph/segmentContent + edit/{styledRuns,listMarkers,ledger} (git mv + re-export desde index.ts para no romper consumidores).
4. EditLedger + adopción en EditSession (Node, más fácil de verificar) → después usePendingEdits.
5. PageGraphService + entidades memoizadas (último: toca editor y agent a la vez).
