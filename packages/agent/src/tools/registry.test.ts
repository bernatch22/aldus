/**
 * registry.test.ts — F0: el despachador ANTES de que exista ninguna tool real.
 * Prueba el contrato completo con tools fake: protocolo ✓/↩︎/⚠️, validación
 * zod reintentable, throw = internal sin stack al modelo, unknown_tool,
 * niveles, duplicados, y el multi-binding vía container (host extiende).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IAgentTool, type ToolContext } from './contract.js';
import { ToolRegistry } from './registry.js';
import { createAgentContainer } from '../ioc.js';
import { IToolRegistry } from './registry.js';

const ctx = {} as ToolContext; // el registry no lo inspecciona; las tools sí.

const ok: IAgentTool = {
  name: 'greet', description: 'saluda', level: 'reader',
  shape: { who: z.string() },
  run: (_c, a) => `✓ hola ${a.who}`,
};
const skip: IAgentTool = {
  name: 'noop', description: 'no aplica', level: 'both',
  shape: {},
  run: () => '↩︎ nada para hacer',
};
const warn: IAgentTool = {
  name: 'shaky', description: 'avisa', level: 'editor',
  shape: {},
  run: () => '⚠️ no encontré el nodo',
};
const boom: IAgentTool = {
  name: 'buggy', description: 'explota', level: 'editor',
  shape: {},
  run: () => { throw new Error('secreto interno con stack'); },
};

describe('ToolRegistry', () => {
  const reg = new ToolRegistry([ok, skip, warn, boom]);

  it('corre una tool y clasifica ✓ como ok', async () => {
    const r = await reg.dispatch('greet', { who: 'Berna' }, ctx);
    expect(r).toEqual({ ok: true, code: 'ok', retriable: false, message: '✓ hola Berna' });
  });

  it('clasifica ↩︎ como skipped (ok) y ⚠️ como warning reintentable', async () => {
    expect((await reg.dispatch('noop', {}, ctx)).code).toBe('skipped');
    const w = await reg.dispatch('shaky', {}, ctx);
    expect(w).toMatchObject({ ok: false, code: 'warning', retriable: true });
  });

  it('args inválidos → bad_args reintentable con el detalle zod, sin correr la tool', async () => {
    const r = await reg.dispatch('greet', { who: 42 }, ctx);
    expect(r.code).toBe('bad_args');
    expect(r.retriable).toBe(true);
    expect(r.message).toContain('who');
  });

  it('un throw es internal: no reintentable y SIN filtrar el mensaje del error', async () => {
    const r = await reg.dispatch('buggy', {}, ctx);
    expect(r).toMatchObject({ ok: false, code: 'internal', retriable: false });
    expect(r.message).not.toContain('secreto');
  });

  it('tool desconocida → unknown_tool', async () => {
    expect((await reg.dispatch('nope', {}, ctx)).code).toBe('unknown_tool');
  });

  it('forLevel filtra por nivel e incluye both; passTools deriva JSON Schema del zod', () => {
    expect(reg.forLevel('reader').map(t => t.name)).toEqual(['greet', 'noop']);
    expect(reg.forLevel('editor').map(t => t.name)).toEqual(['noop', 'shaky', 'buggy']);
    const pass = reg.passTools('reader').find(p => p.name === 'greet')!;
    expect((pass.parameters as { properties: object }).properties).toHaveProperty('who');
  });

  it('nombres duplicados = error de composición (falla al construir, no en runtime)', () => {
    expect(() => new ToolRegistry([ok, { ...skip, name: 'greet' }])).toThrow(/greet/);
  });

  it('el host EXTIENDE bindeando IAgentTool en el container — el registry la levanta solo (OCP)', async () => {
    const container = createAgentContainer();
    container.bind(IAgentTool).toConstantValue({
      name: 'list_signers', description: 'tool de dominio del host', level: 'reader',
      shape: {},
      run: () => '✓ 2 firmantes: a@x.com, b@y.com',
    });
    const registry = container.get(IToolRegistry);
    expect(registry.forLevel('reader').map(t => t.name)).toContain('list_signers');
    expect((await registry.dispatch('list_signers', {}, ctx)).message).toContain('firmantes');
  });
});
