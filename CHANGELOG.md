# Changelog — Aldus

El más reciente arriba; fecha `YYYY-MM-DD`.

## 2026-07-04

### feat(editor+server): editar vía LLM desde la UI — panel de chat "Aldus AI"
Integración del agente en el editor: botón **"AI"** en el header abre un panel de chat a la
derecha donde pedís cambios (o preguntás) en lenguaje natural. Arquitectura: el agente corre
en el **server** (nuevo `POST /api/documents/:id/agent`, reusa `@aldus/agent` — carga el grafo
del PDF, lo embebe en el prompt, corre el turno) y NO hornea: devuelve el `text` + el SET
COMPLETO de ediciones. El panel las **aplica al estado del editor** (`applyAgentEdits` →
reemplaza `edits`/`imageEdits`), así fluyen por el MISMO pipeline preview→Aplicar que una
edición manual, y son deshacibles con Ctrl+Z. Multi-turno: el panel manda las ediciones
pendientes como seed + el `sessionId` (resume) → el agente continúa desde el estado actual.
Verificado end-to-end contra el server real: edición simple, seed + segunda edición (vuelven
las dos), resume. Auth por suscripción → el server corre SIN `ANTHROPIC_API_KEY`. Archivos:
`apps/server/src/index.ts` (+dep `@aldus/agent`), `apps/editor/src/lib/api.ts` (`api.agent`),
`apps/editor/src/editor/AgentPanel.tsx` (nuevo), `pages/EditorPage.tsx` (botón + panel +
`applyAgentEdits`), `packages/agent/src/{index,session}.ts` (`seed`/`getEdits` + exports).
Límite conocido: el agente ve el grafo del PDF GUARDADO (las posiciones de ediciones manuales
pendientes no se reflejan en lo que "ve", aunque se mergean bien) — refinamiento futuro.

### feat(agent): CLI `aldus` + agente LLM con el grafo del PDF embebido en el prompt
Nuevo `@aldus/agent`: un agente (Claude Agent SDK + Sonnet, auth por suscripción) que tiene
el **contenido completo del PDF embebido en su system prompt** (el grafo de `@aldus/core`,
todas las páginas) y con eso responde preguntas o hace cambios. Diseño: NO hay tool de
lectura (el documento entero ya va en el prompt, el agente ancla a los `id` reales); las
tools son solo mutaciones (`edit_text`, `move_text`, `set_text_color`, `set_text_size`,
`delete_text`, `move_image`, `delete_image`) que acumulan `SegmentEdit`/`ImageEdit` con las
MISMAS funciones de merge del editor UI y se hornean con `@aldus/core/bake` al guardar
(front-on-save para imágenes movidas, como el editor). Corre con `tsx` (como el server),
`canUseTool` como único gate de permisos (auto-aprueba las tools de Aldus, niega el resto).
CLI: `aldus <pdf> -p "<prompt>" [-o out.pdf]` (one-shot) o `aldus <pdf>` (chat multi-turno
vía `resume`). Verificado end-to-end contra un PDF real (leer contenido, `edit_text`,
`move_image` → bake → re-extracción confirma el cambio). Archivos: `packages/agent/src/`
(`graph.ts`, `serialize.ts`, `session.ts`, `tools.ts`, `agent.ts`, `cli.ts`),
`bin/aldus.mjs`, `README.md`. Límite conocido: docs muy grandes se acercan al límite de
contexto (embebemos todo el grafo) — paginación selectiva queda como próximo paso.

### fix(editor): imagen movida no desaparece al GUARDAR (front-on-save)
Contraparte del fix in-place: el editor mantiene la imagen movida visible con un sticker al
frente (overlay), pero el bake la reubica EN SU LUGAR (para no romper la identidad durante la
edición en vivo), así que en el PDF **guardado** podía quedar tapada por contenido posterior
→ "la muevo, guardo y desaparece". Al guardar (`bake()` en `EditorPage`), a cada imagen
movida/escalada sin `zOrder` explícito se le setea `zOrder:'front'` antes de mandarla al
server → el bake la reubica Y la sube al frente en el PDF final, coincidiendo con lo que
muestra el editor. Seguro porque el save es definitivo (no hay re-extracción después, así que
no rompe identidad). El preview del editor sigue in-place. Se limpiaron los logs de debug de
la saga de imágenes. Archivo: `pages/EditorPage.tsx`.

## 2026-07-03

### fix(editor): mover imagen BIEN — píxeles reales + lift + sticker in-place
Saga de varios intentos; la causa raíz final resultó ser de z-order/identidad. Piezas:
1. **Píxeles REALES de la imagen** (`imagePixels.ts`): se sacan de `page.objs` de pdf.js
   (bitmap o data RGBA/RGB/GRAY→canvas→dataURL PNG, con transparencia exacta), cacheados
   por documento. Matan el "pedazo pegado" (antes el ghost recortaba el snapshot y traía el
   FONDO en las zonas transparentes del PNG). `objId` capturado en core (`ImageNode.objId`).
2. **LIFT para imágenes** (reusa el del texto): al arrastrar, se re-hornea la página SIN esa
   imagen y se blitea → el canvas muestra lo de atrás, **sin velo blanco**. Guard clave:
   solo se prepara el lift si la imagen NO tiene ya edición (`!imageEdits.has`) — sin él, al
   soltar (imageEdits cambia) se horneaba un lift COMPETIDOR que se bliteaba encima del
   preview → la imagen se esfumaba.
3. **Reubicar EN SU LUGAR + sticker persistente** (la clave del z-order): el bake mueve el
   `Do` en su punto del stream (NO al frente). Reordenar al frente lo arreglaba visualmente
   pero **rompía la identidad**: pdf.js numera los `objId` por orden de pintado, así que
   mover el `Do` al final le cambia el objId → al re-extraer la edición saltaba a OTRA imagen
   ("dos objetos", "cambia de tamaño"). En su lugar preserva la identidad, pero puede dejar la
   imagen tapada por contenido dibujado después → el overlay la mantiene visible con un
   **sticker de sus píxeles limpios ARRIBA** (z-index alto) de forma persistente, sin tocar el
   stream. IDs de imagen ahora estables por `objId` (`extractGraph`), no por índice.
Resultado en el editor: mover una imagen queda visible donde se suelta, misma identidad, sin
blanco/halo/fragmento/duplicado. (Pendiente aparte: en el PDF GUARDADO la imagen queda en su
z-order original; si se necesita siempre al frente al guardar, es un cambio del save.)
Archivos: `core/model.ts`, `core/extractGraph.ts`, `core/bake/bake.ts`, `editor/imagePixels.ts`
(nuevo), `editor/PdfCanvas.tsx`, `editor/NodeOverlay.tsx`, `pages/EditorPage.tsx`.

### fix(editor): mover imagen — sin "pedazo" pegado; ghost solo durante el arrastre
El ghost recorta la región de la imagen del snapshot de la página, que incluye el FONDO
que tenía detrás (otra imagen, p. ej. la de fondo full-page). Al mostrar ese recorte en el
destino —sobre una parte distinta del fondo— el rectángulo con los píxeles viejos no
coincide y se ve como "otro pedazo de imagen quedado arriba". El snapshot no permite
separar la imagen de su fondo, así que el ghost persistente post-drop era irreparable.
Solución: el ghost (con su halo) va **solo durante el arrastre activo** (ahí es un preview
esperado, siguiendo el cursor); al soltar NO se muestra ghost ni velo — el canvas re-hornea
y es la única fuente de verdad. Se elimina el estado `movePending` (y su tolerancia). Log de
debug (`[aldus:img]`, `[aldus:canvas]`) removido tras diagnosticar. Archivos:
`NodeOverlay.tsx` (ghost = drag activo), `PdfCanvas.tsx` (logs fuera).

### fix(editor+core): color EXACTO del fantasma — del content stream, no muestreado
Alternativa definitiva al muestreo de píxeles (siempre aproximado). El BAKE ya matchea
cada segmento con sus ops del content stream (matchOps por geometría) y esos ops llevan
el color REAL (`fillColorRaw`). Ahora `bakeSegmentEdits` DEVUELVE `colors: {segmentId →
hex}` con el color exacto, y el editor lo sobreescribe en el cache de fantasmas → el texto
movido/editado se ve idéntico al original, sin la aproximación del muestreo. (El muestreo
por promedio del núcleo queda como fallback para segmentos que el bake no toca.)

