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

// El agente usa la SUSCRIPCIÓN de Claude Code, nunca la API key: la deshacemos
// para el proceso hijo (a menos que se fuerce con ALDUS_USE_API_KEY=1).
const env = { ...process.env };
if (env.ALDUS_USE_API_KEY !== '1') delete env.ANTHROPIC_API_KEY;

const child = spawn(tsxBin, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
child.on('error', err => { console.error('No se pudo lanzar tsx:', err.message); process.exit(1); });
