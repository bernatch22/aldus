/**
 * transport/claudeSdk.ts — `ILlmTransport` sobre el Claude Agent SDK (auth por
 * SUSCRIPCIÓN de Claude Code, SIN ANTHROPIC_API_KEY). Una pasada = un `query()`
 * que corre el loop agéntico entero adentro (el SDK ejecuta las tools vía el
 * server MCP + el gate `canUseTool`). Transplante de la mecánica de v1 agent.ts:
 * parsing de `stream_event` (deltas de texto + comienzo de tool_use), gate que
 * auto-aprueba SOLO las tools de Aldus, `resume` = session_id.
 */
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CancellationToken } from '@aldus/core';
import type { ILlmTransport, PassRequest, PassResult, PassTool } from './transport.js';

/** Shape zod permisivo para una tool del HOST (que trae JSON Schema, no zod):
 *  una clave `z.unknown()` por propiedad top-level — MCP pasa los args tal cual
 *  y el `run` del host los interpreta (la validación fina la hace runTool). */
function hostShape(t: PassTool): z.ZodRawShape {
  if (t.shape) return t.shape;
  const props = (t.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  const shape: Record<string, unknown> = {};
  for (const key of Object.keys(props)) shape[key] = z.unknown();
  return shape as z.ZodRawShape;
}

export class ClaudeSdkTransport implements ILlmTransport {
  async chat(req: PassRequest, ct: CancellationToken): Promise<PassResult> {
    const ok = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    const tools = req.tools.map(t =>
      tool(t.name, t.description, hostShape(t), async (args: Record<string, unknown>) => ok(await req.onToolCall(t.name, args))),
    );
    const server = createSdkMcpServer({ name: 'aldus', version: '0.0.1', tools });

    const abort = new AbortController();
    const sub = ct.onCancellationRequested(() => abort.abort());

    let text = '';
    const toolsUsed: string[] = [];
    let toolCalls = 0;
    let sessionId: string | undefined;
    try {
      for await (const message of query({
        prompt: req.prompt,
        options: {
          model: req.model,
          systemPrompt: req.system,
          mcpServers: { aldus: server },
          // Deltas token a token → el panel muestra la respuesta escribiéndose y
          // las tools ejecutándose, en vez de quedarse mudo 20-40s en "Pensando".
          includePartialMessages: true,
          // En headless no hay prompt de permisos interactivo: `canUseTool` es el
          // ÚNICO gate — auto-aprueba las tools de Aldus y niega cualquier otra
          // (sin `allowedTools`, que las auto-aprobaría antes y shadowearía esto).
          canUseTool: async (name, input) =>
            name.startsWith('mcp__aldus__')
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: 'Aldus solo permite sus propias tools de edición.' },
          maxTurns: req.maxTurns,
          abortController: abort,
          ...(typeof req.resume === 'string' ? { resume: req.resume } : {}),
        },
      })) {
        if (message.type === 'stream_event') {
          // Evento raw de Anthropic: deltas de texto y comienzo de tool_use.
          const ev = message.event as { type: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; name?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            text += ev.delta.text;
            req.onEvent?.({ type: 'text', delta: ev.delta.text, agent: req.role });
          } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            const name = ev.content_block.name ?? 'tool';
            // Solo las tools de Aldus cuentan/se muestran; las internas del SDK
            // (p. ej. ToolSearch, que canUseTool deniega) no son ruido para el UI.
            if (name.startsWith('mcp__aldus__')) {
              // El prefijo MCP es un detalle del SDK: NO cruza al wire. Afuera
              // (eventos, toolsUsed) la tool se llama como la bindeó su IAgentTool.
              const bare = name.replace('mcp__aldus__', '');
              toolCalls++;
              toolsUsed.push(bare);
              req.onEvent?.({ type: 'tool', name: bare, agent: req.role });
            }
          }
        } else if (message.type === 'result') {
          sessionId = message.session_id;
        }
      }
    } finally {
      sub.dispose();
    }
    return { text, toolsUsed, toolCalls, resume: sessionId };
  }
}
