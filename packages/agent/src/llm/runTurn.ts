/**
 * runTurn.ts — EL orquestador two-level, escrito UNA sola vez (mata la duplicación
 * #2 del plan: el flujo vivía duplicado en agent.ts + openrouter.ts de v1). El
 * transporte se INYECTA (`ILlmTransport`) — sin switch de provider adentro:
 *
 *   FASE 1 — CHAT (router barato): responde/describe desde el grafo COMPLETO; ante
 *     cualquier modificación delega vía edit_document({pages, request}) → captura
 *     la ruta (onToolCall) y para.
 *   FASE 2 — EDITOR (fuerte): corre con los grafos de ESAS páginas y las tools
 *     reales (runTool). `extraTools` del host funcionan en AMBOS transportes.
 *   GATING VERIFY (definido acá UNA vez, MANUAL_GEOMETRY): SOLO si el editor movió
 *     algo A MANO se re-mide el layout y se corre UNA pasada correctiva.
 *
 * CancellationToken threaded: `runTurn(opts, ct)` → cada pasada del transporte
 * (AbortSignal) → la EditSession (que aborta el loop de 6 bakes del reflow).
 */
import { z } from 'zod';
import { createLogger, NeverCancelled, type CancellationToken } from '@aldus/core';
import { chatSystemPrompt, systemPrompt } from './prompts.js';
import { ROUTE_DESC, ROUTE_SHAPE, TOOL_DEFS, runTool, type HostToolDef, type RouteRequest } from './tools.js';
import { overlapReport, verifyMessage } from './verify.js';
import { defaultAgentConfig, type IAgentConfig } from '../config.js';
import { ClaudeSdkTransport } from '../transport/claudeSdk.js';
import { OpenRouterTransport } from '../transport/openRouter.js';
import type { AgentEvent, ILlmTransport, PassRequest, PassTool } from '../transport/transport.js';
import type { DocGraph } from '../graph.js';
import type { EditSession } from '../session/EditSession.js';

export type { AgentEvent, AgentRole, ILlmTransport } from '../transport/transport.js';

export interface TurnResult {
  text: string;
  sessionId?: string;
  toolCalls: number;
}

/** Corre un turno STREAMEADO. `resume` continúa la conversación previa (chat).
 *  `onEvent` recibe los deltas de texto y las tool calls a medida que ocurren. */
export interface TurnOpts {
  doc: DocGraph;
  session: EditSession;
  prompt: string;
  resume?: string;
  /** Página que el usuario está viendo → el prompt se scopea a ESA (menos ruido). */
  page?: number;
  onEvent?: (ev: AgentEvent) => void;
  /** Tools del HOST (extensión OCP): capacidades de su dominio (firmantes,
   *  asignaciones…) que el EDITOR llama junto a las de Aldus. Funcionan en AMBOS
   *  transportes (v1 solo las soportaba en OpenRouter). */
  extraTools?: HostToolDef[];
  /** Transporte INYECTADO (tests: un fake de guion). Default = según el provider
   *  de la config. */
  transport?: ILlmTransport;
  /** Config inyectable (tests). Default = `defaultAgentConfig`. */
  config?: IAgentConfig;
}

const log = createLogger('aldus:runTurn');

/** RED DE SEGURIDAD SOLO para movimientos A MANO. Las tools deterministas
 *  (placeholders_to_fields, edit_text) YA se auto-corrigen con reflow, y crear un
 *  campo SOBRE un "____" es INTENCIONAL (PDF fillable) — correr verify ahí
 *  flaggeaba falsos positivos y el editor escribía un ensayo negándose (25s
 *  tirados). Solo re-verificamos si el editor movió texto/campos a mano. */
const MANUAL_GEOMETRY = ['move_text', 'move_field', 'move_image'];

/** El transporte por defecto según el provider de la config. */
function defaultTransport(config: IAgentConfig): ILlmTransport {
  return config.provider === 'openrouter'
    ? new OpenRouterTransport(config.openrouter)
    : new ClaudeSdkTransport();
}

/** Los modelos {chat, editor} del provider activo. */
function modelsFor(config: IAgentConfig): { chat: string; editor: string } {
  return config.provider === 'openrouter'
    ? { chat: config.openrouter.chatModel, editor: config.openrouter.model }
    : { chat: config.chatModel, editor: config.model };
}

/** Las tools del EDITOR advertidas en una pasada: las de Aldus (con shape zod) +
 *  las del host (JSON Schema plano). */
