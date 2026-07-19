/**
 * editor.ts — EL AGENTE DE EDICIÓN (fuerte: Claude Sonnet por default).
 *
 * Ve la página TAL CUAL ES: {@link serializeDoc} scoped a las páginas que el
 * reader ruteó — el grafo pixel-perfect (ids reales, coordenadas en puntos PDF,
 * estilos por run, campos con su rect). Edita anclando SIEMPRE a ids del grafo,
 * nunca a coordenadas inventadas — por eso no necesita visión ni verificación
 * geométrica a posteriori.
 *
 * El scoping es el motivo del split en dos agentes: el documento entero lo lee
 * el reader (barato); el editor recibe SOLO las páginas a tocar.
 */
import { createLogger, NeverCancelled, type CancellationToken } from '@aldus/core';
import type { IAgentConfig } from '../config.js';
import type { DocGraph } from '../graph.js';
import { serializeDoc } from '../serialize.js';
import type { EditSession } from '../session/EditSession.js';
import type { ToolContext } from '../tools/contract.js';
import type { IToolRegistry } from '../tools/registry.js';
import type { AgentEvent, ILlmTransport } from '../transport/transport.js';
import { dedupedDispatch } from './dedupe.js';
import { createMutex, type Mutex } from './mutex.js';
import { transportFor } from './transports.js';

const log = createLogger('aldus:agent:editor');

export interface EditTurnOpts {
  doc: DocGraph;
  session: EditSession;
  /** Qué hay que hacer (el pedido del usuario + el plan del reader). */
  request: string;
  /** Páginas a editar (1-based). Vacío/undefined = todas (documento chico). */
  pages?: number[];
  /** El conjunto COMPLETO de páginas que el reader ruteó (cuando hay fan-out).
   *  Le dice a este editor que es UNO de varios en paralelo y que solo debe
   *  hacer su parte — sin negarse porque el pedido abarque otras páginas. */
  siblingsPages?: number[];
  onEvent?: (ev: AgentEvent) => void;
  onHostEvent?: (name: string, data: unknown) => void;
  /** Transporte inyectado (tests: un fake de guion). Default: por el modelo. */
  transport?: ILlmTransport;
  /** Serializa el acceso a la EditSession compartida cuando varios editores
   *  corren en paralelo ({@link editPages}). Default: sin cola (un solo editor). */
  mutex?: Mutex;
  /** true = trabajo independiente por página → {@link editPages} hace fan-out.
   *  false/omit = un solo editor sobre todas las páginas (permite cruzar páginas). */
  parallel?: boolean;
}

export interface EditTurnResult {
  /** El reporte del editor (qué hizo / qué no pudo). */
  text: string;
  toolsUsed: string[];
  toolCalls: number;
}

