/**
 * cli.ts — el host de PRUEBA del agente (el que usa Berna para verificar cada
 * fase con sus propios ojos; AGENT-PLAN.md).
 *
 *   aldus tools                    → el manifiesto: tools bindeadas por nivel + config.
 *   aldus ask <pdf> "<prompt>"     → un turno del READER sobre el PDF.
 *
 * Es un host FINITO: compone el container, corre, imprime, sale. Todo lo que
 * hace pasa por la misma API pública que usará el server/Signwax.
 */
import { rm } from 'node:fs/promises';
import { editPages } from './agents/editor.js';
import { readTurn } from './agents/reader.js';
import { IAgentConfig, isOpenRouterModel } from './config.js';
import { loadDoc } from './graph.js';
import { createAgentContainer } from './ioc.js';
import { EditSession } from './session/EditSession.js';
import { IAgentTool } from './tools/contract.js';
import { IToolRegistry } from './tools/registry.js';
import type { AgentEvent } from './transport/transport.js';

/**
 * DEMO de extensión host (F7): con ALDUS_HOST_DEMO=1 el CLI actúa como si fuera
 * Signwax y BINDEA sus propias tools de dominio en el container — sin tocar el
 * paquete del agente (OCP). El reader las ve junto a las nativas; sus eventos de
 * dominio salen por ctx.emit → onHostEvent. Es exactamente lo que hará Signwax.
 */
function bindHostDemoTools(container: ReturnType<typeof createAgentContainer>): boolean {
  if (process.env.ALDUS_HOST_DEMO !== '1') return false;
  container.bind(IAgentTool).toConstantValue({
    name: 'list_signers', level: 'reader',
    description: 'Los firmantes del acuerdo (tool de DOMINIO del host — no del PDF).',
    shape: {},
    run: (ctx) => {
      ctx.emit('signers_listed', { count: 2 }); // evento de dominio → wire
      return '✓ 2 firmantes: ana@empresa.com (pendiente), luis@distribuidora.com (firmado)';
    },
  });
  return true;
}

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

