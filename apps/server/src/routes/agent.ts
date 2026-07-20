/**
 * POST /:id/agent — CASPER: runs one LLM turn with the document graph
 * embedded in the prompt. The response streams NDJSON — one JSON line per
 * event (via {@link IAgentEventSink}) — so the panel shows the answer typing +
 * tools running instead of a mute 20-40s wait.
 *
 * DOS AGENTES, DOS MODOS (`mode` en el body) — el panel los expone como dos
 * pestañas y cada una es una conversación aparte:
 *  - `reader` (default): modelo barato, documento ENTERO inline. Responde
 *    preguntas y COMPLETA campos de formulario por su cuenta (fill_field/
 *    fill_fields son nivel 'both'). NO se le cablea la puerta `editor`, así que
 *    nunca delega ni ofrece edit_document.
 *  - `editor`: modelo fuerte, DIRECTO a {@link editPages} con el grafo scoped a
 *    la página que el usuario está viendo. Sin reader en el medio: el scope lo
 *    fija la UI (la página abierta), no un LLM que adivina.
 * El ruteo automático reader→editor sigue existiendo en la librería (pasarle
 * `editor:` a readTurn); esta ruta simplemente no lo usa.
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
import { createAgentContainer, editPages, EditSession, IAgentConfig, IToolRegistry, loadDoc, readTurn, type ChatTurn } from '@aldus/agent';
import { badRequest, h } from '../errors.js';
import { getStore, requireDoc } from '../validate.js';
import type { AgentSinkFactory } from '../ndjsonSink.js';

const log = createLogger('aldus:server:agent');

export function agentRouter(sinkFor: AgentSinkFactory): Router {
  const router = Router();

  // El agente (reader barato + editor por fan-out) se compone UNA vez: registry
  // de tools + config. Un host que quiera sumar sus tools de dominio bindea en
  // este container (OCP) — acá el demo usa solo las nativas.
  const agent = createAgentContainer();
  const registry = agent.get(IToolRegistry);
  const config = agent.get(IAgentConfig);

  // MEMORIA conversacional por documento: el reader recuerda de qué venían
  // hablando entre requests. El docId ya es único por visitante (uploads
  // session-scoped) → aislado naturalmente. Cap: últimos 20 mensajes (10 turnos).
  // Solo la usa el reader: un turno del editor es una orden autocontenida.
  const histories = new Map<string, ChatTurn[]>();
  const HISTORY_MAX = 20;

  router.post('/:id/agent', requireDoc(), h(async (req, res) => {
    const { id } = req.params;
    const store = getStore(req);
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) throw badRequest('Body esperado: { prompt } (+ mode, edits, imageEdits, page opcionales).');
    const mode: 'reader' | 'editor' = req.body?.mode === 'editor' ? 'editor' : 'reader';
    // La página que el usuario está viendo: EL scope del editor. Sin ella el
    // editor recibe el documento entero (docs chicos), que es el default de
    // editPages.
    const page = Number.isInteger(req.body?.page) && req.body.page > 0 ? req.body.page as number : undefined;
    const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
    const imageEdits = Array.isArray(req.body?.imageEdits) ? req.body.imageEdits : [];
    const t0 = Date.now();
    log(`← id=${id.slice(0, 8)} mode=${mode}${page ? ` p${page}` : ''} prompt=${JSON.stringify(prompt.slice(0, 60))} seed=${edits.length}+${imageEdits.length}`);

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
      let toolCalls = 0;
      if (mode === 'editor') {
        // DIRECTO al editor: el scope son las páginas que la UI dice (la abierta),
        // y el pedido es el prompt tal cual. Sin reader que reescriba ni decida.
        const r = await editPages(
          { doc, session, request: prompt, pages: page ? [page] : undefined, onEvent: ev => sink.send(ev) },
          registry, config, cts.token,
        );
        toolCalls += r.toolCalls;
      } else {
        // El reader responde desde el documento entero y COMPLETA campos si se lo
        // piden (tools nivel 'both'). Sin `editor:` no tiene edit_document: para
        // cualquier otro cambio manda al usuario a la pestaña del editor.
        // `history` = memoria de los turnos previos.
        const history = histories.get(id) ?? [];
        const { text: answer } = await readTurn(
          {
            doc, session, prompt, history,
            onEvent: ev => sink.send(ev),
            onHostEvent: (name, data) => sink.send({ type: 'host', name, data }),
          },
          registry, config, cts.token,
        );
        // Guardar el intercambio para el próximo turno (memoria).
        if (answer.trim()) {
          histories.set(id, [...history, { role: 'user', content: prompt }, { role: 'assistant', content: answer }].slice(-HISTORY_MAX));
        }
      }
      const fin = await session.finishTurn();
      if (fin.kind === 'baked') {
        store.writePdf(id, fin.pdf);
        log(`→ OK ${Date.now() - t0}ms · toolCalls=${toolCalls} · HORNEADO+persistido (${fin.warnings.length} aviso/s)`);
        sink.send({ type: 'done', toolCalls, reloaded: true, warnings: fin.warnings });
      } else {
        log(`→ OK ${Date.now() - t0}ms · toolCalls=${toolCalls} · edits=${fin.edits.length}+${fin.imageEdits.length}`);
        sink.send({ type: 'done', toolCalls, edits: fin.edits, imageEdits: fin.imageEdits });
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
