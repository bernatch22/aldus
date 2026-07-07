/**
 * build.mjs — empaqueta el EDITOR REAL (apps/server + apps/editor) como una app
 * autocontenida para el demo bernardocastro.dev/aldus-app:
 *   - bundlea apps/server/src/index.ts (con @aldus/core + @aldus/agent inlineados
 *     vía alias al source; las deps de npm quedan external) → dist/server.mjs
 *   - copia el build del editor (VITE_BASE=/aldus-app/) → dist/public
 * El server sirve dist/public (ALDUS_STATIC) + /api en el mismo origen.
 *
 * Correlo DESPUÉS de buildear el editor:
 *   VITE_BASE=/aldus-app/ pnpm --filter @aldus/editor build
 *   node deploy/aldus-app/build.mjs
 */
import { build } from 'esbuild';
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, '../..');
const coreSrc = path.join(repo, 'packages/core/src');
const agentSrc = path.join(repo, 'packages/agent/src');
const editorDist = path.join(repo, 'apps/editor/dist');
const outDir = path.join(dir, 'dist');

rmSync(outDir, { recursive: true, force: true });

// 1) bundle del server
await build({
  entryPoints: [path.join(repo, 'apps/server/src/index.ts')],
  outfile: path.join(outDir, 'app.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node18', logLevel: 'warning',
  alias: {
    '@aldus/core': path.join(coreSrc, 'index.ts'),
    '@aldus/core/bake': path.join(coreSrc, 'bake/index.ts'),
    '@aldus/agent': path.join(agentSrc, 'index.ts'),
  },
  external: [
    'express', 'express/*', 'multer', 'multer/*',
    'pdf-lib', 'pdf-lib/*', 'pdfjs-dist', 'pdfjs-dist/*',
    '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*', 'zod', 'zod/*',
  ],
});

// 2) el editor buildeado → dist/public
if (!existsSync(editorDist)) {
  console.error('✗ falta apps/editor/dist — corré primero: VITE_BASE=/aldus-app/ pnpm --filter @aldus/editor build');
  process.exit(1);
}
cpSync(editorDist, path.join(outDir, 'public'), { recursive: true });

console.log('✓ dist/app.mjs + dist/public (editor)');
