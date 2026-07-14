/**
 * Instant document operations (each one bakes + persists immediately):
 *   POST /:id/ops     el registry {@link IInstantOp} (audit-hosts §3.5) — el
 *                     switch de 8 casos de v1 MUERE: la ruta hace probe por
 *                     `action` y 400 si nadie reclama. Op nueva = un bind.
 *   POST /:id/fields  create a new form field (text/checkbox/radio/…/signature)
 *   POST /:id/images  insert a PNG/JPEG at the clicked point (multipart —
 *                     genuinamente distinto, queda bespoke como en v1)
 */
import { Router } from 'express';
import { addFormField, insertImage } from '@aldus/core/bake';
import { badRequest, h, unknownOp } from '../errors.js';
import { getStore, requireDoc } from '../validate.js';
import { upload } from '../uploads.js';
import type { IInstantOp } from '../instantOps.js';

export function opsRouter(ops: readonly IInstantOp[]): Router {
  const router = Router();

  router.post('/:id/ops', requireDoc(), h(async (req, res) => {
    const { id } = req.params;
    const store = getStore(req);
    const { action, ...params } = req.body ?? {};
    const op = ops.find(o => o.name === action);
    if (!op) throw unknownOp(action);
    const parsed = op.schema.safeParse(params);
    if (!parsed.success) throw badRequest(`Parámetros inválidos para ${action}.`);
    const pdf = await op.run(new Uint8Array(store.readPdf(id)), parsed.data);
    store.writePdf(id, pdf);
    res.json({ ok: true });
  }));

  router.post('/:id/fields', requireDoc(), h(async (req, res) => {
    const { id } = req.params;
    const store = getStore(req);
    const { type, page, x, y, width, height, name } = req.body ?? {};
    if (!type || !Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw badRequest('Body esperado: { type, page, x, y, width?, height?, name? }.');
    }
    const original = store.readPdf(id);
    const { pdf, name: assigned } = await addFormField(new Uint8Array(original), { type, page, x, y, width, height, name });
    store.writePdf(id, pdf);
    res.json({ ok: true, name: assigned });
  }));

  router.post('/:id/images', requireDoc(), upload.single('image'), h(async (req, res) => {
    const { id } = req.params;
    const store = getStore(req);
    const file = req.file;
    const page = Number(req.body?.page);
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!file || !Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw badRequest('Esperado: multipart {image} + page/x/y.');
    }
    if (!/^image\/(png|jpe?g)$/i.test(file.mimetype)) {
      throw badRequest('Solo PNG o JPEG.');
    }
    const original = store.readPdf(id);
    const { pdf, rect } = await insertImage(new Uint8Array(original), {
      page, x, y, bytes: new Uint8Array(file.buffer), mime: file.mimetype,
    });
    store.writePdf(id, pdf);
    res.json({ ok: true, rect });
  }));

  return router;
}