### fix(editor): muestreo de color más FIEL — promedio del núcleo del glifo (no un pixel outlier)
El color muestreado difería del real del canvas: elegía el pixel MÁS oscuro del bbox, que
con antialiasing (solapes de trazos) puede ser un outlier más oscuro que el color real.
Ahora se promedian los pixels del NÚCLEO (inkiness ≥ 80% del máximo) → el color coincide
con lo que pinta el canvas. (Si aún se nota diferencia, el paso siguiente es leer el color
EXACTO del content stream, pero requiere casar coordenadas con transform global.)

### fix(editor): el color del texto ya no se "rompe" al mover — CACHE de colores por run
El culpable era mi optimización `sampleColors={!pending}`: apenas había una edición
pendiente, dejaba de muestrear colores, así que CUALQUIER segmento que se moviera/editara
después (p.ej. TÉRMINOS tras mover BASIC) perdía su color y el fantasma lo pintaba negro.
Fix correcto: `sampleColor` cachea el color por run (clave = página+posición+texto,
estable para un run que no se movió). El estado base muestrea todo; los re-bakes reaplican
por clave SIN leer píxeles (barato) y solo muestrean runs genuinamente nuevos. Se vuelve a
muestrear SIEMPRE (con cache) → ningún segmento pierde su color. `clearColorCache()` por
documento.

### fix(editor): el lift SOSTIENE el original oculto hasta el re-bake (fin del "duplicado" sobre imágenes)
Revert de dos parches propios que empeoraban las cosas: el **debounce** (prolongaba el
duplicado post-drop) y la **máscara blanca de drag** (fea sobre imágenes). El mecanismo
limpio sobre imágenes es el LIFT (la página re-horneada SIN el segmento). Ahora el lift:
- se BLITEA en cuanto está listo si el drag arrancó O hay un drop pendiente (`liftHoldRef`),
  no solo durante el gesto — un drag rápido (lift aún horneándose) ya no deja el original
  visible bajo el movido;
- SOSTIENE la página extirpada desde el arranque del drag, a través del drop, hasta que el
  re-bake aterriza (que libera el hold y blitea el preview definitivo).

### perf(editor): preview mucho más fluido — sin re-muestreo de color, debounce, willReadFrequently + máscara de drag
El re-bake local (pdf-lib + pdf.js + extracción) corría COMPLETO en cada edición y era el
cuello de botella (lag + "duplicado" durante el arrastre en PDFs pesados). Sin cambiar la
arquitectura WYSIWYG:
- **No re-muestrear colores en cada re-bake**: `sampleRunColors` (getImageData sobre toda
  la página) solo corre en el estado BASE — los colores no cambian con las ediciones y
  los fantasmas los cachean. Era el costo más grande del hot-path.
- **willReadFrequently** en el back buffer → getImageData más rápido, sin el warning.
- **Debounce (150ms)** del re-bake con ediciones pendientes: un arrastre/tipeo rápido ya
  no encola N bakes. El overlay (fantasmas) da feedback INSTANTÁNEO; el bake solo refina.
- **Máscara de drag**: durante el arrastre, una máscara opaca instantánea tapa la posición
  original (no espera al lift/re-bake) → nunca se ve el original "duplicado" bajo el que
  arrastrás, aun en PDFs lentos.

### feat(editor+core): alinear el TEXTO dentro del área (no el nodo) + inputs con barra de solo "eliminar"
- **Alineación de texto**: los 3 botones de alineación del texto ya NO mueven el nodo a
  los márgenes de la PÁGINA — alinean el texto DENTRO del área del grafo (left/center/
  right), como pidió el usuario, útil cuando el área es más ancha que el texto (grip).
  `SegmentEdit.align` (modelo, metadata) + `applyAlign` (styledDom): recalcula el `dx` de
  cada línea dentro del frame (= ancho del área) — left = natural, center = (frame−ancho)/2,
  right = frame−ancho. El bake solo lee el `dx` (no sabe de "align"). Display: text-align
  CSS en el textarea/backdrop y en el fantasma (ancho = área). Estado activo en la barra.
- **Barra de los inputs/campos**: fuera los 3 botones de alineación (no tenían sentido en
  un widget) — queda solo "eliminar". `ObjectBar.onAlign` ahora es opcional (las imágenes
  conservan alinear-en-la-página + orden Z).

### feat(editor): grip 2D del texto + insert con área generosa + SELECCIÓN MÚLTIPLE (marquee + grupo movible)
- **Grip 2D**: el handle del área de texto ahora estira ANCHO y ALTO (antes solo ancho).
  `areaWidths` pasa a `{w?,h?}` por segmento (persistido). Volver al tamaño natural en
  cualquier dimensión la limpia.
- **Texto insertado menos "cojo"**: desde la paleta nace con área por defecto (240pt de
  ancho, ~2 líneas de alto) y tamaño mínimo 13pt — aplicada al aparecer en el grafo
  (match por posición).
- **Selección múltiple**: arrastrar sobre el fondo dibuja un marquee que selecciona todos
  los nodos que toca (segmentos/imágenes/campos, salteando bloqueados). 2+ = una CAJA DE
  GRUPO punteada que se arrastra para mover TODO junto (un patch de posición por nodo) y
  tiene botón de eliminar-todos; click sin arrastrar la deselecciona. Estado local a
  NodeOverlay (ids estables entre re-bakes); en modo grupo los boxes solo muestran
  highlight (barras/grips los maneja la caja de grupo).

### fix(core+editor): un bloque multilínea SIGUE siendo UN grafo después de guardar
Al aplicar, el bake escribe cada línea como ops separados y la re-extracción los partía
en un grafo por línea — el bloque se desintegraba. Ahora:
- **`mergeBlockSegments` (extracción)**: re-agrupa en UN segmento multilínea las líneas
  consecutivas con la firma de un bloque de Aldus (línea de un solo segmento, misma x
  ±0.5pt, mismo tamaño, leading 1.2×size ±6%) — exactamente lo que emite el bake.
  `text` une con '\n'; los runs conservan su baseline real.
- **`original.baselines`** (modelo) + `matchOps` multilínea: el bake matchea/extirpa los
  ops de TODAS las líneas del bloque (el path A ya movía rígido por deltas por-op).
- `originalStyledRuns` y `originalLayoutHtml` línea-conscientes (runs agrupados por
  baseline, líneas unidas con '\n') — seeds, comparaciones de noop y display coherentes.

### fix(editor): el guardado es IDÉNTICO a lo que muestra el editor
Dos deltas UI↔save eliminados:
1. **El estiramiento del fit (ws/ls) caía en el save**: el fit de apertura imita los
   gaps del PDF del texto ORIGINAL (que el save preserva verbatim, path A) — pero con
   texto MODIFICADO el bake escribe métrica natural, y el editor seguía mostrando la
   versión estirada mientras tipeabas. Ahora, apenas el texto cambia respecto del seed,
   el estiramiento se quita (textarea + backdrop pasan a métrica natural) — lo que ves
   tipeando ES lo que se hornea.
2. **Doble escala de dx/w con resize**: el commit medía los tramos al tamaño escalado y
   el bake multiplica por el ratio otra vez — con `fontSize` override los tramos caían
   corridos. Ahora se miden al tamaño ORIGINAL (ratio 1), como espera el bake.

### fix(editor): la caja de un grafo MULTILÍNEA cubre TODAS las líneas (no solo la primera)
Con breaklines, el `.seg-box` (click + selección + mask) medía una sola línea de alto, así
que solo se podía seleccionar/tapar la primera. Ahora el alto = n_líneas × leading
(1.2×size, el mismo del bake) y el `line-height` es por línea; una sola línea conserva el
alto natural del segmento. El click en cualquier línea selecciona el grafo entero.

### feat(editor+core): viñetas SOLO en la selección + SUBRAYADO + familia en la barra + esquema con seleccionado primero
- **Toggle de lista por selección**: opera solo sobre las líneas alcanzadas por la
  selección del textarea (expandida a límites de línea; sin selección = la línea del
  caret) — ya no marca TODO el nodo. Regla de mezcla estándar intacta.
