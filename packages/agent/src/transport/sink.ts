/**
 * sink.ts — el seam {@link IAgentEventSink}: a DÓNDE fluye un turno del agente
 * (audit-hosts §3.4). Formaliza el `onEvent` informal de v1 como contrato:
 * un host nuevo (WebSocket, SSE de un e-sign) = una impl + un bind — OCP puro.
 *
 * EL PROTOCOLO DE WIRE (contrato con el cliente del editor, `aldusApi.ts` lo
 * consume tal cual — no renombrar campos):
 *  - eventos EN VIVO ({@link AgentEvent}): `{type:'text', delta, agent}` (tokens)
 *    y `{type:'tool', name, agent}` (arrancó una tool). `agent` dice quién emite
 *    (chat router / editor fuerte) — el panel renderiza el pase del editor como
 *    bloque propio.
 *  - terminales: {@link TurnDoneEvent} — `reloaded:true` cuando el server horneó
 *    y persistió (el editor recarga el doc), o `edits`/`imageEdits` cuando el
 *    turno solo acumuló ediciones locales; {@link TurnErrorEvent} en fallo.
 *
 * Impls: `NdjsonHttpSink` (server, una línea JSON por evento) · stdout streaming
 * (CLI) · {@link CallbackSink} (tests/embeds).
 */
import { createToken, type ImageEdit, type SegmentEdit } from '@aldus/core';
import type { AgentEvent } from './transport.js';

/** Terminal OK de un turno. O `reloaded` (horneado+persistido) o `edits`. */
export interface TurnDoneEvent {
  type: 'done';
  sessionId?: string;
  toolCalls: number;
  /** El server horneó Y persistió (creaciones/annotations) → recargar el doc. */
  reloaded?: boolean;
  warnings?: string[];
  edits?: SegmentEdit[];
  imageEdits?: ImageEdit[];
}

/** Terminal de fallo. `error` es apto para el usuario (jamás un stack). */
export interface TurnErrorEvent {
  type: 'error';
  error: string;
}

export type AgentWireEvent = AgentEvent | TurnDoneEvent | TurnErrorEvent;

/** A dónde fluyen los eventos de un turno del agente. `end()` cierra el canal
 *  (SIEMPRE se llama, incluso tras un error — el transporte queda limpio). */
export interface IAgentEventSink {
  send(ev: AgentWireEvent): void;
  end(): void;
}
export const IAgentEventSink = createToken<IAgentEventSink>('IAgentEventSink');

/** Sink de callback — tests y hosts embebidos (recolectar eventos en memoria). */
export class CallbackSink implements IAgentEventSink {
  constructor(
    private readonly onSend: (ev: AgentWireEvent) => void,
    private readonly onEnd?: () => void,
  ) {}

  send(ev: AgentWireEvent): void { this.onSend(ev); }
  end(): void { this.onEnd?.(); }
}
