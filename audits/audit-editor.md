# Auditoría art-of-code — `apps/editor` + `packages/ui` (Aldus)

Auditor: framework **art-of-code** (destilado de vscode-js-debug: layering, Symbol+interface DI,
multi-binding registries, services vs entities, IDisposable/EventEmitter propios, errores
estructurados, golden-text testing). Leídos SKILL.md, PATTERNS.md, APPLYING.md, `example/src`
y **todos** los archivos de `apps/editor/src` (los grandes completos).

---

## 0. `packages/ui` — el misterio, resuelto

**MUERTO. Ni siquiera nació.**

- Contenido real: `packages/ui/src/` — un directorio **vacío** (0 archivos). Sin `package.json`,
  sin tsconfig, sin nada.
- **No está trackeado en git** (`git ls-files packages/ui` → vacío; sin historia de commits).
- Nadie lo importa: cero referencias a `@aldus/ui` o `packages/ui` en todo el repo.
- El único "riesgo" es cosmético: `pnpm-workspace.yaml` globa `packages/*`, así que un día
  alguien le pone un package.json y entra al workspace sin querer.

**Veredicto: MATAR** — `rm -rf packages/ui`. Es un esqueleto de una intención vieja
(probablemente "extraer las primitivas UI") que nunca se ejecutó. La intención en sí es válida
(ver §3.4), pero se cumple distinto.

---

## 1. Inventario real

### 1.1 El doble rol librería vs app de ejemplo

| Pieza | Rol |
|---|---|
| `src/lib.ts` (26) | Entry de la LIB `aldus-editor` (npm): exporta `EditorScreen as AldusEditor`, `HostBox`, `configureAldusApi`/`aldusApi`. Bien documentado por qué NO exporta EditorRoute (tree-shaking de react-router). |
| `vite.lib.config.ts` | Build de lib → `dist-lib`, ES only, `inlineDynamicImports: true` (fix real: los chunks lazy de `@aldus/core/bake` se rompían al re-bundlear en el host). Externals: react, react-dom, pdfjs-dist, react-router-dom. |
| `src/styles-lib.css` (40) | CSS de lib SIN preflight; mini-reset scopeado `.aldus-editor` dentro de `@layer base`; utilities SIN layer a propósito (guerra de especificidad contra resets no-layered del host — comentario de sangre). |
| `src/main.tsx` (33), `pages/EditorRoute.tsx` (24), `pages/HomePage.tsx` (76) | SOLO app de ejemplo (router, upload, basename/HashRouter). |

**¿Cuánto se mezclan?** Sorprendentemente poco en la superficie: la frontera app/lib está bien
cortada (EditorRoute en módulo propio, lib.ts curado, dos CSS). Donde SÍ se mezclan es más
sutil:

1. **Todo lo demás viaja en la lib** — Inspector, AgentPanel, debug/capture, dialogs,
   Markdown… El "editor como componente" arrastra el chat CASPER, el modo forense y el
   markdown renderer aunque el host ponga `agent={false}`. No hay capa "editor-core" vs
   "editor-app-features".
2. **Estado global de módulo como API de configuración**: `configureAldusApi` muta un `let API`
   a nivel módulo (`lib/api.ts`), `capture.ts` calcula SU propia `API` desde `BASE_URL`
   (¡ignora `configureAldusApi`! → el 🐞 forense apunta mal en un host embebido — bug latente).
   `fontRegistry` y `sampleColor` tienen caches/Sets globales de módulo con funciones
   `clear*Cache()` que EditorPage debe acordarse de llamar por documento.
3. **`package.json` de la lib declara TODO en `devDependencies`** (react, pdfjs, lucide,
   @aldus/core) y peers aparte — funciona porque el bundle inlinea, pero es opaco.

### 1.2 `pages/` + `pages/editor/` — los hooks (la lógica de negocio escondida)

