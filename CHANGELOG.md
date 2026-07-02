# Changelog — Aldus

El más reciente arriba; fecha `YYYY-MM-DD`.

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
