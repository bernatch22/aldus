/**
 * BALTHASAR — the Aldus server. Boot only: lee los env knobs, compone
 * (createAldusApp → composition.ts, la composition root real) y escucha.
 *
 * Security posture: localhost-only BY DESIGN (documents are baked on disk
 * with no auth). Set ALDUS_ALLOW_REMOTE=1 to bind 0.0.0.0 — only do that
 * behind your own auth/reverse proxy.
 *
 * Env knobs (los de v1, preservados):
 *   ALDUS_PORT (4100) · ALDUS_ALLOW_REMOTE · ALDUS_DATA · ALDUS_REVISIONS
 *   ALDUS_SESSION_SCOPED (demo público: un store por visitante + GC)
 *   ALDUS_SESSION_TTL_HOURS (168 = 7 días — GC de sesiones, nuevo en v2)
 *   ALDUS_STATIC (servir el SPA del editor) · ALDUS_DEBUG (modo forense 🐞)
 *
 * Las fuentes sustitutas REALES del bake ya no entran por
 * `registerNodeFontProviders()` de convención: las binds `createNodeContainer()`
 * dentro de la composición (audit-hosts §3.2).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAldusApp } from './app.js';

const PORT = Number(process.env.ALDUS_PORT || 4100);
const HOST = process.env.ALDUS_ALLOW_REMOTE ? '0.0.0.0' : '127.0.0.1';
const DATA_DIR = process.env.ALDUS_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const { app } = createAldusApp({
  dataDir: DATA_DIR,
  // Modo demo público: ALDUS_SESSION_SCOPED aísla los documentos POR VISITANTE
  // (cookie `aldus_sid`) — cada uno ve solo lo suyo, uploads y ediciones nunca
  // se cruzan; el GC barre sesiones sin actividad (TTL).
  scoped: !!process.env.ALDUS_SESSION_SCOPED,
  sessionTtlMs: Number(process.env.ALDUS_SESSION_TTL_HOURS || 168) * 3600_000,
  staticDir: process.env.ALDUS_STATIC || undefined,
});

app.listen(PORT, HOST, () => {
  console.log([
    '┌─────────────────────────────────────────────┐',
    '│  A L D U S  //  M A G I   S Y S T E M       │',
    '│                                             │',
    '│  MELCHIOR·1  (core)    ............... OK   │',
    '│  BALTHASAR·2 (server)  ............... OK   │',
    '│  CASPER·3    (agent)   ........... STANDBY  │',
    '└─────────────────────────────────────────────┘',
  ].join('\n'));
  console.log(`[aldus-server] listo en http://${HOST === '0.0.0.0' ? '0.0.0.0' : 'localhost'}:${PORT} (data: ${DATA_DIR})`);
});
