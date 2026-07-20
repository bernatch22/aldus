/**
 * cli/turns.ts — los turnos del agente (`ask` y `edit`) y todo lo que comparten
 * con el chat: los printers de eventos, el horneado y el diagnóstico de fallos.
 *
 * UN VERBO POR AGENTE, y el corte no es "qué modelo corre" sino QUÉ SALE por la
 * otra punta: `ask` escribe texto en stdout (pipeable, y por eso `-o` no tendría
 * sentido); `edit` escribe un PDF (y por eso `-o`/`--pages` son su razón de ser).
 * Es el mismo par que las dos pestañas de CASPER en el editor.
 *
 * {@link editorGate} está exportada porque el ruteo reader→editor lo necesitan
 * DOS llamadores (`edit --auto` y el modo edición del chat con scope `auto`).
 * Duplicarlo era garantizar que se desincronicen.
 */
import { rm } from 'node:fs/promises';
import type { CancellationToken } from '@aldus/core';
import { editPages } from '../agents/editor.js';
import { readTurn } from '../agents/reader.js';
import type { EditRoute } from '../agents/reader.js';
import type { IAgentConfig } from '../config.js';
import { loadDoc } from '../graph.js';
import type { DocGraph } from '../graph.js';
import { EditSession } from '../session/EditSession.js';
import type { IToolRegistry } from '../tools/registry.js';
import type { AgentEvent } from '../transport/transport.js';
import { isOpenRouterModel } from '../config.js';
import { CYAN, DIM, OFF, RED, ReportedError } from './ui.js';

/** Lo que todo comando del agente necesita del container. */
export interface AgentDeps {
  registry: IToolRegistry;
  config: IAgentConfig;
}

/** Carga el grafo y abre la sesión. El .edited.pdf de una corrida ANTERIOR es
 *  una trampa: si esta falla o no edita, abrirlo muestra un resultado viejo como
 *  si fuera el de ahora. Se borra ANTES de empezar — si al final existe, es de
 *  esta corrida. */
export async function openSession(pdf: string, outFlag?: string): Promise<{
  t0: number; outPath: string; doc: DocGraph; session: EditSession;
}> {
  const t0 = Date.now();
  const outPath = outFlag ?? pdf.replace(/\.pdf$/i, '') + '.edited.pdf';
  await rm(outPath, { force: true });
  const doc = await loadDoc(pdf);
  return { t0, outPath, doc, session: new EditSession(doc) };
}

/** Imprime los eventos del turno. `relayed` = hay un reader adelante que va a
 *  repetir el reporte del editor (ruteo), así que el texto del editor NO se
 *  imprime dos veces. En `edit` directo no hay quien lo repita: se imprime. */
export function eventPrinter(state: { streamed: boolean }, relayed: boolean) {
  return (ev: AgentEvent): void => {
    if (ev.type === 'tool') {
      const from = ev.agent === 'editor' ? ` ${DIM}[editor p${ev.page ?? '?'}]${OFF}` : '';
      process.stderr.write(`${CYAN}→ ${ev.name}${from}${OFF}\n`);
      return;
    }
    if (relayed && ev.agent === 'editor') return;
    state.streamed = true;
    process.stdout.write(ev.delta);
  };
}

/** El texto ya salió por deltas; solo lo imprimimos si el transporte NO streameó. */
export function printText(state: { streamed: boolean }, text: string): void {
  if (!state.streamed && text) process.stdout.write(text);
  if (!state.streamed && !text) process.stdout.write(`${DIM}(el modelo no devolvió texto — esto es un bug del turno)${OFF}`);
  process.stdout.write('\n');
}

/**
 * Hornea a un ARCHIVO NUEVO si el turno dejó cambios (el original no se toca).
 * `promised` = el verbo prometía editar (`edit`): ahí "0 cambios" es un FALLO
 * ruidoso, no un silencio. En `ask` es lo normal — solo escribe si el reader
 * llegó a completar campos.
 *
 * OJO: mira `session.count` ABSOLUTO, así que solo vale para una sesión FRESCA
 * (un comando de un solo turno). El chat, que reusa una sesión y donde `count`
 * nunca baja, compara un delta — ver cli/chat.ts.
 */
