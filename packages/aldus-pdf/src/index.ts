/**
 * aldus-pdf — la DISTRIBUCIÓN npm: la fachada pública de @aldus/agent (que ya
 * re-exporta la superficie de core: grafo, bake, create, forms, flatten…)
 * bundleada en un solo paquete autocontenido. `build.mjs` inlinea los dist
 * TIPADOS de @aldus/core + @aldus/agent (tsup dts.resolve → un index.d.ts
 * bundleado — el gap #1 del audit: v1 publicaba SIN tipos).
 *
 * NO re-exporta `aldus-editor` (igual que v1): el editor React es un paquete
 * npm propio con peers de react — un consumidor de la LIB no arrastra UI.
 * El SPA del editor viaja como ASSETS (dist/editor) para `aldus file.pdf`.
 */
export * from '@aldus/agent';
