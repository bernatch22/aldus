# Aldus — editor de PDF pixel-perfect (monorepo pnpm)

Editor de PDF que parsea el **grafo de contenido real** (operadores del content stream)
y lo edita **in situ** — nunca pinta blanco encima ni redibuja con fuentes aproximadas.
Nació como extracción/rewrite del editor de signwax (`~/signwax/packages/pdfkit`).
El agente LLM (CASPER: Claude Agent SDK + suscripción, streaming NDJSON) ya está
integrado; fase final pendiente: integración de vuelta en signwax (punto 5 del backlog).
Arquitectura estilo vscode-js-debug (skill global `art-of-code`): strategies, repository,
memento — ver `docs/architecture.md`. Docs públicos EN (`README.md`, `docs/`); LICENSE MIT.

## Descubrimiento — megabrain PRIMERO (repo ya indexado)

`megabrain ask "<pregunta>" --repo ~/aldus` antes de grep/Read. Queries que rinden:
- "How does the bake pipeline turn SegmentEdits into content stream splices?"
- "How does the editor preview pending image/widget/highlight edits locally in the browser?"
- "How does styledDom bridge StyledRun model and the contentEditable DOM?"
- "How are segments extracted and split from pdf.js text items (gaps, tokens)?"
- "How do FloatingBar style toggles route to the selection vs the whole segment?"
Si conocés el string exacto (label, clase css, endpoint) → grep directo gana.

## Estructura

```
packages/core    @aldus/core    modelo + extracción + BAKE (subpath ./bake trae pdf-lib)
  src/bake/                     bake.ts = ORQUESTADOR (~100 líneas); módulos: tokenizer,
                                textWalk, locate, splice, color, fonts, textEmit,
                                text (STRATEGIES A/B/C), images, widgets, fallback,
                                report (BakeReport), pageContent, createNodes, toUnicode
packages/agent   @aldus/agent   agente Claude Agent SDK + CLI `aldus` (config.ts =
                                knobs env; cli.ts one-shot/chat + --fields/--fill
                                (formularios determinístico, sin LLM); tools.ts =
                                PARIDAD con la UI: texto/imagen/highlight/link/
                                insertar/watermark/header-footer/campos/fill_field;
                                session.ts hornea ediciones + cola de creaciones +
                                fills post-bake). Formularios en core: bake/forms.ts
                                (readFormFields/setFieldValues) + WidgetNode.value
apps/editor      @aldus/editor  Vite+React+Tailwind v4+lucide (:5190, proxy /api→4100)
  src/pages/editor/             hooks de EditorPage: usePendingEdits+useHistory (Memento),
                                useLocalPreview, useLift, useLocks, useAreaWidths,
                                usePlacement, useEditorHotkeys
  src/editor/overlay/           NodeOverlay descompuesto: SegmentBox/ImageBox/WidgetBox/
                                GroupBox, FloatingBar/ObjectBar/toolbar, TextEditLayer
                                (singleton), useDragGesture/useGripResize; el path viejo
                                NodeOverlay.tsx es un re-export shim
apps/server      @aldus/server  Express+tsx (:4100) — index.ts = boot (banner MAGI,
                                localhost-only salvo ALDUS_ALLOW_REMOTE); routes/
                                {documents,bake,ops,agent}; store.ts = DocStore
                                (Repository, N revisiones .rev-<ts>.pdf, ALDUS_REVISIONS);
                                validate.ts (requireDoc)
```
Dev: `pnpm dev` (ambos). Tests: `pnpm -r test` (core: vitest ciclo REAL crear→extraer→
bake→re-extraer; editor: jsdom sobre styledDom + ndjson). Verificar SIEMPRE con build/test,
no tsc (vite no typechequea; los errores de tsc --noEmit que existen son pre-existentes y
conocidos). Debug logs SIEMPRE vía `createLogger('aldus:…')` de core, gateado por
ALDUS_DEBUG / localStorage.aldusDebug — jamás console.log crudo en paths de producción.
CI: `.github/workflows/ci.yml` (pnpm -r test + build del editor).

## El modelo (core/src/model.ts) — coordenadas: puntos PDF, origen abajo-izq, SIEMPRE

