/**
 * transport/openRouter.ts — `ILlmTransport` sobre un endpoint OpenAI-compatible
 * (OpenRouter directo, o el llm-proxy del .dev que esconde la key). La suscripción
 * de Claude Code no se puede exponer en un server; OpenRouter sí, y además deja
 * probar modelos alternativos. `streamCompletion` es el transporte puro de v1
 * (SSE hand-rolled: acumula texto + tool_calls por índice, error-in-stream,
 * provider sort) — acá adentro de la clase; el loop de function-calling respeta
 * `req.loop` (fase CHAT = un intercambio; fase EDITOR = loop hasta sin tools).
 */
import { createLogger, type CancellationToken } from '@aldus/core';
import type { IAgentOpenRouterConfig } from '../config.js';
import type { AgentEvent, AgentRole, ILlmTransport, PassRequest, PassResult } from './transport.js';

const log = createLogger('aldus:transport:openrouter');

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
type OpenAITool = { type: 'function'; function: { name: string; description: string; parameters: unknown } };

/** PROMPT CACHING (modelos anthropic/*): el system — el grafo de la página, el
 *  grueso del contexto — es IDÉNTICO en cada pasada del loop de function-calling
 *  (N tool calls = N requests que lo re-mandan entero). Con `cache_control` las
 *  relecturas cuestan el 10%: medido, un turno de 25 tool calls pasaba de
 *  ~200k tokens de input a precio lleno a ~8k llenos + el resto cacheado.
 *  Los demás vendors de OpenRouter cachean solos (Gemini) o lo ignoran. */
/** Modelos que RECHAZAN `reasoning: {enabled:false}` ("Reasoning is mandatory
 *  for this endpoint"). Se APRENDE del 400 en la primera llamada y no se vuelve
 *  a mandar la flag para ese modelo: sin esto, apagar el reasoning (una
 *  optimización de costo) rompía el turno entero contra esos endpoints
 *  (producción: el reader gemini-3.5-flash del demo, HTTP 400 en cada request). */
const REASONING_MANDATORY = new Set<string>();

function withSystemCache(messages: Msg[], model: string): Msg[] {
  if (!model.startsWith('anthropic/')) return messages;
  return messages.map(m =>
    m.role === 'system' && typeof m.content === 'string'
      ? { ...m, content: [{ type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }] }
      : m);
}

export class OpenRouterTransport implements ILlmTransport {
  constructor(private readonly cfg: Pick<IAgentOpenRouterConfig, 'key' | 'baseUrl'>) {}

