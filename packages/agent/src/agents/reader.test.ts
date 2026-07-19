/**
 * reader.test.ts — el reader con el CONTENIDO INLINE (transporte fake, cero
 * gasto). Verifica:
 *   1. el system prompt lleva el documento COMPLETO en orden de lectura,
 *   2. una consulta no necesita (ni tiene) tools de lectura,
 *   3. las tools del HOST sí entran (dominio) y el guard anti-repetición corre.
 */
import { describe, expect, it } from 'vitest';
import { NeverCancelled } from '@aldus/core';
import { readTurn } from './reader.js';
import { loadAgentConfig } from '../config.js';
import type { DocGraph } from '../graph.js';
import type { EditSession } from '../session/EditSession.js';
import { IAgentTool } from '../tools/contract.js';
import { createAgentContainer } from '../ioc.js';
import { IToolRegistry } from '../tools/registry.js';
import type { ILlmTransport, PassRequest } from '../transport/transport.js';

/** Grafo mínimo: 2 páginas con contenido y un campo. */
const doc = {
  path: '/tmp/contrato.pdf',
  bytes: new Uint8Array(),
  pages: [
    {
      page: 1, width: 595, height: 842,
      segments: [{
        id: 'p1-s0', kind: 'segment', page: 1, text: 'CONTRATO DE DISTRIBUCIÓN',
        runs: [{ fontSize: 18, font: { bold: true, italic: false, bucket: 'sans', postScriptName: 'Helvetica-Bold' } }],
        x: 100, baseline: 700, width: 300, y: 695, height: 20,
      }, {
        id: 'p1-s1', kind: 'segment', page: 1, text: 'La cláusula de rescisión dice tal cosa.',
        runs: [{ fontSize: 10, font: { bold: false, italic: false, bucket: 'sans', postScriptName: 'Helvetica' } }],
        x: 100, baseline: 600, width: 300, y: 595, height: 12,
      }],
      widgets: [{ id: 'p1-w0', fieldName: 'razon_social' }], images: [], links: [], runs: [], lines: [], highlights: [], shapes: [],
    },
    {
      page: 2, width: 595, height: 842,
      segments: [{
        id: 'p2-s0', kind: 'segment', page: 2, text: 'Anexo de precios.',
        runs: [{ fontSize: 10, font: { bold: false, italic: false, bucket: 'sans', postScriptName: 'Helvetica' } }],
        x: 100, baseline: 700, width: 200, y: 695, height: 12,
      }],
      widgets: [], images: [], links: [], runs: [], lines: [], highlights: [], shapes: [],
    },
  ],
} as unknown as DocGraph;

const session = {} as EditSession;
const config = loadAgentConfig({ ALDUS_READER_MODEL: 'google/gemini-3.5-flash', OPENROUTER_API_KEY: 'x' } as NodeJS.ProcessEnv);

/** Transporte de guion: llama las tools que le digan y devuelve un texto fijo. */
function scripted(calls: string[], capture: (req: PassRequest) => void, finalText = 'ok'): ILlmTransport {
  return {
    async chat(req) {
      capture(req);
      const toolsUsed: string[] = [];
      const results: string[] = [];
      for (const name of calls) {
        req.onEvent?.({ type: 'tool', name, agent: 'reader' });
        results.push(String(await req.onToolCall(name, {})));
        toolsUsed.push(name);
      }
      return { text: results.length ? results.join('\n') : finalText, toolsUsed, toolCalls: calls.length };
    },
  };
}

