/** Cliente del server de Aldus. Un solo origen (/api, proxied por Vite). */

import type { SegmentEdit } from '@aldus/core';

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
};