function systemPrompt(doc: DocGraph, pages?: number[], siblingsPages?: number[]): string {
  const mine = pages && pages.length ? pages : doc.pages.map(p => p.page);
  const others = (siblingsPages ?? []).filter(p => !mine.includes(p));
  return [
    'Sos el EDITOR de un documento PDF. Abajo está el grafo EXACTO de las páginas',
    'a trabajar: cada nodo con su id, texto, posición (puntos PDF, origen abajo-',
    'izquierda, y = baseline) y estilo. Esto ES la página, tal cual se renderiza.',
    ...(others.length ? [
      '',
      `IMPORTANTE — TRABAJO EN PARALELO. Vos editás SOLO la/s página/s ${mine.join(', ')}.`,
      `Las página/s ${others.join(', ')} las editan OTROS editores AL MISMO TIEMPO.`,
      'Si el pedido abarca varias páginas (p.ej. "toda la sección 1", que cruza',
      'páginas), hacé ÚNICAMENTE la parte que cae en TU página, con los nodos que',
      'ves abajo. NUNCA te niegues ni pidas el grafo de otra página: no la vas a',
      'tener y NO es tu trabajo — el otro editor la resuelve. Reemplazá/borrá tu',
      'porción como corresponde y listo.',
    ] : []),
    '',
    'Reglas (estrictas):',
    '- Editá SOLO con las tools, anclando por id EXACTO del grafo (p1-y711-x154).',
    '  Nunca inventes ids ni coordenadas.',
    '- Hacé exactamente lo pedido — ni más ni menos. No "mejores" nada que no',
    '  te hayan pedido.',
    '- "Convertir puntos suspensivos / huecos / …… / ____ / rellenos XXXX/xxx/***',
    '  en CAMPOS (de formulario, completables, rellenables)" = placeholders_to_fields',
    '  (o su _batch para varios párrafos). Esa tool crea campos AcroForm REALES',
    '  sobre el hueco (los rellenos XXXX los ELIMINA sola y deja el campo en su',
    '  lugar). Cada hueco es un field SEPARADO ("XX de XXXXXX de XXXX" = 3 fields).',
    '  JAMÁS uses edit_text/replace_paragraph para eso: escribir "[____]" con',
    '  texto NO es un campo — es texto, no se puede rellenar.',
    '- Cuando una acción aplica a VARIOS lugares (p.ej. convertir todos los',
    '  placeholders), usá la tool _batch en UNA sola llamada con todos los grupos.',
    '  NUNCA la llames de a uno en serie: es lento y no hace falta.',
    '- Para reescribir VARIOS párrafos seguidos (una cláusula, un preámbulo):',
    '  UNA sola replace_paragraph con end_id = el último párrafo del bloque.',
    '  NUNCA lo hagas con varias ediciones sueltas: el layout queda inconsistente.',
    '- Cada edición exitosa te devuelve el ESTADO ACTUALIZADO de la zona editada.',
    '  El grafo de abajo NO se actualiza solo: para ediciones encadenadas sobre la',
    '  misma zona, guiate por ese estado (los ids se mantienen).',
    '- Una tool que responde ⚠️ te dice el problema: corregí los args y reintentá',
    '  UNA vez, o explicá por qué no se puede.',
    '- Al terminar, reportá en una línea qué cambiaste (o qué no pudiste).',
    '',
    serializeDoc(doc, pages && pages.length ? pages : undefined),
  ].join('\n');
}

/** ¿A qué página apuntó la tool? Del id (`p3-…`) o del arg `page`. */
function pageOfArgs(args: Record<string, unknown>): number | null {
  const id = typeof args.id === 'string' ? args.id : '';
  const m = /^p(\d+)-/.exec(id);
  if (m) return Number(m[1]);
  return typeof args.page === 'number' ? args.page : null;
}

/**
 * El "estado actualizado" que acompaña a cada edición ✓ (patrón MCP edit-tool):
 * la zona alrededor del nodo tocado (±2 vecinos) con el ledger APLICADO, o los
 * nodos editados de la página si la tool no apuntó a un id. Deja registro de
 * DÓNDE se editó y refresca la vista del modelo sin re-embeber la página.
 */
function updatedSnippet(session: EditSession, page: number, targetId?: string): string {
  const segs = session.effectiveSegments(page).sort((a, b) => b.baseline - a.baseline);
  if (!segs.length) return '';
  let rows = segs;
  const i = targetId ? segs.findIndex(s => s.id === targetId) : -1;
  if (i >= 0) rows = segs.slice(Math.max(0, i - 2), i + 3);
  else rows = segs.filter(s => s.edited || s.removed);
  if (!rows.length) return '';
  const r = (n: number): number => Math.round(n);
  return rows
    .map(s => `- ${s.id} @(${r(s.x)},${r(s.baseline)}): ${s.removed ? '(ELIMINADO)' : JSON.stringify(s.text)}${s.id === targetId ? '   ← editado' : ''}`)
    .join('\n');
}

