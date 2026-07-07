/**
 * cli.ts — el CLI `aldus`. Carga un PDF, embebe su grafo en el agente, y deja
 * preguntar contenido o pedir cambios. Dos modos:
 *
 *   aldus <pdf> "<prompt>" [-o out.pdf] [--open]   one-shot (el prompt va
 *       posicional o con -p; si hubo cambios se guarda; --open abre el PDF)
 *   aldus <pdf>                                     chat interactivo (multi-turno)
 *
 * En el chat: escribí preguntas o instrucciones; `/save [ruta]` hornea las
 * ediciones, `/edits` las lista, `/exit` sale.
 *
 * Auth por suscripción de Claude Code → corré SIN ANTHROPIC_API_KEY.
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadDoc } from './graph.js';
import { EditSession } from './session.js';
import { runTurn, type AgentEvent } from './agent.js';

/** Etiqueta amigable de una tool (mcp__aldus__edit_text → "editar texto"). */
const TOOL_LABEL: Record<string, string> = {
  edit_text: 'editando texto', move_text: 'moviendo texto', set_text_color: 'coloreando texto',
  set_text_size: 'cambiando tamaño', delete_text: 'eliminando texto',
  move_image: 'moviendo imagen', delete_image: 'eliminando imagen',
  highlight_text: 'resaltando', set_highlight_color: 'recoloreando resaltado', delete_highlight: 'quitando resaltado',
  add_link: 'agregando link', delete_link: 'quitando link',
  add_text: 'agregando texto', insert_image: 'insertando imagen', add_watermark: 'marca de agua',
  add_header_footer: 'encabezado/pie', add_form_field: 'creando campo', move_field: 'moviendo campo', delete_field: 'quitando campo',
};

/** Abre un archivo con el visor por defecto del SO (mac/linux/win). */
function openFile(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [file], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}
/** Streamea los eventos del turno a stdout (texto token a token + tools). */
function streamToStdout(ev: AgentEvent): void {
  if (ev.type === 'text') process.stdout.write(ev.delta);
  else if (ev.type === 'tool') process.stdout.write(`\n  · ${TOOL_LABEL[ev.name.replace('mcp__aldus__', '')] ?? ev.name}…\n`);
}

function usage(): never {
  console.error(`aldus — agente sobre el grafo de un PDF

  aldus <archivo.pdf> "<prompt>" [-o salida.pdf] [--open]   one-shot
  aldus <archivo.pdf> -p "<prompt>"                         (equivalente, con flag)
  aldus <archivo.pdf>                                       chat interactivo

Ejemplos:
  aldus contrato.pdf "Describí el contenido"
  aldus contrato.pdf "Resaltá los montos y poné el título en mayúsculas" --open

  --open   abre el PDF resultante (o el original si no hubo cambios).
Chat: preguntá o pedí cambios; /save [ruta] guarda, /edits lista, /exit sale.
Auth: suscripción de Claude Code (corré sin ANTHROPIC_API_KEY).`);
  process.exit(1);
}

/** Ruta de salida por defecto: <nombre>-edited.pdf junto al original. */
function defaultOut(src: string): string {
  const ext = path.extname(src);
  return path.join(path.dirname(src), `${path.basename(src, ext)}-edited${ext || '.pdf'}`);
}

async function save(session: EditSession, outPath: string): Promise<void> {
  if (session.count === 0) { console.log('(no hay ediciones para guardar)'); return; }
  const { applied, warnings } = await session.save(outPath);
  console.log(`💾 Guardado ${outPath} — ${applied.length} aplicada(s)${warnings.length ? `, ${warnings.length} aviso(s)` : ''}`);
  for (const w of warnings) console.log(`   ⚠️ ${w}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      prompt: { type: 'string', short: 'p' },
      out: { type: 'string', short: 'o' },
      open: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const file = positionals[0];
  if (!file || values.help) usage();
  // El prompt puede ir POSICIONAL (aldus x.pdf "…") o con -p; el flag gana.
  const prompt = values.prompt ?? positionals[1];

  process.stdout.write(`📄 Cargando ${file} …\n`);
  const doc = await loadDoc(file);
  const totalSegs = doc.pages.reduce((n, p) => n + p.segments.length, 0);
  console.log(`   ${doc.pages.length} página(s), ${totalSegs} nodo(s) de texto. Grafo embebido en el agente.\n`);
  const session = new EditSession(doc);

  // ── one-shot ──
  if (prompt) {
    await runTurn({ doc, session, prompt, onEvent: streamToStdout });
    process.stdout.write('\n');
    const out = values.out || defaultOut(file);
    if (session.count > 0) await save(session, out);
    // --open: abre el resultado si hubo cambios, si no el original (p. ej. un
    // "describí el contenido" no edita → mostramos el PDF que se describió).
    if (values.open) openFile(session.count > 0 ? out : file);
    return;
  }

  // ── chat interactivo ──
  console.log('Chat con Aldus. Preguntá o pedí cambios. /save [ruta] · /edits · /exit\n');
  const rl = createInterface({ input, output });
  const outPath = values.out || defaultOut(file);
  let resume: string | undefined;
  try {
    while (true) {
      const line = (await rl.question('› ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/edits') { console.log(session.summary()); continue; }
      if (line.startsWith('/save')) {
        const arg = line.slice(5).trim();
        await save(session, arg || outPath);
        continue;
      }
      process.stdout.write('\n');
      const { sessionId } = await runTurn({ doc, session, prompt: line, resume, onEvent: streamToStdout });
      resume = sessionId ?? resume;
      process.stdout.write('\n');
      if (session.count > 0) console.log(`  · ${session.count} edición(es) pendiente(s) — /save para hornear`);
      process.stdout.write('\n');
    }
    if (session.count > 0) {
      const ans = (await rl.question(`Tenés ${session.count} edición(es) sin guardar. ¿Guardar en ${outPath}? [s/N] `)).trim().toLowerCase();
      if (ans === 's' || ans === 'si' || ans === 'y') await save(session, outPath);
    }
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error('✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
