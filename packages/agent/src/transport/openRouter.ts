/**
 * transport/openRouter.ts — `ILlmTransport` sobre un endpoint OpenAI-compatible
 * (OpenRouter directo, o el llm-proxy del .dev que esconde la key). La suscripción
 * de Claude Code no se puede exponer en un server; OpenRouter sí, y además deja
 * probar modelos alternativos. `streamCompletion` es el transporte puro de v1
 * (SSE hand-rolled: acumula texto + tool_calls por índice, error-in-stream,
 * provider sort) — acá adentro de la clase; el loop de function-calling respeta
 * `req.loop` (fase CHAT = un intercambio; fase EDITOR = loop hasta sin tools).
 */
import type { CancellationToken } from '@aldus/core';
import type { IAgentOpenRouterConfig } from '../config.js';
import type { AgentEvent, AgentRole, ILlmTransport, PassRequest, PassResult } from './transport.js';

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
type OpenAITool = { type: 'function'; function: { name: string; description: string; parameters: unknown } };

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
          messages,
          tools,
          tool_choice: 'auto',
          stream: true,
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
          let json: { error?: { message?: string }; choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
          try { json = JSON.parse(data); } catch { continue; }
          // OpenRouter puede mandar el error DENTRO del stream — silenciarlo deja
          // una respuesta vacía imposible de diagnosticar.
          if (json.error) throw new Error(`OpenRouter (stream): ${json.error.message || JSON.stringify(json.error)}`);
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
    // conversación); si no, se arranca fresco [system, user].
    const messages: Msg[] = Array.isArray(req.resume)
      ? [...(req.resume as Msg[]), { role: 'user', content: req.prompt }]
      : [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }];
    const tools: OpenAITool[] = req.tools.map(t => ({
      type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    let text = '';
    const toolsUsed: string[] = [];
    let toolCalls = 0;
    const maxTurns = req.loop ? req.maxTurns : 1;

    for (let turn = 0; turn < maxTurns; turn++) {
      const { content, toolCalls: calls } = await this.streamCompletion(req.model, messages, tools, req.role, req.onEvent, ct);
      text += content;
      if (!calls.length) break; // el modelo terminó (sin tools) → fin de la pasada

      messages.push({ role: 'assistant', content: content || null, tool_calls: calls });
      for (const tc of calls) {
        toolCalls++;
        toolsUsed.push(tc.function.name);
        req.onEvent?.({ type: 'tool', name: `mcp__aldus__${tc.function.name}`, agent: req.role });
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>; } catch { /* args vacíos */ }
        const result = await req.onToolCall(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      // Fase CHAT (loop=false): un solo intercambio — el modelo delegó y para
      // (v1 no re-consultaba al chat tras edit_document).
      if (!req.loop) break;
    }
    return { text, toolsUsed, toolCalls, resume: messages };
  }
}
