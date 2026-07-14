/**
 * cli.ts — el CLI `aldus`. Carga un PDF, embebe su grafo en el agente, y deja
 * preguntar contenido o pedir cambios. Dos modos:
 *
 *   aldus <pdf> "<prompt>" [-o out.pdf] [--open]   one-shot (el prompt va
 *       posicional o con -p; si hubo cambios se guarda; --open abre el PDF)
 *   aldus <pdf>                                     abre el EDITOR en el navegador
 *
 * En el chat: escribí preguntas o instrucciones; `/save [ruta]` hornea las
 * ediciones, `/edits` las lista, `/exit` sale.
 *
 * Auth por suscripción de Claude Code → corré SIN ANTHROPIC_API_KEY.
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFormFields, setFieldValues } from '@aldus/core/bake';
import { registerNodeFontProviders } from '@aldus/core/node';
import { loadDoc } from './graph.js';
import { EditSession } from './session/EditSession.js';
import { runTurn, type AgentEvent } from './runTurn.js';
import { openFile, openInEditor } from './openInEditor.js';

// Fuentes sustitutas REALES para el bake (original del sistema / gemela métrica).
registerNodeFontProviders();

/** Etiqueta amigable de una tool (mcp__aldus__edit_text → "editar texto"). */
const TOOL_LABEL: Record<string, string> = {
  edit_text: 'editando texto', replace_paragraph: 'reemplazando párrafo', move_text: 'moviendo texto', set_text_color: 'coloreando texto',
  set_text_size: 'cambiando tamaño', delete_text: 'eliminando texto',
  move_image: 'moviendo imagen', delete_image: 'eliminando imagen',
  highlight_text: 'resaltando', set_highlight_color: 'recoloreando resaltado', delete_highlight: 'quitando resaltado',
  add_link: 'agregando link', delete_link: 'quitando link',
  add_text: 'agregando texto', insert_image: 'insertando imagen', add_watermark: 'marca de agua',
  add_header_footer: 'encabezado/pie', add_form_field: 'creando campo', fill_field: 'completando campo', move_field: 'moviendo campo', delete_field: 'quitando campo',
};

/** Streamea los eventos del turno a stdout (texto token a token + tools). */
function streamToStdout(ev: AgentEvent): void {
  if (ev.type === 'text') process.stdout.write(ev.delta);
  else if (ev.type === 'tool') process.stdout.write(`\n  · ${TOOL_LABEL[ev.name.replace('mcp__aldus__', '')] ?? ev.name}…\n`);
}

/** Spinner "pensando… Ns" mientras el modelo razona ANTES del primer token (un
 *  doc grande + una tarea compleja tardan; sin esto parecía trancado). Solo en
 *  TTY; en pipe no imprime nada. */
function startSpinner(): { stop: () => void } {
  if (!process.stdout.isTTY) return { stop() { /* pipe: nada */ } };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const t0 = Date.now();
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} pensando… ${Math.round((Date.now() - t0) / 1000)}s`);
  }, 120);
  return { stop() { clearInterval(id); process.stdout.write('\r\x1b[K'); } };
}

/** Corre un turno mostrando el spinner hasta el PRIMER evento, luego streamea. */
async function runTurnLive(opts: Parameters<typeof runTurn>[0]): Promise<Awaited<ReturnType<typeof runTurn>>> {
  const spin = startSpinner();
  let stopped = false;
  const stop = () => { if (!stopped) { spin.stop(); stopped = true; } };
  try {
    return await runTurn({ ...opts, onEvent: ev => { stop(); opts.onEvent?.(ev); } });
  } finally {
    stop();
  }
}

function usage(): never {
  console.error(`aldus — agente sobre el grafo de un PDF

  aldus <archivo.pdf>                                       abre el EDITOR en el navegador
  aldus <archivo.pdf> "<prompt>" [-o salida.pdf] [--open]   one-shot (agente LLM)
  aldus <archivo.pdf> -p "<prompt>"                         (equivalente, con flag)
  aldus <archivo.pdf> --chat                                chat interactivo (terminal)
  aldus <archivo.pdf> --fields                              volcar campos+valores (JSON)
  aldus <archivo.pdf> --fill datos.json [-o out.pdf]        completar el form (sin LLM)