function usage(): never {
  console.log([
    'aldus — agente de lectura/edición de PDFs (v2, reescritura por fases)',
    '',
    '  aldus tools                  manifiesto: tools por nivel + modelos',
    '  aldus ask <pdf> "<prompt>"   un turno del reader sobre el PDF',
  ].join('\n'));
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const container = createAgentContainer();
  const hostDemo = bindHostDemoTools(container);
  const config = container.get(IAgentConfig);
  const registry = container.get(IToolRegistry);

  if (cmd === 'tools') {
    const transport = (m: string) => (isOpenRouterModel(m) ? 'OpenRouter' : 'Claude SDK (suscripción)');
    console.log(`READER  ${config.readerModel}  [${transport(config.readerModel)}]`);
    for (const t of registry.forLevel('reader')) console.log(`  · ${t.name} — ${t.description.split('\n')[0]}`);
    console.log(`EDITOR  ${config.editorModel}  [${transport(config.editorModel)}]  maxTurns=${config.maxTurns}`);
    for (const t of registry.forLevel('editor')) console.log(`  · ${t.name} — ${t.description.split('\n')[0]}`);
    const total = new Set([...registry.forLevel('reader'), ...registry.forLevel('editor')].map(t => t.name)).size;
    console.log(`\n${total} tool/s bindeada/s.${hostDemo ? ' (incluye la tool de demo del host: list_signers)' : ''}`);
    return;
  }

  if (cmd === 'ask') {
    const [pdf, prompt] = rest;
    if (!pdf || !prompt) usage();

    const t0 = Date.now();
    const outPath = pdf.replace(/\.pdf$/i, '') + '.edited.pdf';
    // El .edited.pdf de una corrida ANTERIOR es una trampa: si esta falla o no
    // edita, abrirlo muestra un resultado viejo como si fuera el de ahora.
    // Se borra ANTES de empezar — si al final existe, es de esta corrida.
    await rm(outPath, { force: true });

    const doc = await loadDoc(pdf);
    console.error(`${DIM}grafo: ${doc.pages.length} pág en ${Date.now() - t0}ms · reader=${config.readerModel} · editor=${config.editorModel}${OFF}\n`);

    const session = new EditSession(doc);
    let streamed = false;
    let edited = false;
    // El tipo del CONTRATO (no un inline): así el CLI acompaña al wire — cuando
    // se le sumó `page` (fan-out), un inline suelto lo perdía en silencio.
    const onEvent = (ev: AgentEvent): void => {
      if (ev.type === 'tool') return void process.stderr.write(`${CYAN}→ ${ev.name}${ev.agent === 'editor' ? ` ${DIM}[editor p${ev.page ?? '?'}]${OFF}` : ''}${OFF}\n`);
      if (ev.agent === 'editor') return; // el reporte del editor vuelve por el reader
      streamed = true;
      process.stdout.write(ev.delta);
    };

    const { text, toolsUsed } = await readTurn({
      doc,
      session,
      prompt,
      onEvent,
      // Eventos de DOMINIO de las tools del host (F7): al wire → acá, a stderr.
      onHostEvent: (name, data) => process.stderr.write(`${CYAN}⚡ host:${name}${OFF} ${DIM}${JSON.stringify(data)}${OFF}\n`),
      // La puerta a la edición: reader rutea {pages, request} → editor (Sonnet)
      // con el grafo scoped. Su reporte vuelve al reader, que cierra la respuesta.
      editor: async route => {
        edited = true;
        const n = route.pages.length;
        const mode = n > 1 ? (route.parallel ? ` · ${n} editores en PARALELO` : ` · 1 editor (${n} págs, cross-página)`) : '';
        process.stderr.write(`${CYAN}→ edit_document${OFF} ${DIM}págs ${route.pages.join(',')}${mode} · "${route.request.slice(0, 60)}"${OFF}\n`);
        try {
          const r = await editPages({ doc, session, request: route.request, pages: route.pages, parallel: route.parallel, onEvent }, registry, config);
          return r.text || `✓ editor corrió ${r.toolCalls} tool/s.`;
        } catch (err) {
          // El fallo del EDITOR (auth vencida, red, 5xx) es infra: el reader lo
          // parafrasea y se diluye. Acá se ve crudo, con la salida concreta.
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\n${RED}✗ el editor (${config.editorModel}) falló:${OFF} ${msg}`);
          if (/oauth|authenticate|expired|401/i.test(msg)) {
            console.error(`${DIM}  El editor va por la SUSCRIPCIÓN de Claude (OPENROUTER_API_KEY solo aplica al reader).${OFF}`);
            console.error(`${DIM}  → renová la sesión:  ${OFF}claude login`);
            console.error(`${DIM}  → o mandá el editor por OpenRouter:  ${OFF}export ALDUS_EDITOR_MODEL='anthropic/claude-sonnet-5'`);
          }
          throw err; // corta el turno: no tiene sentido que el reader invente una respuesta
        }
      },
    }, registry, config);

    // El texto ya salió por deltas; solo lo imprimimos si el transporte NO streameó.
    if (!streamed && text) process.stdout.write(text);
    if (!streamed && !text) process.stdout.write(`${DIM}(el modelo no devolvió texto — esto es un bug del turno)${OFF}`);
    process.stdout.write('\n');

    // Hubo edición CON CAMBIOS REALES → hornear a un ARCHIVO NUEVO (el original
    // no se toca). Un editor que falló (0 cambios) no hornea nada.
    if (edited && session.count > 0) {
      const { applied, warnings } = await session.save(outPath);
      console.error(`${DIM}horneado: ${applied.length} cambio/s${warnings.length ? ` · ⚠ ${warnings.join(' · ')}` : ''}${OFF}`);
      console.error(`PDF editado → ${outPath}`);
    } else if (edited) {
      console.error(`${RED}✗ el editor no aplicó ningún cambio — NO se generó .edited.pdf${OFF}`);
    }

    console.error(`${DIM}\n${Date.now() - t0}ms · tools: ${toolsUsed.join(', ') || '(ninguna)'}${OFF}`);
    return;
  }

  usage();
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
