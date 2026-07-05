/**
 * AgentPanel — el chat de Aldus AI dentro del editor. Manda el prompt al server
 * (que corre el agente LLM con el grafo del documento embebido) y STREAMEA la
 * respuesta token a token + las tools ejecutándose en vivo (NDJSON). Al terminar,
 * aplica el SET COMPLETO de ediciones al estado del editor vía `onApply` — el
 * mismo pipeline preview/guardar que una edición manual. Multi-turno con
 * `sessionId` (resume).
 */
import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, X } from 'lucide-react';
import type { ImageEdit, SegmentEdit } from '@aldus/core';
import { api } from '../lib/api';
import { cx } from '../ui/primitives';

const TOOL_LABEL: Record<string, string> = {
  edit_text: 'editando texto', move_text: 'moviendo texto', set_text_color: 'coloreando texto',
  set_text_size: 'cambiando tamaño', delete_text: 'eliminando texto',
  move_image: 'moviendo imagen', delete_image: 'eliminando imagen',
};
const toolLabel = (name: string) => TOOL_LABEL[name.replace('mcp__aldus__', '')] ?? name;

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  error?: boolean;
  streaming?: boolean;
  tools?: string[];
  edits?: number;
}

interface Props {
  docId: string;
  edits: Map<string, SegmentEdit>;
  imageEdits: Map<string, ImageEdit>;
  onApply: (edits: SegmentEdit[], imageEdits: ImageEdit[]) => void;
  onClose: () => void;
}

const SUGGESTIONS = [
  'Resumí de qué trata el documento',
  'Poné el título en mayúsculas',
  'Corregí las faltas de ortografía del título',
];

export function AgentPanel({ docId, edits, imageEdits, onApply, onClose }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionId = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setMessages(m => [...m, { role: 'user', text: prompt }, { role: 'assistant', text: '', streaming: true, tools: [] }]);
    setInput('');
    setBusy(true);
    const patchLast = (fn: (msg: Msg) => Msg) =>
      setMessages(m => { const c = [...m]; c[c.length - 1] = fn(c[c.length - 1]); return c; });
    try {
      const res = await api.agentStream(
        docId, prompt, [...edits.values()], [...imageEdits.values()], sessionId.current,
        ev => {
          if (ev.type === 'text') patchLast(msg => ({ ...msg, text: msg.text + ev.delta }));
          else if (ev.type === 'tool') patchLast(msg => ({ ...msg, tools: [...(msg.tools ?? []), ev.name] }));
        },
      );
      sessionId.current = res.sessionId ?? sessionId.current;
      onApply(res.edits, res.imageEdits);
      patchLast(msg => ({ ...msg, streaming: false, text: msg.text || '(listo)', edits: res.edits.length + res.imageEdits.length }));
    } catch (e) {
      const err = e instanceof Error ? e.message : 'Falló el agente.';
      patchLast(msg => ({ ...msg, streaming: false, error: true, text: (msg.text ? `${msg.text}\n\n` : '') + `⚠️ ${err}` }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-neutral-200 bg-white">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-3">
        <Sparkles size={16} className="text-blue-600" />
        <span className="text-[13px] font-semibold text-neutral-900">Aldus AI</span>
        <span className="text-[11px] text-neutral-400">· preguntá o pedí cambios</span>
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
        {messages.map((m, i) => (
          <div key={i} className={cx('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cx(
              'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[12.5px] leading-relaxed',
              m.role === 'user' ? 'bg-blue-600 text-white' : m.error ? 'bg-red-50 text-red-700' : 'bg-neutral-100 text-neutral-800',
            )}>
              {/* Tools ejecutándose (chips) */}
              {m.role === 'assistant' && m.tools && m.tools.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {m.tools.map((t, j) => (
                    <span key={j} className="rounded-full bg-blue-100 px-2 py-0.5 text-[10.5px] font-medium text-blue-700">✎ {toolLabel(t)}</span>
                  ))}
                </div>
              )}
              {m.text}
              {/* Cursor mientras streamea / "Pensando…" antes del primer token */}
              {m.streaming && (m.text
                ? <span className="ml-0.5 inline-block animate-pulse">▍</span>
                : (!m.tools || m.tools.length === 0) && <span className="text-neutral-400">Pensando…</span>)}
              {m.role === 'assistant' && !m.error && !m.streaming && typeof m.edits === 'number' && m.edits > 0 && (
                <div className="mt-1.5 text-[11px] font-medium text-blue-600">✎ {m.edits} edición(es) activa(s) — revisá y guardá</div>
              )}
            </div>
          </div>
        ))}
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
