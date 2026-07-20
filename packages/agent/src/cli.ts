/**
 * cli.ts — el binario `aldus` (el paquete npm homónimo lo bundlea como
 * dist/cli.js) y a la vez el host de PRUEBA del agente (AGENT-PLAN.md).
 *
 *   aldus <pdf>                     → el EDITOR VISUAL + CASPER en el navegador.
 *   aldus <pdf> --chat              → la conversación en la terminal.
 *   aldus <pdf> --fields            → los campos como JSON       (sin LLM).
 *   aldus <pdf> --fill '{…}'        → completa el formulario     (sin LLM).
 *   aldus tools                     → el manifiesto: tools por nivel + config.
 *   aldus ask  <pdf> "<prompt>"     → un turno del READER  → texto a stdout.
 *   aldus edit <pdf> "<prompt>"     → un turno del EDITOR  → un PDF nuevo.
 *
 * Este archivo es SOLO el dispatch: cada comando vive en `cli/` porque acá
 * `main()` corre al importarse y nada de lo que viva acá se puede testear.
 *
 * Un detalle que el orden del dispatch protege: los comandos DETERMINÍSTICOS
 * (`--fields`, `--fill`) se resuelven ANTES de construir el container del
 * agente. Prometen "sin LLM, sin API key" y armar la config del modelo para
 * leer un AcroForm sería contradecirlo.
 */
import { runChat } from './cli/chat.js';
import { parseFlags } from './cli/flags.js';
import { runFields, runFill } from './cli/forms.js';
import { runAsk, runEdit, type AgentDeps } from './cli/turns.js';
import { CliError, DIM, OFF, RED, ReportedError } from './cli/ui.js';
import { IAgentConfig, isOpenRouterModel } from './config.js';
import { openInEditor } from './host/openInEditor.js';
import { createAgentContainer } from './ioc.js';
import { IAgentTool } from './tools/contract.js';
import { IToolRegistry } from './tools/registry.js';

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

function usage(): never {
  console.log([
    'aldus — agente de lectura/edición de PDFs',
    '',
    '  aldus <pdf>                    abre el EDITOR VISUAL + CASPER en el navegador',
    '  aldus <pdf> --chat             conversación en la terminal (lectura + edición)',
    '',
    'Formularios — DETERMINÍSTICO, sin LLM ni API key:',
    '  aldus <pdf> --fields           vuelca los campos (nombre, tipo, valor, posición) como JSON',
    '  aldus <pdf> --fill \'{"n":"Ana"}\'  completa por nombre → <nombre>.filled.pdf',
    '      --flatten                  aplana después de completar (deja de ser editable)',
    '      -o <path>                  dónde escribir el resultado',
    '',
    'Agente:',
    '  aldus tools                    manifiesto: tools por nivel + modelos',
    '',
    '  aldus ask <pdf> "<prompt>"     READER — responde sobre el PDF (texto a stdout).',
    '                                 Puede completar campos de formulario; si lo hace,',
    '                                 hornea el resultado a un PDF nuevo.',
    '',
    '  aldus edit <pdf> "<prompt>"    EDITOR — edita el PDF → <nombre>.edited.pdf',
    '      --pages 1,3                las páginas a editar (default: todas)',
    '      --auto                     el READER elige las páginas (ruteo automático)',
    '      -o <path>                  dónde escribir el resultado',
  ].join('\n'));
  process.exit(1);
}

/** El container del agente, SOLO para los comandos que corren un modelo. */
function agentDeps(): { deps: AgentDeps; hostDemo: boolean } {
  const container = createAgentContainer();
  const hostDemo = bindHostDemoTools(container);
  return {
    deps: { registry: container.get(IToolRegistry), config: container.get(IAgentConfig) },
    hostDemo,
  };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  if (cmd === 'tools') {
    const { deps: { registry, config }, hostDemo } = agentDeps();
    const transport = (m: string) => (isOpenRouterModel(m) ? 'OpenRouter' : 'Claude SDK (suscripción)');
    console.log(`READER  ${config.readerModel}  [${transport(config.readerModel)}]`);
    for (const t of registry.forLevel('reader')) console.log(`  · ${t.name} — ${t.description.split('\n')[0]}`);
    console.log(`EDITOR  ${config.editorModel}  [${transport(config.editorModel)}]  maxTurns=${config.maxTurns}`);
    for (const t of registry.forLevel('editor')) console.log(`  · ${t.name} — ${t.description.split('\n')[0]}`);
    const total = new Set([...registry.forLevel('reader'), ...registry.forLevel('editor')].map(t => t.name)).size;
    console.log(`\n${total} tool/s bindeada/s.${hostDemo ? ' (incluye la tool de demo del host: list_signers)' : ''}`);
    return;
  }

  if (cmd === 'ask' || cmd === 'edit') {
    const flags = parseFlags(rest);
    const [pdf, prompt] = flags.positional;
    if (!pdf || !prompt) usage();
    const { deps } = agentDeps();
    if (cmd === 'ask') await runAsk(pdf, prompt, flags.out, deps);
    else await runEdit(pdf, prompt, { out: flags.out, pages: flags.pages, auto: flags.auto }, deps);
    return;
  }

  // ── `aldus <pdf> [flags]`: sin verbo. Según la flag, cuatro destinos.
  if (/\.pdf$/i.test(cmd)) {
    const flags = parseFlags(rest);

    // DETERMINÍSTICOS primero: nada de container ni config de modelos.
    if (flags.fields) return runFields(cmd);
    if (flags.fill) return runFill(cmd, flags.fill, flags.out, flags.flatten);

    if (flags.chat) {
      const { deps } = agentDeps();
      return runChat(cmd, deps);
    }

    // `aldus doc.pdf "un prompt"` fue la forma vieja de correr el agente. Ahora
    // hay un verbo por agente: mandarlo al correcto en vez de fallar mudo.
    if (flags.positional.length) {
      console.error(`${RED}aldus <pdf> abre el editor visual y no lleva prompt.${OFF}`);
      console.error(`${DIM}  preguntar → ${OFF}aldus ask ${cmd} ${JSON.stringify(flags.positional[0])}`);
      console.error(`${DIM}  editar    → ${OFF}aldus edit ${cmd} ${JSON.stringify(flags.positional[0])}`);
      process.exit(1);
    }

    // ── EDITOR VISUAL. Levanta el server local, sirve la SPA y abre el navegador
    //    (vive hasta Ctrl+C). `openInEditor` ya existía — la usa el ejemplo
    //    edit-in-browser y su SPA es la que build.mjs empaqueta en dist/editor.
    await openInEditor(cmd);
    return;
  }

  usage();
}

main().catch(err => {
  // Tres clases de fallo, tres tratos:
  //  · ReportedError → ya se explicó con un diagnóstico completo; sumar el stack
  //    del SDK acá solo lo taparía. Salir callado.
  //  · CliError      → culpa del input: mensaje limpio, sin stack.
  //  · cualquier otro → bug nuestro, el stack TIENE que verse.
  if (err instanceof ReportedError) process.exit(1);
  if (err instanceof CliError) console.error(`${RED}${err.message}${OFF}`);
  else console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
