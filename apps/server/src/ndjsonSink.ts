/**
 * ndjsonSink.ts — la impl HTTP del seam {@link IAgentEventSink} de @aldus/agent
 * (audit-hosts §3.4): cada evento del turno = UNA línea JSON en la respuesta
 * (`application/x-ndjson`). El panel del editor la lee en streaming y muestra
 * el texto tipeando + las tools corriendo en vez de una espera muda de 20-40 s.
 *
 * Un host futuro (WebSocket, SSE) = otra impl + otro bind — la ruta no cambia.
 */
import type { Response } from 'express';
import { createToken } from '@aldus/core';
import type { AgentWireEvent, IAgentEventSink } from '@aldus/agent';

export class NdjsonHttpSink implements IAgentEventSink {
  constructor(private readonly res: Response) {
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
  }

  send(ev: AgentWireEvent): void {
    if (!this.res.writableEnded) this.res.write(JSON.stringify(ev) + '\n');
  }

  end(): void {
    if (!this.res.writableEnded) this.res.end();
  }
}

/** El sink es POR RESPUESTA — lo que se binds en el container es su factory. */
export type AgentSinkFactory = (res: Response) => IAgentEventSink;
export const IAgentSinkFactory = createToken<AgentSinkFactory>('IAgentSinkFactory');
