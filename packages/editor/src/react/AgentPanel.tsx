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
 *
 * DOS PESTAÑAS, DOS AGENTES ({@link AgentMode}) — el panel es el shell con el
 * tab bar y {@link AgentThread} ES la conversación, montada UNA VEZ POR MODO:
 *  - `reader`: modelo barato con el documento entero. Pregunta/respuesta y
 *    relleno de campos de formulario. No edita nada más.
 *  - `editor`: modelo fuerte, directo sobre la página abierta. Edita de verdad.
 * Los dos hilos quedan SIEMPRE montados (el inactivo se oculta con `hidden`, no
 * se desmonta): así un turno largo del editor sigue corriendo — y aplica sus
 * ediciones al terminar — aunque te vayas a la pestaña del reader, y ninguna de
 * las dos conversaciones se pierde al cambiar de tab.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sparkles, Send, X, Square, BookOpen, PenLine } from 'lucide-react';
import { createLogger, type ImageEdit, type SegmentEdit } from '@aldus/core';
import type { AgentMode, AgentRole, AldusApi } from '../core/index.js';
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

/** Qué páginas puede tocar el editor. `custom` = las que el usuario escribió. */
type Scope = 'page' | 'all' | 'custom';

/** "1, 3, 5-7" → [1,3,5,6,7]. Acotado a [1..max], sin duplicados, ordenado.
 *  Lo que no parsea se IGNORA en silencio: el usuario está tipeando, y la lista
 *  resuelta se le muestra al lado — no hace falta gritarle a media palabra. */
function parsePages(spec: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let i = a!; i <= b!; i++) out.add(i);
    } else if (/^\s*\d+\s*$/.test(part)) {
      out.add(Number(part));
    }
  }
  return [...out].filter(n => n >= 1 && n <= max).sort((a, b) => a - b);
}

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
  /** Página que el usuario está viendo — el scope POR DEFECTO del editor. */
  page: number;
  /** Total de páginas: habilita elegir "todas" o un rango en el tab de Edición. */
  numPages: number;
  edits: ReadonlyMap<string, SegmentEdit>;
  imageEdits: ReadonlyMap<string, ImageEdit>;
  onApply: (edits: SegmentEdit[], imageEdits: ImageEdit[]) => void;
  /** El agente horneó+persistió cambios (annotations/creaciones) → recargar el
   *  documento desde el server (descarta el estado local, ya horneado). */
  onReload: () => void;
  onClose: () => void;
  /** Nombre del agente en el header — el HOST le pone el suyo ("Wax AI" en
   *  signwax). Default: CASPER, la marca del editor standalone. */
  agentBrand?: ReactNode;
}

/** Qué le ofrece cada pestaña al usuario. La copia importa: el reader NO puede
 *  editar más allá de rellenar campos, y prometer otra cosa lleva a pedirle algo
 *  que va a rebotar. */
const MODES: Record<AgentMode, {
  label: string;
  icon: typeof BookOpen;
  hint: string;
  intro: string;
  placeholder: string;
  suggestions: string[];
}> = {
  reader: {
    label: 'Lectura',
    icon: BookOpen,
    hint: 'preguntá sobre el documento',
    intro:
      'Tengo el documento entero cargado. Preguntame sobre su contenido, o pedime que ' +
      'complete los campos del formulario. Para cambiar el documento (texto, imágenes, ' +
      'campos nuevos) usá la pestaña Edición.',
    placeholder: 'Preguntá algo sobre el documento…',
    suggestions: [
      'Resumí de qué trata el documento',
      '¿Qué campos hay para completar?',
      'Completá los campos con datos de ejemplo',
    ],
  },
  editor: {
    label: 'Edición',
    icon: PenLine,
    hint: 'pedí cambios en esta página',
    intro:
      'Edito la página que estás viendo. Pedime cambios concretos: editar o mover texto, ' +
      'convertir los puntitos y guiones bajos en campos rellenables, resaltar, insertar ' +
      'imágenes. Los cambios aparecen en el editor para revisar y guardar.',
    placeholder: 'Qué querés cambiar en esta página…',
    suggestions: [
      'Poné el título en mayúsculas',
      'Convertí los placeholders en campos rellenables',
      'Corregí las faltas de ortografía del título',
    ],
  },
};

