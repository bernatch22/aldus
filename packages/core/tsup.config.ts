import { defineConfig } from 'tsup';

/**
 * Config mínima ESM + d.ts. Tres entradas = los tres subpaths del package:
 * `.` (browser-safe), `./bake` (pdf-lib, llega en F3) y `./node` (providers
 * con I/O, llega en F2/F3). Los subpaths vacíos ya compilan para que la forma
 * pública del paquete quede fijada desde F0.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bake/index': 'src/bake/index.ts',
    'node/index': 'src/node/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
