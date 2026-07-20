/**
 * reader.ts — EL AGENTE DE LECTURA (barato: Gemini por default).
 *
 * El CONTENIDO del documento va INLINE en el system prompt ({@link
 * serializeReading}: texto en orden de lectura, sin ids ni coordenadas). Un
 * contrato entero entra por centavos en un modelo barato — el reader contesta
 * en UNA pasada, sin round-trips de tools para leer.
 *
 * Las tools de nivel 'reader' son las del HOST (Signwax: list_signers,
 * list_agreements…) — dominio, no lectura — MÁS las nativas de nivel 'both':
 * hoy `fill_field`/`fill_fields`, que rellenan por NOMBRE de campo y por eso no
 * necesitan el grafo. Rellenar un formulario es la edición que se pide LEYENDO,
 * así que el reader la hace solo, barato, sin despertar al editor.
 *
 * Para MODIFICAR el documento (texto, layout, campos nuevos) la única puerta es
 * `edit_document({pages, request})`: delega en el agente EDITOR con el grafo
 * scoped a esas páginas (ese scoping es el motivo del split en dos agentes: el
 * editor nunca come el documento entero). El reader NO conoce al editor — el
 * host le inyecta la puerta como callback ({@link ReadTurnOpts.editor}).
 *
 * Esa puerta es OPCIONAL a propósito: un host que expone reader y editor como
 * DOS agentes separados (dos pestañas de chat) simplemente no pasa `editor` —
 * el reader queda como lectura + relleno de campos, y nunca delega.
 */
import { createLogger, NeverCancelled, type CancellationToken } from '@aldus/core';
import { z } from 'zod';
import type { IAgentConfig } from '../config.js';
import type { DocGraph } from '../graph.js';
import { serializeReading, type EffectiveView } from '../serialize.js';
import type { EditSession } from '../session/EditSession.js';
import { docLessContext, type ToolContext } from '../tools/contract.js';
import type { IToolRegistry } from '../tools/registry.js';
import type { AgentEvent, ChatTurn, ILlmTransport, PassTool } from '../transport/transport.js';
import { dedupedDispatch } from './dedupe.js';
import { transportFor } from './transports.js';

const log = createLogger('aldus:agent:reader');

/** Lo que el reader rutea al editor. */
export interface EditRoute {
  /** Páginas EXACTAS a trabajar (1-based). */
  pages: number[];
  /** El pedido, reescrito con todo el contexto que el editor necesita. */
  request: string;
  /** true = trabajo INDEPENDIENTE por página (misma acción en cada una, p.ej.
   *  convertir placeholders en todas) → fan-out, un editor por página en paralelo.
   *  false/omit = UNA edición que puede cruzar páginas (reemplazar una sección) →
   *  un solo editor que ve TODAS las páginas. Default seguro: un editor. */
  parallel?: boolean;
}

export interface ReadTurnOpts {
  /** El documento abierto. OPCIONAL: un turno sin doc es el chat org-level del
   *  host (consultas de dominio puras) — sin edit_document, tools 'reader' solas. */
  doc?: DocGraph;
  session?: EditSession;
  /** Contexto del HOST para el system prompt: quién es el usuario, el estado de
   *  su organización, qué hay pendiente… Es EL contenido en un turno sin doc,
   *  y contexto adicional cuando hay documento. */
  context?: string;
  prompt: string;
  /** MEMORIA: los turnos de conversación previos (user/assistant). El reader los
   *  ve para recordar de qué venían hablando. Vacío = conversación nueva. */
  history?: ChatTurn[];
  onEvent?: (ev: AgentEvent) => void;
  /** Evento de dominio de una tool del host → wire. */
  onHostEvent?: (name: string, data: unknown) => void;
  /** La puerta a la EDICIÓN: el host la cablea al agente editor (editTurn).
   *  Sin esto el reader es solo-lectura y ni ofrece edit_document. Devuelve el
   *  reporte del editor, que vuelve al reader para cerrar la respuesta. */
  editor?: (route: EditRoute) => Promise<string>;
  /** Transporte inyectado (tests: un fake de guion). Default: por el modelo. */
  transport?: ILlmTransport;
}

