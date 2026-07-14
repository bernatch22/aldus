/**
 * orchestrator.test.ts — el runTurn two-level ÚNICO, ejercitado con un
 * `ILlmTransport` FAKE de guion (chat delega → editor llama tools → fin). Verifica
 * el flujo two-level, el gating de verify y los eventos SIN un LLM real (se
 * virtualiza SOLO el seam de I/O: el PDF y la EditSession son REALES). Y runTool
 * con args rotos → el {@link ToolOutcome} correcto.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { graphFromBytes } from '../src/graph.js';
import { EditSession } from '../src/session/EditSession.js';
import { runTool, runToolOutcome } from '../src/llm/tools.js';
import { runTurn } from '../src/llm/runTurn.js';
import { loadAgentConfig } from '../src/config.js';
import type { AgentEvent, AgentRole, ILlmTransport, PassRequest, PassResult } from '../src/transport/transport.js';

const config = loadAgentConfig({} as NodeJS.ProcessEnv); // defaults; el transporte se inyecta

type Action = { text?: string; tools?: Array<{ name: string; args: Record<string, unknown> }> };

/** Transporte de GUION: virtualiza el LLM. `script(req)` decide qué "responde"
 *  cada pasada (texto + tools a llamar); el transporte ejecuta las tools por el
 *  seam real `onToolCall` (dispatch a la sesión), emite los eventos y devuelve. */
class ScriptedTransport implements ILlmTransport {
  readonly calls: Array<{ role: AgentRole; resume: unknown }> = [];
  constructor(private readonly script: (req: PassRequest, calls: ScriptedTransport['calls']) => Action) {}
  async chat(req: PassRequest): Promise<PassResult> {
    this.calls.push({ role: req.role, resume: req.resume });
    const action = this.script(req, this.calls);
    const text = action.text ?? '';
    if (text) req.onEvent?.({ type: 'text', delta: text, agent: req.role });
    const toolsUsed: string[] = [];
    let toolCalls = 0;
    for (const t of action.tools ?? []) {
      toolCalls++;
      toolsUsed.push(t.name);
      req.onEvent?.({ type: 'tool', name: `mcp__aldus__${t.name}`, agent: req.role });
      await req.onToolCall(t.name, t.args);
    }
    return { text, toolsUsed, toolCalls, resume: req.role === 'chat' ? 'chat-session' : { editor: true } };
  }
}

async function twoTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('CONTRATO DE PRUEBA', { x: 50, y: 250, size: 20, font });
  page.drawText('Cliente Acme Corp', { x: 50, y: 210, size: 12, font });
  return doc.save();
}

