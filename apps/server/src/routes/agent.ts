/**
 * POST /:id/agent — CASPER: runs one LLM turn with the document graph
 * embedded in the prompt. It does NOT bake — it returns the accumulated edits
 * so the editor applies them to its own state (same preview/save pipeline as
 * a manual edit).
 *
 * Auth is the Claude Code subscription: run the server WITHOUT
 * ANTHROPIC_API_KEY. The response streams NDJSON — one JSON line per event —
 * so the panel shows the answer typing + tools running instead of a mute
 * 20-40s wait.
 */
import { Router } from 'express';
import { EditSession, loadDoc, runTurn } from '@aldus/agent';
import type { DocStore } from '../store.js';
import { requireDoc } from '../validate.js';

export function agentRouter(store: DocStore): Router {
  const router = Router();

  router.post('/:id/agent', requireDoc(store), async (req, res) => {
    const { id } = req.params;
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ error: 'Body esperado: { prompt } (+ edits, imageEdits, resume opcionales).' });
    const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
    const imageEdits = Array.isArray(req.body?.imageEdits) ? req.body.imageEdits : [];
    const resume = typeof req.body?.resume === 'string' ? req.body.resume : undefined;
    const t0 = Date.now();
    console.log(`[agent] ← id=${id.slice(0, 8)} prompt=${JSON.stringify(prompt.slice(0, 60))} seed=${edits.length}+${imageEdits.length} resume=${resume ? 'sí' : 'no'}`);

    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    const write = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    try {
      const doc = await loadDoc(store.pdfPath(id));
      console.log(`[agent]   grafo cargado (${doc.pages.length} pág, ${Date.now() - t0}ms) — corriendo LLM…`);
      const session = new EditSession(doc);
      session.seed(edits, imageEdits);
      const { sessionId, toolCalls } = await runTurn({ doc, session, prompt, resume, onEvent: write });
      // Si el agente usó SOLO tools de texto/imagen → devolvemos los edits y el
      // editor los aplica a su estado local (preview, sin persistir). Si además
      // creó annotations/contenido (highlight, link, watermark, campo…) que el
      // estado local no sabe representar, horneamos TODO (incluidas las
      // ediciones semilla del editor) y persistimos: el editor recarga limpio.
      if (session.hasBakedOps) {
        const { pdf, warnings } = await session.bake();
        store.writePdf(id, pdf);
        console.log(`[agent] → OK ${Date.now() - t0}ms · toolCalls=${toolCalls} · HORNEADO+persistido (${warnings.length} aviso/s)`);
        write({ type: 'done', sessionId, toolCalls, reloaded: true, warnings });
      } else {
        const out = session.getEdits();
        console.log(`[agent] → OK ${Date.now() - t0}ms · toolCalls=${toolCalls} · edits=${out.edits.length}+${out.imageEdits.length}`);
        write({ type: 'done', sessionId, toolCalls, edits: out.edits, imageEdits: out.imageEdits });
      }
    } catch (err) {
      console.error(`[agent] ✗ ${Date.now() - t0}ms:`, err instanceof Error ? err.message : err);
      write({ type: 'error', error: err instanceof Error ? err.message : 'El agente falló.' });
    }
    res.end();
  });

  return router;
}
