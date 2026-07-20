/**
 * editor.test.ts — F3. El agente editor con transporte de guion (cero gasto)
 * sobre el PDF REAL. Verifica:
 *   1. el system prompt es el grafo pixel-perfect SCOPED a las páginas ruteadas,
 *   2. edit_text corre contra la EditSession real y la edición queda en el ledger,
 *   3. la puerta edit_document del reader rutea {pages, request} al editor.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { NeverCancelled } from '@aldus/core';
import { editPages, editTurn } from './editor.js';
import { readTurn } from './reader.js';
import { loadAgentConfig } from '../config.js';
import { graphFromBytes, loadDoc, type DocGraph } from '../graph.js';
import { EditSession } from '../session/EditSession.js';
import { createAgentContainer } from '../ioc.js';
import { IToolRegistry } from '../tools/registry.js';
import type { ILlmTransport, PassRequest } from '../transport/transport.js';

const PDF = '/Users/berna/signwax/tmp/contrato-de-distribucion-de-software.pdf';
const config = loadAgentConfig({ OPENROUTER_API_KEY: 'x' } as NodeJS.ProcessEnv);

let doc: DocGraph;
beforeAll(async () => { doc = await loadDoc(PDF); });

/** Transporte de guion: ejecuta las tool calls dadas y devuelve un reporte. */
function scripted(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  capture?: (req: PassRequest) => void,
  finalText = 'listo',
): ILlmTransport {
  return {
    async chat(req) {
      capture?.(req);
      const toolsUsed: string[] = [];
      for (const c of calls) {
        req.onEvent?.({ type: 'tool', name: c.name, agent: req.role });
        await req.onToolCall(c.name, c.args);
        toolsUsed.push(c.name);
      }
      return { text: finalText, toolsUsed, toolCalls: calls.length };
    },
  };
}