- **Subrayado (U)** end-to-end: `StyledRun.underline` en el modelo, toggle en barra +
  Cmd+U + evento al layer, backdrop con `text-decoration`, y en el BAKE la línea se
  DIBUJA (rect fino y=−0.11em, alto 0.055em, color del tramo) — el PDF no tiene
  underline como atributo. `StyledRun.w` (ancho medido por el editor) para el ancho de
  la línea; en el path de fuente estándar, `widthOfTextAtSize` de pdf-lib.
- **Familia tipográfica en la barra flotante** (Original/Sans/Serif/Mono → `edit.font`),
  además del panel.
- **Esquema (sidebar)**: el nodo seleccionado va PRIMERO en su sección y resaltado
  (active); el esquema ahora también se muestra DEBAJO de las propiedades cuando hay
  selección (antes desaparecía).

### feat(editor+core): un grafo PUEDE tener BREAKLINES — Enter = \n real dentro del mismo nodo
Pregunta correcta del usuario: "¿un grafo no puede tener breakline?" — sí puede (el PDF
soporta bloques multilínea). Se elimina TODA la maquinaria de crear-segmentos en Enter:
- **Editor**: Enter inserta `\n` en el mismo textarea (multilínea nativo); en una lista
  continúa el marcador incrementado en la línea nueva; Enter en un ítem vacío (solo
  marcador) lo quita y cierra. `fit()` multilínea: ancho = línea más larga, alto =
  n×line-height (1 línea = alto real del segmento; 2+ = 1.2×size — el MISMO leading que
  hornea el bake, WYSIWYG). El commit recomputa el `dx` de cada tramo POR LÍNEA (medido
  con la fuente real del estilo — `measureFontFor` exportado).
- **Bake (core)**: el texto del edit se parte en líneas por `\n`; cada línea se emite a
  `baseline − i×1.2×size` con su dx relativo a la línea, dentro del MISMO splice (mismos
  paths B/C: re-encode con fuente original o estándar). Test de regresión del round-trip.
- **Toggle de lista POR LÍNEA** (patrón markdown-editors): si todas las líneas con
  contenido tienen marcador → se quita de todas; si no → se agrega a las que falte. La
  viñeta sigue COLGANTE (el marcador de la 1.ª línea corre el ancla x del grafo).
- Fuera `LiveSession.newLine`/`onAddText` del layer y el flujo Enter-crea-segmento.

### fix(editor): Enter = línea de abajo SIEMPRE — continuación LOCAL, sin round-trip ni rebind
El Enter cerraba la edición: para texto suelto no había marcador (→ commit+close) y para
listas dependía de un round-trip al server + rebind por geometría que fallaba. Rediseño
robusto: el editor sigue ABIERTO y edita la línea nueva LOCALMENTE (no hay segmento real
detrás; se crea con `onAddText` en su propio commit). Sin esperar al server, sin rebind,
sin matching frágil por x/baseline.
- `LiveSession.newLine` (page/x/baseline/size/bucket): el commit de una línea nueva usa
  `onAddText` en vez de `onPatch`. Cada Enter comitea la línea actual y arranca la de
  abajo; el blur/click-away comitea la última y cierra.
- Enter en línea nueva VACÍA (solo marcador o nada) = TERMINAR (como Word/Acrobat), sin
  apilar ítems vacíos.
- Eliminada toda la maquinaria `editRequestId`/`pendingItemRef`/rebind (NodeOverlay,
  PdfCanvas, EditorPage) — el editor local la vuelve innecesaria.
- (Formatear una línea NUEVA queda plano por ahora: `onAddText` no lleva runs; las líneas
  ya existentes conservan bold/italic/color como siempre.)

### fix(editor): B/I encendidos según el caret + Enter en lista SIN cerrar el editor (sesión provisional)
- **Estado activo de B/I/color**: con el textarea, `selectionStyle` (que camina DOM)
  devolvía null y los botones no reflejaban el formato bajo el caret. Ahora la barra lee
  los runs VIVOS de la sesión (`styleAtRange` + `selectionStart/End`); el `selectionchange`
  del document cubre textarea, y el toggle refresca al toque (dispatch síncrono). Con
  caret colapsado, B/I aplican a la PALABRA bajo el caret (consistente con lo que muestra
  el botón), no al segmento entero.
- **Enter en lista = breakline real**: antes committeaba, CERRABA el editor y esperaba el
  round-trip para reabrir — se sentía como un submit que "pierde la edición". Ahora el
  editor NO se cierra: commit del ítem actual y la sesión pasa a PROVISIONAL (marcador +
  gap, una línea abajo, commit deshabilitado) mientras el segmento real se crea; cuando
  llega al grafo, `open()` re-liga la sesión preservando lo tipeado y el caret. Tipeo
  continuo, sin interrupciones.
- **Freeze del preview eliminado**: era el parche de la era pre-singleton (y bloqueaba el
  flujo del Enter: sin previews no llegaba el grafo con el ítem nuevo). El layer es inmune
  al churn — el preview fluye debajo del editor abierto.

### fix(editor): host del editor colapsado (texto "impreso muchas veces") + viñetas COLGANTES
- **El editor se veía superpuesto** ("el grafo impreso muchas veces"): al pasar backdrop
  y textarea a `position:absolute`, el host quedó sin ancho intrínseco → su fondo blanco
  no cubría nada y se veían canvas + backdrop + box a la vez. `fit()` ahora también
  dimensiona el host; el textarea con z-index sobre el backdrop (caret visible).
- **Viñetas colgantes (con alineación)**: togglear la lista ya NO corre el texto — el
  CONTENIDO queda anclado donde estaba y la viñeta cuelga a la izquierda (x se corre el
  ancho del marcador, medido con la fuente real). Igual en el camino de modelo (barra
  con editor cerrado) y en vivo (el host del layer se corre y el corrimiento se
  consolida en x al commit). Los ítems quedan alineados con el resto del documento.

### fix(editor): bold/italic/color VISIBLES en el editor — backdrop estilado detrás del textarea
El textarea es texto plano y no podía mostrar formato: aplicar bold "no hacía nada"
(sí se committeaba al modelo, pero sin feedback). Técnica de backdrop (la de los textarea
con syntax-highlight): un div DETRÁS del textarea dibuja los tramos estilados
(bold/italic/color) y el textarea va TRANSPARENTE encima aportando solo caret + input.
Mismas métricas (font/size/word-spacing/letter-spacing/ancho) → el caret cae sobre el
glifo dibujado. Bold via `text-shadow` (faux, sin cambiar el ancho → alineación intacta),
italic real, color real. Se re-dibuja en cada input y en cada B/I/color/lista. Además:
sin selección, B/I/color ahora aplican al SEGMENTO ENTERO (antes no hacían nada). El
commit sigue horneando bold/italic/color REALES en el PDF.

### fix(editor): el texto del editor ya no se ve "más chico" — fit de ancho al abrir (word-spacing)
El textarea muestra texto PLANO con espacios simples, pero el segmento real del PDF
tiene gaps entre runs (los blanks "____ ____") y ajustes de ancho — el texto plano medía
menos y se veía encogido al abrir. Ahora, al abrir con el texto original intacto, el
delta (ancho efectivo − medido) se compensa con `word-spacing` (los gaps reales están en
los espacios) o `letter-spacing` por carácter como fallback (clamp 0.4×fontSize) — la
técnica del text layer de pdf.js. El auto-ancho del textarea incluye la compensación.

### fix(editor): click dentro del editor ya no deselecciona + grips descubribles + gap de lista generoso
- **Click dentro del textarea deseleccionaba** (y podía cerrar el editor): el click
  burbujeaba al overlay, cuyo handler de fondo hace `selectNode(null)`. El host del
  TextEditLayer ahora corta la propagación (click/pointerdown/dblclick).
- **Grips siempre descubribles**: los handles de resize (texto/imagen/campo) ya no
  exigen seleccionar primero — están siempre presentes (salvo lock) y se revelan con
  el hover del nodo (opacity via CSS).
- **`LIST_GAP` (4 espacios)**: constante única en core para el gap marcador→texto de
  las listas (toggle, siembra del ítem nuevo, toggle en vivo del layer). Se elimina
  `toggleListMarkerInDom` (muerto tras el textarea).