/** Un turno del editor: aplica la edición pedida sobre la sesión y reporta. */
export async function editTurn(
  opts: EditTurnOpts,
  registry: IToolRegistry,
  config: IAgentConfig,
  ct: CancellationToken = NeverCancelled,
): Promise<EditTurnResult> {
  const t0 = Date.now();
  const transport = opts.transport ?? transportFor(config.editorModel, config);
  const tools = registry.passTools('editor');
  log(`turno: "${opts.request.slice(0, 60)}" · ${config.editorModel} · págs ${opts.pages?.join(',') || 'todas'} · ${tools.length} tool/s`);

  const ctx: ToolContext = {
    doc: opts.doc,
    session: opts.session,
    emit: (name, data) => opts.onHostEvent?.(name, data),
  };

  // Toda edición ✓ vuelve con DÓNDE se hizo + el estado actualizado de la zona
  // (patrón MCP edit-tool). Centralizado acá: cada tool futura lo hereda gratis.
  // El mutex serializa la mutación cuando varios editores comparten la sesión.
  const dispatch = dedupedDispatch(registry, ctx);
  const lock = opts.mutex ?? (<T>(fn: () => Promise<T>) => fn());
  const onToolCall = (name: string, args: Record<string, unknown>): Promise<string> => lock(async () => {
    const msg = await dispatch(name, args);
    if (!msg.startsWith('✓')) return msg;
    const page = pageOfArgs(args);
    if (page == null) return msg;
    const snippet = updatedSnippet(opts.session, page, typeof args.id === 'string' ? args.id : undefined);
    return snippet ? `${msg}\n\n[estado actualizado · p${page}]\n${snippet}` : msg;
  });

  const res = await transport.chat({
    model: config.editorModel,
    system: systemPrompt(opts.doc, opts.pages, opts.siblingsPages),
    prompt: opts.request,
    role: 'editor',
    tools,
    maxTurns: config.maxTurns,
    loop: true,
    onToolCall,
    // Con el fan-out hay varios editores a la vez: cada evento dice de qué página
    // viene, o el stream es una sopa.
    onEvent: opts.onEvent && (ev => opts.onEvent!({ ...ev, page: opts.pages?.length === 1 ? opts.pages[0] : undefined })),
  }, ct);

  log(`listo en ${Date.now() - t0}ms · ${res.toolCalls} tool call/s: ${res.toolsUsed.join(', ') || '(ninguna)'}`);
  return { text: res.text, toolsUsed: res.toolsUsed, toolCalls: res.toolCalls };
}

/**
 * FAN-OUT: UN AGENTE EDITOR POR PÁGINA, en paralelo.
 *
 * Un solo editor con N páginas encadena todas sus tools en serie contra el
 * mismo modelo — la latencia es la SUMA (medido: 18 llamadas, 235s en un doc de
 * 4 páginas). Una página es una unidad de trabajo independiente: su grafo, sus
 * ids, sus placeholders. Con un agente por página la latencia pasa a ser la de
 * la página MÁS LENTA, y cada uno ve un prompt más chico (mejor precisión).
 *
 * Comparten UNA EditSession (un ledger, un bake, un PDF) → las mutaciones se
 * serializan con un {@link Mutex}. Un editor que falla no tumba a los otros:
 * su error vuelve en el reporte.
 */
export async function editPages(
  opts: EditTurnOpts,
  registry: IToolRegistry,
  config: IAgentConfig,
  ct: CancellationToken = NeverCancelled,
): Promise<EditTurnResult> {
  const pages = opts.pages?.length ? opts.pages : opts.doc.pages.map(p => p.page);
  // Fan-out SOLO si el reader marcó trabajo independiente por página (parallel).
  // Si no, UN editor que ve TODAS las páginas — así una edición que cruza páginas
  // (replace_section) tiene ambos extremos a la vista. Default seguro: un editor.
  if (pages.length === 1 || !opts.parallel) return editTurn(opts, registry, config, ct);

  const t0 = Date.now();
  const mutex = createMutex();
  log(`fan-out: ${pages.length} editores en paralelo (págs ${pages.join(',')})`);

  const results = await Promise.all(pages.map(async page => {
    try {
      const r = await editTurn({ ...opts, pages: [page], siblingsPages: pages, mutex }, registry, config, ct);
      return { page, ok: true as const, r };
    } catch (err) {
      log(`editor p${page} falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return { page, ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }));

  const failed = results.filter(x => !x.ok);
  // TODOS fallaron = el fallo es del modelo/infra, no del contenido: propagarlo
  // (el CLI lo muestra crudo con la salida concreta) en vez de reportar "listo".
  if (failed.length === results.length) {
    throw new Error(failed[0]!.ok ? 'editor falló' : (failed[0] as { error: string }).error);
  }

  const toolsUsed = results.flatMap(x => (x.ok ? x.r.toolsUsed : []));
  const toolCalls = results.reduce((n, x) => n + (x.ok ? x.r.toolCalls : 0), 0);
  const text = results
    .map(x => (x.ok ? `[p${x.page}] ${x.r.text}` : `[p${x.page}] ⚠️ falló: ${x.error}`))
    .join('\n');

  log(`fan-out listo en ${Date.now() - t0}ms · ${toolCalls} tool call/s · ${failed.length} página/s con error`);
  return { text, toolsUsed, toolCalls };
}
