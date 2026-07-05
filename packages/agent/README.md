# @aldus/agent — CLI + agente LLM sobre el grafo de un PDF

Un agente (Claude Agent SDK + Sonnet) que tiene el **contenido completo del PDF
embebido en su prompt** —el grafo de `@aldus/core`, todas las páginas— y con eso
**responde preguntas** sobre el contenido o **hace cambios** (que se hornean sobre
el PDF con el mismo bake que el editor).

## Idea de diseño

- El documento entero (texto con id/posición/tamaño, imágenes, campos, links) se
  serializa y va **dentro del system prompt**. No hay tool de lectura: el agente
  ya ve todo y ancla sus ediciones a los `id` reales del grafo.
- Las **tools son solo mutaciones** (`edit_text`, `move_text`, `set_text_color`,
  `set_text_size`, `delete_text`, `move_image`, `delete_image`). Cada una acumula
  una `SegmentEdit`/`ImageEdit` con las MISMAS funciones de merge que el editor UI
  (una sola fuente de verdad), y al guardar se hornean con `@aldus/core/bake`.
- Coordenadas: puntos PDF, origen abajo-izquierda. Al guardar, las imágenes
  movidas van al frente (como el editor), si no quedarían tapadas.

## Uso

```bash
# One-shot: preguntar
pnpm --filter @aldus/agent aldus documento.pdf -p "¿Cuál es el plazo del contrato?"

# One-shot: editar y guardar
pnpm --filter @aldus/agent aldus documento.pdf \
  -p "Cambiá el título por 'BORRADOR' y movés el logo 40pt a la izquierda" \
  -o documento-editado.pdf

# Chat interactivo (multi-turno; /save [ruta] · /edits · /exit)
pnpm --filter @aldus/agent aldus documento.pdf
```

Tras `pnpm install`, el binario `aldus` queda linkeado en `node_modules/.bin`.

## Auth

Usa la **suscripción de Claude Code**: corré **sin** `ANTHROPIC_API_KEY`
(`env -u ANTHROPIC_API_KEY …`). Modelo override con `ALDUS_MODEL`.

## Módulos

| Archivo | Qué hace |
|---------|----------|
| `graph.ts` | Carga el PDF en Node (pdf.js legacy) y extrae el grafo de todas las páginas. |
| `serialize.ts` | Serializa el grafo compacto para embeber en el prompt. |
| `session.ts` | `EditSession`: acumula ediciones (merge de `@aldus/core`) y hornea. |
| `tools.ts` | Las tools de mutación del Agent SDK, atadas a una `EditSession`. |
| `agent.ts` | Arma el system prompt (con el grafo) y corre un turno (`resume` = multi-turno). |
| `cli.ts` | El CLI: one-shot y chat. |

## Límite conocido

Todo el grafo va en el prompt → documentos MUY grandes pueden acercarse al límite
de contexto (un PDF de ~30 páginas ≈ 35k tokens). Para esos, el próximo paso es
paginar/seleccionar el subconjunto relevante en vez de embeber todo.
