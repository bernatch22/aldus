/**
 * server.test.ts — el host Express REAL en un puerto efímero, ejercitado con
 * fetch (sin mocks): upload → get → bake round-trip con un PDF de pdf-lib,
 * el registry IInstantOp, el 404 estructurado, y que el catch site NO filtra
 * mensajes internos (Commandment 7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EditSession, graphFromBytes } from '@aldus/agent';
import { createAldusApp } from '../src/app.js';
import { GENERIC_ERROR, ServerCodes } from '../src/errors.js';

let dataDir: string;
let server: Server;
let base: string;

async function makePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 72, y: 700, size: 14, font });
  return doc.save();
}

async function uploadPdf(bytes: Uint8Array, name = 'test.pdf'): Promise<{ status: number; body: { id: string; error?: string } }> {
  const form = new FormData();
  form.append('pdf', new Blob([bytes as BlobPart], { type: 'application/pdf' }), name);
  const res = await fetch(`${base}/documents`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() as { id: string; error?: string } };
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'aldus-server-test-'));
  const { app } = createAldusApp({ dataDir });
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('sin puerto efímero');
  base = `http://127.0.0.1:${addr.port}/api`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('documents: upload → list → get', () => {
  it('sube un PDF, lo lista y devuelve los bytes', async () => {
    const { status, body } = await uploadPdf(await makePdf('Hola mundo'));
    expect(status).toBe(201);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

    const list = await fetch(`${base}/documents`).then(r => r.json()) as Array<{ id: string; name: string }>;
    expect(list.some(d => d.id === body.id && d.name === 'test.pdf')).toBe(true);

    const pdf = new Uint8Array(await fetch(`${base}/documents/${body.id}/pdf`).then(r => r.arrayBuffer()));
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
  });

  it('rechaza un archivo que no es PDF (400, string v1)', async () => {
    const { status, body } = await uploadPdf(new TextEncoder().encode('hola'), 'x.pdf');
    expect(status).toBe(400);
    expect(body.error).toBe('El archivo no es un PDF.');
  });

  it('404 ESTRUCTURADO para un documento inexistente', async () => {
    const res = await fetch(`${base}/documents/00000000-0000-0000-0000-000000000000/pdf`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; code: number };
    expect(body.error).toBe('No existe.'); // string v1 byte-idéntico
    expect(body.code).toBe(ServerCodes.NotFound); // el campo NUEVO estable
  });
});

describe('bake round-trip', () => {
  it('upload → editText (EditSession real) → POST /bake → el texto cambió', async () => {
    const bytes = await makePdf('Hola mundo');
    const { body: meta } = await uploadPdf(bytes);

    // El edit lo produce la MISMA maquinaria que usa el agente/editor.
    const doc = await graphFromBytes(bytes.slice());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('Hola'));
    expect(seg).toBeDefined();
    const session = new EditSession(doc);
    const msg = await session.editText(seg!.id, 'Chau mundo');
    expect(msg).toContain('✓');
    const { edits } = session.getEdits();

    const res = await fetch(`${base}/documents/${meta.id}/bake`, json({ edits }));
    const out = await res.json() as { ok: boolean; applied: string[]; warnings: string[] };
    expect(res.status).toBe(200);
    expect(out.ok).toBe(true);
    expect(out.applied.length).toBeGreaterThan(0);

    const baked = new Uint8Array(await fetch(`${base}/documents/${meta.id}/pdf`).then(r => r.arrayBuffer()));
    const after = await graphFromBytes(baked);
    expect(after.pages[0]!.segments.some(s => s.text.includes('Chau mundo'))).toBe(true);
  });

  it('bake sin ediciones → 400 con el string v1', async () => {
    const { body: meta } = await uploadPdf(await makePdf('X'));
    const res = await fetch(`${base}/documents/${meta.id}/bake`, json({}));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Body esperado: { edits, imageEdits, widgetEdits, highlights, highlightEdits, linkEdits, shapeEdits } con al menos una edición.');
  });
});

describe('ops: el registry IInstantOp', () => {
  it('addText por el registry + revert (undo de la última escritura)', async () => {
    const { body: meta } = await uploadPdf(await makePdf('Base'));
    const res = await fetch(`${base}/documents/${meta.id}/ops`, json({ action: 'addText', page: 1, x: 72, y: 600, text: 'Agregado' }));
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);

    const withText = new Uint8Array(await fetch(`${base}/documents/${meta.id}/pdf`).then(r => r.arrayBuffer()));
    const graph = await graphFromBytes(withText);
    expect(graph.pages[0]!.segments.some(s => s.text.includes('Agregado'))).toBe(true);

    // revert: restaura la revisión previa; el segundo revert no tiene qué deshacer.
    const undo = await fetch(`${base}/documents/${meta.id}/revert`, { method: 'POST' });
    expect(undo.status).toBe(200);
    const again = await fetch(`${base}/documents/${meta.id}/revert`, { method: 'POST' });
    expect(again.status).toBe(409);
    expect((await again.json() as { error: string }).error).toBe('No hay revisión para deshacer.');
  });

  it('acción desconocida → 400 (nadie la reclama en el registry)', async () => {
    const { body: meta } = await uploadPdf(await makePdf('X'));
    const res = await fetch(`${base}/documents/${meta.id}/ops`, json({ action: 'nope' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: number };
    expect(body.error).toBe('Acción desconocida: nope');
    expect(body.code).toBe(ServerCodes.UnknownOp);
  });
});

describe('el catch site (UN solo lugar)', () => {
  it('un PDF corrupto NO filtra el mensaje interno de pdf-lib al usuario', async () => {
    // Magic válido, cuerpo basura: pasa el guard del upload, explota en pdf-lib.
    const corrupt = new TextEncoder().encode('%PDF-1.4\nesto no es un pdf de verdad\n%%EOF');
    const { status, body: meta } = await uploadPdf(corrupt);
    expect(status).toBe(201);

    const res = await fetch(`${base}/documents/${meta.id}/ops`, json({ action: 'addText', page: 1, x: 10, y: 10, text: 'x' }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(GENERIC_ERROR); // genérico, jamás el err.message interno
    expect(body.error).not.toMatch(/parse|offset|pdf-lib|at /i);
  });
});
