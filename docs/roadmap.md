# Roadmap y origen

> Aldus Manutius inventó la itálica; Aldus Corp. creó PageMaker, el padre del
> desktop publishing. Este Aldus edita PDFs con esa misma obsesión tipográfica.

## Roadmap (tiers según el research de editores pro — Acrobat/Foxit/PDF Expert/Nitro)

Hecho ✅: grafo tipado (run→segmento→línea), editor por segmentos anclados (gaps =
fronteras, tab-stop gratis), fuente embebida + fit por letter-spacing, object
properties (texto/B/I/tamaño/familia/x/baseline), mover por drag + nudge, grip de
resize, **BAKE del content stream con tests** (extirpar ops + re-emitir verbatim;
texto nuevo re-codificado vía /ToUnicode; sustitución explícita si el subset no
alcanza), imágenes (insert/move/resize/delete/z-order), form fields (7 tipos
AcroForm), highlights, links, watermark/header-footer, undo/redo unificado,
preview local WYSIWYG, **agente LLM** (Claude Agent SDK + suscripción) con
streaming en vivo.

- **Tier 0 — restante:** reflow multi-línea DENTRO del bounding box del párrafo
  (hoy el bake es por segmento/línea); exponer la **matriz de fuentes de 3 niveles**
  en el picker (embebida-subset: solo atributos / sustitución con warning — el bake
  ya la implementa por abajo).
- **Tier 2 — edición seria (restante):** sub/superscript; **Link/Join/Split de
  segmentos** (el feature estrella de Foxit — natural con nuestro modelo);
  smart guides + align/distribute.
- **Tier 3 — anotaciones (/Annots, ortogonal al bake):** ✅ highlights (capa
  /Highlight real, movible/borrable después de guardar); ✅ links movibles/
  borrables como edición (LinkBox + LinkEdit); restante: strikeout/squiggly
  anclados a quads de segmentos; shapes; FreeText.
- **Tier 5 — pro batch:** page numbers, crop/rotate/opacity de imagen,
  redacción (exige bake maduro), Bates.
- **Integración signwax:** signwax pasa a consumir `@aldus/core` + `@aldus/agent`
  (punto 5 del backlog original).

Clave arquitectural del spec (ISO 32000): **`/Contents` (content stream) y `/Annots`
son capas distintas** — el bake solo aplica a la primera; el grafo distingue
content-nodes de annotation-nodes desde el modelo.

## Origen (mapa de extracción desde signwax)

| De signwax | Hacia | Notas |
|---|---|---|
| `packages/pdfkit/src/{extractPages,lineExtract}.ts` | `@aldus/core` | extracción de líneas + geometría; base del grafo |
| `packages/pdfkit/src/{edit,runEditor,reflowParagraph}.ts` | `@aldus/core` | se REEMPLAZÓ el paint-over por edición real de operadores |
| `apps/app/src/client/lib/pdfParagraphs.ts` | editor | extractor browser-side (runs estilados + field chips) |
| `apps/app/src/client/components/{EditableTextLayer,PdfPlacer}.tsx` | editor | el overlay editor; se corrigió el corrimiento |
| `packages/pdfkit/src/{aiEdit,llm}.ts` | `@aldus/agent` | se REEMPLAZÓ por Claude Agent SDK + suscripción |

Lo que NO vino: sealing, versioning, scan/validación, Wax — eso queda en signwax,
que pasa a consumir Aldus.

La motivación original: la versión signwax **no era pixel-perfect** (`applyPdfEdits`
enmascaraba con un rect blanco y redibujaba con Helvetica — métricas distintas,
baseline aproximada, texto que "saltaba" al click) y el LLM era un solo tool-call
sin loop de agente. La tesis que SÍ sobrevivió: darle al modelo el grafo
serializado con geometría para que edite el documento como si fuera código.
