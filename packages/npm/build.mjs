/**
 * build.mjs — empaqueta @bernatch22/aldus para npm: bundlea el CÓDIGO del
 * monorepo (@aldus/agent + @aldus/core) en un solo dist con esbuild, dejando las
 * deps de npm como EXTERNAL (el consumidor las instala). Los specifiers de
 * workspace (@aldus/core, @aldus/core/bake) se resuelven por ALIAS al source →
 * el paquete publicado no lleva ninguna dep `workspace:`.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const coreSrc = path.resolve(dir, '../core/src');
const agentSrc = path.resolve(dir, '../agent/src');

rmSync(path.join(dir, 'dist'), { recursive: true, force: true });

const alias = {
  '@aldus/core': path.join(coreSrc, 'index.ts'),
  '@aldus/core/bake': path.join(coreSrc, 'bake/index.ts'),
};
// deps de npm (y sus subpaths) → external: las trae el consumidor, no el bundle.
const external = [
  'pdf-lib', 'pdf-lib/*',
  'pdfjs-dist', 'pdfjs-dist/*',
  '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*',
  'zod', 'zod/*',
];
const common = { bundle: true, format: 'esm', platform: 'node', target: 'node18', alias, external, logLevel: 'warning' };

// Librería (import { runTurn, EditSession, loadDoc, … } from '@bernatch22/aldus')
await build({ ...common, entryPoints: [path.join(agentSrc, 'index.ts')], outfile: path.join(dir, 'dist/index.js') });
// CLI (`aldus …`) — mismo bundle, con shebang, sin tsx (corre con node directo).
await build({ ...common, entryPoints: [path.join(agentSrc, 'cli.ts')], outfile: path.join(dir, 'dist/cli.js'), banner: { js: '#!/usr/bin/env node' } });

console.log('✓ dist/index.js + dist/cli.js');