export function AgentPanel({ api, docId, page, numPages, edits, imageEdits, onApply, onReload, onClose, agentBrand }: Props) {
  const [mode, setMode] = useState<AgentMode>('reader');

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-neutral-200 bg-white">
      <style>{MD_STYLES}
        {`@keyframes casper-dots{0%,20%{content:''}40%{content:'.'}60%{content:'..'}80%,100%{content:'...'}}
          .casper-dots::after{content:'';animation:casper-dots 1.4s steps(1,end) infinite}`}
      </style>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-3">
        <Sparkles size={16} className="text-blue-600" />
        <span className="text-[13px] font-semibold tracking-wide text-neutral-900">{agentBrand ?? 'CASPER'}</span>
        <span className="text-[11px] text-neutral-400">· {MODES[mode].hint}</span>
        <div className="flex-1" />
        <button onClick={onClose} title="Cerrar" className="grid h-7 w-7 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100">
          <X size={15} />
        </button>
      </header>

      {/* Las dos pestañas = los dos agentes. Cada una su propia conversación. */}
      <div className="flex shrink-0 border-b border-neutral-200 px-2 pt-1.5">
        {(Object.keys(MODES) as AgentMode[]).map(m => {
          const { label, icon: Icon } = MODES[m];
          const active = m === mode;
          return (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cx(
                'flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12px] font-medium transition-colors',
                active
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800',
              )}
            >
              <Icon size={13} /> {label}
            </button>
          );
        })}
      </div>

      {(Object.keys(MODES) as AgentMode[]).map(m => (
        <AgentThread
          key={m}
          mode={m}
          active={m === mode}
          api={api} docId={docId} page={page} numPages={numPages}
          edits={edits} imageEdits={imageEdits}
          onApply={onApply} onReload={onReload}
        />
      ))}
    </aside>
  );
}

type ThreadProps = Omit<Props, 'onClose'> & { mode: AgentMode; active: boolean };

/** UNA conversación con UN agente. Se monta una por modo y solo se oculta la
 *  inactiva — nunca se desmonta, así el turno en vuelo sobrevive al cambio de
 *  pestaña (y aplica sus ediciones al terminar). */