### refactor(editor): el TextEditLayer pasa a TEXTAREA plano (patrón Excalidraw) — adiós contentEditable
Idea del usuario, y es la correcta: un `<textarea>` nativo no colapsa espacios (el gap de
lista son espacios REALES, sin NBSP), no crea spans fantasma, y su caret es indestructible.
Los ESTILOS por tramo salen del DOM y pasan al MODELO de la sesión:
- `applyTextDiff(runs, newText)` (core, puro + 5 tests): re-mapea los tramos al texto
  nuevo por diff de prefijo/sufijo común — lo insertado hereda el estilo del punto de
  cambio. Se sincroniza en cada `input`.
- B/I/color a la selección: `toggleStyleRange`/`setStyleRange` con `selectionStart/End`
  (offsets planos nativos del textarea) — muere `serializeStyled`/`applySelection*` en
  el camino de edición (siguen para tests/compat).
- Toggle de lista en vivo: manipulación de string plano + re-sync (evento `list` al layer).
- El textarea se auto-ajusta al contenido midiendo con la fuente real (`measureWidth`).
- `activeEditingBox` reconoce el textarea; `selectionStyle` degrada a null con él (los
  toggles muestran el estado del segmento).

### refactor(editor): TextEditLayer — EL editor de texto como singleton imperativo (patrón pdf.js edit-box-manager)
Tras tres parches al churn (preview congelado, html congelado, freeze de lifts) el editor
inline seguía muriendo (edit-open ×3, blur "nadie": REMOUNTS del SegmentBox que ninguna
instrumentación terminaba de atribuir). Rediseño estructural, como lo hacen pdf.js
(edit box manager de FreeText) y Excalidraw (textarea singleton): UN solo contentEditable
montado UNA vez en la raíz del overlay, abierto/cerrado IMPERATIVAMENTE (`open(session)`
posiciona, siembra innerHTML, foca; listeners nativos atados una sola vez; commit por
serialize en blur/Enter/Escape). Vive fuera del subtree reactivo: ningún grafo nuevo,
preview o re-render puede desmontarlo, resembrarlo ni robarle el foco — la clase entera
de bugs muere por construcción. `SegmentBox` ya no tiene editable propio (solo lo
solicita); sesión con callbacks que leen por refs (`editsRef`). El gap de ítem pelado,
Cmd+B/I, SELECTION_STYLE_EVENT, beforeinput y el toggle de lista en vivo siguen igual.

### fix(editor): toggle de lista EN VIVO con el editor abierto — muta el DOM como B/I/color
Los traces finales mostraron que el flujo de fondo YA funcionaba (commits "•  asd" y
"•  sdad" correctos, gap sembrado, Enter fluido) — lo roto era lo VISIBLE: con el editor
abierto, el toggle de lista iba por `onPatch` (modelo) y el DOM congelado no lo reflejaba
→ "no pasa nada". Patrón canónico de editores contentEditable (CKEditor et al.): durante
la edición la toolbar MUTA el DOM preservando la selección — nunca re-renderiza desde el
modelo. `toggleListMarkerInDom` (styledDom, jsdom-testeado): prepende "•"+gap NBSP dentro
del primer span (hereda estilo) o recorta el marcador text-node por text-node; el commit
lo serializa normal. Con editor cerrado sigue el camino de modelo (`toggleListMarker`).

### fix(editor): el PREVIEW se CONGELA mientras hay un editor de texto abierto (fin del editor que se cierra solo)
Los traces mostraron `[aldus:edit-open]` ×3 para el mismo segmento y grafos de documentos
distintos (g_d4↔g_d7↔g_d4) aterrizando EN PLENA edición: el pipeline de preview seguía
vivo debajo del editor abierto — re-bakes → nuevos pdf → nuevos grafos → el SegmentBox se
remontaba (blur "nadie" con stack vacío = unmount), el foco moría y el tipeo se perdía.
Mismo principio que el drag (el canvas no cambia durante un gesto): con `editingActive`
(NodeOverlay → EditorPage), los efectos de preview y de lift NO corren mientras un editor
está abierto; al cerrarlo, corren una vez y hornean todo lo acumulado.

## 2026-07-02

### fix(editor): ítem de lista nuevo — gap sembrado al editar + color fantasma #000000 erradicado
Diagnóstico por logs en vivo del ítem creado con Enter:
- **El gap del marcador no puede vivir en el PDF**: la extracción descarta ítems de
  solo-whitespace (correcto: los gaps nunca son whitespace), así que `"•  "` vuelve
  como `"•"` pelado y el tipeo quedaba pegado a la viñeta. Ahora, al abrir en edición
  un segmento que es SOLO un marcador (`isBareListMarker`, core), el editor siembra el
  gap (2 NBSP) con el caret al final: al tipear, el gap se vuelve interior y se hornea;
  sin tipeo, el commit lo recorta = noop limpio.
- **Color fantasma**: `serializeStyled` absorbía el `style.color` inline que Chrome
  copia a los spans que crea al tipear (negro computado → `c#000000` ≠ `undefined`
  original) — cada blur paría una edición fantasma. Ahora el color heredado del
  contenedor (`edit.color ?? color del run dominante ?? #000`) NO cuenta como override;
  los overrides reales siguen viajando por `data-c`.
- Log `[aldus:blur]` (temporal) con el `relatedTarget` para cazar robos de foco si el
  cierre instantáneo reaparece.

### feat(editor): lista = FORMATO del texto (no un componente) + grip que amplía el ÁREA tipeable (no escala)
- **Lista como formatter**: fuera el tool "Lista" del palette (creaba un componente
  aparte, sin gap, y Enter paría otro componente suelto — "muy raro"). Ahora es un
  toggle (ícono lista) en la barra flotante de CUALQUIER texto: `toggleListMarker`
  (core, puro + tests) prepende `"•  "` (viñeta + 2 espacios = gap real) al primer
  tramo o quita el marcador existente (viñeta, "3.", "b)"…). Va por el flujo de
  ediciones pendientes como todo lo demás.
- **Enter fluido**: al continuar una lista (Enter), el ítem nuevo se abre EN EDICIÓN
  automáticamente apenas el grafo lo trae (match por geometría x/baseline ±3pt) — se
  acabó el "doble click para editarlo" en medio del tipeo.
- **Grip = área, no escala**: arrastrar el grip ya no agranda la letra (eso vive en el
  input de tamaño de la barra); ahora AMPLÍA el área tipeable de la línea (min-width
  del box, en pt, por segmento — `areaWidths`, persistido por documento). Espacio para
  escribir sin salto de línea; volver al ancho natural la limpia.

### fix(core): "Al fondo" REAL — inserta tras el papel blanco (backstop), no en el byte 0
Enviar una imagen al fondo la prependeaba al inicio del stream, ANTES del relleno blanco
full-page con que los PDFs de generadores (JotForm) pintan la hoja → el papel opaco la
tapaba y quedaba "todo blanco". Fix de raíz en el bake:
- `walkContent` ahora calcula el **backstop**: el punto justo antes del PRIMER op de
  contenido real (fill no-blanco — con `isWhiteFill` sobre el raw del color —, `Do`,
  `BT`, `sh`, trazos), es decir DESPUÉS del papel. Los paint-ops apuntan al ARRANQUE de
  su path (insertar entre `re` y `f` sería ilegal); `n` (clip-only) no cuenta.
- El bloque re-emitido usa matriz RELATIVA al CTM del backstop (`abs × inv(ctm)`) — en
  el byte 0 el CTM era identidad, en el backstop no necesariamente.
- `rebuild`: con el mismo `start`, una inserción pura ordena ANTES que una extirpación
  (si no, el skip de solapados se la comía — caso "la imagen ya es el primer contenido").
- Verificado contra el insurance agreement real: la imagen de fondo enviada al fondo
  queda idéntica (misma geometría, 0 warnings) en vez de desaparecer. Test de regresión
  `imageZOrder.test.ts` (orden papel→imagen→texto + round-trip de geometría).
- UI: "Al fondo" vuelve a estar disponible para imágenes full-page (el ocultamiento
  anterior era un parche — ahora la operación es correcta).

### fix(editor): "Al fondo" desaparecía la imagen de fondo — full-page ya es la capa de atrás
Una imagen full-page (el fondo del insurance agreement) YA es la capa más al fondo del
contenido: mandarla "al fondo" la reubicaba ANTES del relleno blanco de la página, que
la tapaba → la imagen desaparecía. Ahora "Al fondo" se oculta para imágenes full-page
(coverage ≥ 0.8), tanto en la barra flotante (`ObjectBar.backDisabled`) como en el panel
(con la nota "Fondo de página: ya está en la capa de atrás"). "Al frente" sigue disponible.