| Archivo | LOC | Qué hace | Lógica de negocio escondida |
|---|---|---|---|
| `EditorPage.tsx` | 636 | Composition root: monta los 7 hooks, top bar, rail, panel derecho con tabs del host, modales. `AldusEditorProps` = la API pública (docId, hostBoxes, hostTools, panelTabs…). | `registerServerOp` (undo=revert de revisión server), `bake()` con `promoteMovedImages`, `docOp` (dispatch string→acción con caso especial highlight/unhighlight), derivación de `phantomSegments`, filtrado por página de 7 colecciones (7 useMemo). Es "solo composición" según su docstring, pero contiene ~120 líneas de orquestación de dominio. |
| `editor/usePendingEdits.ts` | 233 | **EL LEDGER**: 7 maps de ediciones pendientes (seg/image/widget/shape/highlightEdit/linkEdit) + `pendingHighlights[]` + `segCache` (fantasmas) + `snapNow/restoreSnap` (Memento) + `syncHighlightEdits` (glue SIN historial) + `applyAgentEdits` + `findSeg` + `clearAll`. | **Todo es dominio, nada es React.** Los 7 `useState` + 7 refs espejo (`editsRef.current = edits` a mano, x7) son puro ruido de adaptación. Conceptualmente duplica el rol de `EditSession` del agente (packages/agent/session.ts): dos acumuladores de edits con vidas separadas — el de la UI (maps + Aplicar→/bake) y el del agente (session.bake()). No comparten ni la interfaz. |
| `editor/useHistory.ts` | 99 | Memento+Command unificado: pilas de `{kind:'snap'}` y `{kind:'command'}` intercaladas, límite 100, `setTick` para re-render. | Memento a mano, correcto y chico. Lo ÚNICO React es `setTick` — el 95% es una clase `History<S>` pura lista para extraer. |
| `editor/useLocalPreview.ts` | 141 | WYSIWYG: fetch bytes base, precalienta el chunk del bake, `bakePending()` (bake EN EL BROWSER con extirpaciones + extraRemoval para el lift), `resolveHighlights()`, effect que re-hornea y crea/destruye `PDFDocumentProxy`. | Pipeline de preview completo = un servicio. El invariante "el effect NO puede depender de graph" (loop de re-render) está defendido solo por comentarios ⚠️ y `eslint-disable`. La identidad estable de `resolveHighlights`/`bakePending` es artesanía de refs. |
| `editor/useLift.ts` | 102 | La máquina de estados del LIFT (pre-hornear la página sin el nodo seleccionado; drop commiteado vs no-op; `dropPendingRef`; `onPreviewLanded`). | "El código más sutil del editor" (dixit su docstring). Estados implícitos repartidos en 1 state + 2 refs + 3 callbacks; las transiciones viven en comentarios. Candidato número 1 a "freeze state on transitions" + máquina explícita. |
| `editor/usePlacement.ts` | 112 | Paleta→crosshair→click crea nodo vía API; estilo dominante de página (mediana de tamaño + bucket modal); `matchInsertedText` (match por posición del texto recién insertado para darle área y seleccionarlo). | El "matching por posición contra el grafo que aterriza" es lógica de dominio disfrazada; `pageTextStyle` (mediana/bucket) pertenece a core o a un servicio. |
| `editor/useLocks.ts` | 53 | Locks por nodo + auto-lock de imágenes ≥80% página; persiste en localStorage (2 claves por doc). | Regla de negocio (auto-lock full-page, seed una-vez) + persistencia mezcladas. |
| `editor/useAreaWidths.ts` | 24 | Área tipeable por segmento (pt), persistida en localStorage. | Fino, OK. |
| `editor/useEditorHotkeys.ts` | 92 | Teclado global: Esc, undo/redo, Delete (cascada if por 5 tipos de nodo), flechas=nudge con clamp. | La cascada Delete/nudge duplica el "dispatch por tipo de nodo" que NodeOverlay ya tiene 4 veces (ver §1.3). |

### 1.3 `editor/` + `editor/overlay/`