describe('runTurn — orquestador two-level (transporte fake de guion)', () => {
  it('chat delega → editor llama 2 tools → estado real mutado + eventos en orden', async () => {
    const doc = await graphFromBytes(await twoTextPdf());
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('CONTRATO'))!;
    const session = new EditSession(doc);
    const events: AgentEvent[] = [];

    const transport = new ScriptedTransport(req =>
      req.role === 'chat'
        ? { text: 'Delego al editor.', tools: [{ name: 'edit_document', args: { pages: [1], request: 'editá el título' } }] }
        : { text: 'Edité.', tools: [
            { name: 'edit_text', args: { id: seg.id, text: 'CONTRATO FIRMADO' } },
            { name: 'set_text_color', args: { id: seg.id, color: '#ff0000' } },
          ] },
    );

    const res = await runTurn({ doc, session, prompt: 'cambiá el título', transport, config, onEvent: e => events.push(e) });

    // Two-level: chat + editor, ambos textos concatenados; toolCalls = SOLO editor.
    expect(res.text).toContain('Delego al editor.');
    expect(res.text).toContain('Edité.');
    expect(res.toolCalls).toBe(2);
    expect(res.sessionId).toBe('chat-session'); // el resume string del chat
    // El estado REAL se mutó por el seam onToolCall → runTool → EditSession.
    expect(session.getEdits().edits.find(e => e.segmentId === seg.id)?.text).toBe('CONTRATO FIRMADO');
    // Eventos en orden cronológico: chat (texto+tool) → editor (texto+tools).
    expect(events[0]).toEqual({ type: 'text', delta: 'Delego al editor.', agent: 'chat' });
    expect(events.find(e => e.type === 'tool' && e.agent === 'chat')?.name).toBe('mcp__aldus__edit_document');
    const editorTools = events.filter(e => e.type === 'tool' && e.agent === 'editor').map(e => e.name);
    expect(editorTools).toEqual(['mcp__aldus__edit_text', 'mcp__aldus__set_text_color']);
    // Sin geometría manual → NO corre verify.
    expect(events.some(e => e.type === 'tool' && e.name === 'mcp__aldus__verify_layout')).toBe(false);
    expect(transport.calls.filter(c => c.role === 'editor')).toHaveLength(1);
  });

  it('gating verify: el editor mueve texto A MANO sobre un campo → corre UNA pasada correctiva', async () => {
    const bytes = await (async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([500, 500]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText('Nombre del cliente', { x: 60, y: 100, size: 11, font });
      doc.getForm().createTextField('campo').addToPage(page, { x: 200, y: 400, width: 100, height: 14 });
      return doc.save();
    })();
    const doc = await graphFromBytes(bytes);
    const seg = doc.pages[0]!.segments.find(s => s.text.includes('Nombre'))!;
    const session = new EditSession(doc);
    const events: AgentEvent[] = [];

    const transport = new ScriptedTransport((req, calls) => {
      if (req.role === 'chat') return { text: '', tools: [{ name: 'edit_document', args: { pages: [1], request: 'mové el nombre' } }] };
      // 1ª pasada editor: move_text SOBRE el rect del campo (genera solape).
      // 2ª pasada (correctiva, resume truthy): "acomoda" sin más tools.
      const editorPasses = calls.filter(c => c.role === 'editor').length;
      return editorPasses === 1
        ? { text: 'Muevo.', tools: [{ name: 'move_text', args: { id: seg.id, x: 205, y: 402 } }] }
        : { text: 'Ok, lo dejo.', tools: [] };
    });

    const res = await runTurn({ doc, session, prompt: 'mové el nombre encima del campo', transport, config, onEvent: e => events.push(e) });

    // move_text ∈ MANUAL_GEOMETRY → overlapReport encuentra el solape → pasada correctiva.
    expect(transport.calls.filter(c => c.role === 'editor')).toHaveLength(2);
    // La 2ª pasada editora encadena el resume OPACO de la 1ª (misma conversación).
    expect(transport.calls.filter(c => c.role === 'editor')[1]!.resume).toEqual({ editor: true });
    expect(events.some(e => e.type === 'tool' && e.name === 'mcp__aldus__verify_layout')).toBe(true);
    expect(res.text).toContain('Muevo.');
    expect(res.text).toContain('Ok, lo dejo.');
  }, 30_000);

  it('chat-only: el chat NO delega → devuelve su texto, 0 tools, sesión intacta', async () => {
    const doc = await graphFromBytes(await twoTextPdf());
    const session = new EditSession(doc);
    const events: AgentEvent[] = [];
    const transport = new ScriptedTransport(() => ({ text: 'Es un contrato de servicios.' }));

    const res = await runTurn({ doc, session, prompt: '¿de qué trata?', transport, config, onEvent: e => events.push(e) });

    expect(res.text).toBe('Es un contrato de servicios.');
    expect(res.toolCalls).toBe(0);
    expect(session.count).toBe(0);
    expect(events.every(e => e.agent === 'chat')).toBe(true);
    expect(transport.calls.filter(c => c.role === 'editor')).toHaveLength(0);
  });
});

describe('runTool — ToolOutcome debajo del protocolo ✓/⚠️/↩︎', () => {
  it('args rotos → bad_args reintentable (mismo contrato de validación en runTool)', async () => {
    const doc = await graphFromBytes(await twoTextPdf());
    const session = new EditSession(doc);
    // move_text.shape: id z.string(); pasar un number rompe la validación zod.
    const outcome = await runToolOutcome(session, 'move_text', { id: 123, x: 'izquierda' });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('bad_args');
    expect(outcome.retriable).toBe(true);
    expect(outcome.message.startsWith('⚠️')).toBe(true);
    expect(session.count).toBe(0); // no se ejecutó nada
  });

  it('tool desconocida → unknown_tool; tool válida → ok', async () => {
    const doc = await graphFromBytes(await twoTextPdf());
    const seg = doc.pages[0]!.segments[0]!;
    const session = new EditSession(doc);

    const unknown = await runToolOutcome(session, 'no_existe', {});
    expect(unknown.code).toBe('unknown_tool');
    expect(unknown.message).toContain('tool desconocida');

    const good = await runToolOutcome(session, 'edit_text', { id: seg.id, text: 'NUEVO' });
    expect(good.ok).toBe(true);
    expect(good.code).toBe('ok');
    // runTool (string) devuelve el mensaje del protocolo para el LLM.
    expect(await runTool(session, 'set_text_color', { id: seg.id, color: '#123456' })).toContain('✓');
  });
});