export interface ReadTurnResult {
  text: string;
  /** Nombres de las tools que corrió, en orden. */
  toolsUsed: string[];
}

const EDIT_DOC_SHAPE = {
  pages: z.array(z.number().int().positive()).min(1)
    .describe('las páginas EXACTAS donde hay que trabajar (mirá el contenido y decidí)'),
  request: z.string().min(5)
    .describe('el pedido de edición COMPLETO, con el texto exacto a tocar y el resultado esperado'),
  parallel: z.boolean().optional()
    .describe('true SOLO si es la MISMA acción independiente en cada página (p.ej. "convertir los puntos en campos en TODAS las páginas"). false/omitir si es UNA edición que puede cruzar páginas (reemplazar/borrar una sección, un párrafo largo).'),
};

function editDocumentTool(): PassTool {
  return {
    name: 'edit_document',
    description:
      'Delegá una MODIFICACIÓN del documento al editor. El editor puede TODO: editar/' +
      'mover/borrar texto, convertir placeholders (...., ____, XXXX) en CAMPOS DE ' +
      'FORMULARIO RELLENABLES reales (AcroForm), completar formularios, crear campos/' +
      'imágenes/resaltados/links/marcas de agua. NUNCA juzgues si algo "se puede": si el ' +
      'usuario pide CAMBIAR el documento, tu trabajo es delegar con esta tool. Pasale las ' +
      'páginas exactas y el pedido completo (citá el texto tal cual aparece). Para leer/' +
      'resumir respondé directo. Para reemplazar una SECCIÓN que cruza páginas, incluí ' +
      'TODAS sus páginas y dejá parallel en false.',
    shape: EDIT_DOC_SHAPE,
    parameters: z.toJSONSchema(z.object(EDIT_DOC_SHAPE)) as Record<string, unknown>,
  };
}

function systemPrompt(
  doc: DocGraph | undefined,
  canEdit: boolean,
  canFill: boolean,
  context?: string,
  eff?: EffectiveView,
): string {
  return [
    ...(doc ? [
      'Sos el asistente de un documento PDF. Abajo tenés su CONTENIDO COMPLETO,',
      'página por página, en orden de lectura. Respondé DIRECTO desde ahí — no',
      'necesitás ninguna tool para leer. No inventes texto que no esté abajo.',
    ] : [
      'Sos un asistente con tools de dominio. Abajo tenés el CONTEXTO del host:',
      'respondé desde ahí y usá las tools cuando haga falta actuar o consultar',
      'algo que no esté abajo. No inventes datos.',
    ]),
    ...(canEdit ? [
      '',
      'Si el usuario pide MODIFICAR el documento, LLAMÁ la tool edit_document:',
      'elegí las páginas exactas mirando el contenido, y reescribí el pedido',
      'citando el texto tal cual aparece. Después contale al usuario el resultado.',
      '⚠️ edit_document es la ÚNICA forma de editar: NUNCA anuncies que "vas a',
      'proceder", ni le des instrucciones al editor en texto, ni describas la',
      'edición como hecha — si no LLAMASTE la tool, NO pasó nada. Ante un pedido',
      'de edición tu PRIMERA acción es la tool call, no una respuesta.',
    ] : []),
    ...(canFill ? [
      '',
      'CAMPOS DE FORMULARIO: los tenés listados abajo, página por página, con su',
      'valor actual y el texto que va pegado a cada uno ("near"). Si el usuario',
      'pide COMPLETARLOS/rellenarlos, hacelo VOS con fill_fields: UNA sola llamada',
      'con todos los campos, identificados por su NOMBRE (usá el "near" para saber',
      'qué va en cada uno — los nombres suelen ser opacos). Rellenar es lo único',
      'que podés modificar por tu cuenta.',
    ] : []),
    ...(doc && !canEdit ? [
      '',
      'NO podés hacer ningún OTRO cambio (editar o mover texto, borrar, crear',
      'campos nuevos, convertir placeholders). Si te lo piden, decilo claro y',
      'mandalos al agente EDITOR — no prometas ni describas cambios que no hiciste.',
    ] : []),
    '',
    'Contestá en el idioma en que te hablen, y sé directo: la respuesta primero.',
    ...(context ? ['', '=== CONTEXTO ===', context] : []),
    ...(doc ? ['', `=== DOCUMENTO: ${doc.path} (${doc.pages.length} página/s) ===`, serializeReading(doc, eff)] : []),
  ].join('\n');
}

