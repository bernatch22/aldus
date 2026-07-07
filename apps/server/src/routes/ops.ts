/**
 * Instant document operations (each one bakes + persists immediately):
 *   POST /:id/ops     addText / watermark / headerFooter / highlight /
 *                     addLink / removeLink / setFieldOptions / addRadioOption
 *   POST /:id/fields  create a new form field (text/checkbox/radio/…/signature)
 *   POST /:id/images  insert a PNG/JPEG at the clicked point
 */
import { Router } from 'express';
import {
  addFormField,
  addHeaderFooter,
  addHighlight,
  addLink,
  addRadioOption,
  addText,
  addWatermark,
  insertImage,
  removeLink,
  setFieldOptions,
} from '@aldus/core/bake';
import type { DocStore } from '../store.js';
import { requireDoc } from '../validate.js';
import { upload } from '../uploads.js';

export function opsRouter(store: DocStore): Router {
  const router = Router();

  router.post('/:id/ops', requireDoc(store), async (req, res) => {
    const { id } = req.params;
    const { action, ...params } = req.body ?? {};
    try {
      const original = new Uint8Array(store.readPdf(id));
      let pdf: Uint8Array;
      switch (action) {
        case 'addText': ({ pdf } = await addText(original, params)); break;
        case 'watermark': ({ pdf } = await addWatermark(original, params)); break;
        case 'headerFooter': ({ pdf } = await addHeaderFooter(original, params)); break;
        case 'highlight': ({ pdf } = await addHighlight(original, params)); break;
        case 'addLink': ({ pdf } = await addLink(original, params)); break;
        case 'setFieldOptions': ({ pdf } = await setFieldOptions(original, params)); break;
        case 'addRadioOption': ({ pdf } = await addRadioOption(original, params)); break;
        case 'removeLink': {
          const r = await removeLink(original, params);
          if (!r.removed) return res.status(404).json({ error: 'Link no encontrado.' });
          pdf = r.pdf;
          break;
        }
        default: return res.status(400).json({ error: `Acción desconocida: ${action}` });
      }
      store.writePdf(id, pdf);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'No se pudo aplicar la operación.' });
    }
  });

  router.post('/:id/fields', requireDoc(store), async (req, res) => {
    const { id } = req.params;
    const { type, page, x, y, width, height, name } = req.body ?? {};
    if (!type || !Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: 'Body esperado: { type, page, x, y, width?, height?, name? }.' });
    }
    try {
      const original = store.readPdf(id);
      const { pdf, name: assigned } = await addFormField(new Uint8Array(original), { type, page, x, y, width, height, name });
      store.writePdf(id, pdf);
      res.json({ ok: true, name: assigned });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'No se pudo crear el campo.' });
    }
  });

  router.post('/:id/images', requireDoc(store), upload.single('image'), async (req, res) => {
    const { id } = req.params;
    const file = req.file;
    const page = Number(req.body?.page);
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!file || !Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: 'Esperado: multipart {image} + page/x/y.' });
    }
    if (!/^image\/(png|jpe?g)$/i.test(file.mimetype)) {
      return res.status(400).json({ error: 'Solo PNG o JPEG.' });
    }
    try {
      const original = store.readPdf(id);
      const { pdf, rect } = await insertImage(new Uint8Array(original), {
        page, x, y, bytes: new Uint8Array(file.buffer), mime: file.mimetype,
      });
      store.writePdf(id, pdf);
      res.json({ ok: true, rect });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'No se pudo insertar la imagen.' });
    }
  });

  return router;
}
