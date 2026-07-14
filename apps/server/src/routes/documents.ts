/**
 * Document CRUD:
 *   POST /               multipart {pdf} → upload, returns meta
 *   GET  /               list (newest first)
 *   GET  /:id/pdf        the bytes
 *   PUT  /:id/edits      persist the editor's pending edits (JSON)
 *   GET  /:id/edits      the saved edits
 *   POST /:id/revert     UNDO de la última escritura del server
 *
 * El store sale de `getStore(req)` (aislado por sesión en el demo) — nunca un
 * store compartido en closure. SIN try/catch: los throws viajan al catch site
 * (errors.ts).
 */
import { Router } from 'express';
import type { AnyEdit } from '@aldus/core';
import { badRequest, documentNotFound, h, nothingToRevert } from '../errors.js';
import { getStore, isValidId, requireDoc } from '../validate.js';
import { upload } from '../uploads.js';

export function documentsRouter(): Router {
  const router = Router();

  router.post('/', upload.single('pdf'), (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('Falta el archivo (campo "pdf").');
    if (!file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw badRequest('El archivo no es un PDF.');
    }
    res.status(201).json(getStore(req).create(file.originalname || 'documento.pdf', file.buffer));
  });

  router.get('/', (req, res) => {
    res.json(getStore(req).list());
  });

  router.get('/:id/pdf', requireDoc(), (req, res) => {
    res.type('application/pdf').send(getStore(req).readPdf(req.params.id));
  });

  router.put('/:id/edits', requireDoc(), (req, res) => {
    const edits = req.body?.edits;
    if (!Array.isArray(edits)) throw badRequest('Body esperado: { edits: [...] }.');
    res.json({ ok: true, count: getStore(req).writeEdits(req.params.id, edits as AnyEdit[]) });
  });

  // Reads don't require the PDF: a bad id is 404, a missing edits file is empty.
  router.get('/:id/edits', (req, res) => {
    if (!isValidId(req.params.id)) throw documentNotFound();
    res.json(getStore(req).readEdits(req.params.id));
  });

  // UNDO of the last server write: restore the newest revision and pop it.
  // The editor uses this to make instant ops (addText / insertImage /
  // createField / watermark / header-footer / links) undoable with Ctrl+Z.
  router.post('/:id/revert', requireDoc(), h((req, res) => {
    const restored = getStore(req).popRevision(req.params.id);
    if (!restored) throw nothingToRevert();
    res.json({ ok: true });
  }));

  return router;
}
