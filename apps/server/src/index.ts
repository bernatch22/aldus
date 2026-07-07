/**
 * BALTHASAR — the Aldus server. Boot only: composition of the store and the
 * routes lives here; every behavior lives in its route module.
 *
 * Security posture: localhost-only BY DESIGN (documents are baked on disk
 * with no auth). Set ALDUS_ALLOW_REMOTE=1 to bind 0.0.0.0 — only do that
 * behind your own auth/reverse proxy.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileDocStore } from './store.js';
import { documentsRouter } from './routes/documents.js';
import { bakeRouter } from './routes/bake.js';
import { opsRouter } from './routes/ops.js';
import { agentRouter } from './routes/agent.js';

const PORT = Number(process.env.ALDUS_PORT || 4100);
const HOST = process.env.ALDUS_ALLOW_REMOTE ? '0.0.0.0' : '127.0.0.1';
const DATA_DIR = process.env.ALDUS_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const store = new FileDocStore(DATA_DIR);

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use('/api/documents', documentsRouter(store));
app.use('/api/documents', bakeRouter(store));
app.use('/api/documents', opsRouter(store));
app.use('/api/documents', agentRouter(store));

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
