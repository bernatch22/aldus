/** Vitest propio (el vite.config.ts apunta su `root` a demo/ — los tests
 *  viven en src/). El entorno jsdom se pide por archivo (@vitest-environment). */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    dir: 'src',
  },
});
