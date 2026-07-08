/**
 * openrouter.ts — el MISMO agente, pero contra un endpoint OpenAI-compatible
 * (OpenRouter directo, o el llm-proxy del .dev que esconde la key real). Reusa
 * los system prompts (agent.ts), las tools (tools.ts) y la EditSession — solo
 * cambia el transporte. Para el demo público: la suscripción de Claude Code no
 * se puede exponer en un server, OpenRouter sí (con budget en el proxy).
 *
 * DOS NIVELES (misma arquitectura que el path suscripción):
 *   FASE 1 — CHAT (config.openrouter.chatModel, barato): responde preguntas y
 *   describe contenido leyendo el grafo de la página actual; ante cualquier
 *   modificación llama edit_document({pages, request}).
 *   FASE 2 — EDITOR (config.openrouter.model, fuerte): corre el loop clásico de
 *   function-calling con los grafos de ESAS páginas y las tools reales.
 */
import { config } from './config.js';
import { chatSystemPrompt, systemPrompt, type AgentEvent, type TurnOpts, type TurnResult } from './agent.js';
import { openaiRouterTool, openaiTools, runTool, type RouteRequest } from './tools.js';
import { overlapReport, verifyMessage } from './verify.js';

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
type OpenAITool = ReturnType<typeof openaiRouterTool>;

/** Una llamada streameada a chat/completions: acumula texto (emitido en vivo) y
 *  las tool_calls (que llegan en deltas por índice). */
async function streamCompletion(
  model: string,
  messages: Msg[],
  tools: OpenAITool[],
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
      model,
      messages,
      tools,
      tool_choice: 'auto',
      stream: true,
      // Sesgo a proveedores de alta throughput — OpenRouter a veces rutea sonnet
      // a un backend encolado (primera llamada de minutos); esto lo evita.
      provider: { sort: 'throughput' },
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
      let json: { error?: { message?: string }; choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
      try { json = JSON.parse(data); } catch { continue; }
      // OpenRouter puede mandar el error DENTRO del stream — silenciarlo deja
      // una respuesta vacía imposible de diagnosticar.
      if (json.error) throw new Error(`OpenRouter (stream): ${json.error.message || JSON.stringify(json.error)}`);
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

  // ── FASE 1 — CHAT (barato): responde directo, o delega con edit_document.
  const chatMsgs: Msg[] = [
    { role: 'system', content: chatSystemPrompt(opts.doc, opts.page) },
    { role: 'user', content: opts.prompt },
  ];
  const r1 = await streamCompletion(config.openrouter.chatModel, chatMsgs, [openaiRouterTool()], opts.onEvent);
  const routeCall = r1.toolCalls.find(c => c.function.name === 'edit_document');
  if (!routeCall) return { text: r1.content, toolCalls: 0 };

  opts.onEvent?.({ type: 'tool', name: 'mcp__aldus__edit_document' });
  let route: RouteRequest = { pages: [], request: opts.prompt };
  try {
    const args = JSON.parse(routeCall.function.arguments || '{}') as Partial<RouteRequest>;
    route = {
      pages: Array.isArray(args.pages) ? args.pages.filter(n => Number.isFinite(n)) : [],
      request: typeof args.request === 'string' && args.request ? args.request : opts.prompt,
    };
  } catch { /* args rotos → defaults */ }
  const pages = route.pages.length ? route.pages : (opts.page != null ? [opts.page] : undefined);

  // ── FASE 2 — EDITOR (fuerte): loop de function-calling con las tools reales,
  // scopeado a las páginas que pidió el chat.
  const messages: Msg[] = [
    { role: 'system', content: systemPrompt(opts.doc, pages) },
    { role: 'user', content: `${opts.prompt}\n\n[Plan del asistente]: ${route.request}` },
  ];
  let text = r1.content;
  let toolCalls = 0;
  let verifies = 0;

  for (let turn = 0; turn < config.maxTurns; turn++) {
    const { content, toolCalls: calls } = await streamCompletion(config.openrouter.model, messages, openaiTools(), opts.onEvent);
    text += content;

    if (!calls.length) {
      // El modelo dio por terminado → VERIFICACIÓN GEOMÉTRICA determinística
      // (hornea en memoria y mide): si algún campo pisa texto u otro campo, el
      // reporte (con el move EXACTO ya calculado) vuelve al MISMO turno para que
      // corrija. Hasta 3 pasadas (los solapamientos pueden cascadear).
      if (toolCalls > 0 && verifies < 3) {
        verifies++;
        const issues = await overlapReport(opts.session).catch(() => []);
        if (issues.length) {
          opts.onEvent?.({ type: 'tool', name: 'mcp__aldus__verify_layout' });
          messages.push({ role: 'assistant', content: content || null });
          messages.push({ role: 'user', content: verifyMessage(issues) });
          continue;
        }
      }
      break; // sin tools y sin (más) solapamientos → listo
    }

    messages.push({ role: 'assistant', content: content || null, tool_calls: calls });
    for (const tc of calls) {
      toolCalls++;
      opts.onEvent?.({ type: 'tool', name: `mcp__aldus__${tc.function.name}` });
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* args vacíos */ }
      const result = await runTool(opts.session, tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  return { text, toolCalls };
}