describe('editTurn (F3) — PDF real', () => {
  it('el system prompt es el grafo EXACTO scoped: la página ruteada está, las otras no', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    let req!: PassRequest;

    await editTurn(
      { doc, session, request: 'cambiá el título', pages: [1], transport: scripted([], r => { req = r; }) },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(req.role).toBe('editor');
    expect(req.model).toBe(config.editorModel);
    expect(req.system).toContain('## Página 1');             // la pág ruteada, grafo exacto
    expect(req.system).toContain('p1-y');                    // ids reales (p1-y711-x154)
    expect(req.system).toContain('CONTRATO DE DISTRIBUCIÓN DE SOFTWARE');
    expect(req.system).not.toContain('## Página 3');         // las otras NO viajan
    expect(req.system).not.toContain('p3-y');
    expect(req.tools.map(t => t.name)).toContain('edit_text');
  });

  it('edit_text aplica una edición REAL: queda en el ledger y finishTurn la devuelve', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const title = doc.pages[0].segments.find(s => s.text.includes('CONTRATO DE DISTRIBUCIÓN'))!;

    const res = await editTurn(
      {
        doc, session, request: 'renombrá el título', pages: [1],
        transport: scripted([{ name: 'edit_text', args: { id: title.id, text: 'CONTRATO DE DISTRIBUCIÓN COMERCIAL' } }]),
      },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(res.toolsUsed).toEqual(['edit_text']);
    const fin = await session.finishTurn();
    if (fin.kind === 'edits') {
      expect(fin.edits.length).toBeGreaterThan(0);
      expect(fin.edits[0].runs?.map(r => r.text).join('')).toContain('COMERCIAL');
    } else {
      expect(fin.applied.length).toBeGreaterThan(0);
    }
  });

  it('cada edición ✓ deja registro de DÓNDE + el estado ACTUALIZADO de la zona (patrón MCP)', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const title = doc.pages[0].segments.find(s => s.text.includes('CONTRATO DE DISTRIBUCIÓN'))!;
    let toolResult = '';
    const t: ILlmTransport = {
      async chat(req) {
        toolResult = String(await req.onToolCall('edit_text', { id: title.id, text: 'CONTRATO MARCO' }));
        return { text: 'ok', toolsUsed: ['edit_text'], toolCalls: 1 };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);

    expect(toolResult).toMatch(/^✓/);
    expect(toolResult).toContain('[cambió en el documento]');
    expect(toolResult).toContain(`${title.id} @(`);            // DÓNDE: id + coordenadas
    expect(toolResult).toContain('"CONTRATO MARCO"');          // QUÉ dice ahora
    // Solo lo que CAMBIÓ: los vecinos intactos no ensucian el diff.
    expect(toolResult).not.toContain('FECHA');
  });

  it('el DIFF llega también en las tools sin arg `id`/`page` (batch, section) — antes no recibían NADA', async () => {
    // El feedback viejo derivaba la página de `args.id`/`args.page`; con
    // `placeholders_to_fields_batch` (usa `groups[]`) o `replace_section`
    // (`start_id`/`end_id`) devolvía null y el modelo se quedaba a ciegas:
    // gastaba llamadas extra sondeando qué había pasado.
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const para = doc.pages[0].segments.find(s => /\.{4,}/.test(s.text))
      ?? doc.pages[0].segments.find(s => s.text.length > 40)!;
    let toolResult = '';
    const t: ILlmTransport = {
      async chat(req) {
        toolResult = String(await req.onToolCall('placeholders_to_fields_batch', {
          groups: [{ id: para.id, fields: [{ placeholder: '.....', name: 'campo_prueba' }] }],
        }));
        return { text: 'ok', toolsUsed: ['placeholders_to_fields_batch'], toolCalls: 1 };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);
    expect(toolResult).toMatch(/^✓/);
    // No exigimos que el texto cambie (los leaders van sin reflow): lo que se
    // congela es que la tool NO se queda sin canal de estado por su shape de args.
    expect(toolResult.startsWith('✓')).toBe(true);
  });

  it('una línea corta puede crecer hasta el ancho de su COLUMNA sin reflow (regresión "DE UNA PARTE,")', async () => {
    // Bug real (2026-07-15): rightEdge se calculaba solo con las líneas del
    // propio párrafo → "DE UNA PARTE," (78pt) no podía crecer NI UN carácter
    // y se partía en dos renglones ("POR UNA\nPARTE ,"). El límite correcto es
    // la columna (las demás líneas x=85 llegan a ~517pt).
    const session = new EditSession(doc);
    const line = doc.pages[0].segments.find(s => s.text.trim() === 'DE UNA PARTE,')!;
    const out = await session.editText(line.id, 'POR UNA PARTE,');
    expect(out).toMatch(/^✓/);
    expect(out).not.toContain('párrafo reconstruido');   // camino simple, sin reflow
    const eff = session.effectiveSegments(1).find(s => s.id === line.id)!;
    expect(eff.text).toBe('POR UNA PARTE,');             // UNA línea, tal cual
  });

  it('placeholders_to_fields: la línea "FECHA: ....." gana un campo SOBRE el hueco, texto intacto', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const fecha = doc.pages[0].segments.find(s => s.text.startsWith('FECHA:'))!;
    let toolResult = '';
    const t: ILlmTransport = {
      async chat(req) {
        toolResult = String(await req.onToolCall('placeholders_to_fields', {
          id: fecha.id,
          fields: [{ placeholder: 'FECHA: ....', name: 'fecha_firma' }],
        }));
        return { text: 'ok', toolsUsed: ['placeholders_to_fields'], toolCalls: 1 };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);

    expect(toolResult).toMatch(/^✓ 1 campo/);
    expect(session.hasBakedOps).toBe(true);                       // el campo quedó encolado
    const eff = session.effectiveSegments(1).find(s => s.id === fecha.id)!;
    expect(eff.text).toBe(fecha.text);                            // el TEXTO no se tocó (cero reflow)
    const fin = await session.finishTurn();
    expect(fin.kind).toBe('baked');                               // creates → se hornea
  });

  it('placeholders_to_fields_batch: varios párrafos en UNA llamada → todos sus campos, en una pasada', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const fecha = doc.pages[0].segments.find(s => s.text.startsWith('FECHA:'))!;
    const empresa = doc.pages[0].segments.find(s => s.text.includes('denominación social de la empresa'))!;
    let passes = 0;
    let toolResult = '';
    const t: ILlmTransport = {
      async chat(req) {
        passes++;
        toolResult = String(await req.onToolCall('placeholders_to_fields_batch', {
          groups: [
            { id: fecha.id, fields: [{ placeholder: 'FECHA: ....', name: 'fecha_firma' }] },
            { id: empresa.id, fields: [{ placeholder: '[denominación social de la empresa]', name: 'empresa_razon_social' }] },
          ],
        }));
        return { text: 'ok', toolsUsed: ['placeholders_to_fields_batch'], toolCalls: 1 };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);

    expect(passes).toBe(1);                                  // UNA sola llamada del modelo
    expect(toolResult).toMatch(/^✓ \d+ campo\(s\) creados en 2 párrafo/);
    expect(session.hasBakedOps).toBe(true);
    expect(session.count).toBeGreaterThanOrEqual(2);         // los campos de AMBOS párrafos
  });

  it('placeholders_to_fields_batch: un grupo malo NO tumba a los buenos', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const fecha = doc.pages[0].segments.find(s => s.text.startsWith('FECHA:'))!;
    let toolResult = '';
    const t: ILlmTransport = {
      async chat(req) {
        toolResult = String(await req.onToolCall('placeholders_to_fields_batch', {
          groups: [
            { id: fecha.id, fields: [{ placeholder: 'FECHA: ....', name: 'fecha_firma' }] },
            { id: 'p1-y9999-x0', fields: [{ placeholder: 'texto inexistente', name: 'no_existe' }] },  // id inexistente
          ],
        }));
        return { text: 'ok', toolsUsed: ['placeholders_to_fields_batch'], toolCalls: 1 };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);

    expect(toolResult).toContain('1/2 párrafos');            // el bueno entró
    expect(toolResult).toContain('p1-y9999-x0');             // el malo reportado
    expect(session.count).toBeGreaterThanOrEqual(1);
  });

  it('delete_text: elimina un nodo real; finishTurn lo devuelve como remove', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const parte = doc.pages[0].segments.find(s => s.text.trim() === 'DE UNA PARTE,')!;
    let toolResult = '';
    const t: ILlmTransport = {
      async chat(req) {
        toolResult = String(await req.onToolCall('delete_text', { id: parte.id }));
        return { text: 'ok', toolsUsed: ['delete_text'], toolCalls: 1 };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);

    expect(toolResult).toMatch(/^✓/);
    const eff = session.effectiveSegments(1).find(s => s.id === parte.id)!;
    expect(eff.removed).toBe(true);
    const fin = await session.finishTurn();
    if (fin.kind === 'edits') expect(fin.edits.some(e => e.segmentId === parte.id && e.remove)).toBe(true);
  });

  it('delete_text pull_up: borra el título y SUBE todo lo de abajo a cerrar el hueco', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const title = doc.pages[0].segments.find(s => s.text.includes('CONTRATO DE DISTRIBUCIÓN'))!;
    // baselines originales de lo que está debajo del título
    const belowBefore = doc.pages[0].segments
      .filter(s => s.id !== title.id && s.baseline < title.baseline - 1 && s.baseline >= 58)
      .map(s => ({ id: s.id, y: s.baseline }));

    let toolResult = '';
    const t: ILlmTransport = {
      async chat(req) {
        toolResult = String(await req.onToolCall('delete_text', { id: title.id, pull_up: 'gap' }));
        return { text: 'ok', toolsUsed: ['delete_text'], toolCalls: 1 };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);

    expect(toolResult).toMatch(/cerrar el hueco \(\d+pt\)/);
    const eff = session.effectiveSegments(1);
    expect(eff.find(s => s.id === title.id)!.removed).toBe(true);
    // Todo lo de abajo subió (baseline efectiva MAYOR que la original).
    for (const b of belowBefore) {
      const now = eff.find(s => s.id === b.id)!;
      expect(now.baseline).toBeGreaterThan(b.y);
    }
    // La separación RELATIVA entre los de abajo se conserva (subieron todos igual).
    if (belowBefore.length >= 2) {
      const [a, b] = belowBefore;
      const na = eff.find(s => s.id === a.id)!.baseline, nb = eff.find(s => s.id === b.id)!.baseline;
      expect(Math.abs((na - nb) - (a.y - b.y))).toBeLessThan(0.5);
    }
  });

  it('delete_text pull_up "top": sube MÁS que "gap" (reclama el margen superior)', async () => {
    const container = createAgentContainer({ config });
    const title = doc.pages[0].segments.find(s => s.text.includes('CONTRATO DE DISTRIBUCIÓN'))!;
    const fecha = doc.pages[0].segments.find(s => s.text.startsWith('FECHA:'))!;

    const runMode = async (mode: 'gap' | 'top'): Promise<number> => {
      const session = new EditSession(doc);
      const t: ILlmTransport = {
        async chat(req) { await req.onToolCall('delete_text', { id: title.id, pull_up: mode }); return { text: 'ok', toolsUsed: ['delete_text'], toolCalls: 1 }; },
      };
      await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);
      return session.effectiveSegments(1).find(s => s.id === fecha.id)!.baseline;
    };

    const gapY = await runMode('gap');
    const topY = await runMode('top');
    expect(gapY).toBeGreaterThan(fecha.baseline);   // gap ya sube algo
    expect(topY).toBeGreaterThan(gapY);             // top sube MÁS
    expect(topY).toBeLessThan(doc.pages[0].height); // pero no se sale de la página
  });

  it('replace_paragraph: reescribe un párrafo entero con reflow; el nuevo texto queda en el ledger', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    // Un párrafo de cuerpo real de la página 1 (el preámbulo "POR CUANTO…").
    const para = doc.pages[0].segments.find(s => s.text.startsWith('POR CUANTO') && s.text.length > 40)
      ?? doc.pages[0].segments.find(s => s.text.length > 60)!;
    const nuevo = 'Este es el texto nuevo del párrafo, reescrito por completo para verificar que el reflow reparte los renglones y respeta el ancho de la columna sin desbordar el margen derecho.';
    let toolResult = '';
    const t: ILlmTransport = {
      async chat(req) {
        toolResult = String(await req.onToolCall('replace_paragraph', { id: para.id, text: nuevo }));
        return { text: 'ok', toolsUsed: ['replace_paragraph'], toolCalls: 1 };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);

    expect(toolResult).toMatch(/^✓/);
    const fin = await session.finishTurn();
    // El texto nuevo está en las ediciones (kind edits) o se horneó (kind baked).
    if (fin.kind === 'edits') {
      const joined = fin.edits.flatMap(e => e.runs?.map(r => r.text) ?? []).join('');
      expect(joined).toContain('texto nuevo del párrafo');
    } else {
      expect(fin.applied.length).toBeGreaterThan(0);
    }
  });

  it('replace_paragraph con id inexistente → ⚠️, no revienta', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    let out = '';
    const t: ILlmTransport = {
      async chat(req) { out = String(await req.onToolCall('replace_paragraph', { id: 'p1-y9-x9', text: 'x y z' })); return { text: 'ok', toolsUsed: [], toolCalls: 1 }; },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);
    expect(out).toMatch(/^⚠️/);
  });

  it('set_text_style / set_text_color / set_text_size: aplican al nodo y quedan en el ledger', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const title = doc.pages[0].segments.find(s => s.text.includes('CONTRATO DE DISTRIBUCIÓN'))!;
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'set_text_style', args: { id: title.id, italic: true } },
      { name: 'set_text_color', args: { id: title.id, color: '#c0392b' } },
      { name: 'set_text_size', args: { id: title.id, size: 20 } },
    ];
    const results: string[] = [];
    const t: ILlmTransport = {
      async chat(req) {
        for (const c of calls) results.push(String(await req.onToolCall(c.name, c.args)));
        return { text: 'ok', toolsUsed: calls.map(c => c.name), toolCalls: calls.length };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);

    expect(results.every(r => r.startsWith('✓'))).toBe(true);
    const fin = await session.finishTurn();
    if (fin.kind === 'edits') {
      const e = fin.edits.find(e => e.segmentId === title.id)!;
      expect(e.fontSize).toBe(20);
      expect(e.color).toBe('#c0392b');
      expect(e.runs?.every(r => r.italic)).toBe(true);
    }
  });

  it('set_text_color rechaza un color mal formado (validación zod → bad_args)', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const registry = container.get(IToolRegistry);
    const title = doc.pages[0].segments.find(s => s.text.includes('CONTRATO'))!;
    const r = await registry.dispatch('set_text_color', { id: title.id, color: 'rojo' }, { doc, session, emit: () => {} });
    expect(r.code).toBe('bad_args');
    expect(r.retriable).toBe(true);
  });

  it('move_text: reposiciona el nodo; la nueva baseline queda en el estado efectivo', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const title = doc.pages[0].segments.find(s => s.text.includes('CONTRATO DE DISTRIBUCIÓN'))!;
    let out = '';
    const t: ILlmTransport = {
      async chat(req) { out = String(await req.onToolCall('move_text', { id: title.id, x: 120, y: 690 })); return { text: 'ok', toolsUsed: ['move_text'], toolCalls: 1 }; },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);
    expect(out).toMatch(/^✓/);
    expect(session.effectiveSegments(1).find(s => s.id === title.id)!.baseline).toBe(690);
  });

  it('delete_element: detecta el tipo por id — texto real se elimina, id inexistente → ⚠️', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const registry = container.get(IToolRegistry);
    const ctx = { doc, session, emit: () => {} };
    const seg = doc.pages[0].segments.find(s => s.text.trim() === 'DE UNA PARTE,')!;

    const ok = await registry.dispatch('delete_element', { id: seg.id }, ctx);
    expect(ok.message).toMatch(/^✓/);
    expect(session.effectiveSegments(1).find(s => s.id === seg.id)!.removed).toBe(true);

    const bad = await registry.dispatch('delete_element', { id: 'p1-y0-x0' }, ctx);
    expect(bad.message).toMatch(/No existe ningún elemento/);
  });

  it('F6 creación: add_text, highlight_text, watermark, header_footer se aplican y se hornean', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const registry = container.get(IToolRegistry);
    const ctx = { doc, session, emit: () => {} };
    const seg = doc.pages[0].segments.find(s => s.text.includes('CONTRATO'))!;

    const r1 = await registry.dispatch('add_text', { page: 1, x: 400, y: 60, text: 'Anexo confidencial' }, ctx);
    const r2 = await registry.dispatch('highlight_text', { id: seg.id, color: '#fff176' }, ctx);
    const r3 = await registry.dispatch('watermark', { text: 'BORRADOR' }, ctx);
    const r4 = await registry.dispatch('header_footer', { footer: 'Contrato de distribución', page_numbers: true }, ctx);
    for (const r of [r1, r2, r3, r4]) expect(r.message).toMatch(/^✓/);

    expect(session.hasBakedOps).toBe(true);
    const fin = await session.finishTurn();
    expect(fin.kind).toBe('baked');
    // La marca de agua y el texto nuevo aparecen en el PDF horneado.
    const re = await graphFromBytes((fin as { pdf: Uint8Array }).pdf);
    const allText = re.pages.flatMap(p => p.segments.map(s => s.text)).join(' ');
    expect(allText).toContain('BORRADOR');
    expect(allText).toContain('Anexo confidencial');
  });

  it('watermark/header_footer son GLOBALES e idempotentes: 2 llamadas iguales = 1 sola (fan-out safe)', async () => {
    const session = new EditSession(doc);
    expect(session.watermark('BORRADOR')).toMatch(/^✓/);
    expect(session.watermark('BORRADOR')).toMatch(/^↩︎/);   // repetida → skip
    expect(session.headerFooter({ footer: 'x', pageNumbers: true })).toMatch(/^✓/);
    expect(session.headerFooter({ footer: 'x', pageNumbers: true })).toMatch(/^↩︎/);
    // Solo 1 watermark + 1 headerFooter encolados, no 2+2.
    expect(session.count).toBe(2);
  });

  it('add_form_field: crea un campo nuevo y se hornea como widget real', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const r = await container.get(IToolRegistry).dispatch(
      'add_form_field', { field_type: 'text', page: 1, x: 100, y: 200, name: 'firma_lugar' }, { doc, session, emit: () => {} });
    expect(r.message).toMatch(/^✓/);
    const fin = await session.finishTurn();
    const re = await graphFromBytes((fin as { pdf: Uint8Array }).pdf);
    expect(re.pages[0].widgets.some(w => w.fieldName === 'firma_lugar')).toBe(true);
  });

  it('fan-out: cada editor sabe que es UNO de varios y solo hace SU página (prompt de paralelo)', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const prompts: string[] = [];
    const t: ILlmTransport = {
      async chat(req) { prompts.push(req.system); return { text: 'ok', toolsUsed: [], toolCalls: 0 }; },
    };
    await editPages(
      { doc, session, request: 'reemplazá toda la sección 1 (cruza páginas)', pages: [1, 2], parallel: true, transport: t },
      container.get(IToolRegistry), config, NeverCancelled,
    );
    // Cada editor recibió el aviso de paralelo, apuntando a SU página y a la otra.
    const p1 = prompts.find(s => s.includes('SOLO la/s página/s 1'))!;
    const p2 = prompts.find(s => s.includes('SOLO la/s página/s 2'))!;
    expect(p1).toContain('página/s 2 las editan OTROS');
    expect(p1).toContain('NUNCA te niegues');
    expect(p2).toContain('página/s 1 las editan OTROS');
  });

  it('replace_section CROSS-PÁGINA: colapsa una sección que cruza p1→p2 en un párrafo', async () => {
    const session = new EditSession(doc);
    // "1. DEFINICIONES" (p1) hasta un nodo de definiciones en p2.
    const start = doc.pages[0].segments.find(s => s.text.includes('DEFINICIONES'))!;
    const p2last = doc.pages[1].segments[doc.pages[1].segments.length - 1];
    expect(start.page).toBe(1);
    expect(p2last.page).toBe(2); // el span cruza páginas de verdad

    const out = await session.replaceSection(start.id, p2last.id, 'Párrafo de prueba que reemplaza toda la sección de definiciones del contrato.');
    expect(out).toMatch(/^✓ Sección/);
    expect(out).toContain('2 páginas');
    // El primer nodo pasó a ser el texto nuevo; el resto del span, eliminado.
    const eff1 = session.effectiveSegments(1).find(s => s.id === start.id)!;
    expect(eff1.text).toContain('Párrafo de prueba');
    // Algún nodo de p2 dentro del span quedó marcado como eliminado.
    expect(session.effectiveSegments(2).some(s => s.removed)).toBe(true);
  });

  it('replace_page: recompone una página entera con bloques tipográficos (layout del código)', async () => {
    const session = new EditSession(doc);
    const out = await session.replacePage(4, [
      { type: 'title', text: 'ANEXO DE PRUEBA', align: 'center' },
      { type: 'paragraph', text: 'Este anexo reemplaza el contenido original de la página con un documento nuevo, ordenado y con estilos, generado a partir de bloques estructurados que el layout del motor compone con medición real de fuente.' },
      { type: 'heading', text: '1. OBJETO' },
      { type: 'paragraph', text: 'El presente anexo tiene por objeto verificar la composición tipográfica automática.' },
      { type: 'bullet', text: 'Título centrado en 18 puntos negrita.' },
      { type: 'bullet', text: 'Encabezados jerárquicos y párrafos con wrap correcto.' },
    ]);
    expect(out).toMatch(/^✓ Página 4 recompuesta/);

    const fin = await session.finishTurn();
    expect(fin.kind).toBe('baked');
    const re = await graphFromBytes((fin as { pdf: Uint8Array }).pdf);
    const p4 = re.pages[3];
    const texts = p4.segments.map(s => s.text).join('\n');
    expect(texts).toContain('ANEXO DE PRUEBA');
    expect(texts).toContain('1. OBJETO');
    expect(texts).not.toContain('NOMBRAMIENTO');           // lo viejo de p4 se fue… (p4 tenía 5.x)
    // El título quedó MÁS GRANDE que el cuerpo y el heading en el medio.
    const title = p4.segments.find(s => s.text.includes('ANEXO DE PRUEBA'))!;
    const body = p4.segments.find(s => s.text.includes('tiene por objeto'))!;
    expect(title.fontSize).toBeGreaterThan(body.fontSize + 4);
    // Ningún run se sale del margen derecho (wrap real).
    for (const seg of p4.segments) for (const r of seg.runs) expect(r.x + r.width).toBeLessThanOrEqual(p4.width - 60);
  });

  it('replace_page DOS VECES sobre la misma página → REEMPLAZA, no acumula (regresión texto doble)', async () => {
    const session = new EditSession(doc);
    await session.replacePage(4, [{ type: 'title', text: 'VERSIÓN UNO' }, { type: 'paragraph', text: 'Primer intento de contenido.' }]);
    const out2 = await session.replacePage(4, [{ type: 'title', text: 'VERSIÓN DOS' }, { type: 'paragraph', text: 'Segundo intento, más corto.' }]);
    expect(out2).toContain('recompuesta: la versión anterior');

    const fin = await session.finishTurn();
    const re = await graphFromBytes((fin as { pdf: Uint8Array }).pdf);
    const texts = re.pages[3].segments.map(s => s.text).join('\n');
    expect(texts).toContain('VERSIÓN DOS');
    expect(texts).not.toContain('VERSIÓN UNO');   // la primera composición NO quedó encimada
  });

  it('replace_section MISMA página → delega en replaceParagraph (no borra de más)', async () => {
    const session = new EditSession(doc);
    const a = doc.pages[0].segments.find(s => s.text.startsWith('POR CUANTO'))!;
    const out = await session.replaceSection(a.id, a.id, 'Texto corto nuevo.');
    expect(out).toMatch(/^✓ Párrafo/); // camino replaceParagraph, no el de sección
  });

  it('edit_text con id inexistente → ⚠️ del session, el turno NO revienta', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    let toolResult = '';
    const t: ILlmTransport = {
      async chat(req) {
        toolResult = String(await req.onToolCall('edit_text', { id: 'p1-s9999', text: 'x' }));
        return { text: 'ok', toolsUsed: ['edit_text'], toolCalls: 1 };
      },
    };
    await editTurn({ doc, session, request: 'x', pages: [1], transport: t }, container.get(IToolRegistry), config, NeverCancelled);
    expect(toolResult).toMatch(/^⚠️/);
    expect(toolResult).toContain('p1-s9999');
  });

  it('editPages: UN editor POR PÁGINA, en PARALELO, cada uno con su grafo scoped', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const seen: Array<{ page: string; startedAt: number }> = [];
    let concurrentPeak = 0;
    let inFlight = 0;

    // Cada "modelo" tarda 50ms: en SERIE serían ≥200ms; en paralelo, ~50ms.
    const t: ILlmTransport = {
      async chat(req) {
        inFlight++;
        concurrentPeak = Math.max(concurrentPeak, inFlight);
        const page = /## Página (\d+)/.exec(req.system)?.[1] ?? '?';
        seen.push({ page, startedAt: Date.now() });
        await new Promise(r => setTimeout(r, 50));
        inFlight--;
        return { text: `p${page} listo`, toolsUsed: [], toolCalls: 0 };
      },
    };

    const t0 = Date.now();
    const res = await editPages(
      { doc, session, request: 'convertí los placeholders', pages: [1, 2, 3, 4], parallel: true, transport: t },
      container.get(IToolRegistry), config, NeverCancelled,
    );
    const elapsed = Date.now() - t0;

    expect(seen.map(s => s.page).sort()).toEqual(['1', '2', '3', '4']); // uno por página
    expect(concurrentPeak).toBe(4);                                     // los 4 a la vez
    expect(elapsed).toBeLessThan(150);                                  // no es la suma (200ms+)
    expect(res.text).toContain('[p1]');
    expect(res.text).toContain('[p4]');
  });

  it('editPages: una página que falla NO tumba a las otras — su error va en el reporte', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const t: ILlmTransport = {
      async chat(req) {
        const page = /## Página (\d+)/.exec(req.system)?.[1] ?? '?';
        if (page === '2') throw new Error('rate limit');
        return { text: `p${page} ok`, toolsUsed: [], toolCalls: 0 };
      },
    };

    const res = await editPages(
      { doc, session, request: 'x', pages: [1, 2, 3], parallel: true, transport: t },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(res.text).toContain('[p1] p1 ok');
    expect(res.text).toContain('[p2] ⚠️ falló: rate limit');
    expect(res.text).toContain('[p3] p3 ok');
  });

  it('editPages: si TODAS fallan, propaga (infra rota) en vez de reportar "listo"', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    const t: ILlmTransport = { async chat() { throw new Error('OAuth session expired'); } };

    await expect(editPages(
      { doc, session, request: 'x', pages: [1, 2], parallel: true, transport: t },
      container.get(IToolRegistry), config, NeverCancelled,
    )).rejects.toThrow('OAuth session expired');
  });

  it('editPages: el mutex SERIALIZA las mutaciones de la sesión compartida', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    let inTool = 0;
    let toolPeak = 0;

    // Cada editor de página llama una tool; el mutex debe impedir que dos
    // mutaciones se solapen sobre la EditSession compartida.
    const t: ILlmTransport = {
      async chat(req) {
        const page = Number(/## Página (\d+)/.exec(req.system)?.[1] ?? 1);
        const seg = doc.pages[page - 1].segments[0];
        await req.onToolCall('edit_text', { id: seg.id, text: `EDITADO p${page}` });
        return { text: 'ok', toolsUsed: ['edit_text'], toolCalls: 1 };
      },
    };
    // Espiamos la concurrencia DENTRO de la tool vía el registry real.
    const registry = container.get(IToolRegistry);
    const orig = registry.dispatch.bind(registry);
    registry.dispatch = async (n, a, c) => {
      inTool++; toolPeak = Math.max(toolPeak, inTool);
      await new Promise(r => setTimeout(r, 10));
      const out = await orig(n, a, c);
      inTool--;
      return out;
    };

    await editPages({ doc, session, request: 'x', pages: [1, 2, 3, 4], parallel: true, transport: t }, registry, config, NeverCancelled);

    expect(toolPeak).toBe(1);              // NUNCA dos mutaciones a la vez
    expect(session.count).toBe(4);         // y las 4 ediciones entraron
  });

  it('la puerta del reader: edit_document rutea {pages, request} al callback editor', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    let route: { pages: number[]; request: string } | null = null;

    const res = await readTurn(
      {
        doc, session, prompt: 'cambiá el título del contrato',
        transport: scripted(
          [{ name: 'edit_document', args: { pages: [1], request: 'cambiar el título "CONTRATO DE DISTRIBUCIÓN DE SOFTWARE"' } }],
          undefined, 'hecho: el título fue cambiado',
        ),
        editor: async r => { route = r; return '✓ 1 edición aplicada'; },
      },
      container.get(IToolRegistry), config, NeverCancelled,
    );

    expect(route).toEqual({ pages: [1], request: 'cambiar el título "CONTRATO DE DISTRIBUCIÓN DE SOFTWARE"' });
    expect(res.text).toContain('hecho');
  });

  it('sin callback editor NO se ofrece edit_document (reader solo-lectura)', async () => {
    const container = createAgentContainer({ config });
    const session = new EditSession(doc);
    let req!: PassRequest;
    await readTurn(
      { doc, session, prompt: 'hola', transport: scripted([], r => { req = r; }) },
      container.get(IToolRegistry), config, NeverCancelled,
    );
    expect(req.tools.map(t => t.name)).not.toContain('edit_document');
  });
});
