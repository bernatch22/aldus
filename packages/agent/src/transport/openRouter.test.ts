/**
 * openRouter.test.ts — el BODY que sale al endpoint. Estos campos son el
 * contrato con OpenRouter: un `tool_choice` mal armado convierte una extracción
 * estructurada en prosa (y el parseo aguas abajo se queda sin nada), y un
 * `max_tokens` de más infla la reserva de crédito que el endpoint hace por
 * request. Se mockea `fetch` y se inspecciona lo que se manda.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeverCancelled } from '@aldus/core';
import { OpenRouterTransport } from './openRouter.js';
import type { PassRequest } from './transport.js';

/** Un body SSE de OpenRouter: los deltas pedidos y el `[DONE]`. */
function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

const textReply = (t: string) => [{ choices: [{ delta: { content: t } }] }];
const toolReply = (name: string, args = '{}') => [{
  choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: args } }] } }],
}];

/** Captura los bodies de cada request y responde con el guion dado. */
function mockFetch(script: unknown[][]): { bodies: () => Array<Record<string, any>> } {
  let n = 0;
  const sent: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(String(init.body));
    return new Response(sse(script[Math.min(n++, script.length - 1)]!), { status: 200 });
  }));
  return { bodies: () => sent.map(b => JSON.parse(b)) };
}

const transport = new OpenRouterTransport({ key: 'test-key', baseUrl: 'https://openrouter.test/api/v1' });

const TOOL = { name: 'extract', description: 'x', parameters: { type: 'object', properties: {} } };
const base = (over: Partial<PassRequest> = {}): PassRequest => ({
  model: 'anthropic/claude-sonnet-5',
  system: 'sys', prompt: 'p', role: 'reader',
  tools: [], maxTurns: 4, loop: false,
  onToolCall: async () => '✓',
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouterTransport — el body del request', () => {
  it('sin toolChoice: tool_choice queda en "auto" y max_tokens en el default 8192', async () => {
    const cap = mockFetch([textReply('hola')]);
    await transport.chat(base({ tools: [TOOL] }), NeverCancelled);

    const body = cap.bodies()[0]!;
    expect(body.tool_choice).toBe('auto');
    expect(body.max_tokens).toBe(8192);
  });

  it('con toolChoice: fuerza ESA tool (si no, el modelo contesta prosa y no hay objeto que parsear)', async () => {
    const cap = mockFetch([toolReply('extract', '{"a":1}')]);
    await transport.chat(base({ tools: [TOOL], toolChoice: 'extract' }), NeverCancelled);

    expect(cap.bodies()[0]!.tool_choice).toEqual({ type: 'function', function: { name: 'extract' } });
  });

  it('maxOutputTokens sube el tope (generación larga: un contrato entero)', async () => {
    const cap = mockFetch([textReply('...')]);
    await transport.chat(base({ maxOutputTokens: 16384 }), NeverCancelled);

    expect(cap.bodies()[0]!.max_tokens).toBe(16384);
  });

  it('SIN tools no se manda tool_choice forzado — el endpoint rechaza lo que no puede satisfacer', async () => {
    const cap = mockFetch([textReply('ok')]);
    await transport.chat(base({ tools: [], toolChoice: 'extract' }), NeverCancelled);

    expect(cap.bodies()[0]!.tool_choice).toBe('auto');
  });

  it('la tool forzada va SOLO en la primera pasada (si no, el modelo la repite hasta agotar turnos)', async () => {
    // Pasada 1: llama la tool. Pasada 2: contesta texto y cierra.
    const cap = mockFetch([toolReply('extract'), textReply('listo')]);
    await transport.chat(base({ tools: [TOOL], toolChoice: 'extract', loop: true, maxTurns: 4 }), NeverCancelled);

    const bodies = cap.bodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.tool_choice).toEqual({ type: 'function', function: { name: 'extract' } });
    expect(bodies[1]!.tool_choice).toBe('auto');
  });

  it('el resultado trae el input de la tool por onToolCall (el camino de la extracción estructurada)', async () => {
    mockFetch([toolReply('extract', '{"title":"NDA","parties":2}')]);
    let captured: Record<string, unknown> | undefined;
    const res = await transport.chat(base({
      tools: [TOOL], toolChoice: 'extract',
      onToolCall: async (_name, args) => { captured = args; return '✓'; },
    }), NeverCancelled);

    expect(captured).toEqual({ title: 'NDA', parties: 2 });
    expect(res.toolsUsed).toEqual(['extract']);
    expect(res.toolCalls).toBe(1);
  });
});