Ejemplos:
  aldus contrato.pdf                                        (editor visual en el navegador)
  aldus contrato.pdf "Describí el contenido"
  aldus contrato.pdf "Resaltá los montos y poné el título en mayúsculas" --open
  aldus formulario.pdf --fields
  aldus formulario.pdf --fill '{"nombre":"Juan","acepta":"true"}' --open

  --open   abre el PDF resultante (o el original si no hubo cambios).
  --fields / --fill   formularios de forma DETERMINÍSTICA (no usan el LLM).
Chat (--chat): preguntá o pedí cambios; /save [ruta] guarda, /edits lista, /exit sale.
Auth del agente: por defecto suscripción de Claude Code (sin ANTHROPIC_API_KEY);
o ALDUS_PROVIDER=openrouter + OPENROUTER_API_KEY.`);
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
      fields: { type: 'boolean' },
      fill: { type: 'string' },
      chat: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const file = positionals[0];
  if (!file || values.help) usage();
  // El prompt puede ir POSICIONAL (aldus x.pdf "…") o con -p; el flag gana.
  const prompt = values.prompt ?? positionals[1];

  // ── EDITOR VISUAL: `aldus x.pdf` sin prompt ni flags → abre la UI en el
  // navegador. --chat fuerza el chat de terminal.
  if (!prompt && !values.chat && !values.fields && !values.fill) {
    await openInEditor(file);
    return;
  }

  // ── FORMULARIOS: rutas DETERMINÍSTICAS (sin LLM) ──
  // --fields: volcar los campos + valores como JSON.
  if (values.fields) {
    const fields = await readFormFields(new Uint8Array(await readFile(file)));
    process.stdout.write(JSON.stringify(fields, null, 2) + '\n');
    return;
  }
  // --fill <datos.json | JSON inline>: completar campos por nombre y guardar.
  if (values.fill) {
    const raw = values.fill.trim().startsWith('{') ? values.fill : await readFile(values.fill, 'utf8');
    const data = JSON.parse(raw) as Record<string, string | boolean | string[]>;
    const out = values.out || defaultOut(file);
    const { pdf, applied, warnings } = await setFieldValues(new Uint8Array(await readFile(file)), data);
    await writeFile(out, pdf);
    console.log(`💾 ${out} — ${applied.length} campo(s) completado(s)${warnings.length ? `, ${warnings.length} aviso(s)` : ''}`);
    for (const a of applied) console.log(`   ✓ ${a}`);
    for (const w of warnings) console.log(`   ⚠️ ${w}`);
    if (values.open) openFile(out);
    return;
  }

  process.stdout.write(`📄 Cargando ${file} …\n`);
  const doc = await loadDoc(file);
  const totalSegs = doc.pages.reduce((n, p) => n + p.segments.length, 0);
  console.log(`   ${doc.pages.length} página(s), ${totalSegs} nodo(s) de texto. Grafo embebido en el agente.\n`);
  const session = new EditSession(doc);

  // ── one-shot ──
  if (prompt) {
    await runTurnLive({ doc, session, prompt, onEvent: streamToStdout });
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
      const { sessionId } = await runTurnLive({ doc, session, prompt: line, resume, onEvent: streamToStdout });
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

// Ejecutar solo como binario (no al importarlo como módulo). El bin de npm es
// un SYMLINK → argv[1] se compara por realpath, o `aldus` instalado global no
// matchearía import.meta.url (que apunta al archivo real) y el CLI moriría mudo.
const invokedAs = (() => {
  if (!process.argv[1]) return null;
  try { return pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return pathToFileURL(process.argv[1]).href; }
})();
if (invokedAs && import.meta.url === invokedAs) {
  main().catch(err => {
    console.error('✗', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
