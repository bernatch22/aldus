/**
 * cli/chat.ts — `aldus <pdf> --chat`: la conversación en la terminal.
 *
 * ESPEJA LAS DOS PESTAÑAS de CASPER, porque son los dos agentes y el chat no
 * debería inventar un tercer modelo mental:
 *
 *   lectura ›   el READER — pregunta/respuesta + completar campos. Nunca delega.
 *   edición ›   el EDITOR — edita de verdad, con el scope que fijes con /pages.
 *
 * El scope de edición arranca en `auto` a propósito: conversando no sabés
 * números de página. `auto` pone al reader adelante a elegirlas — lo mismo que
 * `aldus edit --auto`. No reintroduce el acoplamiento que sacamos: es una
 * elección explícita, y el modo lectura sigue sin poder delegar jamás.
 *
 * Tres cosas que un loop rompe si no se las trata (y acá se tratan):
 *
 *  1. UNA SOLA EditSession para todo el chat. `finishTurn()`/`save()` no la
 *     terminan, y `bake()` re-hornea siempre desde los bytes ORIGINALES + el
 *     ledger completo: el turno 3 contiene los turnos 1-3. Pero `session.count`
 *     es MONOTÓNICO (no hay reset), así que "¿cambió algo este turno?" se
 *     responde con un DELTA, no con el absoluto que usa cli/turns.ts.
 *  2. Ctrl+C corta el TURNO, no el proceso. El token va por los DOS lados: al
 *     turno (aborta el modelo) y a `session.setCancellation` (aborta el loop de
 *     bakes del reflow). Con uno solo, el otro sigue girando.
 *  3. Salir con cambios sin guardar los GUARDA solos. Perder una sesión de
 *     edición ya pagada al LLM es el peor final posible.
 */
import { createInterface } from 'node:readline/promises';
import { CancellationTokenSource, NeverCancelled } from '@aldus/core';
import { editPages } from '../agents/editor.js';
import { readTurn } from '../agents/reader.js';
import { EditSession } from '../session/EditSession.js';
import type { ChatTurn } from '../transport/transport.js';
import { loadDoc } from '../graph.js';
import {
  editorGate, eventPrinter, onHostEvent, printText, reportAgentFailure,
  type AgentDeps,
} from './turns.js';
import { CYAN, DIM, GREEN, OFF, RED, ReportedError } from './ui.js';

/** Misma política que el server (routes/agent.ts): últimos 20 mensajes = 10
 *  turnos. Solo el reader acumula historial; un turno del editor es una orden
 *  autocontenida. */
const HISTORY_MAX = 20;

type Mode = 'ask' | 'edit';
/** 'auto' = las elige el reader · 'all' = todas · number[] = esas. */
type Scope = 'auto' | 'all' | number[];

const scopeLabel = (s: Scope): string =>
  s === 'auto' ? 'auto (las elige el reader)' : s === 'all' ? 'todas' : `págs ${s.join(',')}`;

const HELP = [
  '',
  `  ${CYAN}/ask${OFF}              modo LECTURA — preguntar y completar campos (default)`,
  `  ${CYAN}/edit${OFF}             modo EDICIÓN — cambiar el documento`,
  `  ${CYAN}/pages auto|all|1,3${OFF}  scope del editor`,
  `  ${CYAN}/save [path]${OFF}      hornea lo acumulado a un PDF`,
  `  ${CYAN}/status${OFF}           modo, scope y cambios pendientes`,
  `  ${CYAN}/help${OFF}  ${CYAN}/exit${OFF}      (Ctrl+C corta el turno · Ctrl+D sale)`,
  '',
].join('\n');

