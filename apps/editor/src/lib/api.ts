/** Cliente del server de Aldus. Un solo origen (/api, proxied por Vite). */

import type { HighlightEdit, ImageEdit, LinkEdit, SegmentEdit, WidgetEdit, WidgetKind } from '@aldus/core';
import { readNdjson } from './ndjson';

export interface DocMeta {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
}

/** Evento en vivo de un turno del agente (streaming NDJSON). */
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string };

interface AgentDone {
  sessionId?: string;
  toolCalls: number;
  edits: SegmentEdit[];
  imageEdits: ImageEdit[];
  /** El agente horneó+persistió cambios que el estado local no representa
   *  (annotations/creaciones) → el editor debe RECARGAR el documento. */
  reloaded?: boolean;
}

/** El protocolo completo del wire: eventos en vivo + terminales. */
type AgentWireEvent =
  | AgentEvent
  | { type: 'done'; sessionId?: string; toolCalls?: number; edits?: SegmentEdit[]; imageEdits?: ImageEdit[]; reloaded?: boolean }
  | { type: 'error'; error?: string };

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

  /** DESHACE la última escritura del server (restaura la revisión previa).
   *  El historial lo usa para que las ops instantáneas entren al Ctrl+Z. */
  revert: (id: string): Promise<{ ok: boolean }> =>
    fetch(`/api/documents/${id}/revert`, { method: 'POST' }).then(r => ok<{ ok: boolean }>(r)),

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

  /** Corre un turno del agente LLM STREAMEADO (NDJSON). `onEvent` recibe los
   *  deltas de texto y las tool calls en vivo; la promesa resuelve con el
   *  resultado final: el SET COMPLETO de ediciones (las pendientes enviadas + las
   *  que agregó) para que el editor reemplace su estado. `resume` continúa el chat. */
  agentStream: async (
    id: string,
    prompt: string,
    edits: SegmentEdit[] = [],
    imageEdits: ImageEdit[] = [],
    resume: string | undefined,
    onEvent: (ev: AgentEvent) => void,
  ): Promise<AgentDone> => {
    const res = await fetch(`/api/documents/${id}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, edits, imageEdits, resume }),
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error || `${res.status} ${res.statusText}`);
    }
    let final: AgentDone | undefined;
    let failure: Error | undefined;
    await readNdjson<AgentWireEvent>(res.body, ev => {
      if (ev.type === 'done') final = { sessionId: ev.sessionId, toolCalls: ev.toolCalls ?? 0, edits: ev.edits ?? [], imageEdits: ev.imageEdits ?? [], reloaded: ev.reloaded };
      else if (ev.type === 'error') failure = new Error(ev.error || 'El agente falló.');
      else onEvent(ev);
    });
    if (failure) throw failure;
    if (!final) throw new Error('El agente no devolvió un resultado.');
    return final;
  },

  /** Aplica las ediciones AL PDF (bake del content stream + /Annots) y lo
   *  persiste. `highlights` = resaltados NUEVOS (a crear como anotación);
   *  `highlightEdits`/`linkEdits` = mover/borrar anotaciones ya guardadas. */
  bake: (
    id: string,
    edits: SegmentEdit[],
    imageEdits: ImageEdit[] = [],
    widgetEdits: WidgetEdit[] = [],
    highlights: Array<Record<string, unknown>> = [],
    highlightEdits: HighlightEdit[] = [],
    linkEdits: LinkEdit[] = [],
  ): Promise<{ ok: boolean; applied: string[]; warnings: string[] }> =>
    fetch(`/api/documents/${id}/bake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits, imageEdits, widgetEdits, highlights, highlightEdits, linkEdits }),
    }).then(r => ok<{ ok: boolean; applied: string[]; warnings: string[] }>(r)),
};
