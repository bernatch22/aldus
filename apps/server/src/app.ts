/**
 * app.ts — arma la app Express COMPLETA a partir de la composición
 * (composition.ts): middleware de sesión, las 5 rutas, el SPA estático y el
 * catch site. `index.ts` (el boot) la escucha; los tests la levantan en un
 * puerto efímero sin tocar el entorno.
 */
import express, { type Express } from 'express';
import path from 'node:path';
import { Container } from '@aldus/core';
import { errorMiddleware } from './errors.js';
import { createServerContainer, type ServerOptions } from './composition.js';
import { IInstantOp } from './instantOps.js';
import { IAgentSinkFactory } from './ndjsonSink.js';
import { sessionScope } from './sessionScope.js';
import type { SessionStores } from './store.js';
import { documentsRouter } from './routes/documents.js';
import { bakeRouter } from './routes/bake.js';
import { opsRouter } from './routes/ops.js';
import { agentRouter } from './routes/agent.js';
import { debugRouter } from './routes/debug.js';

export interface AldusApp {
  app: Express;
  container: Container;
  /** Solo en modo demo (scoped) — exponerlo deja apagar su timer de GC. */
  sessions: SessionStores | null;
}

export function createAldusApp(opts: ServerOptions): AldusApp {
  const { container, store, sessions } = createServerContainer(opts);

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Resuelve el store de ESTE request (lo leen las rutas vía getStore):
  // aislado por sesión en el demo, el binding del container en standalone.
  app.use('/api', sessionScope(store, sessions));

  app.use('/api/documents', documentsRouter());
  app.use('/api/documents', bakeRouter());
  app.use('/api/documents', opsRouter(container.getAll(IInstantOp)));
  app.use('/api/documents', agentRouter(container.get(IAgentSinkFactory)));
  app.use('/api/documents', debugRouter()); // modo forense 🐞 — solo responde con ALDUS_DEBUG=1

  // Servir el editor buildeado (SPA) cuando ALDUS_STATIC apunta a su dist — el
  // modo "app autocontenida" del demo (bernardocastro.dev/aldus-app): mismo
  // origen que /api, sin CORS. El fallback a index.html cubre las rutas de
  // cliente (/doc/:id); /api/* ya matcheó antes, así que nunca cae acá.
  // OJO (riesgo §4.7): `app.get('*')` es sintaxis Express 4 — Express 5
  // (path-to-regexp nuevo) la rompe. El server se queda en Express 4.
  if (opts.staticDir) {
    const staticDir = opts.staticDir;
    app.use(express.static(staticDir));
    app.get('*', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // EL catch site — SIEMPRE último (audit-hosts §3.3).
  app.use(errorMiddleware());

  return { app, container, sessions };
}
