/**
 * BALTHASAR — the Aldus server. Boot only: composition of the store and the
 * routes lives here; every behavior lives in its route module.
 *
 * Security posture: localhost-only BY DESIGN (documents are baked on disk
 * with no auth). Set ALDUS_ALLOW_REMOTE=1 to bind 0.0.0.0 — only do that
 * behind your own auth/reverse proxy.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileDocStore, SessionStores } from './store.js';
import { documentsRouter } from './routes/documents.js';
import { bakeRouter } from './routes/bake.js';
import { opsRouter } from './routes/ops.js';
import { agentRouter } from './routes/agent.js';

const PORT = Number(process.env.ALDUS_PORT || 4100);
const HOST = process.env.ALDUS_ALLOW_REMOTE ? '0.0.0.0' : '127.0.0.1';
const DATA_DIR = process.env.ALDUS_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

// Modo demo público: ALDUS_SESSION_SCOPED aísla los documentos POR VISITANTE
// (cookie `aldus_sid`) — cada uno ve solo lo suyo, uploads y ediciones nunca se
// cruzan. Sin la flag, un único store compartido (el editor local de siempre).
const SCOPED = !!process.env.ALDUS_SESSION_SCOPED;
const store = new FileDocStore(DATA_DIR);
const sessions = SCOPED ? new SessionStores(DATA_DIR) : null;
const SID_RE = /^[0-9a-f-]{36}$/;

const app = express();
app.use(express.json({ limit: '4mb' }));

// Resuelve el store de ESTE request (lo leen las rutas vía getStore): aislado
// por sesión en el demo, singleton compartido en standalone.
app.use('/api', (req, res, next) => {
  if (!sessions) {
    (req as unknown as { store: FileDocStore }).store = store;
    return next();
  }
  const raw = (req.headers.cookie || '')
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('aldus_sid='));
  let sid = raw ? decodeURIComponent(raw.slice('aldus_sid='.length)) : '';
  if (!SID_RE.test(sid)) {
    sid = randomUUID();
    res.setHeader('Set-Cookie', `aldus_sid=${sid}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
  }
  (req as unknown as { store: FileDocStore }).store = sessions.for(sid);
  next();
});

app.use('/api/documents', documentsRouter());
app.use('/api/documents', bakeRouter());
app.use('/api/documents', opsRouter());
app.use('/api/documents', agentRouter());

// Servir el editor buildeado (SPA) cuando ALDUS_STATIC apunta a su dist — el
// modo "app autocontenida" del demo (bernardocastro.dev/aldus-app): mismo origen
// que /api, sin CORS. El fallback a index.html cubre las rutas de cliente
// (/doc/:id); /api/* ya matcheó antes, así que nunca cae acá.
const STATIC = process.env.ALDUS_STATIC;
if (STATIC) {
  app.use(express.static(STATIC));
  app.get('*', (_req, res) => res.sendFile(path.join(STATIC, 'index.html')));
}

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
