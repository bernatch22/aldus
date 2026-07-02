# Aldus — editor de PDF pixel-perfect (monorepo pnpm)

Editor de PDF que parsea el **grafo de contenido real** (operadores del content stream)
y lo edita **in situ** — nunca pinta blanco encima ni redibuja con fuentes aproximadas.
Nació como extracción/rewrite del editor de signwax (`~/signwax/packages/pdfkit`).
Fase final pendiente: agente LLM (Claude Agent SDK + suscripción; spike verde en
`packages/agent/src/spike.mjs`) e integración de vuelta en signwax (punto 5 del backlog).

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
packages/agent   @aldus/agent   spike Agent SDK (tool custom + suscripción Claude Code)
apps/editor      @aldus/editor  Vite+React+Tailwind v4+lucide (:5190, proxy /api→4100)
apps/server      @aldus/server  Express+tsx (:4100) — upload, bake, ops, fields, images
```
Dev: `pnpm dev` (ambos). Tests: `pnpm -r test` (core: vitest ciclo REAL crear→extraer→
bake→re-extraer; editor: jsdom sobre styledDom). Verificar SIEMPRE con build/test, no tsc.

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
sin reposicionar = `stale` → el bake NO los toca, warning honesto) → `bake.ts`:
- Localiza ops por GEOMETRÍA (original snapshot, tolerancia ~1.8pt) — nunca por índice.
- Reemplazo IN-PLACE (`Splice {start,end,text}`) = z-order intacto. La matriz emitida es
  RELATIVA al CTM del punto (`M_rel = M_abs × inv(ctm)` — invert() en textWalk).
- Texto: (A) mover/escalar/reestilar → re-emite VERBATIM (bytes/kerning/color intactos,
  Tc/Tz/color overridables); (B) texto nuevo → re-codifica con la fuente ORIGINAL vía
  mapa inverso del /ToUnicode (`toUnicode.ts`); (C) subset insuficiente o cambio de
  familia/estilo → fuente estándar (stdFontFor) PRESERVANDO color (rawFillToRgb del op).
- Imágenes: reubica el `Do` (solo Subtype /Image — JAMÁS un Form XObject: envuelve
  contenido); zOrder = re-emitir en el borde del stream. Widgets: /Annots → setRectangle/
  removeField + updateFieldAppearances. `createNodes.ts`: addText/addFormField (firma FT
  /Sig a mano, T como PDFString)/insertImage/addHighlight (multiply+alpha)/addLink/
  watermark/headerFooter/setFieldOptions/addRadioOption.

## El editor (apps/editor/src/)

- `EditorPage`: estado = 4 colecciones pendientes (edits/imageEdits/widgetEdits/
  pendingHighlights — NADA se guarda solo; el botón Aplicar manda todo a POST /bake) +
  historial unificado undo/redo (snapshots de las 4, Ctrl+Z/Ctrl+Shift+Z) + locks
  (localStorage, nodo bloqueado = pointer-events none, se administra desde el esquema) +
  paleta de inserción (crosshair→click) + modales (ui/dialogs, NUNCA window.prompt).
- **PREVIEW LOCAL**: imágenes/campos/highlights pendientes se hornean EN EL BROWSER
  (import dinámico de @aldus/core/bake) sobre `baseBytes` y se renderiza eso — WYSIWYG
  sin duplicados. ⚠️ el effect del preview NO puede depender de `graph` ni de funciones
  que lo capturen (loop de re-render = pantalla parpadeando); usar refs.
- `PdfCanvas`: render HiDPI → snapshot jpeg (crops de drag) → extractPageGraph →
  sampleRunColors (color por run desde píxeles). `NodeOverlay`: boxes por nodo (drag
  directo con clamp, grips, `selectNode` fuerza blur del editor abierto al cambiar) +
  `FloatingBar` (B/I/tamaño/color/align/highlight/link/trash — con editor abierto, estilo
  y color van A LA SELECCIÓN vía SELECTION_STYLE_EVENT). `styledDom.ts` = puente
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
