/**
 * dedupe.ts — el guard anti-spin COMPARTIDO por los dos agentes: repetir la
 * MISMA tool con los MISMOS args dentro de un turno no re-ejecuta — devuelve
 * un stop. Determinístico, vale para cualquier transporte/modelo: sin esto un
 * modelo débil gira hasta agotar el presupuesto y el turno muere mudo.
 */
import type { ToolContext } from '../tools/contract.js';
import type { IToolRegistry, ToolOutcome } from '../tools/registry.js';

/**
 * Devuelve el {@link ToolOutcome} ENTERO, no su `.message`.
 *
 * Antes devolvía solo el string, y el resultado era que cada consumidor tenía
 * que RE-DEDUCIR el desenlace oliendo el prefijo (`msg.startsWith('✓')`) — el
 * registry ya había hecho ese trabajo en `classify()` y lo tiraba a la basura
 * una línea después. Un `✓` al principio de una frase es un detalle de
 * PRESENTACIÓN para el modelo; que el control de flujo del código dependa de él
 * es frágil (una tool que reformula su mensaje rompe a un caller lejano) y
 * pierde `code`/`retriable`, que ya estaban calculados.
 */
export type Dispatch = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

export function dedupedDispatch(registry: IToolRegistry, ctx: ToolContext): Dispatch {
  const seen = new Set<string>();
  return async (name, args) => {
    const key = `${name}:${JSON.stringify(args)}`;
    if (seen.has(key)) {
      return {
        ok: true,
        code: 'skipped',
        retriable: false,
        message: `↩︎ ya corriste ${name} con esos mismos argumentos — el resultado no va a cambiar. No repitas: seguí con lo que tenés.`,
      };
    }
    seen.add(key);
    return registry.dispatch(name, args, ctx);
  };
}
