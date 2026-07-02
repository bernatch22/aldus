# Changelog — Aldus

El más reciente arriba; fecha `YYYY-MM-DD`.

## 2026-07-02

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