- Grafo por página (`PageGraph`): `TextRunNode` (átomo del stream: baseline exacta de la
  text matrix, fontSize=hypot(c,d), FontInfo con loadedName/PostScript/métricas/embedded,
  `color` muestreado del canvas) → `SegmentNode` (runs contiguos, LA unidad de edición,
  anclada a su x — modelo Acrobat: un gap de columna es FRONTERA entre segmentos, nunca
  whitespace) → `LineNode`. Además `ImageNode` (XObject×CTM bbox), `WidgetNode` (AcroForm:
  tipo/nombre/rect/options), `LinkNode`. Umbrales de gaps en `tokens.ts` (pdfminer: >2×
  charW = columna; >0.5× = espacio) — única fuente de verdad, extracción y bake la comparten.
- Ediciones = overrides acumulados vía `merge*Edit(node, prev, patch)` (null = noop →
  revert): `SegmentEdit` {text, runs?: StyledRun[] (estilo/color POR TRAMO: {text, bold,
  italic, color?, dx}), fontSize, font(bucket), x, baseline, remove, charSpacing(AV),
  hScale(T↔), color} + snapshot `original` (con runs {x,bold,italic} para que el bake mapee
  estilo→fuente). `ImageEdit` (+zOrder front/back), `WidgetEdit`. Geometría efectiva:
  `effectiveGeometry/effectiveImageRect/effectiveWidgetRect`. Rangos de estilo:
  `toggleStyleRange`/`setStyleRange` (puros). Listas: `nextListMarker` (Enter continúa).
- Conversión PDF↔CSS SOLO en `coords.ts` (`pdfRectToCss`/`cssPointToPdf`).

## El bake (core/src/bake/) — la joya

`tokenizer.ts` (content stream completo con offsets de bytes) → `textWalk.ts` (máquina
ISO 32000 §9.4: Tm/Td/TD/T*/TL/Tf/q/Q/cm + fill color + Do de XObjects; shows encadenados
sin reposicionar = `stale` → el bake NO los toca, warning honesto) → `bake.ts` (orquestador;
los detalles viven en módulos por responsabilidad — ver Estructura):
- `locate.ts`: localiza ops por GEOMETRÍA (original snapshot, tolerancia ~1.8pt) — nunca
  por índice. Resultados en `report.ts` (BakeReport: applied/warnings/colors — Builder).
- `splice.ts`: reemplazo IN-PLACE (`Splice {start,end,text}`) = z-order intacto. La matriz
  emitida es RELATIVA al CTM del punto (`M_rel = M_abs × inv(ctm)` — invert() en textWalk).
- Texto en `text.ts` como **STRATEGIES** (`ITextEmitStrategy` {canHandle, emit}, probing
  first-to-claim, catch-all al final — agregar un path = una clase + una entrada en
  `textEmitStrategies`, NUNCA editar una hermana): (A) `VerbatimReemit` — mover/escalar/
  reestilar → re-emite VERBATIM (bytes/kerning/color intactos, Tc/Tz/color overridables);
  (B/C) `StyledRunsReemit` — texto nuevo → re-codifica con la fuente ORIGINAL vía mapa
  inverso del /ToUnicode (`toUnicode.ts`); **sin /ToUnicode** (típico Word/Quartz) el mapa
  sale del ENCODING simple (`encoderFromSimpleEncoding`: /MacRoman|/WinAnsi + FirstChar..
  LastChar con width>0); subset insuficiente o cambio de familia/estilo → fuente estándar
  (`fonts.ts` stdFontFor, cola en `fallback.ts`) PRESERVANDO color (`color.ts`
  rawFillToRgb del op). `applyTextDiff` (edits.ts) mapea estilo POR CARÁCTER en cambios
  multi-región (posicional si el largo coincide, LCS si no) — antes un reemplazo de
  varios "XXXX" en línea mixta bold/regular heredaba UN estilo y forzaba el fallback.
- `promoteMovedImages` (edits.ts): la regla "movida → zOrder front al guardar", ÚNICA
  fuente de verdad compartida por el editor (bake) y el agente (EditSession.bake).
