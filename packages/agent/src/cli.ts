/**
 * cli.ts — el CLI `aldus`. Carga un PDF, embebe su grafo en el agente, y deja
 * preguntar contenido o pedir cambios. Dos modos:
 *
 *   aldus <pdf> -p "<prompt>" [-o out.pdf]   one-shot (imprime la respuesta;
 *                                             si hubo ediciones y hay -o, guarda)
 *   aldus <pdf>                              chat interactivo (multi-turno)
 *
 * En el chat: escribí preguntas o instrucciones; `/save [ruta]` hornea las
 * ediciones, `/edits` las lista, `/exit` sale.
 *
 * Auth por suscripción de Claude Code → corré SIN ANTHROPIC_API_KEY.
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { loadDoc } from './graph.js';
import { EditSession } from './session.js';
import { runTurn } from './agent.js';

function usage(): never {
  console.error(`aldus — agente sobre el grafo de un PDF

  aldus <archivo.pdf> -p "<prompt>" [-o salida.pdf]   one-shot
  aldus <archivo.pdf>                                 chat interactivo

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
      help: { type: 'boolean', short: 'h' },
    },
  });
  const file = positionals[0];
  if (!file || values.help) usage();

  process.stdout.write(`📄 Cargando ${file} …\n`);
  const doc = await loadDoc(file);
  const totalSegs = doc.pages.reduce((n, p) => n + p.segments.length, 0);
  console.log(`   ${doc.pages.length} página(s), ${totalSegs} nodo(s) de texto. Grafo embebido en el agente.\n`);
  const session = new EditSession(doc);

  // ── one-shot ──
  if (values.prompt) {
    const { text, toolCalls } = await runTurn({ doc, session, prompt: values.prompt });
    console.log(text);
    if (session.count > 0) {
      const out = values.out || defaultOut(file);
      await save(session, out);
    } else if (toolCalls === 0 && values.out) {
      console.log('(sin ediciones — nada que guardar)');
    }
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
      const { text, sessionId } = await runTurn({ doc, session, prompt: line, resume });
      resume = sessionId ?? resume;
      console.log(`\n${text}\n`);
      if (session.count > 0) console.log(`  · ${session.count} edición(es) pendiente(s) — /save para hornear\n`);
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