  /** Una llamada streameada a chat/completions: acumula texto (emitido en vivo,
   *  etiquetado con `agent`) y las tool_calls (que llegan en deltas por índice). */
  private async streamCompletion(
    model: string,
    messages: Msg[],
    tools: OpenAITool[],
    agent: AgentRole,
    onEvent: ((ev: AgentEvent) => void) | undefined,
    ct: CancellationToken,
    /** Knobs por-request de {@link PassRequest} (tool forzada / tope de salida).
     *  Van en un objeto: la firma ya tenía seis posicionales. */
    opts: { toolChoice?: string; maxOutputTokens?: number } = {},
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const abort = new AbortController();
    const sub = ct.onCancellationRequested(() => abort.abort());
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: abort.signal,
        headers: {
          authorization: `Bearer ${this.cfg.key}`,
          'content-type': 'application/json',
          'http-referer': 'https://bernardocastro.dev',
          'x-title': 'Aldus PDF Agent',
        },
        body: JSON.stringify({
          model,
          messages: withSystemCache(messages, model),
          tools,
          // Tool FORZADA cuando el llamador la pide (extracción estructurada:
          // quiere el objeto, no prosa). Sin tools no se manda nunca — el
          // endpoint rechaza un tool_choice que no puede satisfacer.
          tool_choice: tools.length && opts.toolChoice
            ? { type: 'function', function: { name: opts.toolChoice } }
            : 'auto',
          stream: true,
          // Contabilidad REAL: el último chunk del stream trae usage con el
          // COSTO en USD de este request — se loguea (gateado) para que "cuánto
          // gasta" sea un número medido, no una estimación.
          usage: { include: true },
          // SIN reasoning: OpenRouter le enciende extended thinking a los modelos
          // que lo traen (Sonnet pensaba 5-8k tokens POR tool call a $15/M — el
          // 66% del costo de un turno medido). En este agente el LLM solo DETECTA
          // y nombra; el layout es del código determinístico — no hay nada que
          // amerite thinking. Se OMITE en los endpoints que lo exigen (aprendido
          // del 400; ver REASONING_MANDATORY) — la optimización nunca puede
          // costar el turno.
          ...(REASONING_MANDATORY.has(model) ? {} : { reasoning: { enabled: false } }),
          // Cap explícito: sin esto OpenRouter RESERVA el máximo de output del
          // modelo (Sonnet = 64k) para el chequeo de crédito y devuelve 402 aunque
          // el turno emita 200 tokens. Un turno (tool calls + reporte corto) nunca
          // se acerca a 8k — y el chequeo de crédito pasa holgado. El llamador lo
          // sube solo para generación larga (un contrato entero).
          max_tokens: opts.maxOutputTokens ?? 8192,
          // Sesgo a proveedores de alta throughput — OpenRouter a veces rutea a
          // un backend encolado (primera llamada de minutos); esto lo evita.
          provider: { sort: 'throughput' },
        }),
      });
    } catch (err) {
      sub.dispose();
      throw err;
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      sub.dispose();
      // El endpoint EXIGE reasoning: se aprende y se reintenta SIN la flag (una
      // sola vez — el Set ya quedó marcado, la recursión no puede ciclar).
      if (res.status === 400 && /reasoning is mandatory/i.test(body) && !REASONING_MANDATORY.has(model)) {
        REASONING_MANDATORY.add(model);
        log(`${model} exige reasoning → reintento sin la flag (y no la vuelvo a mandar para este modelo)`);
        return this.streamCompletion(model, messages, tools, agent, onEvent, ct, opts);
      }
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
    }

    let content = '';
    const calls: ToolCall[] = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let json: { error?: { message?: string }; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } }; choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
          try { json = JSON.parse(data); } catch { continue; }
          // OpenRouter puede mandar el error DENTRO del stream — silenciarlo deja
          // una respuesta vacía imposible de diagnosticar.
          if (json.error) throw new Error(`OpenRouter (stream): ${json.error.message || JSON.stringify(json.error)}`);
          if (json.usage?.cost !== undefined) {
            const u = json.usage;
            log(`usage: ${u.prompt_tokens ?? 0} in (${u.prompt_tokens_details?.cached_tokens ?? 0} cacheados) + ${u.completion_tokens ?? 0} out = $${u.cost!.toFixed(4)}`);
          }
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) { content += delta.content; onEvent?.({ type: 'text', delta: delta.content, agent }); }
          for (const tc of delta.tool_calls ?? []) {
            const i = tc.index ?? 0;
            calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) calls[i]!.id = tc.id;
            if (tc.function?.name) calls[i]!.function.name += tc.function.name;
            if (tc.function?.arguments) calls[i]!.function.arguments += tc.function.arguments;
          }
        }
      }
    } finally {
      sub.dispose();
    }
    return { content, toolCalls: calls.filter(Boolean) };
  }

  async chat(req: PassRequest, ct: CancellationToken): Promise<PassResult> {
    if (!this.cfg.key) throw new Error('falta OPENROUTER_API_KEY (o un token de sesión del llm-proxy)');
    // `resume` = el array de mensajes acumulado de una pasada previa (misma
    // conversación); si no, se arranca fresco: system + HISTORIAL (memoria entre
    // requests) + prompt actual.
    const messages: Msg[] = Array.isArray(req.resume)
      ? [...(req.resume as Msg[]), { role: 'user', content: req.prompt }]
      : [
          { role: 'system', content: req.system },
          ...(req.history ?? []).map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: req.prompt },
        ];
    const tools: OpenAITool[] = req.tools.map(t => ({
      type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    let text = '';
    const toolsUsed: string[] = [];
    let toolCalls = 0;
    const maxTurns = req.loop ? req.maxTurns : 1;

    for (let turn = 0; turn < maxTurns; turn++) {
      const t0 = Date.now();
      const { content, toolCalls: calls } = await this.streamCompletion(
        req.model, messages, tools, req.role, req.onEvent, ct,
        // La tool forzada solo en la PRIMERA pasada: una vez que el modelo la
        // llamó, seguir forzándola lo haría llamarla en loop hasta agotar turnos.
        { toolChoice: turn === 0 ? req.toolChoice : undefined, maxOutputTokens: req.maxOutputTokens },
      );
      log(`pasada ${turn + 1}/${maxTurns} (${req.role}): ${Date.now() - t0}ms · ${content.length} chars · ${calls.length} tool_call/s`);
      text += content;
      if (!calls.length) break; // el modelo terminó (sin tools)

      messages.push({ role: 'assistant', content: content || null, tool_calls: calls });
      for (const tc of calls) {
        toolCalls++;
        toolsUsed.push(tc.function.name);
        req.onEvent?.({ type: 'tool', name: tc.function.name, agent: req.role });
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>; } catch { /* args vacíos */ }
        const result = await req.onToolCall(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      // Fase CHAT (loop=false): un solo intercambio — el modelo delegó y para
      // (v1 no re-consultaba al chat tras edit_document).
      if (!req.loop) break;
    }
    // Un turno con loop NO puede terminar MUDO — pase lo que pase: presupuesto
    // agotado a mitad de tools, o el modelo devolvió una completion vacía (Gemini
    // lo hace tras varios tool-results). UNA pasada final SIN tools lo obliga a
    // responder con lo que juntó.
    if (req.loop && !text.trim()) {
      log(`turno terminó MUDO tras ${toolCalls} tool/s → pasada final forzada sin tools`);
      messages.push({ role: 'user', content: 'Respondé AHORA al pedido original con lo que ya averiguaste con las tools (si no encontraste algo, decilo). Solo texto — no llames más tools.' });
      const t0 = Date.now();
      // Sin tools: nada de tool_choice (el endpoint lo rechazaría).
      const { content } = await this.streamCompletion(
        req.model, messages, [], req.role, req.onEvent, ct,
        { maxOutputTokens: req.maxOutputTokens },
      );
      log(`pasada final: ${Date.now() - t0}ms · ${content.length} chars`);
      text += content;
    }
    return { text, toolsUsed, toolCalls, resume: messages };
  }
}
