/**
 * capture.ts — MODO FORENSE 🐞 del editor. Junta TODO el estado relevante al
 * momento del click (el grafo de la página tal como la UI lo ve, el nodo
 * seleccionado, los edits pendientes de las 6 colecciones, el trace de logs de
 * la sesión — todo lo que pasó por createLogger) y lo manda al server, que
 * escribe un bundle reproducible en /tmp/aldus-debug/<ts>/ con un `repro.mts`
 * pre-armado (npx tsx …) para debuggear el bake/extract SIN la UI.
 *
 * Activación: server con ALDUS_DEBUG=1 + UI con localStorage.aldusDebug='1'
 * (o abrir con ?debug=1, que lo persiste).
 *
 * FIX v2 (audit §1.1 / §3.5): v1 calculaba SU PROPIA base de API desde
 * `BASE_URL` (ignoraba `configureAldusApi`) — en un host embebido el 🐞
 * apuntaba a la URL equivocada. Acá la instancia `AldusApi` llega INYECTADA:
 * la MISMA que usa todo el editor.
 */
import { getTrace, type HighlightEdit, type ImageEdit, type LinkEdit, type PageGraph, type SegmentEdit, type WidgetEdit } from '@aldus/core';
import type { AldusApi } from '../../core/index.js';

/** ¿Modo forense activo en la UI? (?debug=1 lo enciende y persiste). */
export function pdfDebugEnabled(): boolean {
  try {
    if (new URLSearchParams(location.search).has('debug')) localStorage.setItem('aldusDebug', '1');
    return !!localStorage.getItem('aldusDebug');
  } catch { return false; }
}

/** JSON seguro: los buffers/typed arrays no van al bundle (peso y ruido). */
function sanitize(_k: string, v: unknown): unknown {
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `[${(v as Uint8Array).byteLength ?? (v as ArrayBuffer).byteLength} bytes]`;
  return v;
}

export interface CaptureInput {
  docId: string;
  page: number;
  nodeId: string | null;
  graph: PageGraph | null;
  edits: ReadonlyMap<string, SegmentEdit>;
  imageEdits: ReadonlyMap<string, ImageEdit>;
  widgetEdits: ReadonlyMap<string, WidgetEdit>;
  highlightEdits: ReadonlyMap<string, HighlightEdit>;
  linkEdits: ReadonlyMap<string, LinkEdit>;
  pendingHighlights: unknown[];
  note?: string;
}

/** Arma el mensaje que el usuario PEGA EN EL CHAT para que Claude debuggee: es
 *  autocontenido (path del bundle + comando + nodo + hueco para el síntoma). */
function handoff(dir: string, cmd: string, c: CaptureInput): string {
  return [
    'Aldus bug — bundle forense listo para reproducir.',
    `Dir:   ${dir}`,
    `PDF:   ${dir}/doc.pdf   (abrir: open ${dir}/doc.pdf)`,
    `Repro: ${cmd}`,
    `Nodo:  ${c.nodeId ?? '(ninguno — página entera)'} · página ${c.page}`,
    'Qué está mal: <describí el síntoma acá>',
    '',
    'Claude: leé capture.json, corré el repro, y arreglá la causa raíz en packages/core (bake/extract).',
  ].join('\n');
}

/** Captura el estado y devuelve {dir, cmd, handoff}. Al portapapeles va el
 *  HANDOFF (lo que el usuario pega en el chat), no solo el comando. */
export async function captureDebug(api: AldusApi, c: CaptureInput): Promise<{ dir: string; cmd: string; handoff: string }> {
  const payload = JSON.parse(JSON.stringify({
    page: c.page,
    nodeId: c.nodeId,
    // El grafo COMPLETO de la página como lo ve la UI ahora (con overrides ya
    // aplicados por extract) — el repro lo compara contra la re-extracción.
    clickPage: c.graph,
    edits: [...c.edits.values()],
    imageEdits: [...c.imageEdits.values()],
    widgetEdits: [...c.widgetEdits.values()],
    highlightEdits: [...c.highlightEdits.values()],
    linkEdits: [...c.linkEdits.values()],
    pendingHighlights: c.pendingHighlights,
    note: c.note ?? '',
    ui: { url: location.href, userAgent: navigator.userAgent },
    trace: getTrace(), // toda la sesión: cada log gateado que emitió el editor
  }, sanitize));

  const res = await fetch(`${api.apiBase}/documents/${c.docId}/debug`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`captura falló (${res.status}) — ¿server con ALDUS_DEBUG=1?`);
  const out = await res.json() as { dir: string; cmd: string };
  const msg = handoff(out.dir, out.cmd, c);
  try { await navigator.clipboard.writeText(msg); } catch { /* clipboard puede fallar sin gesto */ }
  return { ...out, handoff: msg };
}
