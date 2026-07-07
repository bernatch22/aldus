# @aldus/agent — CLI + agente LLM sobre el grafo de un PDF

Un agente (Claude Agent SDK + Sonnet) que tiene el **contenido completo del PDF
embebido en su prompt** —el grafo de `@aldus/core`, todas las páginas— y con eso
**responde preguntas** sobre el contenido o **hace cambios** (que se hornean sobre
el PDF con el mismo bake que el editor).

## Idea de diseño

- El documento entero (texto con id/posición/tamaño, imágenes, campos, resaltados,
  links) se serializa y va **dentro del system prompt**. No hay tool de lectura: el
  agente ya ve todo y ancla sus ediciones a los `id` reales del grafo.
- **Paridad con el editor humano**: las tools cubren lo mismo que la UI.
  - Texto existente: `edit_text`, `move_text`, `set_text_color`, `set_text_size`, `delete_text`.
  - Imagen existente: `move_image`, `delete_image`.
  - Resaltar: `highlight_text` (sobre un id de texto); sobre resaltados ya creados
    `set_highlight_color`, `delete_highlight`.
  - Links: `add_link` (sobre un id de texto → URL), `delete_link`.
  - Crear: `add_text`, `insert_image` (desde una ruta local), `add_watermark`,
    `add_header_footer`, `add_form_field`. Campos existentes: `move_field`, `delete_field`.
  - **Formularios**: cada campo se serializa con su VALOR actual (`= "…"` o
    `(vacío)`) → el agente "extrae"/lee el form respondiendo, y **completa** con
    `fill_field(fieldName, valor)`.
- Dos clases de cambio (igual que el editor): **ediciones** de nodos existentes
  (Maps de `*Edit` con las MISMAS funciones de merge que la UI) y **creaciones** de
  nodos nuevos (una cola aplicada DESPUÉS del bake, cada una vía `createNodes`). El
  `highlight`/`link` "sobre un texto" resuelve su rect al hornear desde la geometría
  EFECTIVA del segmento → sigue al texto aunque el agente lo haya movido antes.
- Coordenadas: puntos PDF, origen abajo-izquierda. Al guardar, las imágenes
  movidas van al frente (como el editor), si no quedarían tapadas.

## Uso

El prompt va **posicional** o con `-p` (el flag gana). `--open` abre el PDF
resultante (o el original si no hubo cambios) con el visor del SO.

```bash
# Preguntar (posicional)
aldus documento.pdf "¿Cuál es el plazo del contrato?"

# Editar, guardar y abrir
aldus documento.pdf "Resaltá los montos y poné una marca de agua BORRADOR" --open

# Elegir la salida
aldus documento.pdf "Cambiá el título por 'BORRADOR'" -o documento-editado.pdf

# Chat interactivo (multi-turno; /save [ruta] · /edits · /exit)
aldus documento.pdf
```

### Formularios (determinístico, sin LLM)

```bash
aldus formulario.pdf --fields                                 # volcar campos + valores (JSON)
aldus formulario.pdf --fill '{"nombre":"Ana","acepta":"true"}' --open
aldus formulario.pdf --fill datos.json -o completado.pdf      # desde un archivo
```

`--fields`/`--fill` NO usan el LLM: mapeo exacto por nombre de campo. También como
**API programática** (`@aldus/core/bake`): `readFormFields(bytes)` → `FormField[]`
(con el valor actual) y `setFieldValues(bytes, { campo: valor })` → `{ pdf, applied,
warnings }` (valida opciones de select/radio y respeta read-only). El agente por
lenguaje natural usa la misma `setFieldValues` por debajo.

Tras `pnpm install`, el binario `aldus` queda linkeado en `node_modules/.bin`
(o corré `pnpm --filter @aldus/agent aldus …`).

## Auth

Usa la **suscripción de Claude Code**: corré **sin** `ANTHROPIC_API_KEY`
(`env -u ANTHROPIC_API_KEY …`). Modelo override con `ALDUS_MODEL`.

## Módulos

| Archivo | Qué hace |
|---------|----------|
| `graph.ts` | Carga el PDF en Node (pdf.js legacy) y extrae el grafo de todas las páginas. |
| `serialize.ts` | Serializa el grafo compacto para embeber en el prompt. |
| `session.ts` | `EditSession`: acumula ediciones (merge de `@aldus/core`) + creaciones (cola post-bake) y hornea todo. |
| `tools.ts` | Las tools de mutación del Agent SDK (paridad con el editor), atadas a una `EditSession`. |
| `agent.ts` | Arma el system prompt (con el grafo) y corre un turno (`resume` = multi-turno). |
| `cli.ts` | El CLI: one-shot y chat. |

## Límite conocido

Todo el grafo va en el prompt → documentos MUY grandes pueden acercarse al límite
de contexto (un PDF de ~30 páginas ≈ 35k tokens). Para esos, el próximo paso es
paginar/seleccionar el subconjunto relevante en vez de embeber todo.
