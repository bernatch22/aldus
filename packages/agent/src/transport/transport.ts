/**
 * transport/transport.ts — el contrato `ILlmTransport`: UN pipe tonto por
 * provider (Claude Agent SDK / OpenRouter). Absorbe la duplicación #2 del plan
 * (el flujo two-level estaba escrito DOS veces, una por transporte). El
 * orquestador `runTurn` corre UNA sola vez sobre este contrato, con el transporte
 * INYECTADO — sin switch de provider adentro.
 */
import type { z } from 'zod';
import type { CancellationToken } from '@aldus/core';

/** Quién emite el evento: el CHAT (router barato) o el EDITOR (fuerte). */
export type AgentRole = 'chat' | 'editor';

/** Eventos en vivo de un turno (para streamear al panel). Cada evento lleva
 *  `agent` para que el UI pueda renderizar el pase del editor como un bloque
 *  propio, en orden cronológico real (chat → editor → chat). */
export type AgentEvent =
  | { type: 'text'; delta: string; agent: AgentRole }   // token(s) de texto
  | { type: 'tool'; name: string; agent: AgentRole };   // arrancó una tool

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
export interface PassRequest {
  model: string;
  system: string;
  prompt: string;
  role: AgentRole;
  tools: PassTool[];
  maxTurns: number;
  /** false = un solo intercambio (fase CHAT: el modelo delega y para). true =
   *  loop de function-calling hasta que no queden tools (fase EDITOR). El SDK
   *  lo ignora (query() loopea solo); el OpenRouter lo respeta. */
  loop: boolean;
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
