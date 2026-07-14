/**
 * POST /:id/bake — applies the pending edits TO the PDF's content stream and
 * persists the result. The previous PDF is kept as a revision (DocStore).
 *
 * v2: el body se valida con zod (audit-hosts §2 — v1 desarmaba 7 arrays a
 * mano); las 7 colecciones del wire se convierten a la unión {@link AnyEdit}
 * por kind y se hornean con `bake()` (la API v2 de core). `highlights` (los
 * resaltados NUEVOS del editor) se crean después, como en v1.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { AnyEdit, HighlightEdit, ImageEdit, LinkEdit, SegmentEdit, ShapeEdit, WidgetEdit } from '@aldus/core';
import { addHighlight, bake } from '@aldus/core/bake';
import { badRequest, h } from '../errors.js';
import { getStore, requireDoc } from '../validate.js';

/** Un array del wire, tolerante como v1: cualquier no-array cae a []. */
const arr = <T>() => z.array(z.custom<T>()).catch([]).default([]);

const BakeBody = z.object({
  edits: arr<SegmentEdit>(),
  imageEdits: arr<ImageEdit>(),
  widgetEdits: arr<WidgetEdit>(),
  // `highlights` = resaltados NUEVOS a crear (annots); `highlightEdits` /
  // `linkEdits` = mover/borrar anotaciones ya existentes en el PDF.
  highlights: arr<{ page: number } & Record<string, unknown>>(),
  highlightEdits: arr<HighlightEdit>(),
  linkEdits: arr<LinkEdit>(),
  shapeEdits: arr<ShapeEdit>(),
});

export function bakeRouter(): Router {
  const router = Router();

  router.post('/:id/bake', requireDoc(), h(async (req, res) => {
    const { id } = req.params;
    const store = getStore(req);
    const body = BakeBody.parse(req.body ?? {});
    const total = body.edits.length + body.imageEdits.length + body.widgetEdits.length
      + body.highlights.length + body.highlightEdits.length + body.linkEdits.length + body.shapeEdits.length;
    if (total === 0) {
      throw badRequest('Body esperado: { edits, imageEdits, widgetEdits, highlights, highlightEdits, linkEdits, shapeEdits } con al menos una edición.');
    }
    const all: AnyEdit[] = [
      ...body.edits.map(e => ({ kind: 'segment', ...e }) as AnyEdit),
      ...body.imageEdits.map(e => ({ kind: 'image', ...e }) as AnyEdit),
      ...body.widgetEdits.map(e => ({ kind: 'widget', ...e }) as AnyEdit),
      ...body.highlightEdits.map(e => ({ kind: 'highlight', ...e }) as AnyEdit),
      ...body.linkEdits.map(e => ({ kind: 'link', ...e }) as AnyEdit),
      ...body.shapeEdits.map(e => ({ kind: 'shape', ...e }) as AnyEdit),
    ];
    const original = store.readPdf(id);
    let { pdf, applied, warnings } = await bake(new Uint8Array(original), all);
    for (const hl of body.highlights) {
      ({ pdf } = await addHighlight(pdf, hl as never));
      applied.push(`highlight en p${hl.page}`);
    }
    store.writePdf(id, pdf);
    res.json({ ok: true, applied, warnings });
  }));

  return router;
}
