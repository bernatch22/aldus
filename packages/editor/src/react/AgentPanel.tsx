/**
 * AgentPanel — el chat de Aldus AI dentro del editor. Manda el prompt al server
 * (que corre el agente LLM con el grafo del documento embebido) y STREAMEA la
 * respuesta token a token + las tools ejecutándose en vivo (NDJSON). Al terminar,
 * aplica el SET COMPLETO de ediciones al estado del editor vía `onApply` — el
 * mismo pipeline preview/guardar que una edición manual. Multi-turno con
 * `sessionId` (resume).
 *
 * v2: el cliente del wire llega INYECTADO (`api: AldusApi`) — muere el `api`
 * global de módulo de v1 (audit §1.1).
 */
import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, X } from 'lucide-react';
import { createLogger, type ImageEdit, type SegmentEdit } from '@aldus/core';
import type { AgentRole, AldusApi } from '../core/index.js';
import { cx } from './ui/primitives.js';
import { StreamingMarkdown, MD_STYLES } from './Markdown.js';

const log = createLogger('aldus:panel');

const TOOL_LABEL: Record<string, string> = {
  edit_document: 'delegando al editor',
  verify_layout: 'verificando layout',
  edit_text: 'editando texto', replace_paragraph: 'reemplazando párrafo', move_text: 'moviendo texto', set_text_color: 'coloreando texto',
  set_text_size: 'cambiando tamaño', delete_text: 'eliminando texto',
  move_image: 'moviendo imagen', delete_image: 'eliminando imagen',
  highlight_text: 'resaltando', set_highlight_color: 'recoloreando resaltado', delete_highlight: 'quitando resaltado',
  add_link: 'creando link', delete_link: 'quitando link',
  add_text: 'agregando texto', insert_image: 'insertando imagen',
  add_watermark: 'poniendo watermark', add_header_footer: 'encabezado/pie',
  add_form_field: 'creando campo', placeholders_to_fields: 'convirtiendo a inputs',
  fill_field: 'completando campo', fill_fields: 'completando campos',
  move_field: 'moviendo campo', delete_field: 'eliminando campo',
};
const toolLabel = (name: string) => TOOL_LABEL[name.replace('mcp__aldus__', '')] ?? name;

/** Un mensaje del asistente es una secuencia CRONOLÓGICA de partes: texto y
 *  tools intercalados como fueron ocurriendo, cada una etiquetada con QUIÉN la
 *  emite (chat = el operador, editor = el segundo agente). */
type Part =
  | { kind: 'text'; text: string; agent: AgentRole }
  | { kind: 'tool'; name: string; agent: AgentRole };

interface Msg {
  role: 'user' | 'assistant';
  text?: string;        // user
  parts?: Part[];       // assistant (orden cronológico)
  error?: boolean;
  streaming?: boolean;
  edits?: number;
  /** El turno horneó+guardó (annotations/creaciones) — ya persistido. */
  saved?: boolean;
  startedAt?: number;
  /** Primer turno de la sesión → a los 5s avisamos que usa Claude Code. */
  firstTurn?: boolean;
}

/** Agrega un delta de texto a la ÚLTIMA parte, solo si es texto DEL MISMO
 *  agente (si no, abre una parte nueva — nunca se mezclan chat y editor). */
function appendText(parts: Part[], delta: string, agent: AgentRole): Part[] {
  const out = [...parts];
  const last = out[out.length - 1];
  if (last && last.kind === 'text' && last.agent === agent) {
    out[out.length - 1] = { ...last, text: last.text + delta };
  } else out.push({ kind: 'text', text: delta, agent });
  return out;
}

type Row = { kind: 'text'; text: string } | { kind: 'tools'; names: string[] };
type Block = { agent: AgentRole; rows: Row[] };

/** Agrupa las partes en BLOQUES contiguos por agente, y dentro de cada bloque
 *  en filas (texto suelto / fila de tools) en orden cronológico. */
function groupParts(parts: Part[]): Block[] {
  const blocks: Block[] = [];
  for (const p of parts) {
    let block = blocks[blocks.length - 1];
    if (!block || block.agent !== p.agent) { block = { agent: p.agent, rows: [] }; blocks.push(block); }
    const last = block.rows[block.rows.length - 1];
    if (p.kind === 'tool') {
      if (last && last.kind === 'tools') last.names.push(p.name);
      else block.rows.push({ kind: 'tools', names: [p.name] });
    } else {
      block.rows.push({ kind: 'text', text: p.text });
    }
  }
  return blocks;
}