function AgentThread({ mode, active, api, docId, page, numPages, edits, imageEdits, onApply, onReload }: ThreadProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // SCOPE del editor. Default 'page': lo que estás mirando es lo que se edita,
  // y una edición no se dispara nunca sobre páginas que no tenías a la vista.
  const [scope, setScope] = useState<Scope>('page');
  const [spec, setSpec] = useState('');
  // Con varias páginas, un editor POR PÁGINA en paralelo mantiene chico el
  // prompt de cada uno (y es mucho más rápido). Se apaga para una edición que
  // CRUZA páginas, donde un editor tiene que ver ambos extremos.
  const [parallel, setParallel] = useState(true);
  const [nowTick, setNowTick] = useState(0); // re-render mientras esperamos, para el aviso de 5s
  const sessionId = useRef<string | undefined>(undefined);
  const turns = useRef(0); // cuántos turnos van (para saber si es el primero)
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Corta el turno en curso: abortar el fetch cierra la respuesta y el server
   *  cancela de verdad (routes/agent.ts). Un modelo que entra en loop se para
   *  desde acá — antes había que esperar a que se agotara el presupuesto. */
  const abort = useRef<AbortController | null>(null);
  const copy = MODES[mode];

  /** Las páginas que va a recibir el editor, ya resueltas. */
  const targetPages = useMemo(() => {
    if (mode !== 'editor') return [];
    if (scope === 'all') return Array.from({ length: numPages }, (_, i) => i + 1);
    if (scope === 'custom') return parsePages(spec, numPages);
    return [page];
  }, [mode, scope, spec, page, numPages]);
  // Un rango escrito que no resuelve a nada = no hay dónde editar: mejor
  // bloquear el envío que mandar un turno que el server interpreta como "todas".
  const badScope = mode === 'editor' && targetPages.length === 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Mientras hay un turno en curso, tickeamos para que aparezca el aviso a los 5s.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNowTick(t => t + 1), 500);
    return () => clearInterval(id);
  }, [busy]);

  // Esc CORTA el turno — el reflejo de cualquiera cuando el modelo se va de tema.
  // Solo la pestaña VISIBLE escucha: si no, un Esc mataría el turno del hilo
  // oculto sin que el usuario entienda por qué.
  useEffect(() => {
    if (!busy || !active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') abort.current?.abort(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, active]);

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || busy || badScope) return;
    const firstTurn = turns.current === 0;
    turns.current++;
    setMessages(m => [...m, { role: 'user', text: prompt }, { role: 'assistant', parts: [], streaming: true, startedAt: Date.now(), firstTurn }]);
    setInput('');
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const patchLast = (fn: (msg: Msg) => Msg) =>
      setMessages(m => { const c = [...m]; c[c.length - 1] = fn(c[c.length - 1]!); return c; });
    try {
      const res = await api.agentStream(docId, prompt, {
        edits: [...edits.values()],
        imageEdits: [...imageEdits.values()],
        resume: sessionId.current,
        mode,
        // El reader siempre ve el documento entero: el scope es cosa del editor.
        pages: mode === 'editor' ? targetPages : undefined,
        parallel: mode === 'editor' && targetPages.length > 1 && parallel,
        signal: ctrl.signal,
        onEvent: ev => {
          const agent: AgentRole = ev.agent ?? 'chat';
          if (ev.type === 'text') patchLast(msg => ({ ...msg, parts: appendText(msg.parts ?? [], ev.delta, agent) }));
          else if (ev.type === 'tool') {
            log('tool [%s/%s]: %s', mode, agent, ev.name);
            patchLast(msg => ({ ...msg, parts: [...(msg.parts ?? []), { kind: 'tool', name: ev.name, agent }] }));
          }
        },
      });
      sessionId.current = res.sessionId ?? sessionId.current;
      log('done [%s]: toolCalls=%d edits=%d reloaded=%s', mode, res.toolCalls, res.edits.length + res.imageEdits.length, !!res.reloaded);
      if (res.reloaded) onReload(); else onApply(res.edits, res.imageEdits);
      patchLast(msg => ({
        ...msg, streaming: false,
        parts: (msg.parts && msg.parts.length) ? msg.parts : [{ kind: 'text', text: '(listo)', agent: 'chat' }],
        // reloaded = ya horneado+guardado (no hay nada que "revisar y guardar").
        edits: res.reloaded ? 0 : res.edits.length + res.imageEdits.length,
        saved: res.reloaded,
      }));
    } catch (e) {
      // Cortado por el usuario: no es un fallo. Las ediciones que el turno ya
      // aplicó quedan pendientes en la sesión del server; el mensaje lo dice.
      if (ctrl.signal.aborted) {
        log('turno DETENIDO por el usuario [%s]', mode);
        patchLast(msg => ({ ...msg, streaming: false, parts: [...(msg.parts ?? []), { kind: 'text', text: '⏹ Detenido. Lo que ya se había aplicado sigue pendiente — revisá y guardá, o pedime que lo deshaga.', agent: 'chat' }] }));
      } else {
        const err = e instanceof Error ? e.message : 'Falló el agente.';
        log('error [%s]: %s', mode, err);
        patchLast(msg => ({ ...msg, streaming: false, error: true, parts: [...(msg.parts ?? []), { kind: 'text', text: `⚠️ ${err}`, agent: 'chat' }] }));
      }
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }

  return (
    <div className={cx('flex min-h-0 flex-1 flex-col', !active && 'hidden')}>
      <div ref={scrollRef} className="thin-scroll flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="mt-2 space-y-2">
            <p className="text-[12px] leading-relaxed text-neutral-500">{copy.intro}</p>
            <div className="flex flex-col gap-1.5 pt-1">
              {copy.suggestions.map(s => (
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
              {/* CRONOLÓGICO por bloques. En la pestaña de EDICIÓN todo el turno ES
                  el editor: anidarlo en su cajita sería una caja dentro de sí misma.
                  El bloque anidado queda para un host que sí rutee reader→editor. */}
              {blocks.map((b, bi) => {
                const streamingBlock = !!m.streaming && bi === blocks.length - 1;
                if (b.agent === 'editor' && mode !== 'editor') {
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
        {/* SCOPE explícito: qué páginas puede tocar el editor. Sin esto el
            editor trabajaba siempre sobre la página abierta y no había forma de
            pedir "convertí los placeholders de TODO el documento". */}
        {mode === 'editor' && (
          <div className="flex flex-col gap-1 px-0.5 pb-1.5">
            <div className="flex items-center gap-1">
              <span className="text-[10.5px] text-neutral-400">Editar en:</span>
              {([
                ['page', `esta (${page})`],
                ['all', `todas (${numPages})`],
                ['custom', 'elegir'],
              ] as Array<[Scope, string]>).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setScope(k)}
                  className={cx(
                    'rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
                    scope === k ? 'bg-blue-100 text-blue-700' : 'text-neutral-500 hover:bg-neutral-100',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {scope === 'custom' && (
              <input
                value={spec}
                onChange={e => setSpec(e.target.value)}
                placeholder="1, 3, 5-7"
                className={cx(
                  'w-full rounded border px-1.5 py-0.5 text-[11px] outline-none',
                  badScope ? 'border-red-300 focus:border-red-500' : 'border-neutral-200 focus:border-blue-500',
                )}
              />
            )}

            {badScope ? (
              <span className="text-[10.5px] text-red-500">
                Escribí al menos una página entre 1 y {numPages}.
              </span>
            ) : targetPages.length > 1 ? (
              <label
                className="flex cursor-pointer items-center gap-1 text-[10.5px] text-neutral-500"
                title="Cada página se edita por separado y en paralelo: mucho más rápido, y cada editor ve un prompt más chico. Desactivalo si el cambio CRUZA páginas (por ejemplo reemplazar una sección que empieza en una y termina en otra), porque ahí un solo editor tiene que ver los dos extremos."
              >
                <input
                  type="checkbox"
                  checked={parallel}
                  onChange={e => setParallel(e.target.checked)}
                  className="h-3 w-3 accent-blue-600"
                />
                una por una, en paralelo ({targetPages.length} pág.)
              </label>
            ) : null}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            placeholder={copy.placeholder}
            rows={2}
            disabled={busy}
            className="thin-scroll min-h-[38px] flex-1 resize-none rounded-lg border border-neutral-200 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-blue-500 disabled:bg-neutral-50"
          />
          {/* Mientras corre, el MISMO botón corta el turno: abortar el fetch
              cierra la respuesta y el server cancela de verdad. */}
          {busy ? (
            <button
              onClick={() => abort.current?.abort()}
              title="Detener el turno (Esc)"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-red-600 text-white hover:bg-red-700"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => void send(input)}
              disabled={!input.trim() || badScope}
              title={badScope ? 'Elegí al menos una página válida' : 'Enviar (Enter)'}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-200 disabled:text-neutral-400"
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
