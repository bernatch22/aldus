/**
 * POST /:id/debug — MODO FORENSE (solo con ALDUS_DEBUG=1). Recibe la captura
 * del editor (nodo clickeado, grafo de la página al momento del click, edits
 * pendientes, trace de logs) y escribe un BUNDLE reproducible en
 * /tmp/aldus-debug/<ts>-<doc>/:
 *
 *   doc.pdf        los bytes ACTUALES del documento (lo que el editor ve)
 *   capture.json   todo el estado capturado (nodo, grafo, edits, trace, UI)
 *   repro.mts      script PRE-ARMADO (template en ../reproTemplate.ts): compara
 *                  grafo al click vs fresco, aplica los edits con el bake REAL
 *                  y muestra el ANTES/DESPUÉS de la fila del nodo.
 *
 * Correr:  npx tsx /tmp/aldus-debug/<dir>/repro.mts
 */
import { Router } from 'express';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@aldus/core';
import { forensicOff } from '../errors.js';
import { getStore, requireDoc } from '../validate.js';
import { REPO, reproTemplate } from '../reproTemplate.js';

const log = createLogger('aldus:server:debug');

export function debugRouter(): Router {
  const router = Router();

  router.post('/:id/debug', requireDoc(), (req, res) => {
    if (!process.env.ALDUS_DEBUG) throw forensicOff();
    const { id } = req.params;
    const store = getStore(req);
    const cap = req.body ?? {};

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join('/tmp/aldus-debug', `${stamp}-${id.slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });

    copyFileSync(store.pdfPath(id), path.join(dir, 'doc.pdf'));
    writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ ...cap, docId: id, capturedAt: new Date().toISOString() }, null, 2));
    writeFileSync(path.join(dir, 'repro.mts'), reproTemplate(REPO));

    const cmd = `npx tsx ${path.join(dir, 'repro.mts')}`;
    log(`🐞 bundle forense → ${dir}\n[debug]    ${cmd}`);
    res.json({ dir, cmd });
  });

  return router;
}
