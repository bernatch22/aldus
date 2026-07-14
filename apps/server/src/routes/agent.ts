/**
 * POST /:id/agent — CASPER: runs one LLM turn with the document graph
 * embedded in the prompt. The response streams NDJSON — one JSON line per
 * event (via {@link IAgentEventSink}) — so the panel shows the answer typing +
 * tools running instead of a mute 20-40s wait.
 *
 * v2 (audit-hosts §3.4):
 *  - el `res.write` inline de v1 → el seam {@link IAgentEventSink}
 *    (NdjsonHttpSink inyectada por factory desde la composition root).
 *  - la política "hasBakedOps → bake+persist, sino devolver edits" vive en
 *    `session.finishTurn()` (decisión de producto, fuera de la ruta).
 *  - el `close` de la respuesta cancela el turno (CancellationTokenSource →
 *    transporte AbortSignal → loop de bakes del reflow). Cliente que corta =
 *    LLM que deja de facturar.
 *
 * NOTA sobre el catch site: esta ruta ES streaming — una vez enviados los
 * headers el error no puede volver como HTTP status; el canal de error es el
 * evento `{type:'error'}` del wire (mensaje apto para usuario; el stack va al
 * logger). El 400 de body inválido SÍ viaja al middleware (pre-stream).
 */
import { Router } from 'express';
import { CancellationTokenSource, createLogger, isStructuredError, ProtocolError } from '@aldus/core';
import { EditSession, loadDoc, runTurn } from '@aldus/agent';
import { badRequest, h } from '../errors.js';
import { getStore, requireDoc } from '../validate.js';
import type { AgentSinkFactory } from '../ndjsonSink.js';

const log = createLogger('aldus:server:agent');

export function agentRouter(sinkFor: AgentSinkFactory): Router {
  const router = Router();

  router.post('/:id/agent', requireDoc(), h(async (req, res) => {
    const { id } = req.params;
    const store = getStore(req);
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) throw badRequest('Body esperado: { prompt } (+ edits, imageEdits, resume opcionales).');
    const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
    const imageEdits = Array.isArray(req.body?.imageEdits) ? req.body.imageEdits : [];
    const resume = typeof req.body?.resume === 'string' ? req.body.resume : undefined;
    const page = Number.isFinite(req.body?.page) ? Number(req.body.page) : undefined;
    const t0 = Date.now();
    log(`← id=${id.slice(0, 8)} prompt=${JSON.stringify(prompt.slice(0, 60))} seed=${edits.length}+${imageEdits.length} resume=${resume ? 'sí' : 'no'}`);

    const sink = sinkFor(res);
    // Cliente que corta el stream (cierra el panel, recarga) → cancelar el
    // turno entero. `close` también dispara tras un end() normal — el guard
    // writableEnded distingue el corte real.
    const cts = new CancellationTokenSource();
    res.on('close', () => { if (!res.writableEnded) cts.cancel(); });

    try {
      const doc = await loadDoc(store.pdfPath(id));
      log(`  grafo cargado (${doc.pages.length} pág, ${Date.now() - t0}ms) — corriendo LLM…`);
      const session = new EditSession(doc);
      session.seed(edits, imageEdits);
      const { sessionId, toolCalls } = await runTurn(
        { doc, session, prompt, resume, page, onEvent: ev => sink.send(ev) },
        cts.token,
      );
      const fin = await session.finishTurn();
      if (fin.kind === 'baked') {
        store.writePdf(id, fin.pdf);
        log(`→ OK ${Date.now() - t0}ms · toolCalls=${toolCalls} · HORNEADO+persistido (${fin.warnings.length} aviso/s)`);
        sink.send({ type: 'done', sessionId, toolCalls, reloaded: true, warnings: fin.warnings });
      } else {
        log(`→ OK ${Date.now() - t0}ms · toolCalls=${toolCalls} · edits=${fin.edits.length}+${fin.imageEdits.length}`);
        sink.send({ type: 'done', sessionId, toolCalls, edits: fin.edits, imageEdits: fin.imageEdits });
      }
    } catch (err) {
      log(`✗ ${Date.now() - t0}ms:`, err instanceof Error ? err.stack ?? err.message : err);
      // Solo un StructuredError showUser cruza al usuario; el resto, genérico.
      const msg = err instanceof ProtocolError && err.error.showUser
        ? err.error.format
        : isStructuredError(err) && err.showUser ? err.format : 'El agente falló.';
      sink.send({ type: 'error', error: msg });
    } finally {
      cts.dispose();
      sink.end();
    }
  }));

  return router;
}
