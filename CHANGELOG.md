# Changelog — Aldus

El más reciente arriba; fecha `YYYY-MM-DD`.

## 2026-07-02

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