export async function runChat(pdf: string, deps: AgentDeps): Promise<void> {
  const t0 = Date.now();
  const doc = await loadDoc(pdf);
  const session = new EditSession(doc);
  const defaultOut = pdf.replace(/\.pdf$/i, '') + '.edited.pdf';

  let mode: Mode = 'ask';
  let scope: Scope = 'auto';
  let history: ChatTurn[] = [];
  /** `session.count` en el último guardado — el delta contra el actual dice si
   *  hay trabajo sin escribir (count nunca baja, así que el absoluto no sirve). */
  let savedAt = 0;

  console.error(
    `${DIM}grafo: ${doc.pages.length} pág en ${Date.now() - t0}ms · `
    + `reader=${deps.config.readerModel} · editor=${deps.config.editorModel}${OFF}`);
  console.error(`${DIM}Chateando sobre ${pdf}. /help para los comandos.${OFF}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  /** No-null mientras un turno está EN VUELO: es la señal de que Ctrl+C debe
   *  cancelar el turno en vez de salir. */
  let running: CancellationTokenSource | null = null;

  async function save(path?: string): Promise<void> {
    const out = path ?? defaultOut;
    const { applied, warnings } = await session.save(out);
    for (const w of warnings) console.error(`${RED}⚠ ${w}${OFF}`);
    console.error(`${GREEN}✓${OFF} ${applied.length} cambio/s → ${out}`);
    savedAt = session.count;
  }

  // Ctrl+C: con un turno corriendo lo CANCELA y vuelve al prompt; en el prompt,
  // cierra. Los dos handlers son necesarios: readline se queda con la señal
  // mientras lee, y el de process cubre el rato en que el turno está en vuelo.
  const onSigint = (): void => {
    if (running) {
      running.cancel();
      process.stderr.write(`\n${DIM}⏹ cancelando el turno…${OFF}\n`);
      return;
    }
    rl.close();
  };
  rl.on('SIGINT', onSigint);
  process.on('SIGINT', onSigint);
  // Solo para NO dibujar el prompt sobre una interfaz ya cerrada (eso tira
  // ERR_USE_AFTER_CLOSE). NO se usa para cortar el loop — ver abajo.
  let closed = false;
  rl.on('close', () => { closed = true; });

  /** Corre un turno y reporta si ESTE turno cambió algo (delta, no absoluto). */
  async function turn(text: string): Promise<void> {
    const before = session.count;
    const cts = new CancellationTokenSource();
    running = cts;
    // Los DOS lados: el turno aborta el modelo, la sesión aborta el reflow.
    session.setCancellation(cts.token);
    const state = { streamed: false };
    try {
      if (mode === 'ask') {
        const r = await readTurn(
          { doc, session, prompt: text, history, onEvent: eventPrinter(state, true), onHostEvent },
          deps.registry, deps.config, cts.token,
        );
        printText(state, r.text);
        if (r.text.trim()) {
          history = [...history,
            { role: 'user', content: text },
            { role: 'assistant', content: r.text },
          ].slice(-HISTORY_MAX);
        }
      } else if (scope === 'auto') {
        // Ruteo: el reader elige las páginas y delega. Su respuesta es la que se
        // imprime, así que el texto del editor viaja "relayed".
        const onEvent = eventPrinter(state, true);
        const r = await readTurn(
          {
            doc, session, prompt: text, onEvent, onHostEvent,
            editor: editorGate(doc, session, deps, onEvent, cts.token),
          },
          deps.registry, deps.config, cts.token,
        );
        printText(state, r.text);
      } else {
        const r = await editPages(
          {
            doc, session, request: text,
            pages: scope === 'all' ? undefined : scope,
            onEvent: eventPrinter(state, false),
          },
          deps.registry, deps.config, cts.token,
        );
        printText(state, r.text);
      }
    } catch (err) {
      // En el chat un fallo NO mata la sesión: se reporta y se vuelve al prompt
      // (los cambios de turnos anteriores siguen vivos en la sesión).
      if (cts.token.isCancellationRequested) console.error(`${DIM}⏹ turno cancelado.${OFF}`);
      else if (err instanceof ReportedError) void 0; // editorGate ya lo explicó
      else reportAgentFailure(err, deps.config, mode === 'edit' && scope !== 'auto' ? 'editor' : 'reader');
    } finally {
      running = null;
      cts.dispose();
      session.setCancellation(NeverCancelled);
    }

    const delta = session.count - before;
    if (delta > 0) {
      console.error(`${DIM}✎ ${delta} cambio/s en este turno · ${session.count - savedAt} sin guardar · /save para escribir${OFF}`);
    }
  }

  /** Devuelve true si la línea era un comando (y ya se atendió). */
  async function command(line: string): Promise<boolean> {
    const [cmd, ...args] = line.slice(1).trim().split(/\s+/);
    switch (cmd) {
      case 'ask': case 'lectura':
        mode = 'ask';
        console.error(`${DIM}modo LECTURA — pregunto y completo campos, no edito.${OFF}`);
        return true;
      case 'edit': case 'edicion': case 'edición':
        mode = 'edit';
        console.error(`${DIM}modo EDICIÓN — scope: ${scopeLabel(scope)}.${OFF}`);
        return true;
      case 'pages': case 'paginas': case 'páginas': {
        const raw = args.join('');
        if (!raw) { console.error(`${DIM}scope actual: ${scopeLabel(scope)}${OFF}`); return true; }
        if (raw === 'auto' || raw === 'all') scope = raw;
        else {
          const nums = raw.split(',').map(s => Number(s.trim()));
          if (!nums.length || nums.some(n => !Number.isInteger(n) || n < 1 || n > doc.pages.length)) {
            console.error(`${RED}/pages: esperaba auto, all, o páginas 1..${doc.pages.length} (p.ej. /pages 1,3)${OFF}`);
            return true;
          }
          scope = [...new Set(nums)].sort((a, b) => a - b);
        }
        console.error(`${DIM}scope: ${scopeLabel(scope)}${OFF}`);
        return true;
      }
      case 'save':
        if (session.count === 0) { console.error(`${DIM}no hay cambios que guardar.${OFF}`); return true; }
        await save(args[0]);
        return true;
      case 'status':
        console.error(`${DIM}modo: ${mode === 'ask' ? 'LECTURA' : 'EDICIÓN'} · scope: ${scopeLabel(scope)} · `
          + `${session.count} cambio/s (${session.count - savedAt} sin guardar) · ${history.length / 2} turno/s de memoria${OFF}`);
        return true;
      case 'help': case '?':
        console.error(HELP);
        return true;
      case 'exit': case 'quit': case 'q':
        rl.close();
        return true;
      default:
        console.error(`${RED}comando desconocido: /${cmd}${OFF} — /help para la lista`);
        return true;
    }
  }

  // ITERADOR async, no `rl.question()` en un while: question() registra un
  // listener de UNA línea, así que todo lo que llegue mientras el cuerpo está
  // esperando (un turno dura segundos) se PIERDE. Con stdin por pipe eso se ve
  // enseguida — sólo corre la primera línea y las demás se descartan en
  // silencio. El iterador pausa el stream mientras el cuerpo trabaja, así que
  // anda igual en una terminal que en `printf '…' | aldus doc.pdf --chat`.
  const promptStr = (): string => `\n${CYAN}${mode === 'ask' ? 'lectura' : 'edición'} ›${OFF} `;
  rl.setPrompt(promptStr());
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line.startsWith('/')) await command(line);
    else if (line) await turn(line);
    // OJO: NADA de `if (closing) break` acá. Con stdin por PIPE el stream
    // termina apenas se leyó todo, así que 'close' dispara MIENTRAS corre el
    // primer turno — y cortar ahí descarta las líneas que el iterador todavía
    // tiene encoladas (se veía como "contesta la primera pregunta y se va").
    // Salir es cosa del iterador: `rl.close()` (/exit, Ctrl+D) lo termina solo,
    // después de drenar lo que quedaba.
    if (!closed) {
      rl.setPrompt(promptStr()); // el modo pudo cambiar
      rl.prompt();
    }
  }

  process.off('SIGINT', onSigint);
  rl.close();

  // Salir con trabajo sin guardar: guardarlo. Avisar y perderlo sería tirar a la
  // basura lo que el modelo ya cobró.
  if (session.count > savedAt) {
    console.error(`\n${DIM}hay ${session.count - savedAt} cambio/s sin guardar — los escribo:${OFF}`);
    await save();
  }
  console.error(`${DIM}chau.${OFF}`);
}
