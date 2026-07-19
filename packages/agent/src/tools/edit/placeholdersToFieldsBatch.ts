/**
 * placeholders_to_fields_batch — TODOS los párrafos con placeholders de una
 * página en UNA sola llamada del modelo. Misma división del trabajo que la
 * versión de a uno (el LLM detecta {placeholder, name}, el código hace el
 * layout), pero el modelo describe la página COMPLETA en un tool call en vez
 * de encadenar N idas y vueltas — que era el cuello de botella real (una página
 * de 8 párrafos = 8 pasadas de LLM en serie).
 *
 * Cada grupo se aplica independiente contra la sesión: un párrafo que falla no
 * tumba a los demás, y el resultado reporta grupo por grupo.
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

const GROUP = z.object({
  id: z.string().regex(/^p\d+-\S+$/).describe('id de una línea del párrafo (ej: p1-y659-x85)'),
  fields: z.array(z.object({
    placeholder: z.string().min(2).describe('substring exacto de la línea que contiene/identifica el hueco'),
    name: z.string().min(2).describe('nombre del campo, snake_case'),
    width: z.number().positive().optional().describe('ancho útil en pt (solo si el hueco real es más chico)'),
  })).min(1).describe('un item por hueco, en ORDEN de aparición en el párrafo'),
});

export const placeholdersToFieldsBatchTool: IAgentTool = {
  name: 'placeholders_to_fields_batch',
  description:
    'Convierte los placeholders ("……", "....", "____", y rellenos "XXXX"/"xxx"/"***") ' +
    'de VARIOS párrafos en campos, en UNA sola llamada. Preferila SIEMPRE que haya que ' +
    'convertir más de un párrafo: pasá un grupo {id, fields} por párrafo con placeholders. ' +
    'Cada grupo es como una llamada a placeholders_to_fields (id = una línea del párrafo; ' +
    'fields en orden; cada hueco un field separado — "XX de XXXXXX de XXXX" = 3 fields).',
  level: 'editor',
  shape: {
    groups: z.array(GROUP).min(1).describe('un grupo por párrafo que tenga placeholders'),
  },

  run: async ({ session }, args) => {
    const groups = args.groups as Array<z.infer<typeof GROUP>>;
    const lines: string[] = [];
    let created = 0;
    let failed = 0;

    for (const g of groups) {
      const msg = await session.placeholdersToFields(g.id, g.fields);
      lines.push(`  ${g.id}: ${msg}`);
      if (msg.startsWith('✓')) {
        const m = /^✓ (\d+) campo/.exec(msg);
        created += m ? Number(m[1]) : 0;
      } else if (msg.startsWith('⚠️')) {
        failed++;
      }
    }

    const head = failed
      ? `✓ ${created} campo(s) creados en ${groups.length - failed}/${groups.length} párrafos (${failed} con problema):`
      : `✓ ${created} campo(s) creados en ${groups.length} párrafo(s):`;
    return [head, ...lines].join('\n');
  },
};
