/**
 * openrouter.ts — el MISMO agente, pero contra un endpoint OpenAI-compatible
 * (OpenRouter directo, o el llm-proxy del .dev que esconde la key real). Reusa
 * el system prompt (agent.ts), las tools (tools.ts) y la EditSession — solo
 * cambia el transporte. Para el demo público: la suscripción de Claude Code no
 * se puede exponer en un server, OpenRouter sí (con budget en el proxy).
 *
 * Loop clásico de function-calling: chat/completions con `tools` → si el modelo
 * pide tool_calls, se ejecutan contra la sesión y se re-inyectan como mensajes
 * `role:tool` → hasta que responde sin tools. Streaming SSE token a token.
 */
import { config } from './config.js';
import { systemPrompt, type AgentEvent, type TurnOpts, type TurnResult } from './agent.js';
import { openaiTools, runTool } from './tools.js';

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Una llamada streameada a chat/completions: acumula texto (emitido en vivo) y
 *  las tool_calls (que llegan en deltas por índice). */
async function streamCompletion(
  messages: Msg[],
  onEvent?: (ev: AgentEvent) => void,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.openrouter.key}`,
      'content-type': 'application/json',
      'http-referer': 'https://bernardocastro.dev',
      'x-title': 'Aldus PDF Agent',
    },
    body: JSON.stringify({
      model: config.openrouter.model,
      messages,
      tools: openaiTools(),
      tool_choice: 'auto',
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }

  let content = '';
  const calls: ToolCall[] = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
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
      let json: { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; onEvent?.({ type: 'text', delta: delta.content }); }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls: calls.filter(Boolean) };
}

export async function runTurnOpenRouter(opts: TurnOpts): Promise<TurnResult> {
  if (!config.openrouter.key) throw new Error('falta OPENROUTER_API_KEY (o un token de sesión del llm-proxy)');
  const messages: Msg[] = [
    { role: 'system', content: systemPrompt(opts.doc, opts.page) },
    { role: 'user', content: opts.prompt },
  ];
  let text = '';
  let toolCalls = 0;

  for (let turn = 0; turn < config.maxTurns; turn++) {
    const { content, toolCalls: calls } = await streamCompletion(messages, opts.onEvent);
    text += content;
    if (!calls.length) break; // el modelo respondió sin pedir tools → listo

    messages.push({ role: 'assistant', content: content || null, tool_calls: calls });
    for (const tc of calls) {
      toolCalls++;
      opts.onEvent?.({ type: 'tool', name: `mcp__aldus__${tc.function.name}` });
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* args vacíos */ }
      const result = runTool(opts.session, tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  return { text, toolCalls };
}
