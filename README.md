# Aldus

**Aldus** es un agente de edición de PDF **pixel-perfect**: parsea el grafo de contenido
real del PDF (operadores de texto, gráficos, imágenes, forms) y lo edita **in situ** —
no pinta blanco encima ni redibuja con fuentes aproximadas. El agente (Claude Agent SDK,
Sonnet 5) ve el grafo del documento en su contexto y lo edita como si editara código.

> Aldus Manutius inventó la itálica; Aldus Corp. creó PageMaker, el padre del
> desktop publishing. Este Aldus edita PDFs con esa misma obsesión tipográfica.

## Por qué existe

Extraído de `~/signwax` (`packages/pdfkit` + el editor de `apps/app`). La versión
original funcionaba pero con dos límites de fondo:

1. **No es pixel-perfect.** `applyPdfEdits` nunca toca los operadores de contenido
   (`Tj`/`TJ`) — enmascara con un rect blanco y redibuja encima con Helvetica estándar
   (pdf-lib). Métricas distintas a la fuente embebida, baseline aproximada
   (`baseline − height·0.3`), texto que "salta" al engancharse el `contentEditable`
   (el browser layoutea con SUS fuentes, no con la del PDF).
2. **El LLM era un solo tool-call** (`plan_edits`, SDK crudo + API key), sin loop de
   agente ni verificación. Lo que SÍ funcionaba bien — y es la tesis de Aldus — es
   darle al modelo el grafo serializado con geometría (`<line x y w h>`) para que
   edite el documento como código.

## Arquitectura (monorepo pnpm)

```
packages/core    @aldus/core    — el motor: modelo tipado del grafo (TextRunNode/LineNode
                                  → PageGraph), extracción con geometría exacta (baseline
                                  de la text matrix, métricas del font embebido), helpers
                                  de coordenadas (pdfRectToCss, ÚNICA conversión). Próximo:
                                  edición in-place del content stream, save incremental.
packages/agent   @aldus/agent   — el agente: Claude Agent SDK + Sonnet, corre con la
                                  suscripción de Claude Code (sin API key). Tools sobre
                                  @aldus/core; el grafo del PDF entra al contexto y el
                                  agente emite ediciones verificables. (spike verde)
apps/editor      @aldus/editor  — el editor (Vite+React, :5190): upload → render pdf.js →
                                  overlay de nodos. Los boxes usan el FontFace EMBEBIDO
                                  que pdf.js registra (font.loadedName) + line-height =
                                  ascent−descent ⇒ la baseline del browser cae sobre la
                                  del PDF (sin corrimiento al click). Click = seleccionar,
                                  doble click = editar in situ; Inspector muestra el grafo.
apps/server      @aldus/server  — Express (:4100): upload de PDFs, servir bytes, persistir
                                  ediciones (el bake sobre el content stream llega en core).
```

Dev: `pnpm install && pnpm dev` (server :4100 + editor :5190).

## Roadmap (en orden, sin saltear)

1. **Grafos de texto** — parsear y reescribir operadores de texto in situ, pixel-perfect.
   UI: boxes que NO se desacomodan al click. ← *foco actual*
2. **Imágenes** — XObjects: mover, reemplazar, escalar.
3. **Forms** — AcroForm nativo: widgets como nodos del grafo.
4. **Firmas** — cajas de firma, placement anclado.
5. **LLM** — el agente completo sobre todo lo anterior.

## Origen (mapa de extracción desde signwax)

| De signwax | Hacia | Notas |
|---|---|---|
| `packages/pdfkit/src/{extractPages,lineExtract}.ts` | `@aldus/core` | extracción de líneas + geometría; base del grafo |
| `packages/pdfkit/src/{edit,runEditor,reflowParagraph}.ts` | `@aldus/core` | se REEMPLAZA el paint-over por edición real de operadores |
| `apps/app/src/client/lib/pdfParagraphs.ts` | `@aldus/ui` | extractor browser-side (runs estilados + field chips) |
| `apps/app/src/client/components/{EditableTextLayer,PdfPlacer}.tsx` | `@aldus/ui` | el overlay editor; se corrige el corrimiento |
| `packages/pdfkit/src/{aiEdit,llm}.ts` | `@aldus/agent` | se REEMPLAZA por Claude Agent SDK + suscripción |

Lo que NO viene: sealing, versioning, scan/validación, Wax — eso queda en signwax,
que pasa a consumir Aldus.
