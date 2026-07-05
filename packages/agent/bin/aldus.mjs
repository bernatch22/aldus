#!/usr/bin/env node
/**
 * Launcher del CLI `aldus`: corre src/cli.ts con tsx (resuelve el TS + los
 * imports .js→.ts de @aldus/core, igual que el server). Así `aldus` funciona
 * como binario sin un paso de build.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');

const child = spawn(tsxBin, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
child.on('error', err => { console.error('No se pudo lanzar tsx:', err.message); process.exit(1); });
