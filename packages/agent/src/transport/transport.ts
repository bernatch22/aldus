/**
 * transport/transport.ts — el contrato `ILlmTransport`: UN pipe tonto por
 * provider (Claude Agent SDK / OpenRouter). Absorbe la duplicación #2 del plan
 * (el flujo two-level estaba escrito DOS veces, una por transporte). El
 * orquestador `runTurn` corre UNA sola vez sobre este contrato, con el transporte
 * INYECTADO — sin switch de provider adentro.
 */
import type { z } from 'zod';
import type { CancellationToken } from '@aldus/core';

/** Quién emite el evento: el READER (barato, lee y rutea) o el EDITOR (fuerte, aplica). */
export type AgentRole = 'reader' | 'editor';

/** Eventos en vivo de un turno (para streamear al panel). Cada evento lleva
 *  `agent` para que el UI pueda renderizar el pase del editor como un bloque
 *  propio, en orden cronológico real (chat → editor → chat). */
export type AgentEvent =
  | { type: 'text'; delta: string; agent: AgentRole; page?: number }   // token(s) de texto
  | { type: 'tool'; name: string; agent: AgentRole; page?: number };   // arrancó una tool

/** Una tool ADVERTIDA en una pasada. El shape zod (tools Aldus) deja al transporte
 *  SDK armar un MCP tool validante; ausente en tools del host (traen su JSON
 *  Schema plano). El JSON Schema (`parameters`) es el que consume el path OpenAI. */
export interface PassTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  shape?: z.ZodRawShape;
}

/** UNA pasada de completions (streameada) que el transporte corre hasta terminar
 *  de ejecutar sus tools. `onToolCall` es el ÚNICO seam de ejecución: el
 *  orquestador es dueño del dispatch (runTool para el editor; captura de ruta
 *  para el chat) — el transporte solo lo invoca y devuelve su string al modelo. */
/** Un turno de conversación previo (para la MEMORIA del reader entre requests).
 *  Va DESPUÉS del system (que trae el doc) y ANTES del prompt actual. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PassRequest {
  model: string;
  system: string;
  prompt: string;
  role: AgentRole;
  tools: PassTool[];
  maxTurns: number;
  /** Historial conversacional previo (memoria). El transporte lo intercala entre
   *  system y prompt. Vacío/undefined = turno fresco. */
  history?: ChatTurn[];
  /** false = un solo intercambio (fase CHAT: el modelo delega y para). true =
   *  loop de function-calling hasta que no queden tools (fase EDITOR). El SDK
   *  lo ignora (query() loopea solo); el OpenRouter lo respeta. */
  loop: boolean;
  /** FORZAR una tool concreta (por nombre) en vez de dejar elegir al modelo.
   *  Para las pasadas de "extracción estructurada": el llamador no quiere una
   *  respuesta en prosa, quiere el objeto — sin esto el modelo puede contestar
   *  texto y el parseo aguas abajo se queda sin nada. Ausente = `'auto'`.
   *  OpenRouter: `tool_choice: {type:'function', function:{name}}`. */
  toolChoice?: string;
  /** Tope de tokens de SALIDA. Default 8192 — alcanza de sobra para un turno de
   *  tool calls + reporte, y mantiene chica la reserva de crédito que OpenRouter
   *  hace por request. Subirlo solo para generación larga (un contrato entero). */
  maxOutputTokens?: number;
  /** Handle OPACO de una pasada previa (misma conversación): el SDK lo mapea a
   *  su session resume; el OpenRouter a su array de mensajes acumulado. El
   *  orquestador NUNCA lo inspecciona — lo re-pasa tal cual a la pasada correctiva. */
  resume?: unknown;
  onToolCall: (name: string, args: Record<string, unknown>) => string | Promise<string>;
  onEvent?: (ev: AgentEvent) => void;
}

export interface PassResult {
  text: string;
  /** Nombres BARE de las tools usadas esta pasada, en orden. */
  toolsUsed: string[];
  toolCalls: number;
  /** Handle OPACO para encadenar una pasada correctiva (verify). */
  resume?: unknown;
}

export const ILlmTransport = Symbol('ILlmTransport');
export interface ILlmTransport {
  /** Corre una pasada streameada, ejecutando las tools vía `req.onToolCall`. El
   *  `ct` aborta el fetch/SDK; la cancelación del reflow la threa la EditSession. */
  chat(req: PassRequest, ct: CancellationToken): Promise<PassResult>;
}