### feat(editor): imágenes full-page bloqueadas por defecto + esquema (layers) ordenado por cantidad, locked primero
- **Auto-lock de fondos full-page**: una imagen que cubre ≥80% de la hoja (el fondo del
  insurance agreement) nace bloqueada — estorbaba al editar. Se siembra UNA vez por
  imagen/documento (marcador `aldus-autolock-<id>` persistido): si el usuario la
  desbloquea, no se re-bloquea al recargar.
- **Esquema del Inspector reordenado**: las secciones van por CANTIDAD ascendente
  (imágenes/links arriba, campos/texto — que se hacen "infinitos" — al final), y dentro
  de cada sección los nodos BLOQUEADOS van primero (sort estable) para verlos de una.

### fix(editor): mover un texto ya no cambia sus GAPS — el move puro usa el layout original exacto
`seedHtml` con edición colapsaba TODO el texto a un solo span (estilo dominante, texto
fluido): los gaps entre runs quedaban como espacios naturales de la fuente, no los del
PDF — al mover un segmento con blanks ("____ ____") el gap visible cambiaba. Ahora:
- **Move/resize puro** (texto y estilos intactos) renderiza con `originalLayoutHtml`:
  un span por run, letter-spacing fit y el gap EXACTO del PDF entre runs, escalado por
  el ratio del resize. Mover no altera ni un gap.
- Los word-gaps además COMPENSAN la diferencia entre el ancho real del gap y el espacio
  de la fuente (margin-left delta) — cada run cae en su x exacto también al editar.
- Solo una edición real de texto/estilos pasa al modo "texto fluido" (span por tramo).

### fix(editor): color muestreado — runs que tocan campos NO se muestrean; grises jamás son "color"
Confirmado con logs en vivo (`color=#dcdcdc`, fuentes `VIVO=true STABLE=true`): el color
"buggeado" del texto bajo los inputs era el BORDE antialiaseado del campo derramándose
justo fuera del rect excluido y ganándole al trazo del texto en el muestreo. Ahora:
- Un run cuyo bbox intersecta un widget directamente NO se muestrea (negro default) —
  el chrome del campo siempre contamina.
- Ningún gris (croma < 30) se acepta como color de texto: trazos finos (guiones bajos)
  salen 100% antialiaseados y nunca alcanzan el negro real; un gris claro es chrome.
  Display-only: el bake sigue tomando el color exacto del content stream.
- `fitLetterSpacing` no ajusta tracking si ninguna fuente real está viva, y el overlay
  se re-renderiza cuando una FontFace termina de cargar (re-mide con la fuente real).

### fix(editor): texto arrastrado sobre CAMPOS — color/contenido "buggeado" (tinte del widget-box + sampling contaminado)
Con text fields presentes (insurance agreement), el texto movido se veía de otro color
y con el contenido ensuciado. Dos causas, ninguna en el bake (test de regresión
`widgetAppearance.test.ts` prueba que extirpar texto NO altera /AP, /DA ni /V de los
campos; ids de segmentos estables — drift 0 verificado contra el PDF real):
1. El `.widget-box` (overlay) tenía FONDO permanente (tinte violeta 5%) y los widgets
   van últimos en el DOM (prioridad de mouse) → el texto soltado sobre un campo quedaba
   DEBAJO del tinte. Ahora el fondo del widget solo existe en hover, y un seg-box
   seleccionado/editado/en edición sube a `z-index: 20` (arriba del chrome de widgets).
2. `sampleRunColors` muestreaba el color del run desde píxeles del canvas donde los
   WIDGETS pintan su apariencia: un run solapado con un campo cacheaba el color del
   borde/fondo del campo. Ahora los rects de widgets se excluyen del muestreo.

### fix(editor): los fantasmas perdían TODOS los estilos al soltar — fuentes embebidas bajo nombres ESTABLES
pdf.js registra cada fuente embebida como FontFace bajo su `loadedName` (g_d0_f3), un id
POR DOCUMENTO: el preview crea un doc nuevo por edición y destruye el anterior (sus
FontFace se van), y el segmento extirpado ni siquiera carga su fuente en el doc nuevo.
El fantasma quedaba huérfano → font por defecto, letter-spacing con la métrica
equivocada (texto "deformado", tamaño/color aparente distintos). Fix:
- `fontRegistry.ts` (nuevo): re-registra cada fuente embebida UNA vez por sesión bajo
  `aldus-<postScriptName>` (estable entre documentos) con sus bytes reales
  (`page.commonObjs` + `fontExtraProperties: true` en getDocument).
- `styledDom.family()`: `'<loadedName>', '<aldus-ps>', <bucket fallback>` — si el
  loadedName murió con su documento, el nombre estable responde con los glifos REALES.
- `PdfCanvas`: registra las fuentes del grafo tras cada extracción.

### feat(editor): drag natural — LIFT pre-horneado en la selección, cero pipeline durante el gesto
Rediseño de la interacción de mover texto siguiendo el patrón del annotation editor de
pdf.js (el canvas NO se toca durante un gesto; el elemento viaja como DOM y el render
pesado ocurre fuera del gesto). Antes el bake+render+extracción corrían EN MEDIO del
arrastre → jank y "refresh" a mitad de gesto.
- **Al seleccionar** un texto (aún presente en el canvas) se hornea en background la
  página SIN ese segmento (`bakePending(extraRemoval)`) y PdfCanvas la renderiza a un
  buffer offscreen (`liftBack`) — todo en el tiempo muerto entre click y drag.
- **Al arrancar el drag** (umbral 3px): un único `drawImage` blitea el lift — el
  original se esfuma al "levantarlo". Durante el arrastre no corre NADA (ni bake, ni
  render, ni extracción de grafo): solo el transform CSS del box.
- **Drop con cambio**: commit del edit; el preview re-horneado produce píxeles idénticos
  al lift visible (blit invisible); la extracción del grafo ocurre POST-gesto y el
  fantasma releva al box sin salto. El lift se descarta recién cuando el grafo nuevo
  aterriza (`handleGraph` + `dropPendingRef`).
- **Drop no-op** (soltó donde estaba): sin commit, se restaura el buffer principal.
- `PdfCanvas`: `renderToBackBuffer()` compartido para preview y lift; el canvas visible
  solo recibe blits atómicos. `NodeOverlay.onDragging(segId, active, committed)`.

### fix(editor): double-buffering del canvas — los updates del preview ya no se ven como un "refresh"
`PdfCanvas` renderizaba directo sobre el canvas visible: `canvas.width = …` lo LIMPIA,
así que cada update del preview (extirpación al arrancar un drag, drop, nudge, highlight)
dejaba la página en blanco hasta que pdf.js terminaba — un flash de refresh completo.
Ahora pdf.js renderiza en un canvas fuera de pantalla y el visible se actualiza con UN
`drawImage` atómico al final: la página vieja queda intacta hasta ese frame y lo único
que cambia en pantalla son los píxeles realmente distintos (p. ej. el texto extirpado
que se esfuma). El snapshot y el muestreo de colores leen del back buffer.

### fix(editor): extirpación TEMPRANA al arrancar el drag — sin duplicado y sin rectángulo blanco, nunca
El velo post-drop seguía siendo un rectángulo blanco visible (nodo quieto durante el
arrastre → velo al soltar → recién ahí se iba). Enfoque definitivo: el preview extirpa
el segmento APENAS ARRANCA el gesto, no al soltar:
- `EditorPage`: estado `extirpating` (ids en arrastre) + callback `onDragging(segId,
  active)` — cachea el nodo en `segCache` y lo suma a los `textRemovals` del bake local
  (aunque todavía no exista edición). Al soltar, el commit del edit y el fin del arrastre
  van en el mismo lote de estado: el re-bake produce bytes idénticos → cero salto visual.
- `SegmentBox`: dispara `onDragging(true)` al superar el umbral de movimiento,
  `onDragging(false)` en drop/cancel. El velo (`seg-mask` de texto) se ELIMINÓ del todo:
  el único transitorio es el original desvaneciéndose una fracción de segundo al arrancar
  el drag, mientras el bake local aterriza.
