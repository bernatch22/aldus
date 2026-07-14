/**
 * api/aldusApi.ts — cliente del server de Aldus (v1: `apps/editor/src/lib/api.ts`).
 *
 * AJUSTE v2 (audit §1.1 bug latente / §2 COPY-CON-AJUSTES): v1 guardaba la base
 * del API en un `let API` a nivel de MÓDULO, mutado por `configureAldusApi`.
 * `debug/capture.ts` (el modo forense 🐞) calculaba SU PROPIA base desde
 * `BASE_URL` en vez de leer esa variable — en un host embebido (`apiBase`
 * distinto de la convención `BASE_URL + /api`) el 🐞 apuntaba a la URL
 * equivocada. Acá `AldusApi` es una CLASE inyectable: la composition root
 * construye UNA instancia con `apiBase` y se la pasa a todo lo que hace fetch
 * (incluido el `debug/capture` del checkpoint 2) — no hay estado de módulo que
 * un consumidor pueda ignorar.
 *
 * `saveEdits`/`loadEdits` de v1 NO cruzan (audit: sin usuarios en el editor —
 * el documento se persiste únicamente vía `bake`).
 */
import type { HighlightEdit, ImageEdit, LinkEdit, SegmentEdit, ShapeEdit, WidgetEdit, WidgetKind } from '@aldus/core';
import { readNdjson } from './ndjson.js';

export interface DocMeta {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
}

/** Evento en vivo de un turno del agente (streaming NDJSON). `agent` dice quién
 *  lo emite: el CHAT (router) o el EDITOR (segundo nivel) — el panel renderiza
 *  el pase del editor como bloque propio. */
export type AgentRole = 'chat' | 'editor';
export type AgentEvent =
  | { type: 'text'; delta: string; agent?: AgentRole }
  | { type: 'tool'; name: string; agent?: AgentRole };

export interface AgentDone {
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

export interface AldusApiOptions {
  /** Base del API, SIN slash final (p. ej. `/api` o `/aldus-app/api`). */
  apiBase: string;
}

export class AldusApi {
  private base: string;

  constructor(opts: AldusApiOptions) {
    this.base = opts.apiBase.replace(/\/+$/, '');
  }

  /** Reconfigura la base (host embebido que la resuelve tarde). Todo lo que
   *  sostiene una referencia a ESTA instancia (incluido capture.ts) ve el
   *  cambio — no hay una segunda copia que ignorarlo. */
  configure(opts: AldusApiOptions): void {
    this.base = opts.apiBase.replace(/\/+$/, '');
  }

  get apiBase(): string {
    return this.base;
  }

  list(): Promise<DocMeta[]> {
    return fetch(`${this.base}/documents`).then(r => ok<DocMeta[]>(r));
  }

  upload(file: File): Promise<DocMeta> {
    const fd = new FormData();
    fd.append('pdf', file);
    return fetch(`${this.base}/documents`, { method: 'POST', body: fd }).then(r => ok<DocMeta>(r));
  }

  pdfUrl(id: string): string {
    return `${this.base}/documents/${id}/pdf`;
  }

  /** DESHACE la última escritura del server (restaura la revisión previa).
   *  El historial lo usa para que las ops instantáneas entren al Ctrl+Z. */
  revert(id: string): Promise<{ ok: boolean }> {
    return fetch(`${this.base}/documents/${id}/revert`, { method: 'POST' }).then(r => ok<{ ok: boolean }>(r));
  }

  /** Crea un campo de formulario nuevo en el punto dado. */
  createField(id: string, spec: { type: WidgetKind; page: number; x: number; y: number }): Promise<{ ok: boolean; name: string }> {
    return fetch(`${this.base}/documents/${id}/fields`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    }).then(r => ok<{ ok: boolean; name: string }>(r));
  }

  /** Operación de documento: addText | watermark | headerFooter | highlight | addLink | removeLink. */
  docOp(id: string, action: string, params: Record<string, unknown>): Promise<{ ok: boolean }> {
    return fetch(`${this.base}/documents/${id}/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...params }),
    }).then(r => ok<{ ok: boolean }>(r));
  }

  /** Inserta una imagen (PNG/JPEG) en el punto clickeado. */
  insertImage(id: string, file: File, spec: { page: number; x: number; y: number }): Promise<{ ok: boolean }> {
    const fd = new FormData();
    fd.append('image', file);
    fd.append('page', String(spec.page));
    fd.append('x', String(spec.x));
    fd.append('y', String(spec.y));
    return fetch(`${this.base}/documents/${id}/images`, { method: 'POST', body: fd }).then(r => ok<{ ok: boolean }>(r));
  }

  /** Corre un turno del agente LLM STREAMEADO (NDJSON). `onEvent` recibe los
   *  deltas de texto y las tool calls en vivo; la promesa resuelve con el
   *  resultado final: el SET COMPLETO de ediciones (las pendientes enviadas + las
   *  que agregó) para que el editor reemplace su estado. `resume` continúa el chat. */
  async agentStream(
    id: string,
    prompt: string,
    edits: SegmentEdit[] = [],
    imageEdits: ImageEdit[] = [],
    resume: string | undefined,
    onEvent: (ev: AgentEvent) => void,
    page?: number,
  ): Promise<AgentDone> {
    const res = await fetch(`${this.base}/documents/${id}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, edits, imageEdits, resume, page }),
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
  }

  /** Aplica las ediciones AL PDF (bake del content stream + /Annots) y lo
   *  persiste. `highlights` = resaltados NUEVOS (a crear como anotación);
   *  `highlightEdits`/`linkEdits` = mover/borrar anotaciones ya guardadas. */
  bake(
    id: string,
    edits: SegmentEdit[],
    imageEdits: ImageEdit[] = [],
    widgetEdits: WidgetEdit[] = [],
    highlights: Array<Record<string, unknown>> = [],
    highlightEdits: HighlightEdit[] = [],
    linkEdits: LinkEdit[] = [],
    shapeEdits: ShapeEdit[] = [],
  ): Promise<{ ok: boolean; applied: string[]; warnings: string[] }> {
    return fetch(`${this.base}/documents/${id}/bake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits, imageEdits, widgetEdits, highlights, highlightEdits, linkEdits, shapeEdits }),
    }).then(r => ok<{ ok: boolean; applied: string[]; warnings: string[] }>(r));
  }
}
