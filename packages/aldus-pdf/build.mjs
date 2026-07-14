/**
 * build.mjs — empaqueta `aldus-pdf` para npm, ADELGAZADO vs v1 (audit §3.6):
 * core y agent buildean su PROPIO dist tipado (tsup) y todo acá se bundlea
 * CONTRA esos dist resueltos por node_modules — muere el hack alias-a-source
 * con su gotcha de prefijos (§4.4). Deps de npm quedan EXTERNAL (el consumidor
 * las instala). Salidas:
 *
 *   dist/index.js + index.d.ts   la lib (tsup, tipos de @aldus/* INLINEADOS)
 *   dist/cli.js                  el binario `aldus` (bundle del dist del agent)
 *   dist/server.mjs              launcher del server con check de express/multer
 *   dist/server-impl.mjs         el server real bundleado (apps/server)
 *   dist/editor/                 el SPA del editor (base '/')
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, '../..');
const run = (cmd, opts = {}) => execSync(cmd, { cwd: repo, stdio: 'inherit', ...opts });

rmSync(path.join(dir, 'dist'), { recursive: true, force: true });

// 1. Los dist TIPADOS de core + agent (la fuente de TODO lo que se bundlea acá).
run('pnpm --filter @aldus/core build && pnpm --filter @aldus/agent build');

// 2. La LIB con d.ts bundleado (tsup.config.ts: noExternal @aldus/*, dts.resolve).
run('pnpm exec tsup', { cwd: dir });

// deps de npm (y sus subpaths) → external: las trae el consumidor, no el bundle.
const external = [
  'pdf-lib', 'pdf-lib/*',
  '@pdf-lib/fontkit', '@pdf-lib/fontkit/*',
  'pdfjs-dist', 'pdfjs-dist/*',
  '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*',
  'zod', 'zod/*',
  'express', 'express/*', 'multer', 'multer/*',
  // Subpaths de builtins de Node que el dist de tsup emite SIN prefijo `node:`
  // (esbuild no los auto-externaliza en esta forma). Son builtins → external.
  'fs/promises', 'readline/promises', 'stream/promises', 'timers/promises', 'dns/promises', 'stream/web', 'util/types',
];
const common = { bundle: true, format: 'esm', platform: 'node', target: 'node18', external, logLevel: 'warning' };

// 3. CLI (`aldus …`) — bundle del dist YA COMPILADO del agent, con shebang.
await build({
  ...common,
  entryPoints: [path.resolve(dir, '../agent/dist/cli.js')],
  outfile: path.join(dir, 'dist/cli.js'),
  banner: { js: '#!/usr/bin/env node' },
});

// 4. Server real bundleado → `aldus file.pdf` lo levanta y sirve el editor.
//    server.mjs es un LAUNCHER: express/multer son optionalDependencies
//    (audit §4.3 — un consumidor de la lib no arrastra un web framework);
//    si faltan, el launcher lo dice claro en vez de un ERR_MODULE_NOT_FOUND.
await build({
  ...common,
  entryPoints: [path.join(repo, 'apps/server/src/index.ts')],
  outfile: path.join(dir, 'dist/server-impl.mjs'),
});
writeFileSync(path.join(dir, 'dist/server.mjs'), `#!/usr/bin/env node
// aldus-pdf server launcher — express/multer son optionalDependencies.
try {
  await import('express');
  await import('multer');
} catch {
  console.error('aldus-pdf: el modo server necesita express y multer (optionalDependencies).');
  console.error('Instalalos en tu proyecto:  npm i express multer');
  process.exit(1);
}
await import('./server-impl.mjs');
`);

// 5. Editor SPA con base '/' (se sirve en la raíz local, no bajo /aldus) → dist/editor.
run('pnpm --filter aldus-editor build:demo', { env: { ...process.env, VITE_BASE: '/' } });
cpSync(path.join(repo, 'packages/editor/dist-demo'), path.join(dir, 'dist/editor'), { recursive: true });

console.log('✓ dist/index.js (+d.ts) + dist/cli.js + dist/server.mjs(+impl) + dist/editor/ (SPA)');