- Imágenes: reubica el `Do` (solo Subtype /Image — JAMÁS un Form XObject: envuelve
  contenido); zOrder = re-emitir en el borde del stream. Widgets: /Annots → setRectangle/
  removeField + updateFieldAppearances. **Highlights: /Annots (Subtype /Highlight) —
  NO se queman en el contenido** (así, como widgets/links, se los extrae como
  `HighlightNode`, se los mueve/borra incluso después de guardar, y el preview coincide
  con lo guardado). `createNodes.addHighlight` crea la anotación (QuadPoints + /C + un
  appearance stream Multiply para viewers externos); `bake/highlights.ts`
  `applyHighlightEdits` mueve/borra los existentes (localiza por /Rect, como los widgets).
  `createNodes.ts`: addText/addFormField (firma FT /Sig a mano, T como PDFString)/
  insertImage/addHighlight/addLink/watermark/headerFooter/setFieldOptions/addRadioOption.

## El editor (apps/editor/src/)

- `EditorPage` = SOLO composición y layout; cada comportamiento es un hook en
  `pages/editor/`: `usePendingEdits` (4 colecciones pendientes edits/imageEdits/
  widgetEdits/pendingHighlights — NADA se guarda solo; Aplicar manda todo a POST /bake —
  + historial unificado `useHistory` (Memento, Ctrl+Z/Ctrl+Shift+Z) + segCache de
  fantasmas), `useLocalPreview` (bytes base + bake local), `useLift` (la máquina de drag),
  `useLocks` (localStorage, nodo bloqueado = pointer-events none), `useAreaWidths`,
  `usePlacement` (paleta crosshair→click) y `useEditorHotkeys`. Modales en ui/dialogs,
  NUNCA window.prompt.
- **PREVIEW LOCAL**: imágenes/campos/highlights pendientes se hornean EN EL BROWSER
  (import dinámico de @aldus/core/bake) sobre `baseBytes` y se renderiza eso — WYSIWYG
  sin duplicados. ⚠️ el effect del preview NO puede depender de `graph` ni de funciones
  que lo capturen (loop de re-render = pantalla parpadeando); usar refs.
- `PdfCanvas`: render HiDPI → snapshot jpeg (crops de drag) → extractPageGraph →
  sampleRunColors (color por run desde píxeles). `editor/overlay/`: boxes por nodo
  (SegmentBox/ImageBox/WidgetBox/GroupBox — drag directo con clamp vía `useDragGesture`,
  grips vía `useGripResize`, `selectNode` fuerza blur del editor abierto al cambiar) +
  `FloatingBar` (B/I/tamaño/color/align/highlight/link/trash — con editor abierto, estilo
  y color van A LA SELECCIÓN vía SELECTION_STYLE_EVENT) + `TextEditLayer` (singleton
  imperativo, inmune al churn de grafos). `styledDom.ts` = puente
  modelo↔DOM (sin React, testeado en jsdom): spans data-b/data-i/data-c, serializeStyled
  (NUNCA innerText), fit horizontal por letter-spacing (técnica pdf.js), NBSP vía
  String.fromCharCode(0xa0) (el carácter crudo se corrompe al editar archivos).
- Texto editable = contentEditable enmascarado con la FUENTE EMBEBIDA real (FontFace
  g_d0_fN que pdf.js registra al renderizar; embedded = !missingFile, NO font.data).

## Gotchas que ya mordieron

- pdf.js TRANSFIERE buffers al worker → siempre `bytes.slice()` antes de getDocument/bake.
- preventDefault en pointerdown mata el blur del contentEditable → cerrar editores
  explícitamente (selectNode). Widgets al FINAL del DOM del overlay (arriba para el mouse).
- Callbacks: declarar pushHistory/history ANTES de quien los usa (TDZ crashea al montar).
- Imagen ≥80% de página: no se enmascara el origen en drags (taparía todo) → ghost marco.
- `/ops` endpoint: addText/watermark/headerFooter/addLink/removeLink/setFieldOptions/
  addRadioOption (instantáneas); highlight NO — acumula y va en el body de /bake.