/** Un turno del reader: responde, y si el usuario pidió editar, rutea al editor. */
export async function readTurn(
  opts: ReadTurnOpts,
  registry: IToolRegistry,
  config: IAgentConfig,
  ct: CancellationToken = NeverCancelled,
): Promise<ReadTurnResult> {
  const t0 = Date.now();
  const transport = opts.transport ?? transportFor(config.readerModel, config);
  // Sin documento no hay puerta a la edición: edit_document sería un sinsentido.
  const canEdit = !!opts.editor && !!opts.doc && !!opts.session;
  // Sin documento no hay EditSession: las tools de nivel 'both' (fill_field…)
  // la mutan, así que un turno org-level recibe SOLO las 'reader' puras.
  const hasDoc = !!opts.doc && !!opts.session;
  const tools = [...registry.passTools('reader', { docLess: !hasDoc }), ...(canEdit ? [editDocumentTool()] : [])];
  // Qué le contamos del relleno de campos sale de las tools que REALMENTE tiene
  // (nivel 'both' en el registry), no de una lista hardcodeada acá: un host que
  // no las registre no recibe un prompt que le miente.
  const canFill = tools.some(t => t.name === 'fill_field' || t.name === 'fill_fields');
  log(`turno: "${opts.prompt.slice(0, 60)}" · ${config.readerModel} · ${tools.length} tool/s${opts.doc ? '' : ' · sin doc'}${canFill ? ' · rellena campos' : ''}`);

  const emit: ToolContext['emit'] = (name, data) => opts.onHostEvent?.(name, data);
  const ctx: ToolContext = opts.doc && opts.session
    ? { doc: opts.doc, session: opts.session, emit }
    : docLessContext(emit);

  const dispatch = dedupedDispatch(registry, ctx);
  const onToolCall = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name === 'edit_document' && canEdit && opts.editor) {
      const parsed = z.object(EDIT_DOC_SHAPE).safeParse(args);
      if (!parsed.success) return `⚠️ edit_document: ${parsed.error.issues.map(i => i.message).join('; ')}`;
      // Un fallo del editor NO mata el turno del reader: vuelve como ⚠️ para
      // que le explique al usuario qué pasó (misma política que el registry).
      try {
        return await opts.editor(parsed.data);
      } catch (err) {
        log(`editor falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        return `⚠️ el editor no pudo correr: ${err instanceof Error ? err.message : 'error interno'}. Contale al usuario.`;
      }
    }
    return (await dispatch(name, args)).message;
  };

  const res = await transport.chat({
    model: config.readerModel,
    // Vista EFECTIVA (ver editor.ts): el reader debe LEER el documento como
    // quedó tras las ediciones pendientes, no como estaba en disco.
    system: systemPrompt(opts.doc, canEdit, canFill, opts.context, opts.session?.effectiveView()),
    prompt: opts.prompt,
    history: opts.history,
    role: 'reader',
    tools,
    // Una consulta cierra en 1 pasada; el presupuesto es para tools del host,
    // la vuelta de edit_document (delegar → reportar) y el relleno de campos
    // (fill_fields en batch + un reintento si algún nombre no matcheó).
    maxTurns: 6,
    loop: true,
    onToolCall,
    onEvent: opts.onEvent,
  }, ct);

  log(`listo en ${Date.now() - t0}ms · tools: ${res.toolsUsed.join(', ') || '(ninguna)'}`);
  return { text: res.text, toolsUsed: res.toolsUsed };
}
