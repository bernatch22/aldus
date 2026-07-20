/**
 * `aldus` — la DISTRIBUCIÓN npm. Ojo con el nombre: la CARPETA se llama
 * `aldus-pdf` por historia, el PAQUETE publicado es `aldus`.
 *
 * Este archivo tiene UNA línea a propósito: **casi no es un paquete de código,
 * es un TARGET DE BUILD**. La superficie pública ya está definida y curada en
 * `@aldus/agent/src/index.ts`, que no exporta solo los agentes — re-exporta a
 * mano toda la API de `@aldus/core` (grafo, bake, create, forms, flatten,
 * registerNodeFontProviders), organizada en LEER / EDITAR / FINALIZAR. Acá no
 * hay nada que agregar: `export *` dice "mi API es exactamente esa".
 *
 * El trabajo real vive en `build.mjs`, que junta piezas de CUATRO carpetas en un
 * solo paquete autocontenido:
 *
 *   dist/index.js + index.d.ts   la lib     ← @aldus/core + @aldus/agent inlineados
 *   dist/cli.js                  `aldus`    ← packages/agent/dist/cli.js
 *   dist/server.mjs (+impl)      el server  ← apps/server
 *   dist/editor/                 el SPA     ← packages/editor (build:demo)
 *   dist/editor-lib/             React      ← packages/editor (subpath `aldus/editor`)
 *
 * `@aldus/core` y `@aldus/agent` NO se publican (0.0.1, `workspace:*`): existen
 * para separar motor de agente PUERTAS ADENTRO. El consumidor instala una cosa.
 *
 * Sobre el editor React: no entra por el entry RAÍZ (un consumidor de la lib no
 * debe arrastrar react), pero sí viaja en el paquete, como subpath
 * `aldus/editor` con react/react-dom de peers. Y el SPA (dist/editor) es lo que
 * sirve `openInEditor()` — o sea `aldus file.pdf`.
 *
 * Tipos: los ensambla `assembleTypes()` a mano, porque ni `tsup dts.resolve` ni
 * `dts-bundle-generator` aplanan los .d.ts de @aldus/* (ver build.mjs §2b). Era
 * el gap #1 del audit: v1 publicaba SIN tipos.
 */
export * from '@aldus/agent';
