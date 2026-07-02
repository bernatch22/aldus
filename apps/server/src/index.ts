/**
 * El server de Aldus. Fase 1: documentos como archivos en disco.
 *
 *   POST /api/documents            multipart {pdf}  → sube un PDF, devuelve la meta
 *   GET  /api/documents            lista (más reciente primero)
 *   GET  /api/documents/:id/pdf    los bytes
 *   PUT  /api/documents/:id/edits  persiste las ediciones del editor (JSON)
 *   GET  /api/documents/:id/edits  las ediciones guardadas
 *
 * El bake de ediciones sobre el content stream llega con @aldus/core fase de
 * escritura; hasta entonces el server es la fuente de verdad de PDF + edits.
 */

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeSegmentEdits } from '@aldus/core/bake';

const PORT = Number(process.env.ALDUS_PORT || 4100);
const DATA_DIR = process.env.ALDUS_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

interface DocMeta {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pdfPath = (id: string) => path.join(DATA_DIR, `${id}.pdf`);
const metaPath = (id: string) => path.join(DATA_DIR, `${id}.json`);
const editsPath = (id: string) => path.join(DATA_DIR, `${id}.edits.json`);

const app = express();
app.use(express.json({ limit: '4mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/api/documents', upload.single('pdf'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Falta el archivo (campo "pdf").' });
  if (!file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return res.status(400).json({ error: 'El archivo no es un PDF.' });
  }
  const meta: DocMeta = {
    id: randomUUID(),
    name: file.originalname || 'documento.pdf',
    size: file.size,
    uploadedAt: new Date().toISOString(),
  };
  writeFileSync(pdfPath(meta.id), file.buffer);
  writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
  res.status(201).json(meta);
});

app.get('/api/documents', (_req, res) => {
  const metas: DocMeta[] = readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('.edits.json'))
    .map(f => JSON.parse(readFileSync(path.join(DATA_DIR, f), 'utf8')) as DocMeta)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  res.json(metas);
});

app.get('/api/documents/:id/pdf', (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id) || !existsSync(pdfPath(id))) return res.status(404).json({ error: 'No existe.' });
  res.type('application/pdf').send(readFileSync(pdfPath(id)));
});

app.put('/api/documents/:id/edits', (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id) || !existsSync(pdfPath(id))) return res.status(404).json({ error: 'No existe.' });
  const edits = req.body?.edits;
  if (!Array.isArray(edits)) return res.status(400).json({ error: 'Body esperado: { edits: [...] }.' });
  writeFileSync(editsPath(id), JSON.stringify({ edits, savedAt: new Date().toISOString() }, null, 2));
  res.json({ ok: true, count: edits.length });
});

// Bake: aplica las ediciones AL PDF (content stream) y persiste el resultado.
// El PDF anterior queda en .bak (un nivel de undo grueso).
app.post('/api/documents/:id/bake', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id) || !existsSync(pdfPath(id))) return res.status(404).json({ error: 'No existe.' });
  const edits = req.body?.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return res.status(400).json({ error: 'Body esperado: { edits: [...] } no vacío.' });
  }
  try {
    const original = readFileSync(pdfPath(id));
    const { pdf, applied, warnings } = await bakeSegmentEdits(new Uint8Array(original), edits);
    copyFileSync(pdfPath(id), `${pdfPath(id)}.bak`);
    writeFileSync(pdfPath(id), Buffer.from(pdf));
    res.json({ ok: true, applied, warnings });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'No se pudo aplicar el bake.' });
  }
});

app.get('/api/documents/:id/edits', (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(404).json({ error: 'No existe.' });
  if (!existsSync(editsPath(id))) return res.json({ edits: [], savedAt: null });
  res.json(JSON.parse(readFileSync(editsPath(id), 'utf8')));
});

app.listen(PORT, () => {
  console.log(`[aldus-server] listo en http://localhost:${PORT} (data: ${DATA_DIR})`);
});