| Archivo | LOC | Qué hace | Notas |
|---|---|---|---|
| `PdfCanvas.tsx` | 278 | Render HiDPI a back-buffer, DOUBLE BUFFER + blit del lift, snapshot jpeg, `extractPageGraph`, registerPageFonts, sampleRunColors, extractImagePixels, y pasa ~34 props al NodeOverlay. | El double-buffer/lift-blit es OTRA media máquina de estados (liftShownRef/liftHoldRef/draggingRef) acoplada a la de useLift por convención. El orden grafo-antes-que-snapshot es un invariante en comentario. |
| `overlay/NodeOverlay.tsx` | 517 | Raíz de composición del overlay: dibuja los boxes por tipo, marquee/multi-selección, GLUE de highlights guardados (asociación por solape geométrico + sync de /Rect en un useEffect), `selectNode` con force-blur. | Contiene **4 cascadas if-por-tipo-de-nodo**: `nodeCssRect`, `moveGroup`, el `test` del marquee, y el delete del GroupBox — más la 5.ª en useEditorHotkeys. Cada tipo nuevo de nodo = tocar 5 switches. ESTE es el switch→registry de manual (APPLYING §3). |
| `overlay/TextEditLayer.tsx` | 633 | EL editor de texto: singleton imperativo (un `<textarea>` + backdrop de spans + Lbl colgante), open() por handle, diff de runs por input, Enter=lista/renumerar, B/I/U/color/align/list vía `SELECTION_STYLE_EVENT`, commit en blur. | El archivo más grande. Exporta **`let liveEditRuns` / `let liveMarkerKind` mutables a nivel módulo** que FloatingBar lee — acople oculto por estado global. El bus de estilos es un `CustomEvent` de `window` sin tipo en runtime. El diseño singleton en sí es CORRECTO (inmunidad al churn de grafos) — lo incorrecto es el transporte. |
| `overlay/SegmentBox.tsx` | 247 | Box del segmento: drag (via useDragGesture), grip (useGripResize), fantasma/masked/moved, capas hijas de highlights pendientes y guardados. | El "casi-INodeBox" arquetípico. |
| `overlay/ImageBox.tsx` | 177 | Ídem imagen + ghost con cleanPixels/snapshot congelado + sticker persistente de movidas. | Mismo patrón. |
| `overlay/WidgetBox.tsx` | 125, `HighlightBox` 72, `LinkBox` 70, `ShapeBox` 97, `GroupBox` 41 | Un box por tipo de nodo, todos con la misma firma moral: `{node, edit, scale, pageHeight, selected, locked, onSelect, onPatch(merge*Edit)}`. | **El patrón INodeBox ya existe de facto — solo falta nombrarlo.** |
| `overlay/FloatingBar.tsx` | 264 | Toolbar del segmento: B/I/U, lista (5 tipos, marcador colgante con corrimiento de ancla x), familia, tamaño, color, align, highlight toggle/recolor, link, delete. | Lee `activeEditingBox()` (DOM global) + `liveEditRuns` (módulo global) para decidir si el estilo va a la selección o al modelo. Lógica de dominio (medir marcadores, delta de ancla) adentro de un componente. |
| `overlay/ObjectBar.tsx` 33, `toolbar.tsx` 39 | Barra de imagen/campo; FbBtn/FbSep/FloatingWrap (portal al dock del header, `FB_DOCK_ID`). | OK. El portal-por-id-de-DOM es un contrato implícito con EditorPage. |
| `overlay/useDragGesture.ts` 98, `useGripResize.ts` 64 | Los DOS gestos extraídos y documentados (umbral 3px click-vs-drag; grip sin umbral). | **Excelente**: es exactamente "formalizar el patrón repetido". |
| `overlay/helpers.ts` 62, `types.ts` 51 | log gateado, dbgStyles, containerStyle, clampX/Y (con el porqué del clamp de bbox entero); tipos EditAction/OverlayHighlight/SavedHighlight. | OK. |
| `NodeOverlay.tsx` (viejo) | 6 | Shim re-export; lo usan PdfCanvas e Inspector. | Matar tras actualizar 2 imports. |
| `styledDom.ts` | 460 | Puente modelo↔DOM: esc/NBSP, measureWidth (canvas), fitLetterSpacing, family/stableFontFamily, styledSpanStyle, applyAlign, runsToHtml, originalLayoutHtml (gaps exactos, runLines), serializeStyled (DOM→runs con filtro de color heredado), flatOffsets/restoreSelection, applySelectionStyle/Color, activeEditingBox, SELECTION_STYLE_EVENT. | **Sin React, testeado en jsdom (styledDom.test.ts, 150 LOC).** Verificado: cero imports de react; deps = @aldus/core + fontRegistry. Ver veredicto §2. |
| `Inspector.tsx` | 501 | Panel de propiedades + esquema de página: 5 sub-paneles (Text/Image/Highlight/Link/Widget Props) todos con el mismo esqueleto `commit(patch) = merge*Edit ?? revert`. | El esquema (outline) y los sub-paneles son otro "por tipo de nodo" duplicado — 6.ª instancia del dispatch. |
| `AgentPanel.tsx` | 310 | Chat CASPER: NDJSON stream, partes cronológicas chat/editor, agrupado en bloques, sugerencias, aviso de 5s. | Autocontenido, protocolo bien tipado en api.ts. |
| `PdfCanvas/fontRegistry.ts` | 55 | FontFace embebidas re-registradas bajo `aldus-<psname>` estables (sobreviven al destroy del doc). | Set global de módulo, sin dispose; documentado con la historia del bug. |
| `sampleColor.ts` 98, `imagePixels.ts` 105 | Muestreo de color por píxeles (cache global por clave posicional; exclusión de widgets; núcleo de inkiness promediado) y píxeles limpios por imagen. | **Muta `run.color` in place sobre el grafo** — mutación silenciosa de la "fuente de verdad" extraída. Cache global + `clearColorCache()` manual. |
| `Markdown.tsx` | 249 | Markdown sin deps, render a React (sin innerHTML), reveal por rAF. | OK. |
| `debug/capture.ts` 89, `renderProbe.ts` 70 | Modo forense 🐞 (bundle a /tmp + handoff al clipboard); probes de render. | `capture.ts` calcula su API base propia — no respeta `configureAldusApi` (bug latente en hosts). |
| `lib/api.ts` | 162 | Cliente del wire: documents/revert/fields/ops/images/agentStream(NDJSON)/bake. | `saveEdits`/`loadEdits` **sin ningún usuario en el editor** → API muerta o solo-host; verificar y matar. |
| `lib/ndjson.ts` 31 (+test 38) | Lector NDJSON puro, testeado. | Modelo de cómo debe verse todo `common/`. |
| `ui/primitives.tsx` 197, `ui/dialogs.tsx` 87 | Design system chico (Button/Input/Modal/Toast…) y 3 modales. | Esto es lo que `packages/ui` quería ser. |