- `@aldus/core`: `segmentOriginal(seg)` extraído de `mergeSegmentEdit` y exportado (el
  editor lo usa para armar el removal de un segmento aún sin edición — sin duplicar lógica).

### fix(editor): duplicado transitorio al primer mover — velo hasta que el preview extirpe + warm-up del bake
El bake extirpador del preview es ASÍNCRONO: al soltar el drag, el overlay ya dibuja el
texto en la posición nueva pero el canvas viejo sigue mostrando los glifos originales
hasta que el re-bake aterriza (la primera vez ~1s: pagaba el `import()` dinámico de
pdf-lib). Se veía "duplicado" y quedaba en la posición original. Ahora:
- `SegmentBox` recibe `inPreview` (¿el segmento sigue en el grafo extraído?): mientras
  esté (bake en vuelo), un velo esmerilado tapa la posición original; cuando el preview
  nuevo llega, el segmento pasa a fantasma y el velo cae solo. También aplica al drag
  sin edición previa y al texto eliminado pendiente.
- `EditorPage` precalienta `@aldus/core/bake` al montar — la primera edición ya no paga
  la carga del chunk.

### fix(editor): sin mask blanco en la posición original — el preview EXTIRPA los originales (fantasmas)
El texto editado entra al preview horneado local: por cada `SegmentEdit` pendiente se pasa
un clon remove-only a `bakeSegmentEdits`, así los operadores ORIGINALES desaparecen del
canvas y en la posición original no queda NADA (ni mask blanco, ni velo) — igual que ya
pasaba con imágenes/widgets. El estado editado lo dibuja el overlay como box "fantasma"
transparente:
- `extractGraph.ts`: ids de línea/segmento por GEOMETRÍA (`p{n}-y{baseline}` / `-x{x}`),
  estables cuando otros segmentos se extirpan del preview (antes eran por índice y se
  corrían todos).
- `EditorPage`: `segCache` (ref) guarda el nodo original al primer edit; `phantomSegments`
  (useMemo por página) los inyecta a `PdfCanvas`→`NodeOverlay`, que los agrega a los del
  grafo (dedupe por id). `findSeg` (grafo ?? cache) para Delete/nudge por teclado.
- `NodeOverlay`: fuera el `seg-mask` de segmentos y el velo rojo de "texto eliminado"
  (eliminado = extirpado del preview, no se dibuja nada; Ctrl+Z restaura). `.seg-mask`
  queda solo para el arrastre de imágenes/widgets.

### fix(editor): texto movido transparente + velo esmerilado + campos creados con estilo moderno
- Un segmento editado (sin estar en edición) ya NO lleva fondo blanco: el texto flota
  TRANSPARENTE sobre lo que haya debajo (imagen incluida) — fiel a lo que hará el bake.
  El blanco queda solo mientras se EDITA (legibilidad del contentEditable).
- La máscara sobre los glifos originales pasa de bloque blanco duro a velo esmerilado
  (rgba .93 + blur): invisible sobre página blanca, atenúa sin cuadrado brutal sobre imagen.
- Los campos CREADOS por Aldus ahora nacen con apariencia moderna (borde fino gris-azulado
  1pt + fondo apenas tintado, font 10 en text fields) en vez de la caja negra default de
  pdf-lib — consistentes con los AcroForm de templates modernos.

### fix(editor): LOOP de re-render (pantalla parpadeando) + CLAUDE.md del proyecto
`resolveHighlights` (que captura `graph`) estaba en las deps del effect del preview:
render → extract → graph nuevo → effect → nuevo PDF → render… loop infinito = todo
parpadeando. Ahora lee por REFS (identidad estable, jamás en deps) y el rerun por "movió
un segmento con highlight atado" usa un derivado quirúrgico (`editsAffectingHighlights`,
null si no hay highlights atados). Regla documentada en CLAUDE.md: el effect del preview
no puede depender de `graph` ni de funciones que lo capturen.
+ **CLAUDE.md** nuevo (~100 líneas): arquitectura completa (modelo/bake/editor/gotchas)
+ queries recomendadas de `megabrain ask` — repo indexado en megabrain.

### fix(editor): color POR SELECCIÓN, highlights que siguen al texto, y des-boldear de verdad
- **Color a la selección**: `StyledRun` ahora tiene `color` por tramo, end-to-end —
  `setStyleRange` en core (corta el rango y aplica color/estilo, testeado), los spans
  llevan `data-c`, la serialización lo preserva, y el bake lo emite por tramo (prioridad:
  color del tramo > override del segmento > color del op original). El swatch de la toolbar
  aplica a la selección cuando el editor está abierto.
- **El highlight sigue al texto**: lleva `segmentId` y su rect se resuelve contra la
  geometría EFECTIVA (con la edición pendiente) al previsualizar y al aplicar — mover el
  grafo mueve el resaltado; se acabó la máscara amarilla stale en la posición vieja.
- **Des-boldear un segmento 100% bold**: el preview usaba la familia embebida (bold) por
  falta de un run regular del cual tomar la fuente — ahora, sin match exacto de estilo, cae
  al fallback del bucket con font-weight/style sintéticos del tramo (igual que hará el bake
  con la sustitución estándar).

### fix(editor): editor huérfano, toolbar durante la edición, y drag de imagen full-page
- **Seleccionar otro nodo CIERRA el editor abierto** (con commit): el preventDefault de los
  pointerdown impedía el blur natural, y la B de la toolbar del nodo nuevo le pegaba al
  editor viejo. `selectNode` fuerza el blur del editable activo antes de cambiar la
  selección (+ guard: solo el box editando Y seleccionado atiende el evento de estilo).
- **La toolbar flotante queda visible mientras editás** y sus B/I reflejan el estilo BAJO
  LA SELECCIÓN (selectionchange → selectionStyle) — marcás una palabra, la barra muestra su
  estado y el toggle aplica solo a esa parte.
- **Drag de imagen full-page sin duplicado**: si la imagen no se puede enmascarar (≥80% de
  la página), el ghost del drag es solo un marco punteado — sin píxeles duplicados; al
  soltar, el preview local renderiza la verdad.

### feat(editor): PREVIEW HORNEADO EN EL BROWSER — adiós duplicados/máscaras fantasma
El cambio de arquitectura que mata la familia entera de bugs de preview (duplicados al
mover, cajas blancas remanentes, "recién se ve al Aplicar"): las ediciones pendientes de
IMÁGENES, CAMPOS y HIGHLIGHTS se hornean **localmente en el browser** (el mismo bake de
core — pdf-lib es isomórfico, import dinámico code-split) sobre una copia de los bytes, y
se renderiza ESO. WYSIWYG real: la imagen movida se ve movida (una sola), la borrada
desaparece al instante, el input movido no deja caja blanca. El server no se toca hasta
Aplicar. Durante el GESTO de drag se mantienen los píxeles viajando + máscara; al soltar,
el preview re-renderiza la verdad. Ctrl+Z restaura (los nodos eliminados vuelven por undo).
- **Highlight ahora ACUMULA** (preview local + se escribe con Aplicar, como pediste) — el
  endpoint de bake acepta `highlights[]` y los aplica en cadena.
- **Formato arriba, no en el sidebar**: la toolbar flotante del texto ahora tiene B/I,
  tamaño (pt), color del texto, alineación, resaltador (+color), link y eliminar. El panel
  derecho quedó minimal: contenido, familia/AV/escala (avanzado), posición y restaurar/
  revertir — listo para volverse el panel de propiedades de CAMPOS (key/label/firma).

### fix(color): editar un nodo ya NO pierde el color (ni el bake ni el display)
Editar el contenido de un texto cuya fuente embebida no cubre los caracteres nuevos (o no
tiene /ToUnicode) cae al fallback de fuente estándar — que **pintaba todo en negro**,
perdiendo el color original. Ahora:
- **Bake (autoritativo)**: el fallback preserva el color del content stream original
  (`rawFillToRgb` parsea rg/g/k/sc del op) salvo override explícito. Test: título rojo →
  editar texto → el bloque horneado emite el rojo, no `0 0 0 rg`.
- **Display**: `sampleColor.ts` muestrea el color de cada run del canvas ya renderizado
  (pdf.js no expone color por run) — el más "tinta" del bbox. Se usa en el overlay (el
  texto editado se ve con su color real), el contenedor editable y el default del color
  picker del panel. Best-effort, solo para preview; el bake toma el color exacto.
