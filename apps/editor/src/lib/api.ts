/** Cliente del server de Aldus. Un solo origen (/api, proxied por Vite). */

import type { ImageEdit, SegmentEdit, WidgetEdit, WidgetKind } from '@aldus/core';

export interface DocMeta {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
}

async function ok<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  list: (): Promise<DocMeta[]> => fetch('/api/documents').then(r => ok<DocMeta[]>(r)),

  upload: (file: File): Promise<DocMeta> => {
    const fd = new FormData();
    fd.append('pdf', file);
    return fetch('/api/documents', { method: 'POST', body: fd }).then(r => ok<DocMeta>(r));
  },

  pdfUrl: (id: string): string => `/api/documents/${id}/pdf`,

  saveEdits: (id: string, edits: SegmentEdit[]): Promise<{ ok: boolean; count: number }> =>
    fetch(`/api/documents/${id}/edits`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits }),
    }).then(r => ok<{ ok: boolean; count: number }>(r)),

  loadEdits: (id: string): Promise<{ edits: SegmentEdit[]; savedAt: string | null }> =>
    fetch(`/api/documents/${id}/edits`).then(r => ok<{ edits: SegmentEdit[]; savedAt: string | null }>(r)),

  /** Crea un campo de formulario nuevo en el punto dado. */
  createField: (id: string, spec: { type: WidgetKind; page: number; x: number; y: number }): Promise<{ ok: boolean; name: string }> =>
    fetch(`/api/documents/${id}/fields`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    }).then(r => ok<{ ok: boolean; name: string }>(r)),

  /** Operación de documento: addText | watermark | headerFooter | highlight | addLink | removeLink. */
  docOp: (id: string, action: string, params: Record<string, unknown>): Promise<{ ok: boolean }> =>
    fetch(`/api/documents/${id}/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...params }),
    }).then(r => ok<{ ok: boolean }>(r)),

  /** Inserta una imagen (PNG/JPEG) en el punto clickeado. */
  insertImage: (id: string, file: File, spec: { page: number; x: number; y: number }): Promise<{ ok: boolean }> => {
    const fd = new FormData();
    fd.append('image', file);
    fd.append('page', String(spec.page));
    fd.append('x', String(spec.x));
    fd.append('y', String(spec.y));
    return fetch(`/api/documents/${id}/images`, { method: 'POST', body: fd }).then(r => ok<{ ok: boolean }>(r));
  },

  /** Aplica las ediciones AL PDF (bake del content stream + /Annots) y lo persiste. */
  bake: (
    id: string,
    edits: SegmentEdit[],
    imageEdits: ImageEdit[] = [],
    widgetEdits: WidgetEdit[] = [],
    highlights: Array<Record<string, unknown>> = [],
  ): Promise<{ ok: boolean; applied: string[]; warnings: string[] }> =>
    fetch(`/api/documents/${id}/bake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits, imageEdits, widgetEdits, highlights }),
    }).then(r => ok<{ ok: boolean; applied: string[]; warnings: string[] }>(r)),
};