interface Props {
  api: AldusApi;
  docId: string;
  /** Página que el usuario está viendo → el agente solo recibe ESA página. */
  page: number;
  edits: ReadonlyMap<string, SegmentEdit>;
  imageEdits: ReadonlyMap<string, ImageEdit>;
  onApply: (edits: SegmentEdit[], imageEdits: ImageEdit[]) => void;
  /** El agente horneó+persistió cambios (annotations/creaciones) → recargar el
   *  documento desde el server (descarta el estado local, ya horneado). */
  onReload: () => void;
  onClose: () => void;
}

const SUGGESTIONS = [
  'Resumí de qué trata el documento',
  'Poné el título en mayúsculas',
  'Corregí las faltas de ortografía del título',
];

export function AgentPanel({ api, docId, page, edits, imageEdits, onApply, onReload, onClose }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(0); // re-render mientras esperamos, para el aviso de 5s
  const sessionId = useRef<string | undefined>(undefined);
  const turns = useRef(0); // cuántos turnos van (para saber si es el primero)
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Mientras hay un turno en curso, tickeamos para que aparezca el aviso a los 5s.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNowTick(t => t + 1), 500);
    return () => clearInterval(id);
  }, [busy]);

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    const firstTurn = turns.current === 0;
    turns.current++;
    setMessages(m => [...m, { role: 'user', text: prompt }, { role: 'assistant', parts: [], streaming: true, startedAt: Date.now(), firstTurn }]);
    setInput('');
    setBusy(true);
    const patchLast = (fn: (msg: Msg) => Msg) =>
      setMessages(m => { const c = [...m]; c[c.length - 1] = fn(c[c.length - 1]!); return c; });
    try {
      const res = await api.agentStream(
        docId, prompt, [...edits.values()], [...imageEdits.values()], sessionId.current,
        ev => {
          const agent: AgentRole = ev.agent ?? 'chat';
          if (ev.type === 'text') patchLast(msg => ({ ...msg, parts: appendText(msg.parts ?? [], ev.delta, agent) }));
          else if (ev.type === 'tool') {
            log('tool [%s]: %s', agent, ev.name);
            patchLast(msg => ({ ...msg, parts: [...(msg.parts ?? []), { kind: 'tool', name: ev.name, agent }] }));
          }
        },
        page,
      );
      sessionId.current = res.sessionId ?? sessionId.current;
      log('done: toolCalls=%d edits=%d reloaded=%s', res.toolCalls, res.edits.length + res.imageEdits.length, !!res.reloaded);
      if (res.reloaded) onReload(); else onApply(res.edits, res.imageEdits);
      patchLast(msg => ({
        ...msg, streaming: false,
        parts: (msg.parts && msg.parts.length) ? msg.parts : [{ kind: 'text', text: '(listo)', agent: 'chat' }],
        // reloaded = ya horneado+guardado (no hay nada que "revisar y guardar").
        edits: res.reloaded ? 0 : res.edits.length + res.imageEdits.length,
        saved: res.reloaded,
      }));
    } catch (e) {
      const err = e instanceof Error ? e.message : 'Falló el agente.';
      log('error: %s', err);
      patchLast(msg => ({ ...msg, streaming: false, error: true, parts: [...(msg.parts ?? []), { kind: 'text', text: `⚠️ ${err}`, agent: 'chat' }] }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-neutral-200 bg-white">
      <style>{MD_STYLES}
        {`@keyframes casper-dots{0%,20%{content:''}40%{content:'.'}60%{content:'..'}80%,100%{content:'...'}}
          .casper-dots::after{content:'';animation:casper-dots 1.4s steps(1,end) infinite}`}
      </style>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-3">
        <Sparkles size={16} className="text-blue-600" />
        <span className="text-[13px] font-semibold tracking-wide text-neutral-900">CASPER</span>
        <span className="text-[11px] text-neutral-400">· MAGI-3 · preguntá o pedí cambios</span>
        <div className="flex-1" />
        <button onClick={onClose} title="Cerrar" className="grid h-7 w-7 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100">
          <X size={15} />
        </button>
      </header>

      <div ref={scrollRef} className="thin-scroll flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="mt-2 space-y-2">
            <p className="text-[12px] leading-relaxed text-neutral-500">
              Tengo el documento entero cargado. Preguntame sobre su contenido o pedime cambios
              (editar texto, mover imágenes…). Los cambios aparecen en el editor para revisar y guardar.
            </p>
            <div className="flex flex-col gap-1.5 pt-1">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => void send(s)}
                  className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-left text-[12px] text-neutral-600 hover:border-blue-300 hover:bg-blue-50">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div key={i} className="flex flex-col items-end gap-1.5">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-blue-600 px-3 py-2 text-[12.5px] leading-relaxed text-white">{m.text}</div>
              </div>
            );
          }
          const blocks = groupParts(m.parts ?? []);
          const parts = m.parts ?? [];
          const lastPart = parts[parts.length - 1];
          void nowTick; // el aviso de 5s depende del tick
          // ESPERANDO = el turno corre pero NO hay texto fluyendo (arranque o una
          // tool en ejecución). Con el primer token de texto se apaga: el texto ES
          // el progreso. Sin barra ni cronómetro: un simple "Pensando…".
          const waiting = !!m.streaming && (!lastPart || lastPart.kind === 'tool');
          const secs = m.startedAt ? (Date.now() - m.startedAt) / 1000 : 0;
          const showFirstNote = waiting && m.firstTurn && secs >= 5;
          // Filas de un bloque: burbuja de texto · fila de chips · … (cronológico).
          const renderRows = (rows: Row[], streamingBlock: boolean, editor: boolean) =>
            rows.map((row, j) => row.kind === 'text' ? (
              row.text.trim() ? (
                <div key={j}
                  style={editor ? { backgroundColor: 'rgba(255,255,255,0.06)', color: '#e6edf3' } : undefined}
                  className={cx(
                    'rounded-2xl px-3 py-2 text-[12.5px] leading-relaxed',
                    m.error ? 'bg-red-50 text-red-700' : editor ? '' : 'bg-neutral-100 text-neutral-800',
                    editor ? 'max-w-full' : 'max-w-[85%]',
                  )}>
                  <StreamingMarkdown text={row.text} active={streamingBlock && j === rows.length - 1} />
                </div>
              ) : null
            ) : (
              <div key={j} className="flex flex-wrap gap-1 px-0.5">
                {row.names.map((t, k) => (
                  <span key={k}
                    style={editor ? { border: '1px solid rgba(255,255,255,0.18)', backgroundColor: 'rgba(255,255,255,0.10)', color: '#cfe6f5' } : undefined}
                    className={cx(
                      'rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                      editor ? '' : 'border border-blue-200 bg-blue-100 text-blue-700',
                    )}>✎ {toolLabel(t)}</span>
                ))}
              </div>
            ));
          return (
            <div key={i} className="flex flex-col items-start gap-2">
              {/* CRONOLÓGICO por bloques: chat → [editor anidado] → chat … */}
              {blocks.map((b, bi) => {
                const streamingBlock = !!m.streaming && bi === blocks.length - 1;
                if (b.agent === 'editor') {
                  return (
                    <div key={bi} style={{ backgroundColor: '#172c3a', color: '#e6edf3' }} className="flex w-[92%] flex-col gap-1.5 rounded-lg px-2.5 py-2">
                      <div style={{ color: '#7cc4e8' }} className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
                        <Sparkles size={11} /> editor
                      </div>
                      {renderRows(b.rows, streamingBlock, true)}
                    </div>
                  );
                }
                return <div key={bi} className="flex w-full flex-col items-start gap-2">{renderRows(b.rows, streamingBlock, false)}</div>;
              })}

              {/* Indicador único mientras esperamos: "Pensando…" con puntos (sin barra).
                  A los 5s del primer turno, aviso genérico de latencia inicial. */}
              {waiting && (
                <div className="flex flex-col gap-1 px-1">
                  <span style={{ color: '#8a8a93' }} className="text-[12px]">Pensando<span className="casper-dots" /></span>
                  {showFirstNote && (
                    <span style={{ color: '#8a8a93' }} className="text-[11px] leading-relaxed">
                      La primera respuesta puede tardar unos segundos.
                    </span>
                  )}
                </div>
              )}

              {!m.streaming && !m.error && typeof m.edits === 'number' && m.edits > 0 && (
                <div className="px-1 text-[11px] font-medium text-blue-600">✎ {m.edits} edición(es) activa(s) — revisá y guardá</div>
              )}
              {!m.streaming && !m.error && m.saved && (
                <div className="px-1 text-[11px] font-medium text-emerald-600">✓ Aplicado y guardado en el documento</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-neutral-200 p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            placeholder="Escribí una pregunta o un cambio…"
            rows={2}
            disabled={busy}
            className="thin-scroll min-h-[38px] flex-1 resize-none rounded-lg border border-neutral-200 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-blue-500 disabled:bg-neutral-50"
          />
          <button
            onClick={() => void send(input)}
            disabled={busy || !input.trim()}
            title="Enviar (Enter)"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-200 disabled:text-neutral-400"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