La fuente: para glifos fuera del subset la sustitución estándar (Helvetica≈Arial, bucket +
bold/italic) es inherente al formato — Acrobat hace lo mismo; el color ahora sí se conserva.

### fix(editor): unlock accesible, drag de widgets con píxeles, y NADA se guarda solo
- **Unlock**: candadito clickeable en cada fila del esquema (Campos/Imágenes/Texto) — se
  bloquea/desbloquea con un click, sin necesidad de seleccionar el nodo (que estando
  bloqueado no responde en el lienzo).
- **Drag de inputs con píxeles**: mismo bug de "se mueve el frame y el elemento queda" —
  ahora el widget viaja con los PÍXELES reales (crop del snapshot) y su lugar original se
  enmascara. Las imágenes también muestran píxeles DURANTE el drag (antes solo tras soltar),
  con máscara del original salvo imágenes casi full-page (taparían el texto).
- **Se acabó el auto-save**: mover/escalar/eliminar imágenes y campos ya NO hornea al
  instante — TODO acumula y se escribe únicamente con el botón Aplicar (contador = texto +
  imágenes + campos). El historial undo/redo ahora es UNIFICADO sobre los tres tipos.
  Etiquetas "se elimina al Aplicar" + Restaurar campo en el panel.

### feat(editor): undo/redo, toolbar flotante en imágenes/campos, highlight visible + color picker
- **Undo/Redo** de las ediciones de texto: `Ctrl/Cmd+Z` deshace, `Ctrl+Shift+Z`/`Ctrl+Y`
  rehace (historial de snapshots del map de ediciones, hasta 100), + botones en la top bar.
  Se limpia al Aplicar.
- **Sin "amarillito"**: un segmento/imagen editado ya NO muestra el borde ámbar en el
  lienzo — se ve normal (el texto nuevo sobre fondo blanco); el estado pendiente vive solo
  en el panel y el botón Aplicar. La máscara funcional (tapa los glifos originales) se
  mantiene.
- **Toolbar flotante también en imágenes y campos**: alinear izq/centro/der, orden Z
  (imágenes) y eliminar, arriba del objeto seleccionado — igual que el texto.
- **Highlight arreglado**: era invisible (amarillo pálido por multiply+0.45 sobre blanco);
  ahora amarillo marcador saturado a 0.55 de opacidad, **con color picker** en la toolbar
  flotante (persistido). Verificado: era correcto a nivel de PDF pero imperceptible.

### feat(editor): toolbar flotante con alineación + listas reales + fixes de drag y estilo
- **Toolbar flotante arriba del texto seleccionado** (estilo Sejda/Acrobat): alinear
  izquierda/centro/derecha (x relativo a los márgenes de la página), B/I (respetan la
  selección si estás editando), resaltar, link y eliminar.
- **Listas de verdad**: `nextListMarker` en core — **Enter al final de un ítem crea el
  siguiente con el marcador incrementado** ("3." → "4.", "b)" → "c)", "B." → "C.", bullets
  se repiten), con la fuente y tamaño del ítem actual. Tests de todos los marcadores.
- **Texto nuevo con el estilo de la página**: el ¶/viñeta nacen con la MEDIANA de tamaño y
  el bucket de fuente dominante del grafo — no más Helvetica 11 que desentona.