---

## 2. Veredicto por archivo

**COPY** (van a v2 tal cual, quizá con `git mv`):
- `styledDom.ts` + `styledDom.test.ts` — **CONFIRMADO candidato COPY**: cero React, puro
  DOM+modelo, testeado en jsdom, docstrings con invariantes ("el estilo pasa SIEMPRE por el
  modelo, nunca execCommand"). Dos asteriscos menores para la mudanza: (a) importa
  `stableFontFamily` de fontRegistry (estado global) — inyectar o re-exportar junto; (b)
  `measureCtx` singleton de módulo — aceptable, ya degradado limpio en jsdom (→0).
- `lib/ndjson.ts` + test — common/ de manual.
- `overlay/useDragGesture.ts`, `overlay/useGripResize.ts` — patrones ya extraídos y documentados.
- `overlay/helpers.ts` (clampX/Y + containerStyle), `overlay/types.ts`.
- `ui/primitives.tsx`, `ui/dialogs.tsx`, `Markdown.tsx`.
- `fontRegistry.ts` — COPY, con ajuste opcional: envolverlo en un servicio IDisposable (hoy el
  Set vive para siempre; inofensivo, pero el framework pide lifecycle explícito).
- `imagePixels.ts`, `debug/renderProbe.ts`.
- `main.tsx`, `EditorRoute.tsx`, `HomePage.tsx`, `vite.lib.config.ts`, `styles-lib.css` — la
  frontera app/lib ya está bien.

**COPY-CON-AJUSTES**:
- `sampleColor.ts` — el algoritmo es bueno y pagado con sangre (widgets, inkiness, croma);
  ajustar: cache como servicio inyectado (no global+clear manual) y devolver un
  `Map<runKey,color>` en vez de mutar `run.color` sobre el grafo.
- `lib/api.ts` — de `let API` global → `class AldusApi` (o factory) que la composición root
  construye; matar `saveEdits/loadEdits` si el grep del host confirma que nadie los usa;
  `capture.ts` debe recibir la MISMA instancia (fix del bug de API base en hosts).
- `debug/capture.ts` — solo el fix de API base.
- Los boxes (`SegmentBox`, `ImageBox`, `WidgetBox`, `HighlightBox`, `LinkBox`, `ShapeBox`,
  `GroupBox`, `HostBoxLayer`) — el código interno queda; se les da el contrato `INodeBox`
  (ver §3.3) y dejan de recibir el ledger por prop-drilling.
- `FloatingBar.tsx` / `ObjectBar.tsx` / `toolbar.tsx` — quedan, pero el canal
  window-CustomEvent + `liveEditRuns` global se reemplaza por el emitter del servicio de
  edición (§3.2). La lógica de medición de marcadores/ancla baja a core o a un helper puro.
- `Inspector.tsx`, `AgentPanel.tsx`, `PdfCanvas.tsx` — presentación válida; adelgazar props
  (suscripción al ledger) y en PdfCanvas extraer la lógica de blit/lift-hold a un
  `CanvasPresenter` no-React (es la mitad de una máquina de estados cuya otra mitad es useLift).
- `useEditorHotkeys.ts`, `usePlacement.ts`, `useLocks.ts`, `useAreaWidths.ts` — se vuelven
  adaptadores finos sobre servicios (hotkeys → registry de comandos por tipo de nodo;
  placement/locks/areas → servicios con persistencia inyectada).

**REESCRIBIR** (misma semántica, otra estructura — acá vive el refacto):
- `usePendingEdits.ts` → **EditLedger** (servicio framework-agnostic, §3.1). El contenido se
  conserva casi línea a línea; muere el andamiaje (7 useState + 7 refs espejo + useCallback×12).
- `useHistory.ts` → clase `History<S>` pura dentro del ledger (95% ya lo es).
- `useLocalPreview.ts` → **PreviewService** suscripto al ledger (§3.2) — el invariante del
  loop de re-render desaparece estructuralmente.
- `useLift.ts` (+ la mitad de PdfCanvas) → **LiftService** con máquina de estados explícita
  (`idle → prepared → dragging → dropPending → landed`), eventos en vez de refs compartidas.
- `overlay/NodeOverlay.tsx` → registry `INodeKind` que mata las 4 cascadas internas (+ la de
  hotkeys y el outline del Inspector).
- `overlay/TextEditLayer.tsx` → **TextEditController** (clase imperativa, sin React) montada
  sobre un div host; expone `open/close/isOpen` + `onSession`/`onStyleState` (EventEmitter
  propio) en vez de `let` exportadas + window events. El textarea+backdrop+Lbl y todo el
  algoritmo (splitAtChar, renumberLines, fit, Lbl/LBody) se conservan — es de lo mejor del
  editor.
- `EditorPage.tsx` → composición real: construye los servicios (composition root estilo
  `ioc.ts` del ejemplo), los hooks se reducen a `useLedger(ledger)` etc.

**MATAR**:
- `packages/ui/` — directorio vacío, no trackeado. `rm -rf`.
- `src/editor/NodeOverlay.tsx` (shim de 6 líneas) — actualizar los 2 imports (PdfCanvas,
  Inspector) y borrar.
- `api.saveEdits` / `api.loadEdits` — sin usuarios en el editor (verificar host signwax antes).

---

## 3. Propuesta de refacto art-of-code

### 3.1 EditLedger — el servicio que ya está escrito (solo hay que desnudarlo)

`usePendingEdits` ES un servicio con disfraz de hook. La reescritura es mecánica:

```ts
// packages/editor-core/src/editLedger.ts   (cero React, cero DOM)
export const IEditLedger = Symbol('IEditLedger');
export interface IEditLedger extends IDisposable {
  readonly state: LedgerState;                       // inmutable, se reemplaza entero
  readonly onDidChange: IEvent<LedgerChange>;        // EventEmitter propio (example/src/common/events.ts)
  apply(action: EditAction): void;                   // pushHistory + merge + fire
  sync(actions: HighlightEditAction[]): void;        // el glue SIN historial, HOY un caso especial — acá es API con JSDoc
  applyAgentEdits(...): void;  addHighlights(...): void;
  findSeg(id: string): SegmentNode | null;           // grafo → segCache (fantasmas)
  clearAll(): void;
  readonly history: { undo(); redo(); pushCommand(c); canUndo; canRedo };
  snapshot(): LedgerState;                           // ← el Memento, gratis (ver abajo)
}

interface LedgerState {           // exactamente el `Snap` de hoy, promovido a estado canónico
  edits: ReadonlyMap<string, SegmentEdit>;
  imageEdits: ...; widgetEdits: ...; shapeEdits: ...;
  highlightEdits: ...; linkEdits: ...;
  pendingHighlights: readonly PendingHighlight[];
}
```

- **Un solo objeto de estado inmutable** en vez de 7 `useState`: cada `apply` produce
  `{...state, edits: nextMap}` y dispara `onDidChange`. Los **7 refs espejo desaparecen**
  (eran el precio de leer estado fresco desde callbacks estables — con un servicio, `this.state`
  ES siempre fresco).
- **React solo SUSCRIBE**: `const state = useSyncExternalStore(ledger.onDidChange, () => ledger.state)`
  — el hook `useLedger` tiene ~10 líneas. Los `useMemo` de filtrado por página se vuelven
  selectores (`ledger.pageState(pageNum)` o memo local, da igual).
- **Servicios poseen colecciones, una por forma de query** (Commandment 5): el ledger es dueño
  de los 7 maps Y de `segCache`; `findSeg` (grafo→cache) deja de estar repartido entre
  usePendingEdits y useLocalPreview (hoy `resolveHighlights` re-implementa el mismo fallback
  con el comentario "Mismo fallback que findSeg" — duplicación admitida en un comentario).
- **Convergencia con `EditSession` del agente** (la duplicación señalada): no fusionarlos de
  una — viven en procesos distintos (browser vs node) — pero SÍ darles el mismo contrato de
  acumulación (`IEditAccumulator`: apply/state/toBakeArgs) en core. `EditorPage.bake()` y
  `EditSession.bake()` hoy serializan las mismas 7 colecciones hacia `bakeSegmentEdits` con
  código gemelo; `toBakeArgs()` en core = una sola fuente de verdad (misma jugada que ya se
  hizo con `promoteMovedImages`).

### 3.2 ¿El Memento sale gratis? — SÍ, y mejor que hoy

Hoy: `snapNow()` junta 7 refs en un `Snap`; `restoreSnap` hace 7 `setState`. Con el ledger,
**el snapshot ES el puntero al estado inmutable**: `snapshot() { return this.state; }` y
`restore(s) { this.state = s; fire(); }` — O(1), sin recolectar nada, sin el bug-class de
"me olvidé de agregar la colección nueva al Snap" (que YA pasó: `sh: s.sh ?? new Map()` en
restoreSnap delata que shapeEdits se agregó tarde y hay snapshots viejos sin él). `useHistory`
se vuelve `class History<S>` privada del ledger; las entradas `command` (ops de server con
undo=revert) quedan idénticas. El `setTick` muere: los botones undo/redo se suscriben a
`onDidChange` como todo lo demás.

### 3.3 INodeBox / INodeKind — el registry que mata 6 cascadas

Los boxes YA son el patrón (una firma moral común); lo que falta es el **contrato del lado de
datos**. La cascada `if (seg) … if (im) … if (w) … if (hl) … if (lk)` aparece en:
NodeOverlay×4 (nodeCssRect, moveGroup, marquee test, group delete), useEditorHotkeys (Delete +
nudge), Inspector (outline + panel por tipo). Multi-binding de manual (Commandment 4):

```ts
export const INodeKind = Symbol('INodeKind');
export interface INodeKind<N = AnyNode, E = AnyEdit> {
  /** Self-gating: null si el id no es de este tipo (no-op, nunca throw). */
  find(graph: PageGraph, id: string): N | null;
  effectiveRect(node: N, edit: E | null): Rect;
  move(node: N, edit: E | null, d: {dxPt: number; dyPt: number}): EditAction;   // vía merge*Edit
  remove(node: N, edit: E | null): EditAction | null;
  Box: FC<NodeBoxProps<N, E>>;          // el componente React del tipo
  inspector?: FC<...>; outline?: ...;   // opcional: Inspector se cuelga del mismo registry
}
export const nodeKinds: INodeKind[] = [segmentKind, imageKind, widgetKind, highlightKind, linkKind, shapeKind];
```

- `nodeCssRect(id)` = `first(nodeKinds, k => k.find(g,id))` → una función, no cinco copias.
- **Agregar un tipo de nodo** (p. ej. hacer editable ShapeNode-de-verdad, o anotaciones ink)
  = una clase + una línea de registro — hoy son ~7 archivos tocados. OCP cumplido.
- El GroupBox/marquee/hotkeys/Inspector consumen el registry; el orden del array = el z-order
  de render (los widgets al final, como hoy, con su comentario).

### 3.4 Librería vs app en v2 — layering explícito

```
packages/editor-core/        Layer 2 (browser, SIN React):
  common/    events.ts disposable.ts (copiados del example)      ← Layer 0
  ledger/    editLedger.ts history.ts
  preview/   previewService.ts liftService.ts   (suscriptos al ledger)
  text/      styledDom.ts textEditController.ts fontRegistry.ts sampleColor.ts
  api/       aldusApi.ts ndjson.ts              ← Layer 1 (I/O tonto)
packages/editor-react/  (lo publicado como `aldus-editor`)       ← Layer 3/4
  boxes/ (INodeKind registry + Box components) hooks/ (useLedger, adaptadores finos)
  AldusEditor.tsx (composition root: construye ledger+preview+lift+api, DisposableList,
                   dispose en unmount) Inspector/ AgentPanel/ ui/
apps/editor-demo/       HomePage, router, main — NUNCA se publica
```

- **PreviewService**: `ledger.onDidChange → debouncelessRebake → onPreviewReady(pdfDoc)`.
  El gotcha del loop de re-render (effect que depende de graph) **desaparece por
  construcción**: el servicio se suscribe UNA vez a UN evento; el grafo nuevo no re-crea
  suscripciones — no hay array de deps que envenenar. Ídem la coreografía
  useLift↔PdfCanvas: `LiftService.onLiftReady`/`onLanded` son eventos con nombre en vez de
  `liftHoldRef` compartido por convención.
- **TextEditController**: los `export let liveEditRuns/liveMarkerKind` se vuelven
  `controller.session` (getter) y `controller.onStyleStateChanged` (evento). FloatingBar se
  suscribe; el `window.dispatchEvent(SELECTION_STYLE_EVENT)` se vuelve
  `controller.applyStyle({key:'bold'})` — tipado, sin bus global, testeable en jsdom (el
  controller no tiene React).
- El AgentPanel/forense quedan en editor-react pero detrás de flags que el bundler puede
  cortar si algún día duele el peso.

### 3.5 Qué gotchas desaparecen ESTRUCTURALMENTE (y cuáles no)

| Gotcha (CLAUDE.md / código) | ¿Desaparece? | Por qué |
|---|---|---|
| `preventDefault` en pointerdown mata el blur → `selectNode` fuerza `activeEditingBox()?.blur()` | **Sí** | Con TextEditController, seleccionar otro nodo llama `controller.commitAndClose()` explícito — la coordinación deja de viajar por el focus del DOM. El blur nativo queda como red de seguridad, no como mecanismo. |
| TDZ: "callbacks: declarar ANTES de sus usuarios" | **Sí** | Los servicios se construyen en el composition root en orden de dependencia (constructor injection); no hay `useCallback` cuyo orden textual importe. |
| Loop de re-render del preview (effect no puede depender de graph; todo por refs) | **Sí** | Evento del ledger, no deps de effect (§3.4). Los 3 `eslint-disable-line react-hooks/exhaustive-deps` de esa zona mueren. |
| 7 refs espejo `xRef.current = x` | **Sí** | El servicio es su propia fuente fresca. |
| `syncHighlightEdits` SIN pushHistory (piggyback del snapshot) | **Parcial** | El invariante no desaparece (es semántico: un Ctrl+Z = texto+highlight juntos), pero pasa de "convención entre 3 archivos" a **método con JSDoc en el contrato** (`sync()` documentado como no-historial) + el glue geométrico sale del `useEffect` de NodeOverlay (que hoy corre en cada render con deps deshabilitadas) a una reacción del ledger a sus propios cambios de segmento. |
| Snap sin la colección nueva (`s.sh ?? new Map()`) | **Sí** | Snapshot = puntero al estado entero (§3.2). |
| pdf.js TRANSFIERE buffers → `.slice()` | No | Es del dominio pdf.js; queda encapsulado en PreviewService (un solo lugar en vez de 3: useLocalPreview×2 + useLift). |
| `clearColorCache/clearImagePixelCache` manual por doc | **Sí** | Caches con lifetime del servicio-por-documento; `dispose()` los limpia (disposal wired into DI). |
| capture.ts ignora `configureAldusApi` | **Sí** | Api inyectada, una sola instancia. |
| FontFace huérfanas / registry global eterno | Parcial | Servicio disposable por sesión; el nombre estable sigue siendo necesario. |

### 3.6 Errores y testing (Commandments 7 y 9)

- Hoy: `catch (e) … e instanceof Error ? e.message : 'No se pudo aplicar'` repetido ~8 veces
  en EditorPage/hooks. Un `errors.ts` chico (`createUserError('bake_failed', …)`) + UN catch
  site en la capa api (que ya casi existe: `ok<T>()`) y el Toast consume `{format, showUser}`.
- Testing: styledDom ya tiene el modelo (jsdom + roundtrip). Con el ledger extraído, el
  historial/glue/agent-apply se testean SIN React (hoy son intesteable salvo montando todo).
  Golden-text natural: `ledger.apply(...)×N → snapshot serializado` contra `.txt` — cambios de
  semántica de merge se vuelven diffs revisables. El LiftService con máquina explícita se
  testea por transiciones.

### 3.7 Orden de ejecución sugerido (cada paso deja verde)

1. `rm -rf packages/ui`; matar el shim NodeOverlay + `saveEdits/loadEdits` (tras grep en host).
2. Copiar `common/` (events/disposable) del example a un `editor-core` embrionario.
3. Extraer `History<S>` y `EditLedger` (usePendingEdits→adaptador de 10 líneas). Sin tocar UI.
4. `INodeKind` registry; colapsar las 6 cascadas.
5. PreviewService + LiftService (+ CanvasPresenter); borrar los eslint-disable de deps.
6. TextEditController: matar `liveEditRuns`/window-events; FloatingBar suscripta.
7. Api como clase inyectada; fix capture.ts; errors.ts.
8. Split de paquetes editor-core/editor-react solo al final (git mv), cuando los imports ya
   fluyen en una dirección.

---

## 4. Riesgos — lo frágil y pagado con sangre (tocar con guantes)

1. **TextEditLayer (633)** — la mayor concentración de sutileza: backdrop transparente con
   caret alineado por text-shadow-bold (no cambia ancho), fit ws/ls que se APAGA al primer
   cambio de texto ("lo que ves tipeando = lo que se guarda"), Lbl colgante con corrimiento de
   ancla en pt consolidado al commit, renumerado horneado (no markdown), Enter-en-ítem-vacío =
   cerrar lista. Riesgo del refacto: es imperativo Y global-dependiente; migrarlo a controller
   requiere conservar el singleton-siempre-montado (la razón de ser: caret indestructible ante
   el churn de previews). NO reescribir el algoritmo; solo el transporte de eventos.
2. **La coreografía lift/preview/canvas** (useLift + PdfCanvas + useLocalPreview): 3 archivos,
   1 máquina de estados, transiciones en comentarios (`dropPendingRef`, `liftHoldRef`,
   `liftShownRef`, "el grafo nuevo = el preview aterrizó"). Cada bug histórico (ghost vacío,
   imagen esfumada, lift competidor tras drop, duplicado sobre imágenes) está parchado con un
   guard puntual + comentario. Es la zona con más regresiones potenciales; máxima ganancia de
   la máquina explícita, máximo riesgo de romper un guard cuyo síntoma solo se ve arrastrando.
3. **El GLUE de highlights guardados** (NodeOverlay): asociación por solape geométrico >30%
   del área, sync de /Rect en un useEffect con deps deshabilitadas que corre en CADA render y
   depende de idempotencia (guarda de igualdad round1) para no loopear. Sin pushHistory por
   diseño. Frágil ante cualquier cambio en round1/geometría efectiva.
4. **sampleColor muta el grafo** (`run.color = hex`) y useLocalPreview TAMBIÉN muta segCache
   (`s.runs.forEach(run => run.color = hex)` con el color exacto del bake). Dos escritores
   sobre los mismos nodos con prioridades implícitas (bake exacto pisa muestreo). Si el ledger
   promueve inmutabilidad, esta zona necesita diseño explícito (colores como capa aparte).
5. **fontRegistry + fantasmas**: la cadena loadedName→stable→bucket-fallback con
   `document.fonts.check` en caliente (fitLetterSpacing decide "sin ajuste" si la fuente no
   vive — hornear tracking con la fuente equivocada DEFORMA). El `setFontsTick` de NodeOverlay
   (re-render en `fonts.loadingdone`) es parte del contrato. Mover archivos sí; cambiar
   semántica no.
6. **Orden DOM = orden de hit-testing** (widgets al final "como en el PDF") y **portal por id
   `FB_DOCK_ID`** — contratos implícitos entre NodeOverlay/EditorPage/toolbar que un registry
   debe preservar como orden de registro documentado.
7. **styles-lib.css**: la guerra de capas (utilities sin layer vs reset del host) es un
   equilibrio probado en signwax; cualquier upgrade de Tailwind debe re-verificarlo en host.
8. **`inlineDynamicImports`** en la lib: existe por un bug real de re-bundleo en el host; un
   futuro "optimicemos con chunks" lo re-introduce.
9. **Strings de bake `applied`/`warnings` son API de facto** (el Toast los muestra, tests los
   consumen) — el refacto de errores estructurados NO debe reformularlos.

---

### Cierre

El editor está **mucho mejor de lo que su forma sugiere**: los patrones del framework ya
existen sin nombre (Command en merge*Edit, Memento en Snap, Strategy embrionaria en los boxes,
gestos extraídos, frontera lib/app cortada). El problema no es el código — es que el estado y
los eventos viajan por los canales de React (deps, refs espejo, window events, module-let) en
vez de por un servicio con emitter propio. La reescritura propuesta es en un 80% *mover* código
que ya funciona a clases sin React, y en un 20% matar duplicación (6 cascadas por tipo de nodo,
2 acumuladores de edits, 3 `.slice()` de pdf.js). `packages/ui` se borra hoy mismo.
