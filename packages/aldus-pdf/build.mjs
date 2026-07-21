/**
 * build.mjs — empaqueta `aldus` para npm (la CARPETA se llama aldus-pdf por
 * historia; el paquete publicado es `aldus`), ADELGAZADO vs v1 (audit §3.6):
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
import { cpSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, '../..');
const run = (cmd, opts = {}) => execSync(cmd, { cwd: repo, stdio: 'inherit', ...opts });

rmSync(path.join(dir, 'dist'), { recursive: true, force: true });

// 1. Los dist TIPADOS de core + agent (la fuente de TODO lo que se bundlea acá).
run('pnpm --filter @aldus/core build && pnpm --filter @aldus/agent build');

// 2. La LIB (SOLO el runtime index.js — tsup.config.ts: noExternal @aldus/*,
//    dts: false; los tipos los ensambla `assembleTypes` abajo).
run('pnpm exec tsup', { cwd: dir });

// 2b. Los TIPOS, autocontenidos y con specifiers RELATIVOS.
//     Ni `tsup dts.resolve` ni `dts-bundle-generator` aplanan los tipos de
//     @aldus/* (el primero emitía un re-export de 30 bytes a `@aldus/agent`
//     que el consumidor no puede resolver; el segundo revienta en un tipo
//     transitivo de undici via el SDK de Anthropic). Ensamblamos a mano un set
//     autoconsistente desde los dist YA TIPADOS de core + agent:
//       dist/_core/**        el árbol .d.ts de @aldus/core (root + bake + node +
//                            chunks compartidos: relative imports intactos)
//       dist/_agent.d.ts     @aldus/agent/index.d.ts con `@aldus/core[/bake|/node]`
//                            reescrito a `./_core/...` (subpaths PRIMERO)
//       dist/index.d.ts      `export * from './_agent.js'`
//     Externos legítimos (pdf-lib, zod, @anthropic-ai/*, pdfjs-dist) quedan como
//     imports — el consumidor ya los tiene.
assembleTypes();
function assembleTypes() {
  const dist = path.join(dir, 'dist');
  const coreDist = path.resolve(dir, '../core/dist');
  const agentDts = path.resolve(dir, '../agent/dist/index.d.ts');
  // Solo los .d.ts del árbol de core (los .js reales viajan bundleados en index.js).
  cpSync(coreDist, path.join(dist, '_core'), {
    recursive: true,
    filter: (src) => statSync(src).isDirectory() || src.endsWith('.d.ts'),
  });
  let agent = readFileSync(agentDts, 'utf8');
  agent = agent
    .replaceAll('@aldus/core/bake', './_core/bake/index.js')
    .replaceAll('@aldus/core/node', './_core/node/index.js')
    .replaceAll('@aldus/core', './_core/index.js');
  writeFileSync(path.join(dist, '_agent.d.ts'), agent);
  writeFileSync(path.join(dist, 'index.d.ts'), "export * from './_agent.js';\n");
}

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
// aldus server launcher — express/multer son optionalDependencies.
try {
  await import('express');
  await import('multer');
} catch {
  console.error('aldus: el modo server necesita express y multer (optionalDependencies).');
  console.error('Instalalos en tu proyecto:  npm i express multer');
  process.exit(1);
}
await import('./server-impl.mjs');
`);

// 5. Editor SPA con base '/' (se sirve en la raíz local, no bajo /aldus) → dist/editor.
run('pnpm --filter aldus-editor build:demo', { env: { ...process.env, VITE_BASE: '/' } });
cpSync(path.join(repo, 'packages/editor/dist-demo'), path.join(dir, 'dist/editor'), { recursive: true });

// 6. Editor como LIBRERÍA React (subpath `aldus/editor`) → dist/editor-lib.
//    UN SOLO package con subpaths: react/react-dom son peers OPCIONALES, así
//    quien usa solo el motor (`import 'aldus'` en un server) no los arrastra.
run('pnpm --filter aldus-editor build');
cpSync(path.join(repo, 'packages/editor/dist-lib'), path.join(dir, 'dist/editor-lib'), { recursive: true });

// 6b. Los TIPOS del editor (dist/editor-lib/types/**) — hasta 0.5.1 el subpath
//     `aldus/editor` se publicaba SIN .d.ts: en el host TODO era `any` (TS7016)
//     y un breaking del wire (agentStream 0.4.0) pasó sin que tsc chistara.
//     tsc emite el árbol 1:1 (no hay flattener que sobreviva a este monorepo —
//     ver 2b) y acá se reescriben los specifiers `@aldus/core*` a rutas
//     RELATIVAS al `dist/_core` que YA viaja en el paquete. CSS side-effect
//     imports fuera (un `.d.ts` no puede importar css). Tests y la entry demo
//     no son superficie: no viajan.
assembleEditorTypes();
function assembleEditorTypes() {
  const editorDir = path.join(repo, 'packages/editor');
  const typesOut = path.join(editorDir, 'dist-lib-types');
  rmSync(typesOut, { recursive: true, force: true });
  run('pnpm exec tsc -p tsconfig.json --noEmit false --emitDeclarationOnly --declaration --outDir dist-lib-types --rootDir src', { cwd: editorDir });

  const destRoot = path.join(dir, 'dist/editor-lib/types');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const abs of walk(typesOut)) {
    const rel = path.relative(typesOut, abs);
    if (!abs.endsWith('.d.ts') || /\.test\.d\.ts$/.test(rel) || rel === 'index.d.ts') continue; // tests + entry demo: fuera
    // Cuántos niveles hay que subir desde este archivo hasta dist/ (donde vive _core).
    const up = '../'.repeat(rel.split(path.sep).length + 1); // +1: el propio dir `types/`
    let src = readFileSync(abs, 'utf8');
    src = src
      .replace(/^import '[^']*\.css';\n/gm, '')
      .replaceAll("'@aldus/core/bake'", `'${up}_core/bake/index.js'`)
      .replaceAll("'@aldus/core/node'", `'${up}_core/node/index.js'`)
      .replaceAll("'@aldus/core'", `'${up}_core/index.js'`);
    const dest = path.join(destRoot, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, src);
  }

  // El build MIENTE si esto no se cumple — mejor que reviente acá que en el host.
  const entry = path.join(destRoot, 'react/lib.d.ts');
  const entrySrc = readFileSync(entry, 'utf8'); // throws si no existe
  if (!entrySrc.includes('AldusEditorProps')) throw new Error('types: react/lib.d.ts no re-exporta AldusEditorProps');
  for (const abs of walk(destRoot)) {
    const leftover = readFileSync(abs, 'utf8').match(/'@aldus\/[^']*'/);
    if (leftover) throw new Error(`types: specifier sin reescribir ${leftover[0]} en ${path.relative(destRoot, abs)}`);
  }
}

console.log('✓ dist/index.js (+d.ts) + dist/cli.js + dist/server.mjs(+impl) + dist/editor/ (SPA) + dist/editor-lib/ (React, +d.ts)');
