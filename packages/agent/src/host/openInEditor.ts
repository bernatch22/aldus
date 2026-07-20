/**
 * openInEditor.ts — abre un PDF en el EDITOR visual + agente CASPER en el
 * navegador: corre el server REAL en modo local (un usuario, sin sesiones)
 * sirviendo la SPA, sube el PDF y abre el navegador en ese doc. Vive hasta
 * Ctrl+C.
 *
 * Es LA pieza que deduplica el ejemplo `examples/edit-in-browser` (audit-hosts
 * §2: la copia de 85 líneas de v1 muere — el ejemplo importa esto). Funciona en
 * DOS layouts:
 *   · paquete publicado (`aldus`) → server.mjs + editor/ están junto al
 *     bundle (dist/).
 *   · repo → corre apps/server con tsx y sirve packages/editor/dist-demo.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Abre un archivo/URL con el visor por defecto del SO (mac/linux/win). */
export function openFile(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [file], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

/** Abre el PDF en el editor visual (server local + SPA + navegador). */
export async function openInEditor(file: string): Promise<void> {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledServer = path.join(cliDir, 'server.mjs');
  const published = existsSync(bundledServer);
  const repo = path.resolve(cliDir, '../../..');
  const editorDir = published ? path.join(cliDir, 'editor') : path.join(repo, 'packages/editor/dist-demo');
  if (!existsSync(path.join(editorDir, 'index.html'))) {
    console.error(published
      ? 'Paquete incompleto: falta el editor buildeado.'
      : 'Buildeá el editor primero:  pnpm --filter aldus-editor build:demo');
    process.exit(1);
  }
  const PORT = Number(process.env.ALDUS_PORT || 4180);
  const [cmd, args] = published
    ? [process.execPath, [bundledServer]] as const
    : ['npx', ['tsx', path.join(repo, 'apps/server/src/index.ts')]] as const;
  const server = spawn(cmd, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ALDUS_PORT: String(PORT),
      ALDUS_STATIC: editorDir,
      ALDUS_SESSION_SCOPED: '',
      // store temporal — no ensuciar el cwd ni node_modules.
      ALDUS_DATA: process.env.ALDUS_DATA || mkdtempSync(path.join(tmpdir(), 'aldus-')),
    },
  });
  server.on('exit', code => process.exit(code ?? 0));
  process.on('SIGINT', () => server.kill('SIGINT'));

  const base = `http://localhost:${PORT}`;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 120; i++) { try { await fetch(base); break; } catch { await sleep(150); } }
  const form = new FormData();
  form.append('pdf', new Blob([await readFile(path.resolve(file))]), path.basename(file));
  const res = await fetch(`${base}/api/documents`, { method: 'POST', body: form });
  if (!res.ok) { console.error(`No pude cargar el PDF (${res.status})`); server.kill('SIGINT'); return; }
  const { id } = await res.json() as { id: string };
  const ai = process.env.ALDUS_PROVIDER === 'openrouter'
    ? (process.env.OPENROUTER_API_KEY ? 'OpenRouter' : 'OpenRouter (falta OPENROUTER_API_KEY)')
    : 'suscripción Claude Code';
  console.log(`\n📄  ${path.basename(file)}\n🖊  Editor + agente CASPER: ${base}/doc/${id}\n🤖  IA: ${ai}\n   (Ctrl+C para cerrar)\n`);
  openFile(`${base}/doc/${id}`);
}
