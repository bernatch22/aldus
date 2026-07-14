/**
 * composition.ts — LA composition root del host Express (audit-hosts §3.2):
 * el manifiesto de qué implementación juega cada contrato. Se lee entero:
 *
 *  - `createNodeContainer()` de core: los FONT PROVIDERS reales (sistema →
 *    gemela métrica) entran POR CONTAINER — muere el `registerNodeFontProviders()`
 *    por convención de v1 (riesgo §4.11: el host que lo olvidaba horneaba con
 *    fuentes estándar EN SILENCIO; ahora el binding vive en el manifiesto).
 *  - {@link IDocStore} → FileDocStore (persistencia standalone). Con
 *    ALDUS_SESSION_SCOPED se construye además {@link SessionStores} (un store
 *    por visitante + GC por TTL) y el middleware `sessionScope` elige por request.
 *  - {@link IInstantOp} ×8 multi-bound → la ruta /ops consume `getAll`.
 *  - {@link IAgentSinkFactory} → NdjsonHttpSink (el streaming del agente).
 */
import type { Response } from 'express';
import { Container } from '@aldus/core';
import { createNodeContainer } from '@aldus/core/node';
import { defaultInstantOps, IInstantOp } from './instantOps.js';
import { IAgentSinkFactory, NdjsonHttpSink, type AgentSinkFactory } from './ndjsonSink.js';
import { FileDocStore, IDocStore, SessionStores } from './store.js';

export interface ServerOptions {
  /** Raíz de datos (PDFs + revisiones + sessions/ + _samples). */
  dataDir: string;
  /** Demo público: un store aislado por visitante (cookie `aldus_sid`). */
  scoped?: boolean;
  /** Revisiones a retener por documento (ALDUS_REVISIONS, default 10). */
  revisions?: number;
  /** TTL de una sesión sin actividad antes del GC (default 7 días). */
  sessionTtlMs?: number;
  /** Servir el SPA del editor desde este dir (ALDUS_STATIC). */
  staticDir?: string;
}

export interface ServerComposition {
  container: Container;
  store: FileDocStore;
  sessions: SessionStores | null;
}

export function createServerContainer(opts: ServerOptions): ServerComposition {
  const container = createNodeContainer();

  const store = opts.revisions != null
    ? new FileDocStore(opts.dataDir, opts.revisions)
    : new FileDocStore(opts.dataDir);
  container.bind(IDocStore).toConstantValue(store);

  const sessions = opts.scoped ? new SessionStores(opts.dataDir, { ttlMs: opts.sessionTtlMs }) : null;

  for (const op of defaultInstantOps()) container.bind(IInstantOp).toConstantValue(op);

  const sinkFactory: AgentSinkFactory = (res: Response) => new NdjsonHttpSink(res);
  container.bind(IAgentSinkFactory).toConstantValue(sinkFactory);

  return { container, store, sessions };
}