- **Drag arreglado**: (1) arrastrar YA NO exige pre-seleccionar (pointerdown selecciona y
  arma el drag en el mismo gesto — texto, imagen y campo); (2) al arrastrar un segmento el
  box viaja con su texto visible y una máscara tapa los glifos originales (antes "se movía
  el frame y el texto quedaba").
- **Sidebar agrupado por categoría** (Texto / Forms / Objetos / Doc) con tooltips en todo.
- **Select editable**: panel con las opciones actuales (una por línea, extraídas del PDF)
  → setOptions vía pdf-lib. **Radios**: "Agregar opción al grupo" (mismo nombre = mismo
  grupo, exclusión mutua) + eliminar grupo completo. Tests (28/28 core).

### feat(editor): REDISEÑO estilo Acrobat Pro — Tailwind + lucide-react, cero prompts
Rediseño completo del shell y el panel de propiedades: Tailwind v4 (`@tailwindcss/vite`) +
lucide-react, sin emojis. **Shell**: top bar minimalista (nav de página, zoom, Aplicar),
**rail vertical de herramientas** a la izquierda (seleccionar / insertar texto·viñeta·campos·
firma·imagen / marca de agua·enc-pie) con iconos y tooltips, área de página centrada con
sombra, **panel de propiedades** derecho en secciones (CONTENIDO / FORMATO / POSICIÓN /
ACCIONES / ESTADO) estilo Acrobat. **Se eliminaron TODOS los `window.prompt/confirm/alert`**
(el desastre de Enc/Pie): ahora hay modales reales — HeaderFooterDialog (encabezado+pie+
checkbox de numeración en un solo modal), WatermarkDialog y LinkDialog con validación. Los
avisos son un Toast efímero. Primitivos reusables en `ui/primitives.tsx` (Button, Toggle,
NumberInput, Select, ColorSwatch, Modal, Section, Toast). El overlay de nodos conserva sus
clases (restyled coherente con los tokens: acento azul, ámbar=pendiente, teal=campos).

### feat: edición completa — texto nuevo, borrar todo, formato avanzado, highlight, links, watermark, enc/pie
- **Insertar texto**: paleta ¶ (párrafo con wrap hasta el margen) y • (viñeta) — al re-extraer
  son segmentos normales del grafo, editables con todo lo existente.
- **Eliminar cualquier nodo**: botón Eliminar/Restaurar en el panel de texto (el bake extirpa
  los ops) + tecla **Delete/Backspace** para el nodo seleccionado (texto acumula; imagen y
  campo al instante).
- **Formato avanzado estilo Acrobat** en el panel de texto: **AV** (tracking, Tc), **T↔**
  (escala horizontal, Tz) y **color** — overrides del SegmentEdit que el bake re-emite a
  nivel de operadores (funcionan también en el camino verbatim, sin tocar los bytes).
- **Resaltar** (rect multiply+alpha sobre el bbox del segmento, texto legible) y **Link**
  (annotation /Link con URI sobre el segmento; extracción en graph.links + borrar por rect).
- **Marca de agua** (diagonal, todas las páginas, tamaño adaptado al texto) y
  **Encabezado/Pie** con numeración "Página N de M". Endpoint único POST /:id/ops.
- 4 tests nuevos (25/25 core). Alineación y line-height quedan para la fase de reflow de
  párrafos (requieren la caja de párrafo como unidad).

### feat: LOCK de nodos + paleta de INSERTAR (campos, firma, imágenes)
**Lock**: cualquier nodo (imagen/campo/segmento) se puede bloquear desde su panel — un
nodo bloqueado es invisible al mouse (ni hover, ni selección, ni drag; pointer-events
none); se ve con 🔒 en las listas del Inspector y se desbloquea desde ahí. Persistido por
documento en localStorage. **Insertar**: paleta en la toolbar (T ☑ ◉ ▾ ✍ 🖼) → modo
colocación (crosshair, Esc cancela) → click en la página crea el nodo al instante:
campos AcroForm vía pdf-lib (text/checkbox/radio/select) con nombre único autogenerado
(texto_1, check_1…), campo de FIRMA armado a mano a nivel de diccionario (FT /Sig — el
`T` como PDFString, no PDFName: pdf.js lee el fieldName de ahí), e imágenes PNG/JPEG
subidas por file-picker, colocadas en el click con aspecto preservado (máx 240pt).
Endpoints POST /:id/fields y /:id/images. 2 tests nuevos (21/21 core).

### feat: Z-ORDER preservado + WIDGETS AcroForm editables
**Z-order**: la re-emisión del bake ahora es un REEMPLAZO IN-PLACE en el stream (Splice
{start,end,text}), no extirpar+append — una imagen de fondo movida sigue quedando DEBAJO
del texto. Sutileza clave: el reemplazo ejecuta dentro del CTM vigente (los q/cm originales
quedan alrededor), así que la matriz emitida es RELATIVA (M_rel = M_abs × inv(CTM)) — se
agregó `invert()` y el CTM registrado por op. Test que verifica el orden de ops en el
stream horneado. **Widgets**: `WidgetNode` en el grafo (getAnnotations de pdf.js: tipo
text/checkbox/radio/select/lista/botón/firma, nombre de campo, rect); overlay con box
punteado teal — seleccionar/arrastrar/redimensionar (grip) — e Inspector con propiedades
(tipo, nombre, geometría numérica, eliminar campo); sección "Campos" en el grafo. Bake vía
/Annots: reescritura del /Rect del widget (pdf-lib setRectangle + updateFieldAppearances)
o removeField; aplicación INSTANTÁNEA como las imágenes. 3 tests nuevos (18/18 core).

### feat: IMÁGENES — extracción, edición y bake (Tier 1)
El grafo ahora incluye `ImageNode` (extraído del operator list de pdf.js: cada paint de
XObject con su CTM → bounding box; detecta rotación). Overlay: box por imagen con
seleccionar/arrastrar (mover)/grip (escalar con top fijo)/eliminar; una imagen movida
muestra frame fantasma en el destino (el pixel real aparece al Aplicar); eliminada = máscara
blanca. Inspector: panel de geometría numérica + eliminar/restaurar/revertir, y sección
"Imágenes" en la lista del grafo. Bake: el walker registra los `Do` de XObjects con su CTM;
mover/escalar extirpa el Do y re-emite `q cm /Nombre Do Q` con la matriz nueva (preserva
flips; el ancla corrige escalas negativas); eliminar solo extirpa el Do. Imagen rotada =
warning honesto (v1 no la toca). Localización por geometría (no por nombre de recurso), con
tolerancia relativa. 3 tests nuevos del ciclo crear→extraer→bake→re-extraer (14/14 en core).
Verificado contra el Insurance Agreement real (9 páginas, imagen de fondo full-page + texto
con negritas).

### fix(core+editor): el estilo es POR TRAMO — quitar bold a una parte no pisa el resto
Bug de diseño: bold/italic eran overrides de TODO el segmento, así que en un nodo mixto
("**Total:** 125.00") togglear B aplicaba/quitaba la negrita al segmento entero. Ahora el
estilo vive en `StyledRun {text, bold, italic, dx}`: `SegmentEdit.runs` guarda los tramos,
`originalStyledRuns(seg)` deriva los tramos originales (única fuente para el noop-check), y
el panel muestra **cada tramo con sus propios B/I** además de los toggles globales. En el
DOM editable cada span lleva `data-b`/`data-i` (la fuente embebida bold no "se ve" bold para
el browser); la serialización preserva el estilo por tramo y mide el `dx` de cada uno. El
bake re-codifica **cada tramo con el recurso de fuente del propio PDF que ya usaba ese
estilo** (mapa estilo→fuente por x contra los ops); si el estilo es nuevo o el subset no
alcanza, sustitución estándar explícita por tramo. Test nuevo: PDF con bold+regular en un
segmento → quitar bold de una parte → re-extraer y verificar que ningún tramo quedó bold
y el resto intacto (6/6).
Las ediciones ahora se aplican AL PDF de verdad, sin paint-over: tokenizador completo del
content stream (`bake/tokenizer.ts`, strings/hex/arrays/dicts/inline-images con offsets de
bytes), máquina de estado de texto ISO 32000 §9.4 (`bake/textWalk.ts`: Tm/Td/TD/T*/TL/Tf/
q/Q/cm + color de relleno; los shows encadenados sin reposicionar se marcan `stale` y NO se
tocan), y el orquestador (`bake/bake.ts`, pdf-lib para plumbing): (A) mover/escalar = los
ops originales se EXTIRPAN y se re-emiten VERBATIM (mismos bytes/fuente/color/kerning TJ)
con la matriz reubicada — pixel-perfect; (B) texto nuevo = re-codificado con la fuente
ORIGINAL vía el mapa inverso del /ToUnicode (`bake/toUnicode.ts`); (C) cambio de familia/
estilo o subset insuficiente = fuente estándar embebida con warning explícito (política
Acrobat). Lo ilocalizable se salta con warning — nunca se toca lo que no se entiende.
Tests vitest reales (crear pdf-lib → extraer pdfjs → bake → re-extraer y verificar
geometría). Server: `POST /:id/bake` (backup .bak). UI: botón "Aplicar al PDF" (recarga el
doc y limpia las ediciones), nudge con flechas (Shift=5pt), grip de resize proporcional.

### fix(editor): el texto ya no "salta" de tamaño/espacio al editar
Dos causas: (1) texto tipeado FUERA de los spans sembrados (bordes del box, select-all)
heredaba el system font del UI → ahora el contenedor editable hereda la fuente/tamaño
dominante del segmento; (2) el PDF posiciona con ajustes que el browser no reproduce
(Tc/Tw/Tz, TJ de justificado) → fit horizontal a lo pdf.js-text-layer: cada run se mide
con canvas.measureText y la diferencia contra su ancho PDF real se reparte como
letter-spacing (con clamp anti-fallback), así el overlay ocupa EXACTAMENTE el espacio
original sin deformar glifos.

### fix(editor): los gaps sobreviven a la edición — SEGMENTOS anclados (modelo Acrobat)
El commit leía `innerText` y los gaps sembrados como `margin-left` (solo visuales) morían ahí
(signwax los cuantizaba a NBSPs — el hack). Research (Acrobat/Foxit, ProseMirror/Lexical/CKEditor,
pdfminer/PDFBox) → decisión: **el gap de columna/tab no se representa: es la FRONTERA entre dos
`SegmentNode` independientes, cada uno anclado a su x** (el modelo de text boxes de Acrobat).
Jerarquía nueva en core: run → segmento (LA unidad de edición) → línea. Umbrales de la industria
en `core/tokens.ts` (única fuente de verdad, la reusará el bake): gap > 2×ancho-medio-de-char =
frontera de segmento (char_margin de pdfminer); > 0.5× = espacio de palabra; menos = kerning.
Beneficios: tab-stop gratis (editar la izquierda NO mueve la columna derecha), `innerText` vuelve
a ser una serialización válida (solo texto plano por segmento), y cero atoms `contenteditable=false`
— el research documentó que son un pantano inter-browser (caret invisible, Backspace roto en
Firefox, ZWSPs). Se descartó el approach intermedio de gap-atoms implementado horas antes.
`LineEdit` → `SegmentEdit` (texto + snapshot del original con su x de anclaje).

### feat: rewrite desde 0 — grafo tipado + editor + server (fases 1–3 del UI)
Primera implementación real, sin herencia de hacks de signwax:
- **`@aldus/core`**: modelo tipado del grafo (`TextRunNode`/`LineNode`/`PageGraph`),
  extracción con geometría EXACTA (baseline de la text matrix, fontSize por `hypot(c,d)`,
  ascent/descent del font embebido vía `commonObjs`, soporte de texto rotado), agrupado
  en líneas por baseline, y `coords.ts` como única conversión PDF↔CSS. Core no importa
  pdfjs-dist (tipado estructural `PdfJsPage`) — corre en browser y Node.
- **`@aldus/server`** (:4100): upload de PDFs (multipart, validación de header), listar,
  servir bytes, persistir ediciones como JSON. El bake llega con la fase de escritura de core.
- **`@aldus/editor`** (:5190, Vite+React): Paso 1 upload (dropzone + lista), Paso 2 render
  (canvas HiDPI, doble-buffer de render task, zoom persistente, pager), Paso 3 boxes:
  overlay de nodos posicionado por geometría real; **el texto editable usa el FontFace
  embebido que pdf.js registra (`font.loadedName`) con `line-height = ascent−descent`**,
  así la baseline del browser cae sobre la del PDF y el click NO desacomoda nada. Click =
  seleccionar, doble click = editar in situ (el box enmascara el glifo original y muestra
  el texto vivo), Inspector con el grafo completo (líneas, runs, fuente PostScript real,
  embebida/estándar, geometría). Guardar → `PUT /edits`.

### feat(agent): spike verde del Claude Agent SDK
`packages/agent/src/spike.mjs`: tool custom (`tool()` + `createSdkMcpServer`) invocado por
Sonnet leyendo un grafo de juguete, autenticado con la suscripción de Claude Code (sin
`ANTHROPIC_API_KEY`). Diagnóstico del experimento viejo: bug `tool_use ids must be unique`
del SDK 0.1.x con `Task` paralelas; en 0.3.x está corregido y la tool es `Agent`.