export async function bakeIfChanged(
  session: EditSession, outPath: string, promised: boolean, note: string,
): Promise<void> {
  if (session.count > 0) {
    const { applied, warnings } = await session.save(outPath);
    console.error(`${DIM}horneado: ${applied.length} cambio/s${warnings.length ? ` · ⚠ ${warnings.join(' · ')}` : ''}${OFF}`);
    console.error(`${note} → ${outPath}`);
  } else if (promised) {
    console.error(`${RED}✗ el editor no aplicó ningún cambio — NO se generó ${outPath}${OFF}`);
  }
}

/**
 * Un fallo del agente (auth vencida, sin crédito, red, 5xx) es INFRA, no algo
 * que el usuario haya pedido mal. Con un reader adelante se diluye en una
 * paráfrasis; acá se ve crudo, con la salida concreta y qué hacer al respecto.
 *
 * Vale para los DOS agentes: cada uno puede ir por un proveedor distinto (el
 * reader por OpenRouter y el editor por la suscripción es el default), así que
 * el consejo se elige por el modelo que falló, no por una suposición.
 */
export function reportAgentFailure(err: unknown, config: IAgentConfig, which: 'reader' | 'editor'): void {
  const model = which === 'reader' ? config.readerModel : config.editorModel;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n${RED}✗ el ${which} (${model}) falló:${OFF} ${msg}`);
  // "credit/balance" está acá porque una key SIN SALDO falla distinto que una
  // vencida y también deja al usuario sin saber qué tocar.
  if (!/oauth|authenticate|expired|401|403|credit|balance|api[_ ]?key/i.test(msg)) return;
  if (isOpenRouterModel(model)) {
    console.error(`${DIM}  Ese modelo va por OpenRouter → necesita OPENROUTER_API_KEY.${OFF}`);
    console.error(`${DIM}  → export OPENROUTER_API_KEY=sk-or-...${OFF}`);
  } else {
    console.error(`${DIM}  Ese modelo va por la SUSCRIPCIÓN de Claude Code.${OFF}`);
    console.error(`${DIM}  → renová la sesión:  ${OFF}claude login`);
    console.error(`${DIM}  → o mandalo por OpenRouter:  ${OFF}export ALDUS_${which.toUpperCase()}_MODEL='anthropic/claude-sonnet-5'${DIM} + OPENROUTER_API_KEY${OFF}`);
  }
}

export const onHostEvent = (name: string, data: unknown): void => {
  process.stderr.write(`${CYAN}⚡ host:${name}${OFF} ${DIM}${JSON.stringify(data)}${OFF}\n`);
};

/**
 * LA PUERTA reader→editor: el callback que se le pasa a `readTurn` para que el
 * reader pueda delegar (`edit_document`). Sin esto, el reader es lectura +
 * relleno de campos y nada más.
 *
 * Un fallo del editor CORTA el turno (rethrow) en vez de volver como texto: si
 * el editor no corrió, que el reader improvise una respuesta amable sería
 * mentirle al usuario sobre un PDF que no se tocó.
 */
export function editorGate(
  doc: DocGraph, session: EditSession, deps: AgentDeps,
  onEvent: (ev: AgentEvent) => void, ct?: CancellationToken,
) {
  return async (route: EditRoute): Promise<string> => {
    const n = route.pages.length;
    const how = n > 1 ? (route.parallel ? ` · ${n} editores en PARALELO` : ` · 1 editor (${n} págs, cross-página)`) : '';
    process.stderr.write(`${CYAN}→ edit_document${OFF} ${DIM}págs ${route.pages.join(',')}${how} · "${route.request.slice(0, 60)}"${OFF}\n`);
    try {
      const r = await editPages(
        { doc, session, request: route.request, pages: route.pages, parallel: route.parallel, onEvent },
        deps.registry, deps.config, ct,
      );
      return r.text || `✓ editor corrió ${r.toolCalls} tool/s.`;
    } catch (err) {
      reportAgentFailure(err, deps.config, 'editor');
      throw new ReportedError(err);
    }
  };
}

/** `aldus ask <pdf> "<prompt>"` — el READER. Sin `editor:` cableado no delega ni
 *  ofrece edit_document; si le piden un cambio, lo dice y manda a `aldus edit`. */
export async function runAsk(pdf: string, prompt: string, out: string | undefined, deps: AgentDeps): Promise<void> {
  const { t0, outPath, doc, session } = await openSession(pdf, out);
  console.error(`${DIM}grafo: ${doc.pages.length} pág en ${Date.now() - t0}ms · reader=${deps.config.readerModel}${OFF}\n`);

  const state = { streamed: false };
  let text: string;
  let toolsUsed: string[];
  try {
    ({ text, toolsUsed } = await readTurn(
      { doc, session, prompt, onEvent: eventPrinter(state, true), onHostEvent },
      deps.registry, deps.config,
    ));
  } catch (err) {
    // Sin esto, la falla más común de todas (auth vencida) le tiraba al usuario
    // un stack del SDK de Anthropic y ninguna pista de qué hacer.
    reportAgentFailure(err, deps.config, 'reader');
    throw new ReportedError(err);
  }

  printText(state, text);
  // El reader solo puede haber tocado el doc rellenando campos.
  await bakeIfChanged(session, outPath, false, 'campos completados → PDF');
  console.error(`${DIM}\n${Date.now() - t0}ms · tools: ${toolsUsed.join(', ') || '(ninguna)'}${OFF}`);
}

/** `aldus edit <pdf> "<prompt>"` — el EDITOR. Por default DIRECTO (el scope lo da
 *  `--pages`); con `--auto` se le pone el reader adelante para que elija. */
export async function runEdit(
  pdf: string, prompt: string,
  opts: { out?: string; pages?: number[]; auto: boolean },
  deps: AgentDeps,
): Promise<void> {
  const { t0, outPath, doc, session } = await openSession(pdf, opts.out);
  const scope = opts.auto ? 'las elige el reader' : opts.pages?.length ? `págs ${opts.pages.join(',')}` : 'todas las págs';
  console.error(`${DIM}grafo: ${doc.pages.length} pág en ${Date.now() - t0}ms · editor=${deps.config.editorModel} · ${scope}${OFF}\n`);

  const state = { streamed: false };
  let toolsUsed: string[] = [];

  if (opts.auto) {
    // Ruteo: el reader lee todo, elige páginas y delega. Su respuesta final es
    // la que se imprime, así que el texto del editor viaja "relayed".
    const onEvent = eventPrinter(state, true);
    try {
      const res = await readTurn(
        { doc, session, prompt, onEvent, onHostEvent, editor: editorGate(doc, session, deps, onEvent) },
        deps.registry, deps.config,
      );
      toolsUsed = res.toolsUsed;
      printText(state, res.text);
    } catch (err) {
      // Un fallo del EDITOR ya lo reportó editorGate (y el reader suele
      // convertirlo en prosa); esto atrapa al READER cayéndose.
      if (!(err instanceof ReportedError)) reportAgentFailure(err, deps.config, 'reader');
      throw new ReportedError(err);
    }
  } else {
    try {
      const r = await editPages(
        { doc, session, request: prompt, pages: opts.pages, onEvent: eventPrinter(state, false) },
        deps.registry, deps.config,
      );
      toolsUsed = r.toolsUsed;
      printText(state, r.text);
    } catch (err) {
      reportAgentFailure(err, deps.config, 'editor');
      throw new ReportedError(err);
    }
  }

  await bakeIfChanged(session, outPath, true, 'PDF editado');
  console.error(`${DIM}\n${Date.now() - t0}ms · tools: ${toolsUsed.join(', ') || '(ninguna)'}${OFF}`);
}