describe('readTurn — contenido inline', () => {
  it('el system prompt lleva el documento COMPLETO, página por página, y los campos', async () => {
    const container = createAgentContainer({ config });
    let req!: PassRequest;
    await readTurn(
      { doc, session, prompt: '¿qué dice sobre la rescisión?', transport: scripted([], r => { req = r; }) },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(req.system).toContain('── Página 1 ──');
    expect(req.system).toContain('CONTRATO DE DISTRIBUCIÓN');
    expect(req.system).toContain('La cláusula de rescisión dice tal cosa.');  // el CONTENIDO está
    expect(req.system).toContain('── Página 2 ──');
    expect(req.system).toContain('razon_social');                             // los campos también
    expect(req.model).toBe('google/gemini-3.5-flash');
    expect(req.role).toBe('reader');
  });

  it('una consulta pura no tiene NINGUNA tool: cierra en una pasada', async () => {
    const container = createAgentContainer({ config });
    let req!: PassRequest;
    const res = await readTurn(
      { doc, session, prompt: '¿cuántas páginas tiene?', transport: scripted([], r => { req = r; }) },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(req.tools).toEqual([]);   // sin tools de lectura — el contenido ya está
    expect(res.toolsUsed).toEqual([]);
    expect(res.text).toBe('ok');
  });

  it('el HOST extiende: su tool de dominio entra y corre por el registry', async () => {
    const container = createAgentContainer({ config });
    container.bind(IAgentTool).toConstantValue({
      name: 'list_signers', description: 'firmantes del acuerdo (dominio del host)',
      level: 'reader', shape: {}, run: () => '✓ 2 firmantes: ana@x.com, luis@y.com',
    });

    let req!: PassRequest;
    const res = await readTurn(
      { doc, session, prompt: '¿quién firma?', transport: scripted(['list_signers'], r => { req = r; }) },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(req.tools.map(t => t.name)).toEqual(['list_signers']);
    expect(res.text).toContain('ana@x.com');
  });

  it('MEMORIA: el historial previo viaja al transporte (el reader recuerda la conversación)', async () => {
    const container = createAgentContainer({ config });
    let req!: PassRequest;
    const history = [
      { role: 'user' as const, content: '¿cuántas páginas tiene?' },
      { role: 'assistant' as const, content: 'Tiene 4 páginas.' },
    ];
    await readTurn(
      { doc, session, prompt: '¿y de qué trata la primera?', history, transport: scripted([], r => { req = r; }) },
      container.get(IToolRegistry), config, NeverCancelled,
    );
    expect(req.history).toEqual(history);          // el turno lleva la memoria
    expect(req.system).toContain('DOCUMENTO');      // + el doc en el system, como siempre
  });

  it('F7 host extension: una tool de dominio inyectada emite un evento que llega a onHostEvent', async () => {
    const container = createAgentContainer({ config });
    const hostEvents: Array<{ name: string; data: unknown }> = [];
    container.bind(IAgentTool).toConstantValue({
      name: 'list_signers', level: 'reader', description: 'firmantes (dominio host)',
      shape: {},
      run: (ctx) => { ctx.emit('signers_listed', { count: 2 }); return '✓ 2 firmantes'; },
    });

    const res = await readTurn(
      {
        doc, session, prompt: '¿quién firma?',
        onHostEvent: (name, data) => hostEvents.push({ name, data }),
        transport: scripted(['list_signers'], () => {}),
      },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(res.text).toContain('2 firmantes');
    expect(hostEvents).toEqual([{ name: 'signers_listed', data: { count: 2 } }]);
  });

  it('SIN DOCUMENTO: turno org-level — contexto del host en el system, sin edit_document, tools de dominio corren', async () => {
    const container = createAgentContainer({ config });
    container.bind(IAgentTool).toConstantValue({
      name: 'list_agreements', description: 'acuerdos de la org', level: 'reader', shape: {},
      run: () => '✓ 3 acuerdos: NDA Globex (parcial), MSA Globex (completo), Consultoría (borrador)',
    });

    let req!: PassRequest;
    const res = await readTurn(
      {
        context: 'Usuario: Bernardo Castro (owner de DeutschePolska). 3 documentos activos.',
        prompt: '¿qué acuerdos tengo?',
        editor: async () => '✓', // cableado, pero SIN doc no debe ofrecerse
        transport: scripted(['list_agreements'], r => { req = r; }),
      },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(req.system).toContain('=== CONTEXTO ===');
    expect(req.system).toContain('DeutschePolska');
    expect(req.system).not.toContain('=== DOCUMENTO');
    expect(req.tools.map(t => t.name)).toEqual(['list_agreements']); // sin edit_document
    expect(res.text).toContain('NDA Globex');
  });

  it('SIN DOCUMENTO: una tool que toca doc/session recibe el ⚠️ estructurado, no un crash', async () => {
    const container = createAgentContainer({ config });
    container.bind(IAgentTool).toConstantValue({
      name: 'touch_doc', description: 'toca el grafo (mal, en un turno sin doc)', level: 'reader', shape: {},
      run: (ctx) => `páginas: ${ctx.doc.pages.length}`,
    });

    const res = await readTurn(
      { context: 'org', prompt: 'x', transport: scripted(['touch_doc'], () => {}) },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(res.text).toContain('⚠️'); // el catch central del registry lo tradujo
  });

  it('anti-spin: repetir la MISMA tool con los MISMOS args no re-ejecuta — vuelve un stop', async () => {
    const container = createAgentContainer({ config });
    let runs = 0;
    container.bind(IAgentTool).toConstantValue({
      name: 'count_me', description: 'cuenta ejecuciones', level: 'reader', shape: {},
      run: () => { runs++; return '↩︎ no encontré nada'; },
    });

    const res = await readTurn(
      { doc, session, prompt: 'buscá x', transport: scripted(['count_me', 'count_me', 'count_me'], () => {}) },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(runs).toBe(1); // las 2 repeticiones NO llegaron a la tool
    expect(res.text).toContain('el resultado no va a cambiar');
  });
});
