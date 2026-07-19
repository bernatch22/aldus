/**
 * dedupe.ts — el guard anti-spin COMPARTIDO por los dos agentes: repetir la
 * MISMA tool con los MISMOS args dentro de un turno no re-ejecuta — devuelve
 * un stop. Determinístico, vale para cualquier transporte/modelo: sin esto un
 * modelo débil gira hasta agotar el presupuesto y el turno muere mudo.
 */
import type { ToolContext } from '../tools/contract.js';
import type { IToolRegistry } from '../tools/registry.js';

export type Dispatch = (name: string, args: Record<string, unknown>) => Promise<string>;

export function dedupedDispatch(registry: IToolRegistry, ctx: ToolContext): Dispatch {
  const seen = new Set<string>();
  return async (name, args) => {
    const key = `${name}:${JSON.stringify(args)}`;
    if (seen.has(key)) {
      return `↩︎ ya corriste ${name} con esos mismos argumentos — el resultado no va a cambiar. No repitas: seguí con lo que tenés.`;
    }
    seen.add(key);
    return (await registry.dispatch(name, args, ctx)).message;
  };
}
