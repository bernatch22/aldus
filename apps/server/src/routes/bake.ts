/**
 * POST /:id/bake — applies the pending edits TO the PDF's content stream and
 * persists the result. The previous PDF is kept as a revision (DocStore).
 */
import { Router } from 'express';
import { addHighlight, bakeSegmentEdits } from '@aldus/core/bake';
import type { DocStore } from '../store.js';
import { requireDoc } from '../validate.js';

export function bakeRouter(store: DocStore): Router {
  const router = Router();

  router.post('/:id/bake', requireDoc(store), async (req, res) => {
    const { id } = req.params;
    const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
    const imageEdits = Array.isArray(req.body?.imageEdits) ? req.body.imageEdits : [];
    const widgetEdits = Array.isArray(req.body?.widgetEdits) ? req.body.widgetEdits : [];
    // `highlights` = resaltados NUEVOS a crear (annots); `highlightEdits` /
    // `linkEdits` = mover/borrar anotaciones ya existentes en el PDF.
    const highlights = Array.isArray(req.body?.highlights) ? req.body.highlights : [];
    const highlightEdits = Array.isArray(req.body?.highlightEdits) ? req.body.highlightEdits : [];
    const linkEdits = Array.isArray(req.body?.linkEdits) ? req.body.linkEdits : [];
    if (edits.length === 0 && imageEdits.length === 0 && widgetEdits.length === 0 && highlights.length === 0 && highlightEdits.length === 0 && linkEdits.length === 0) {
      return res.status(400).json({ error: 'Body esperado: { edits, imageEdits, widgetEdits, highlights, highlightEdits, linkEdits } con al menos una edición.' });
    }
    try {
      const original = store.readPdf(id);
      let { pdf, applied, warnings } = await bakeSegmentEdits(new Uint8Array(original), edits, imageEdits, widgetEdits, highlightEdits, linkEdits);
      for (const h of highlights) {
        ({ pdf } = await addHighlight(pdf, h));
        applied.push(`highlight en p${h.page}`);
      }
      store.writePdf(id, pdf);
      res.json({ ok: true, applied, warnings });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'No se pudo aplicar el bake.' });
    }
  });

  return router;
}