function editorPassTools(extra: HostToolDef[] = []): PassTool[] {
  return [
    ...TOOL_DEFS.map(d => ({
      name: d.name, description: d.description, shape: d.shape,
      parameters: z.toJSONSchema(z.object(d.shape)) as Record<string, unknown>,
    })),
    ...extra.map(h => ({ name: h.name, description: h.description, parameters: h.parameters })),
  ];
}

export async function runTurn(opts: TurnOpts, ct: CancellationToken = NeverCancelled): Promise<TurnResult> {
  const config = opts.config ?? defaultAgentConfig;
  const transport = opts.transport ?? defaultTransport(config);
  const models = modelsFor(config);
  opts.session.setCancellation(ct);
  const t0 = Date.now();
  log(`turno: "${opts.prompt.slice(0, 80)}" (page=${opts.page}, provider=${config.provider}, resume=${!!opts.resume})`);

  // ── FASE 1 — CHAT (barato): responde/describe; ante una modificación delega
  // vía edit_document({pages, request}) → captura la ruta y para.
  let route: RouteRequest | null = null;
  const routerTool: PassTool = {
    name: 'edit_document', description: ROUTE_DESC, shape: ROUTE_SHAPE,
    parameters: z.toJSONSchema(z.object(ROUTE_SHAPE)) as Record<string, unknown>,
  };
  const chatReq: PassRequest = {
    model: models.chat,
    system: chatSystemPrompt(opts.doc, opts.page),
    prompt: opts.prompt,
    role: 'chat',
    tools: [routerTool],
    maxTurns: 4,
    loop: false,
    resume: opts.resume,
    onToolCall: (name, args) => {
      if (name === 'edit_document') {
        route = {
          pages: Array.isArray(args.pages) ? (args.pages as number[]).filter(n => Number.isFinite(n)) : [],
          request: typeof args.request === 'string' && args.request ? args.request : opts.prompt,
        };
        return '✓ delegado al editor — las ediciones corren a continuación; no repitas la llamada.';
      }
      return `⚠️ tool desconocida: ${name}`;
    },
    onEvent: opts.onEvent,
  };
  const chatRes = await transport.chat(chatReq, ct);
  let text = chatRes.text;
  const sessionId = typeof chatRes.resume === 'string' ? chatRes.resume : undefined;

  if (!route) {
    log(`turno chat-only listo en ${Date.now() - t0}ms`);
    return { text, sessionId, toolCalls: 0 };
  }

  // ── FASE 2 — EDITOR (fuerte): corre con los grafos de LAS PÁGINAS pedidas por
  // el chat y las tools reales de edición.
  const routed = route as RouteRequest;
  const pages = routed.pages.length ? routed.pages : (opts.page != null ? [opts.page] : undefined);
  const tools = editorPassTools(opts.extraTools);
  const onToolCall = (name: string, args: Record<string, unknown>): Promise<string> =>
    runTool(opts.session, name, args, opts.extraTools);

  const editorReq: PassRequest = {
    model: models.editor,
    system: systemPrompt(opts.doc, pages),
    prompt: `${opts.prompt}\n\n[Plan del asistente]: ${routed.request}`,
    role: 'editor',
    tools,
    maxTurns: config.maxTurns,
    loop: true,
    onToolCall,
    onEvent: opts.onEvent,
  };
  const editorRes = await transport.chat(editorReq, ct);
  text += editorRes.text;
  let toolCalls = editorRes.toolCalls;
  const usedTools = new Set(editorRes.toolsUsed);

  // VERIFICACIÓN GEOMÉTRICA determinística — solo si el editor movió algo A MANO.
  // UNA sola pasada correctiva (re-invocar es caro), encadenada a la MISMA
  // conversación editora (resume opaco del transporte).
  const movedByHand = MANUAL_GEOMETRY.some(t => usedTools.has(t));
  if (movedByHand) {
    const issues = await overlapReport(opts.session).catch(() => []);
    if (issues.length) {
      log(`verify: ${issues.length} issues → pasada correctiva`);
      opts.onEvent?.({ type: 'tool', name: 'mcp__aldus__verify_layout', agent: 'editor' });
      const fixRes = await transport.chat({ ...editorReq, prompt: verifyMessage(issues), resume: editorRes.resume }, ct);
      text += fixRes.text;
      toolCalls += fixRes.toolCalls;
    }
  }
  log(`turno listo en ${Date.now() - t0}ms (toolCalls=${toolCalls}, tools=[${[...usedTools].join(',')}])`);
  return { text, sessionId, toolCalls };
}