- **Highlights y LINKS = /Annots, objetos editables**: el resaltado NUEVO se acumula como
  `pendingHighlight` (overlay hijo del SegmentBox → sigue al texto) y va en `highlights` del
  /bake (server → addHighlight). Los YA GUARDADOS son nodos del grafo (`HighlightNode`/
  `LinkNode`). Los LINKS y los highlights SIN texto debajo → boxes overlay independientes
  (`LinkBox`/`HighlightBox`: drag/Supr/multi-select/Inspector) → `highlightEdits`/`linkEdits`
  del /bake (`bake/annotEdits.ts` = localizador compartido por /Rect).
- **HIGHLIGHT GUARDADO PEGADO AL TEXTO** (`NodeOverlay`): un `HighlightNode` se ASOCIA por
  solape de rects ORIGINALES (estable, no cambia al mover) al segmento que resalta y se dibuja
  como capa HIJA de ESE `SegmentBox` (como el pendiente → hereda el transform → sigue al texto
  en vivo). Su /Rect se sincroniza con el movimiento del segmento vía `syncHighlightEdits`
  (usePendingEdits) — SIN pushHistory: el snapshot del propio movimiento ya capturó los
  highlightEdits previos, así UN Ctrl+Z revierte texto + resaltado juntos. Sin texto debajo =
  "huérfano" → `HighlightBox` suelto. Select/borrar del pegado: por el Inspector (sección
  Resaltados) o Supr con el nodo seleccionado.
- El canvas rinde con annotationMode DEFAULT (widgets y annots exóticas SÍ se pintan — el
  snapshot de drags depende de eso); los /Highlight se ocultan SOLO en la copia de display vía
  flag Hidden (`hideHighlightAnnotations`) para no duplicarse con su box. ⚠️ NO hay fast-path
  por scan de bytes buscando "/Highlight": pdf-lib guarda con OBJECT STREAMS (dicts comprimidos)
  y el literal no aparece crudo → el scan saltaba el hide y los resaltados se DUPLICABAN.
- **pdf-lib `lookup(name, Type)` LANZA si la clave falta** ("Expected instance of PDFArray, but
  got instance of undefined") — NO devuelve undefined. En páginas sin /Annots reventaba el bake.
  Usar `lookupMaybe` cuando la clave puede no estar (annotEdits, highlights, createNodes).
- **CLIP: el texto movido FUERA del clip de su op se re-emite al FINAL del stream**: muchos
  generadores envuelven la página en `q <rect> W n … Q`. Re-emitir un segmento movido IN-PLACE
  dentro de ese clip lo RECORTA a nada (el texto "desaparece" aunque los ops existan). `textWalk`
  trackea el clip rect activo (apilado con q/Q, intersección de `re W n`/polígono axis-aligned)
  en cada `ShowOp.clip`; `text.ts` (`escapesClip`) detecta el escape y emite vía `appendBlocks`
  (CTM identidad, sin clip) en vez de splice in-place. Las anotaciones (/Annots) nunca se
  clippean → por eso quedaba solo el highlight y el texto negro se iba.
- **SUBRAYADOS siguen a su texto**: `textWalk` trackea rects rellenos simples (`re` o
  polígono m+3l — pdf-lib dibuja así) como `fillRects` con rango de bytes; el bake los
  reubica al mover (path A), los extirpa al eliminar/reescribir. Antes quedaban huérfanos.
- **UNDO TOTAL (Command+Memento)**: `useHistory` intercala snapshots (ediciones pendientes)
  y COMANDOS (ops de server: crear texto/imagen/campo, watermark, enc/pie, links). Deshacer
  un comando = POST /:id/revert (restaura y saca la última revisión); rehacer = re-ejecutar
  la op. Aplicar limpia el historial (los comandos viejos no pueden revertir el bake).
- **Watermark/header-footer** se dibujan como TEXTO del contenido → se extraen como
  segmentos normales: editables/borrables con el pipeline estándar (test lo cubre).
- El server persiste con revisiones (`<id>.rev-<ts>.pdf`, últimas 10) — ya no hay `.bak`.
- Los mensajes de `applied`/`warnings` del bake son API de facto (el editor los muestra,
  los tests los matchean): NO traducirlos ni reformatearlos sin revisar consumidores.
