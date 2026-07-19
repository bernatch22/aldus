/**
 * registry.ts — el despachador de tools y ÚNICO catch site del agente
 * (art-of-code C7: errores estructurados, un solo lugar que mapea throw →
 * respuesta; el stack va al log, nunca al LLM ni al usuario).
 *
 * Recibe TODAS las {@link IAgentTool} bindeadas (nativas + del host) por
 * multi-inyección (C4): agregar una capacidad = un bind más en el composition
 * root, este archivo no se toca.
 */
import { z } from 'zod';
import { all, createLogger, createToken } from '@aldus/core';
import type { PassTool } from '../transport/transport.js';
import { IAgentTool, type AgentLevel, type ToolContext } from './contract.js';

const log = createLogger('aldus:agent:tools');

/** Resultado ESTRUCTURADO de correr una tool (debajo del protocolo ✓/↩︎/⚠️). */
export type ToolCode = 'ok' | 'skipped' | 'warning' | 'bad_args' | 'internal' | 'unknown_tool';
export interface ToolOutcome {
  ok: boolean;
  code: ToolCode;
  /** true → el modelo puede corregir los args y reintentar. */
  retriable: boolean;
  /** Lo que ve el LLM (protocolo de texto). */
  message: string;
}

/** message del protocolo → outcome (la tool habla texto; el código, data). */
function classify(message: string): ToolOutcome {
  if (message.startsWith('↩︎')) return { ok: true, code: 'skipped', retriable: false, message };
  if (message.startsWith('⚠️')) return { ok: false, code: 'warning', retriable: true, message };
  return { ok: true, code: 'ok', retriable: false, message };
}

export interface IToolRegistry {
  /** Las tools visibles para un agente (level exacto o 'both'). */
  forLevel(level: Exclude<AgentLevel, 'both'>): IAgentTool[];
  /** Las tools en el formato del transporte (JSON Schema derivado del zod). */
  passTools(level: Exclude<AgentLevel, 'both'>): PassTool[];
  /** Valida args → corre → outcome. Nunca lanza. */
  dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}
export const IToolRegistry = createToken<IToolRegistry>('IToolRegistry');

export class ToolRegistry implements IToolRegistry {
  public static readonly inject = [all(IAgentTool)] as const;

  constructor(private readonly tools: IAgentTool[]) {
    const dup = tools.map(t => t.name).filter((n, i, a) => a.indexOf(n) !== i);
    if (dup.length) throw new Error(`IAgentTool duplicada/s: ${[...new Set(dup)].join(', ')}`);
  }

  public forLevel(level: Exclude<AgentLevel, 'both'>): IAgentTool[] {
    return this.tools.filter(t => t.level === level || t.level === 'both');
  }

  public passTools(level: Exclude<AgentLevel, 'both'>): PassTool[] {
    return this.forLevel(level).map(t => ({
      name: t.name,
      description: t.description,
      shape: t.shape,
      parameters: t.parameters ?? z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>,
    }));
  }

  public async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.find(t => t.name === name);
    if (!tool) return { ok: false, code: 'unknown_tool', retriable: false, message: `⚠️ tool desconocida: ${name}` };

    let parsed: Record<string, unknown>;
    try {
      // Con `parameters` (JSON Schema crudo del host) los args pasan tal cual:
      // la tool del host valida los suyos, como siempre lo hizo.
      parsed = tool.parameters ? args : z.object(tool.shape).parse(args) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof z.ZodError
        ? err.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        : 'args inválidos';
      return { ok: false, code: 'bad_args', retriable: true, message: `⚠️ ${name}: ${detail}` };
    }

    try {
      return classify(await tool.run(ctx, parsed));
    } catch (err) {
      log(`internal en tool "${name}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return { ok: false, code: 'internal', retriable: false, message: `⚠️ ${name}: error interno` };
    }
  }
}
