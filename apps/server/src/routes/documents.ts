/**
 * Document CRUD:
 *   POST /               multipart {pdf} → upload, returns meta
 *   GET  /               list (newest first)
 *   GET  /:id/pdf        the bytes
 *   PUT  /:id/edits      persist the editor's pending edits (JSON)
 *   GET  /:id/edits      the saved edits
 *
 * El store sale de `getStore(req)` (aislado por sesión en el demo) — nunca un
 * store compartido en closure.
 */
import { Router } from 'express';
import { getStore, isValidId, requireDoc } from '../validate.js';
import { upload } from '../uploads.js';

export function documentsRouter(): Router {
  const router = Router();

  router.post('/', upload.single('pdf'), (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Falta el archivo (campo "pdf").' });
    if (!file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      return res.status(400).json({ error: 'El archivo no es un PDF.' });
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
    if (!Array.isArray(edits)) return res.status(400).json({ error: 'Body esperado: { edits: [...] }.' });
    res.json({ ok: true, count: getStore(req).writeEdits(req.params.id, edits) });
  });

  // Reads don't require the PDF: a bad id is 404, a missing edits file is empty.
  router.get('/:id/edits', (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'No existe.' });
    res.json(getStore(req).readEdits(req.params.id));
  });

  // UNDO of the last server write: restore the newest revision and pop it.
  // The editor uses this to make instant ops (addText / insertImage /
  // createField / watermark / header-footer / links) undoable with Ctrl+Z.
  router.post('/:id/revert', requireDoc(), (req, res) => {
    const restored = getStore(req).popRevision(req.params.id);
    if (!restored) return res.status(409).json({ error: 'No hay revisión para deshacer.' });
    res.json({ ok: true });
  });

  return router;
}
