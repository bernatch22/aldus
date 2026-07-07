# Aldus // MAGI SYSTEM

> *God's in his heaven. All's right with the PDF.*

**Aldus es un editor de PDF pixel-perfect que edita el grafo de contenido REAL
del documento — nunca pinta blanco encima ni redibuja con fuentes
aproximadas.** Parsea los operadores del content stream, los edita in situ y
splicea el resultado byte a byte.

[Read me in English](README.md) · [Arquitectura](docs/architecture.md) ·
[Bake por dentro](docs/bake-internals.md) · [Coordenadas](docs/coordinate-system.md) ·
[Roadmap y origen](docs/roadmap.md)

## Por qué existe

Todos los "editores" de PDF web hacen trampa: rasterizan, o pintan un
rectángulo blanco sobre el texto viejo y dibujan encima con cualquier fuente.
Aldus hace lo que hace Acrobat — y es honesto cuando no puede:

- **Mover / escalar / re-estilar** → los operadores originales se re-emiten
  **verbatim** (mismos bytes, misma fuente, kerning TJ intacto) con la matriz
  reubicada. Pixel-perfect.
- **Texto nuevo, misma fuente** → re-codificado vía el mapa inverso del
  `/ToUnicode` de la fuente embebida. ¿Falta un carácter en el subset? →
  fallback explícito y *reportado*.
- **Cambio de familia/estilo** → fuente estándar embebida preservando el color
  original. Sustitución explícita, la política Acrobat — jamás una adivinanza
  silenciosa.
- **¿No puede localizar un segmento sin ambigüedad?** No lo toca, y te dice
  por qué. Lo que no se entiende no se modifica.

## Las MAGI

| Unidad | Paquete | Rol |
|---|---|---|
| **MELCHIOR·1** | `packages/core` | La científica — modelo, extracción y el **bake** del content stream |
| **BALTHASAR·2** | `apps/server` | La madre — API Express, store de documentos con revisiones |
| **CASPER·3** | `packages/agent` | La mujer — agente LLM (Claude Agent SDK) con el grafo del PDF embebido en el prompt |
| **NERV HQ** | `apps/editor` | La UI — Vite + React, preview local WYSIWYG (el mismo bake, corriendo en el browser) |

## Arranque

```bash
pnpm install
pnpm dev          # server :4100 + editor :5190
```

Abrí http://localhost:5190, tirá un PDF, doble click en cualquier texto.

**El panel AI (CASPER)** usa la suscripción de Claude Code — corré el server
SIN `ANTHROPIC_API_KEY`. Los knobs están documentados en
[`packages/agent/src/config.ts`](packages/agent/src/config.ts).

## Tests

```bash
pnpm -r test
```

Los tests de core corren el **ciclo real**: crear un PDF → extraer el grafo →
hornear ediciones → re-extraer → assert. Sin PDFs mockeados: el propio parser
es el oráculo.

## Licencia

[MIT](LICENSE) — Bernardo Castro.
